#!/usr/bin/env node
/**
 * 唯一 outbox 双写期：事件投递那半（阶段七第 3 步）。
 *
 * 一、全路径：跑一遍事件层冒烟（workbench-events-smoke：held / 放行 / 自动投递 / 重试 / dead / 撤回），再对它的库对账：
 *    非 held 的投递与 outbox 一一对上；held 的单独列出、不在 outbox 里。冒烟里唯一一处直改库（把 sent_at 挪到 8 天前测
 *    token 过期）必须被对账抓到——对账真在逐字段比。
 * 二、放行即入队，同一事务：进程在「投递改成 pending」和「写进 outbox」之间被 SIGKILL，重启后投递仍是 held、outbox 没有它、
 *    事件日志没有 released（没有「放行成功而没入队」）；再放行一次，pending 和 outbox 行一起出现。
 * 三、启动整表同步：outbox 里的投递行被删、被改、多出 held 投递的行，重启后都对齐；对账零差异。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const node = (args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300_000 });
const reconcile = (dir) => { const r = node(['scripts/a2a-outbox-reconcile.mjs', dir, '--json']); try { return { status: r.status, j: JSON.parse(r.stdout) }; } catch { return { status: r.status, j: null, out: r.stdout + r.stderr }; } };

console.log('一、全路径（事件层冒烟之后对账）');
{
  const before = new Set(readdirSync('tmp').filter((n) => n.startsWith('wbe-')));
  const smoke = node(['scripts/workbench-events-smoke.mjs']);
  ok('事件层冒烟通过', smoke.status === 0, (smoke.stdout + smoke.stderr).slice(-400));
  const dirs = readdirSync('tmp').filter((n) => n.startsWith('wbe-') && !n.startsWith('wbe-backfill-') && !before.has(n));
  ok('找到冒烟的数据目录', dirs.length === 1, dirs.join(','));
  if (dirs.length === 1) {
    const dir = resolve('tmp', dirs[0]);
    const { j } = reconcile(dir);
    const ev = j?.events;
    ok('非 held 的投递全在 outbox 里，没有多出的', ev && ev.old_rows > 0 && ev.missing.length === 0 && ev.extra.length === 0, JSON.stringify(ev));
    ok('按状态计数两边一致（含 sent / dead / cancelled）', ev && JSON.stringify(ev.by_status.old) === JSON.stringify(ev.by_status.new) && ['sent', 'dead', 'cancelled'].every((s) => ev.by_status.old[s] > 0), JSON.stringify(ev?.by_status));
    ok('held 的单独列出', ev && ev.held.count > 0 && ev.held.count === ev.held.refs.length);
    const d = new DatabaseSync(resolve(dir, 'workbench-market.db'), { readOnly: true });
    const tampered = d.prepare("SELECT CAST(id AS TEXT) AS ref FROM workbench_event_deliveries WHERE sent_at <> '' AND sent_at < datetime('now', '-7 days')").all().map((r) => r.ref);
    const heldInOutbox = d.prepare("SELECT COUNT(*) AS n FROM a2a_outbox_items o JOIN workbench_event_deliveries w ON o.kind = 'event-delivery' AND o.ref = CAST(w.id AS TEXT) WHERE w.status = 'held'").get().n;
    const plaintext = d.prepare("SELECT COUNT(*) AS n FROM a2a_outbox_items WHERE kind = 'event-delivery' AND status IN ('sent','dead','cancelled') AND payload <> ''").get().n;
    d.close();
    ok('冒烟直改库的那一行被对账抓到（只有 sent_at 不同）', tampered.length === 1 && ev?.mismatched.length === 1 && ev.mismatched[0].ref === tampered[0] && ev.mismatched[0].fields.join() === 'sent_at', JSON.stringify({ tampered, m: ev?.mismatched }));
    ok('held 的投递没有一行进 outbox', heldInOutbox === 0);
    ok('落定后的 outbox 行信封清空（reply token 明文不多留一份）', plaintext === 0);
  }
}

console.log('二、放行即入队，同一事务（两步之间被杀）');
const DATA = resolve('tmp/a2a-outbox-events');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const EV = 'wbe-00000000000000aa';
{
  const seed = node(['scripts/a2a-outbox-events-harness.mjs', 'seed', EV], { DATA_DIR: DATA });
  ok('造一个 held 投递', seed.status === 0 && seed.stdout.includes('seeded'), seed.stderr.slice(-300));
  const killed = node(['--import', './scripts/kill-on-sql-preload.mjs', 'scripts/a2a-outbox-events-harness.mjs', 'release', EV], { DATA_DIR: DATA, KILL_ON_SQL: "AND d.id = ?" /* 只有逐行镜像有这一句，启动整表同步没有 */ });
  ok('放行途中进程被 SIGKILL', killed.signal === 'SIGKILL', `status=${killed.status} signal=${killed.signal} ${killed.stderr.slice(-300)}`);
  const look = () => {
    const d = new DatabaseSync(resolve(DATA, 'workbench-market.db'), { readOnly: true });
    try {
      return {
        status: d.prepare('SELECT status FROM workbench_event_deliveries WHERE event_id = ?').get(EV)?.status,
        item: d.prepare("SELECT status FROM a2a_outbox_items WHERE kind = 'event-delivery'").get()?.status ?? null,
        released: d.prepare("SELECT COUNT(*) AS n FROM workbench_event_log WHERE event_id = ? AND action = 'released'").get(EV).n,
      };
    } finally { d.close(); }
  };
  let s = look();
  ok('重启后：投递仍 held、outbox 没有它、日志没有 released', s.status === 'held' && s.item === null && s.released === 0, JSON.stringify(s));
  const again = node(['scripts/a2a-outbox-events-harness.mjs', 'release', EV], { DATA_DIR: DATA });
  ok('再放行一次 → 200', again.status === 0 && again.stdout.includes('release 200'), again.stdout + again.stderr.slice(-300));
  s = look();
  ok('投递 pending、outbox 行 pending、日志一条 released', s.status === 'pending' && s.item === 'pending' && s.released === 1, JSON.stringify(s));
  const { j } = reconcile(DATA);
  ok('对账零差异', j?.ok === true, JSON.stringify(j));
}

