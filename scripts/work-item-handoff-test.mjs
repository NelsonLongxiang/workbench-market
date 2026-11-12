#!/usr/bin/env node
/**
 * 规范 14 第 2 步 A：事项是怎么交出去的，建的时候记下来（handoff、review_by、directed_seat_id；seat_id、seat_at 先留空列）。
 *
 *   任务中心的事件一律记交给方式：缺省 team；等谁过目没给时按投递推——held（先过目）→ lead，直接派出 → 空
 *   阶段七的指名派工经 recordTaskCenterEvent 的 arranged 写：own-seat、requester、seatId 原样落到事项上
 *   不认得的取值一律当没写（team、不过目、没有指名）；指名的席位只认 seatId（seat-<8hex>），句柄不认
 *   不经事件建的事项、旧库里的存量：交给团队、不过目（列缺省值，不回填）
 *   （事项都经 syncEvent 建——回填用的就是它；回填和实时逐行相同由 work-item-backfill-test 守）
 *   旧库：开库时补上这五列，存量行是缺省值；再开一次不重复补
 *
 *   node scripts/work-item-handoff-test.mjs              测本仓库
 *   node scripts/work-item-handoff-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-handoff-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  // ---------- 旧库：没有这五列的事项表，开库时补上，存量是缺省值 ----------
  {
    const dir = join(OUT, 'old');
    mkdirSync(dir, { recursive: true });
    const first = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      for (const c of ['handoff', 'review_by', 'directed_seat_id', 'seat_id', 'seat_at']) db.exec('ALTER TABLE work_items DROP COLUMN ' + c);
      db.prepare("INSERT INTO work_items (id, title, created_by, source_kind) VALUES ('wi_old', '存量', 'user:a', 'agent')").run();
      console.log('OK');`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
    const reopen = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
      console.log('ROW ' + JSON.stringify(db.prepare("SELECT handoff, review_by, directed_seat_id, seat_id, seat_at FROM work_items WHERE id = 'wi_old'").get()));`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
    const a = reopen(), b = reopen();
    const row = (r) => /ROW (.*)/.exec(r.stdout)?.[1];
    check(first.stdout.includes('OK') && row(a) === show({ handoff: 'team', review_by: '', directed_seat_id: '', seat_id: '', seat_at: '' }) && row(b) === row(a) && b.status === 0,
      '旧库开库时补上五列，存量行是缺省值（交给团队、不过目）；再开一次不重复补、不出错', show({ first: first.stderr.slice(-200), a: row(a), b: row(b), err: b.stderr.slice(-200) }));
  }

  // ---------- 新建：从事件层取 ----------
  const dir = join(OUT, 'data');
  mkdirSync(dir, { recursive: true });
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
    const ev = await import(${JSON.stringify(at('server/src/workbench-events.ts'))});
    const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
    const { WorkItemService, itemIdForEvent } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
    ev.initWorkbenchEvents();
    await root.plugin(WorkItemService);
    const items = root.get('workItems');
    db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', 'dsh/canvas/team-a', 'notify', 'read', 'http://127.0.0.1:1', 'seed')").run();
    const publish = (extra, dispatch) => {
      const id = Number(db.prepare("INSERT INTO tasks (title, status) VALUES ('t', 'published')").run().lastInsertRowid);
      const f = { title: 't', intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
      db.exec('BEGIN IMMEDIATE');
      const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: 'user:alpha', publisherPrincipal: 'user:alpha', templateVersion: 1, materialSha256: 'h', agentDispatch: dispatch, centerOn: dispatch, ...(extra ? { arranged: { team: 'dsh/canvas/team-a', submitter: 'user:alpha', ...extra } } : {}) });
      db.exec('COMMIT');
      return e;
    };
    const E = {
      held: publish(null, false),
      open: publish(null, true),
      own: publish({ handoff: 'own-seat', reviewBy: 'requester', directedSeatId: 'seat-0a1b2c3d' }, true),
      directed: publish({ handoff: 'lead-directed', reviewBy: '', directedSeatId: 'seat-ffffffff' }, true),
      badSeat: publish({ handoff: 'own-seat', directedSeatId: 'dsh/12345678' }, true),
    };
    // 不认得的取值：类型只在编译时管，运行时照样能传进来，事件层原样记下；事项那边要当没写
    E.bogus = publish({ handoff: 'whatever', reviewBy: 'admin', directedSeatId: 'seat-XYZ' }, false);
    for (const e of Object.values(E)) items.syncEvent(e);
    const plain = items.create({ title: '不经事件', created_by: 'user:alpha', creator_principal: 'user:alpha', source_kind: 'agent' });
    const pick = (id) => { const w = items.get(id); return w && { handoff: w.handoff, review_by: w.review_by, directed_seat_id: w.directed_seat_id, seat_id: w.seat_id, seat_at: w.seat_at }; };
    const out = Object.fromEntries(Object.entries(E).map(([k, e]) => [k, pick(itemIdForEvent(e))]));
    out.plain = pick(plain.id);
    console.log('OUT ' + JSON.stringify({ out }));
    process.exit(0);`], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  const r = JSON.parse(/OUT (.*)/.exec(run.stdout)?.[1] ?? 'null');
  if (!r) throw new Error(`跑不起来：${run.stderr.slice(-800)}`);
  const o = r.out;
  const v = (h, rb, s) => ({ handoff: h, review_by: rb, directed_seat_id: s, seat_id: '', seat_at: '' });
  check(show(o.held) === show(v('team', 'lead', '')), '任务中心发布、先过目（held）：交给团队、等负责人过目', show(o.held));
  check(show(o.open) === show(v('team', '', '')), '任务中心发布、直接派出：交给团队、不过目', show(o.open));
  check(show(o.own) === show(v('own-seat', 'requester', 'seat-0a1b2c3d')), '指名派工（经 arranged）：交给自己的 AI 员工、勾了先过目由建立人放行、指名的 seatId 原样落下', show(o.own));
  check(show(o.directed) === show(v('lead-directed', '', 'seat-ffffffff')), '负责人指名：不过目、指名的 seatId', show(o.directed));
  check(show(o.badSeat) === show(v('own-seat', '', '')), '指名的席位只认 seatId：给了句柄（<区>/<8hex>）当没有指名', show(o.badSeat));
  check(show(o.bogus) === show(v('team', '', '')), '不认得的取值（坏的 detail）一律当没写：交给团队、不过目、没有指名', show(o.bogus));
  check(show(o.plain) === show(v('team', '', '')), '不经事件建的事项：交给团队、不过目（列缺省值）', show(o.plain));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
