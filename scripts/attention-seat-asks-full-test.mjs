#!/usr/bin/env node
/**
 * 「关注」的席位提问不按最近 N 个事件截断（对抗组）。原先只看最近 200 个事件：早一点的提问从「关注」漏掉、没人答，
 * 而事项详情的 can/turn、事项列表的 decide 能数到它，侧栏角标和页签红数对不上。
 * 起隔离实例（假的登录提供方，NODE_ENV=test），合成：
 *
 *   alpha 建的、席位问了一句还没人答的三件：一件在最前（之后再造 250 个别的事件，它落在最近 200 个之外），两件在最后；
 *   alpha 建的、席位问过、后来接了单的一件（提问已合上），也在最前；
 *   别人（user:load）建的、在问的 SEAT_ASK_LIMIT + 1 件，提问时间都更晚：管理层看得到，alpha 和普通员工看不到
 *   守的：
 *   - alpha 的三件在问的都在「关注」的席位提问里，轮到他、有答法；合上的那件不在
 *   - 「关注」里 alpha 能当场答的席位提问条数，等于事项列表「我发起的」的 decide（同一批、同数）
 *   - more 只按这个人看得到的算：alpha 只看得到 3 条，全库超了上限也没有 more；
 *     普通员工一条都看不到，sources['seat-asks'] 和全库没有提问时一样（没有 more、count 0）
 *   - 管理层看得到的超过上限：列满 SEAT_ASK_LIMIT 条、带 more，按提问先后取最早的（alpha 那三件在）
 *   变异：恢复 200 个事件的窗口、取最晚的（倒序）、不往上报 more、在可见性过滤之前算 more 都必须红
 *
 *   node scripts/attention-seat-asks-full-test.mjs              测本仓库
 *   node scripts/attention-seat-asks-full-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `attention-seat-asks-full-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'seat-asks-full-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid';
const TEAM = 'zone1/canvas/Team A', VACANT = 'zone1/canvas/Team B';
const NEWER = 250;
// 上限从源码里读（不 import：那会在本进程里打开另一份库）；没有这个常量的树（变异、旧代码）按 1000
const LIMIT = Number((/export const SEAT_ASK_LIMIT = (\d+)/.exec(readFileSync(join(ROOT, 'server/src/services/attention-sources.ts'), 'utf8')) ?? [])[1]) || 1000;
const at = (p) => JSON.stringify(pathToFileURL(join(ROOT, p)).href);

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const SEED = `
const { db } = await import(${at('server/src/db.ts')});
const ev = await import(${at('server/src/workbench-events.ts')});
const { root } = await import(${at('server/src/root-context.ts')});
const { WorkItemService, itemIdForEvent } = await import(${at('server/src/services/work-item.ts')});
ev.initWorkbenchEvents();
await root.plugin(WorkItemService);
const items = root.get('workItems');
const b = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', ?, 'notify', 'read', ?, 'seed')");
b.run(${JSON.stringify(TEAM)}, ${JSON.stringify(PEER)}); b.run(${JSON.stringify(VACANT)}, ${JSON.stringify(PEER)});
const task = (title) => Number(db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'published')").run(title).lastInsertRowid);
const held = (title, team, by) => {
  const id = task(title), f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
  db.exec('BEGIN IMMEDIATE');
  const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: by, publisherPrincipal: by, templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: by } });
  db.exec('COMMIT');
  items.syncEvent(e);
  return itemIdForEvent(e);
};
// 在问：派到 Team A，席位问了一句；closed 时之后又接了单（提问合上）
const asked = (title, at, closed = false, by = 'user:alpha') => {
  const id = task(title), f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
  db.exec('BEGIN IMMEDIATE');
  const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: by, publisherPrincipal: by, templateVersion: 1, materialSha256: 'h', agentDispatch: true, centerOn: true });
  db.exec('COMMIT');
  const d = db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ? AND target_team = ?').get(e, ${JSON.stringify(TEAM)});
  db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = ?, decision = 'ask', decision_reason = '哪个店？', decided_by = 'bob', decided_at = ? WHERE id = ?").run(at, at, d.id);
  db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(e, d.id);
  db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(e, d.id, JSON.stringify({ reason: '哪个店？' }));
  if (closed) {
    db.prepare("UPDATE workbench_event_deliveries SET decision = 'accept', decision_reason = '', decided_at = ? WHERE id = ?").run(at, d.id);
    db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:accept', '{}')").run(e, d.id);
  }
  items.syncEvent(e);
  return itemIdForEvent(e);
};
const out = { oldAsk: asked('合成：早先在问', '2026-01-01 00:00:01'), oldClosed: asked('合成：早先问过、已接单', '2026-01-01 00:00:02', true) };
// 之后再来 ${NEWER} 个别人的事件：上面两件落到最近 200 个事件之外
for (let i = 0; i < ${NEWER}; i++) held('合成：后来的事件 ' + i, ${JSON.stringify(VACANT)}, 'user:load');
out.newAsk = asked('合成：最近在问', '2026-02-01 00:00:01');
out.thirdAsk = asked('合成：最近又问', '2026-02-01 00:00:02');
// 别人建的、更晚的提问，超过上限一条：只有管理层看得到
for (let i = 0; i <= ${LIMIT}; i++) asked('合成：别人的在问 ' + i, '2026-03-01 00:' + String(Math.floor(i / 60) % 60).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0'), false, 'user:load');
console.log('SEEDED ' + JSON.stringify(out));
process.exit(0);
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', SEED], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seeded.stdout);
  if (!m) throw new Error(`造数据失败：${seeded.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 300 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const WHO = { 普通员工: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` }, alpha: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, beta: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 管理层: { ...SAME, cookie: `session_id=${SESSIONS.admin}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 15000 }); // 实例刚起来、还在写库时等一等，不报 database is locked
    const now = Date.now();
    db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)').run(HOST, PEER, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
    const seatIns = db.prepare('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)');
    seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', now, now);
    seatIns.run(HOST, VACANT, 'zone1/0000000d', 'seat-0000000d', '合成别队', 'router', now, now);
    db.close();
  }
  // 部门负责人、团队认领、管理层授予都由属主（本机命令行）做
  const dept = await call('PUT', '/api/departments/sales', {}, { name: '合成销售部', lead: 'user:beta' });
  const claim = await call('POST', '/api/teams/claim', {}, { host: HOST, team: TEAM, department: 'sales' });
  const g = await call('POST', '/api/grants', {}, { principal: 'user:root-admin', role: 'management', scope: '*', reason: '合成：持有管理层授予的人' });
  await call('POST', `/api/grants/${g.body?.grant?.id}/submit`, {}, {});
  const ga = await call('POST', `/api/grants/${g.body?.grant?.id}/approve`, {}, {});
  if (![dept, claim, ga].every((r) => r.status >= 200 && r.status < 300)) throw new Error(`搭不起来：${show({ dept, claim, ga })}`);

  const seatAsks = async (h) => { const r = await call('GET', '/api/attention', h); return { meta: r.body?.sources?.['seat-asks'], rows: (r.body?.items ?? []).filter((x) => x.source === 'seat-asks') }; };
  const idOf = (x) => (/^\/work-items\/([^/?#]+)/.exec(x.link || '') ?? [])[1] ?? null;
  const ALPHA = [I.oldAsk, I.newAsk, I.thirdAsk];
  {
    const evs = (await call('GET', '/api/work-items', WHO.alpha)).body;
    const { meta, rows } = await seatAsks(WHO.alpha);
    const mineRows = rows.filter((x) => x.mine !== false && (x.answers ?? []).length > 0);
    const ids = new Set(mineRows.map(idOf));
    check(ids.has(I.oldAsk), '落在最近 200 个事件之外的提问，在「关注」的席位提问里，轮到 alpha、有答法', show(rows.map((x) => [idOf(x), x.mine, x.answers])));
    check(ids.has(I.newAsk) && ids.has(I.thirdAsk), '最近的提问也在', show([...ids]));
    check(!rows.some((x) => idOf(x) === I.oldClosed), '已经接了单（提问合上）的那件不在', show([...ids]));
    check(mineRows.length === 3 && evs?.views?.mine?.decide === 3, `「关注」里 alpha 能当场答的席位提问（${mineRows.length}）和「我发起的」的 decide（${evs?.views?.mine?.decide}）同数，都是 3`, show({ rows: mineRows.length, views: evs?.views }));
    const decideIds = new Set();
    for (const id of [...ALPHA, I.oldClosed]) { const d = (await call('GET', `/api/work-items/${id}`, WHO.alpha)).body; if (d?.turn?.answer && d?.can?.answer) decideIds.add(id); }
    check(decideIds.size === ids.size && [...ids].every((id) => decideIds.has(id)), '两边是同一批：详情里轮到 alpha 答、能答的，正好是「关注」里列出来的', show({ decideIds: [...decideIds], ids: [...ids] }));
    check(rows.length === 3 && meta && !('more' in meta), `全库还没答的提问超过上限（${LIMIT + 4}），alpha 只看得到 3 条：没有 more`, show(meta));
  }
  {
    const { meta, rows } = await seatAsks(WHO.普通员工);
    check(rows.length === 0 && show(meta) === show({ label: '席位的提问', visible: true, count: 0 }), '普通员工一条都看不到：sources 里这个来源和全库没有提问时一样（没有 more、count 0），不透露全库的量', show(meta));
  }
  {
    const { meta, rows } = await seatAsks(WHO.管理层);
    const got = new Set(rows.map(idOf));
    check(meta?.more === true && rows.length === LIMIT, `管理层看得到的超过上限（${LIMIT + 4} 条）：列满 ${LIMIT} 条、sources['seat-asks'].more 为真`, show({ meta, n: rows.length }));
    check(ALPHA.every((id) => got.has(id)), '超了上限按提问先后取最早的：alpha 那三件（最早的）在', show(ALPHA.filter((id) => !got.has(id))));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}\n${log.slice(-1500)}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); }); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
