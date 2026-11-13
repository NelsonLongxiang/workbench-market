#!/usr/bin/env node
/**
 * 按时间排序的列表在时间相同时次序固定：统一用 id 作第二排序键（录制回放里出过「同一秒建的两条 run 先后对调」的偶发）。
 *
 *   SOP 运行列表（GET /api/sop/runs 用的 runsFiltered、在跑的 runsRunning）：更新时间只到秒，同一秒的几条按 id 倒序
 *   成员分配（这个人现在被分到的成员 assignedTo）：分配时刻相同（同一毫秒）的几条按 id 正序
 *   每种都插几条时间相同的行，反复取，次序每次都一样、都是按 id 定的
 *
 *   node scripts/time-order-tiebreak-test.mjs              测本仓库
 *   node scripts/time-order-tiebreak-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `time-order-tiebreak-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
    const { svc } = await import(${JSON.stringify(at('server/src/context.ts'))});
    // SOP 运行：五条，更新时间全是同一秒（夹着一条更早的、一条更晚的）
    const run = db.prepare("INSERT INTO sop_runs (sop_slug, sop_version, status, updated_at) VALUES ('order-probe', 1, 'running', ?)");
    run.run('2026-01-01 00:00:00');
    for (let i = 0; i < 5; i++) run.run('2026-01-02 00:00:00');
    run.run('2026-01-03 00:00:00');
    const sop = svc('sop');
    const filtered = [], running = [];
    for (let k = 0; k < 5; k++) { filtered.push(sop.runsFiltered('order-probe', '').map((x) => x.id)); running.push(sop.runsRunning().map((x) => x.id)); }
    // 成员分配：同一个人在同一毫秒被分到四个成员
    // 团队归属绑节点：名册和对端登记里要有这个节点（合成的）
    db.prepare("INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES ('a1b2c3d4', 'https://order.synthetic.invalid', 'zone1', '0', '0')").run();
    db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('peer-order', 'https://order.synthetic.invalid', 'zone1', '', 'active', 'sha256:a1b2c3d4', 'seed', '0', '0')").run();
    const a = db.prepare("INSERT INTO seat_assignments (host, team, seat, seat_id, principal_id, assigned_by, assigned_at, peer_root, key_fingerprint) VALUES ('a1b2c3d4', 'zone1/canvas/Team A', ?, ?, 'user:alpha', 'test', 1000, 'https://order.synthetic.invalid', 'sha256:a1b2c3d4')");
    for (let i = 0; i < 4; i++) a.run('zone1/0000000' + i, 'seat-0000000' + i);
    const teams = svc('teams');
    const assigned = [];
    for (let k = 0; k < 5; k++) assigned.push(teams.assignedTo('user:alpha').map((x) => x.id));
    console.log('OUT ' + JSON.stringify({ filtered, running, assigned }));
    process.exit(0);`], { env: { ...process.env, DATA_DIR: join(OUT, 'data') }, encoding: 'utf8', timeout: 60000 });
  const m = /OUT (.*)/.exec(r.stdout);
  if (!m) throw new Error(`跑不起来：${r.stderr.slice(-600)}`);
  const o = JSON.parse(m[1]);
  // 期望：更新时间倒序；同一秒的五条（id 2～6）按 id 倒序
  const expectRuns = [7, 6, 5, 4, 3, 2, 1];
  check(o.filtered.every((x) => show(x) === show(expectRuns)), 'SOP 运行列表（runsFiltered）：同一秒更新的几条按 id 倒序，反复取次序不变', show(o.filtered[0]));
  check(o.running.every((x) => show(x) === show(expectRuns)), '在跑的 SOP 运行（runsRunning）：同上', show(o.running[0]));
  check(o.assigned.every((x) => show(x) === show([1, 2, 3, 4])), '这个人现在被分到的成员（assignedTo）：同一毫秒分配的几条按 id 正序，反复取次序不变', show(o.assigned[0]));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