console.log('三、启动整表同步');
{
  const d = new DatabaseSync(resolve(DATA, 'workbench-market.db'));
  d.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, 'dsh/bbbb', 'http://peer.invalid', 'market/test', 'held')").run(EV);
  const heldId = String(d.prepare("SELECT MAX(id) AS id FROM workbench_event_deliveries").get().id);
  d.prepare("INSERT INTO a2a_outbox_items (kind, ref, target_url, payload) VALUES ('event-delivery', ?, 'http://peer.invalid', 'x')").run(heldId);
  d.prepare("UPDATE a2a_outbox_items SET attempts = 3 WHERE kind = 'event-delivery' AND ref <> ?").run(heldId);
  d.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status) VALUES (?, 'dsh/cccc', 'http://peer.invalid', 'market/test', 'dead')").run(EV);
  d.close();
  let { j } = reconcile(DATA);
  ok('对账报：改过的、缺的、held 却在 outbox 的', j && !j.ok && j.events.mismatched.length === 1 && j.events.missing.length === 1 && j.events.extra.join() === heldId, JSON.stringify(j?.events));
  const boot = node(['--input-type=module', '-e', "const ev = await import('./server/src/workbench-events.ts'); ev.initWorkbenchEvents();"], { DATA_DIR: DATA });
  ok('重启（装事件层）成功', boot.status === 0, boot.stderr.slice(-300));
  ({ j } = reconcile(DATA));
  ok('重启后零差异；held 的仍单独列出', j?.ok === true && j.events.held.refs.join() === heldId, JSON.stringify(j?.events));
}

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
