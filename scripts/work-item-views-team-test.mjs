#!/usr/bin/env node
/**
 * 规范 14 第 2 步 B 后一半：成员的主人、负责人和 seats / team 视角（放宽访问的对抗组；建立人、管理层和 mine / all 在 work-item-views-test）。起隔离实例（假的登录提供方，NODE_ENV=test），
 * 合成名册、部门、团队认领、负责人、成员分配：
 *
 *   看得到：建立人、成员的主人（承接席位在接手那一刻分配给他）、负责人（事项交给的团队）、管理层；别人 404
 *   成员的主人：只算分配给他的那段时间里交到成员手上的事——接手早于分配的不算（前一个主人的事）
 *   旧席位（没有 seatId）按句柄认；seat_id、句柄都空的事项不算进任何人的 AI 员工（空串不参加匹配）
 *   视角：mine（我安排的）、seats（我的 AI 员工手上的）、team（我团队的）、all（全部，管理层）；
 *         应答带每个视角可不可用、几件；不带 view 落在第一个有内容的；不可用的视角 403；坏的 view 400
 *   按状态的件数跟着视角算；可以按席位筛（seatId 或旧席位的句柄）
 *   席位按完整的键：别的节点上 seat_id 相同的、名字只多一个字的团队里句柄相同的，都不算成员的主人的（列表里没有、详情 404）
 *   换主人的边界：同一秒里收回又分给别人，接手时刻按左闭右开归属，列表和详情结论一样
 *   不变量：每个人、每个可用的视角，列表里的每一条，详情都是 200
 *   「关注」的验收条目给看得到这件事项的人：负责人看得到本团队的，mine 只对建立人为真
 *
 *   node scripts/work-item-views-team-test.mjs              测本仓库
 *   node scripts/work-item-views-team-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-views-team-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'views-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid';
const TEAM = 'zone1/canvas/Team A', TEAM2 = 'zone1/canvas/Team B';
const MEMBER = { seat: 'zone1/0000000b', seat_id: 'seat-0000000b' }, LEGACY = { seat: 'zone1/0000000c', seat_id: '' };
// 对抗用：另一个节点（seat_id 和 MEMBER 相同）；名字只多一个字的团队（旧席位句柄和 LEGACY 相同）；换主人用的另一个成员
const HOST2 = 'e5f6a7b8', PEER2 = 'http://peer2.synthetic.invalid', TEAM_A2 = 'zone1/canvas/Team A2';
const MEMBER2 = { seat: 'zone1/0000000e', seat_id: 'seat-0000000e' }, MEMBER3 = { seat: 'zone1/0000000f', seat_id: 'seat-0000000f' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  // 事项：都由 alpha 建（I_ZETA 由 zeta 建），经任务中心派给团队 A 或 B
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    const ev = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/workbench-events.ts')).href)});
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService, itemIdForEvent } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    ev.initWorkbenchEvents();
    await root.plugin(WorkItemService);
    const items = root.get('workItems');
    const b = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', ?, 'notify', 'read', ?, 'seed')");
    b.run(${JSON.stringify(TEAM)}, ${JSON.stringify(PEER)}); b.run(${JSON.stringify(TEAM2)}, ${JSON.stringify(PEER)});
    b.run(${JSON.stringify(TEAM_A2)}, ${JSON.stringify(PEER)});
    const mk = (title, who, team) => {
      const id = Number(db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'published')").run(title).lastInsertRowid);
      const f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
      db.exec('BEGIN IMMEDIATE');
      const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: who, publisherPrincipal: who, templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: who } });
      db.exec('COMMIT');
      items.syncEvent(e);
      return itemIdForEvent(e);
    };
    const out = { owned: mk('成员接手（分配之后）', 'user:alpha', ${JSON.stringify(TEAM)}), before: mk('成员接手（分配之前）', 'user:alpha', ${JSON.stringify(TEAM)}),
      legacy: mk('旧席位接手', 'user:alpha', ${JSON.stringify(TEAM)}), noSeat: mk('还没有承接', 'user:alpha', ${JSON.stringify(TEAM)}),
      other: mk('别的团队', 'user:zeta', ${JSON.stringify(TEAM2)}),
      // 对抗用的四件都由 zeta 建（不改 alpha 那边的件数）
      xh: mk('别的节点、seat_id 相同', 'user:zeta', ${JSON.stringify(TEAM)}), sub: mk('名字只多一个字的团队、句柄相同', 'user:zeta', ${JSON.stringify(TEAM_A2)}),
      zo: mk('换主人那一秒接手', 'user:zeta', ${JSON.stringify(TEAM)}), zq: mk('正好在换主人那一刻接手', 'user:zeta', ${JSON.stringify(TEAM)}), rd: mk('等验收', 'user:zeta', ${JSON.stringify(TEAM)}) };
    // xh 的投递改投到另一个节点（同名团队）；投递表只这一处改
    db.prepare("UPDATE workbench_event_deliveries SET target_url = ? WHERE event_id = ?").run(${JSON.stringify(PEER2)}, out.xh.slice(3));
    // rd 推到等验收：只经事项服务（放行、回执做完）
    for (const [k, x] of [['release', {}], ['receipt', { outcome: 'completed' }]]) items.apply(out.rd, { kind: k, source: 'seed', id: out.rd + ':' + k + ':' + (x.outcome ?? ''), ...x });
    out.rdState = items.get(out.rd).state;
    console.log('SEEDED ' + JSON.stringify(out));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
  if (I.rdState !== 'ready') throw new Error(`等验收的那件没推到 ready：${I.rdState}`);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const WHO = { 建立人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, 负责人: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 成员的主人: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
  const now = Date.now();
  db.prepare('INSERT INTO a2a_roster_nodes (host, peer_root, peer_zone, reported_at, received_at, key_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, char(115, 104, 97, 50, 53, 54, 58) || substr(?1 || hex(zeroblob(32)), 1, 64))').run(HOST, PEER, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
  // 团队归属绑节点（根地址 + 完整指纹）：这个根地址要在对端登记里、启用、有指纹（合成的）
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES (?, ?, 'zone1', '', 'active', ?, 'seed', '0', '0') ON CONFLICT(root_url) DO UPDATE SET status = 'active', key_fingerprint = CASE WHEN a2a_peers.key_fingerprint = '' THEN excluded.key_fingerprint ELSE a2a_peers.key_fingerprint END").run(`peer-${HOST}`, PEER, `sha256:${String(HOST).padEnd(64, '0')}`);
  db.prepare('INSERT INTO a2a_roster_nodes (host, peer_root, peer_zone, reported_at, received_at, key_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, char(115, 104, 97, 50, 53, 54, 58) || substr(?1 || hex(zeroblob(32)), 1, 64))').run(HOST2, PEER2, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
  // 团队归属绑节点（根地址 + 完整指纹）：这个根地址要在对端登记里、启用、有指纹（合成的）
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES (?, ?, 'zone1', '', 'active', ?, 'seed', '0', '0') ON CONFLICT(root_url) DO UPDATE SET status = 'active', key_fingerprint = CASE WHEN a2a_peers.key_fingerprint = '' THEN excluded.key_fingerprint ELSE a2a_peers.key_fingerprint END").run(`peer-${HOST2}`, PEER2, `sha256:${String(HOST2).padEnd(64, '0')}`);
  const seatIns = db.prepare('INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ((SELECT peer_root FROM a2a_roster_nodes WHERE host = ?1 ORDER BY rowid LIMIT 1), (SELECT key_fingerprint FROM a2a_roster_nodes WHERE host = ?1 ORDER BY rowid LIMIT 1), ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)');
  seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', now, now);
  seatIns.run(HOST, TEAM, MEMBER.seat, MEMBER.seat_id, '合成成员甲', 'member', now, now);
  seatIns.run(HOST, TEAM, LEGACY.seat, '', '合成成员乙', 'member', now, now);
  seatIns.run(HOST, TEAM2, 'zone1/0000000d', 'seat-0000000d', '合成别队', 'router', now, now);
  seatIns.run(HOST, TEAM, MEMBER2.seat, MEMBER2.seat_id, '合成成员丙', 'member', now, now);
  seatIns.run(HOST, TEAM, MEMBER3.seat, MEMBER3.seat_id, '合成成员丁', 'member', now, now);
  seatIns.run(HOST, TEAM_A2, LEGACY.seat, '', '合成别队旧席位', 'member', now, now);
  seatIns.run(HOST2, TEAM, MEMBER.seat, MEMBER.seat_id, '合成别节点成员', 'member', now, now);
  // 部门负责人、团队认领由属主（本机命令行）做，直接生效；管理口令做只记成提议（规范 14「关系由谁说了算」），这里要的是已确认的关系
  const dept = await call('PUT', '/api/departments/sales', {}, { name: '合成销售部', lead: 'user:beta' });
  const claim = await call('POST', '/api/teams/claim', {}, { host: HOST, team: TEAM, department: 'sales' });
  const as1 = await call('POST', '/api/teams/assign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER, principal: 'user:no-flag' });
  const as2 = await call('POST', '/api/teams/assign', WHO.负责人, { host: HOST, team: TEAM, ...LEGACY, principal: 'user:no-flag' });
  // 换主人：MEMBER2 先分给成员的主人，收回，再分给负责人；再把两段的毫秒边界定死在同一秒里：前一段止于 T+500，后一段起于 T+600
  const as3 = await call('POST', '/api/teams/assign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER2, principal: 'user:no-flag' });
  const un3 = await call('POST', '/api/teams/unassign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER2 });
  const as4 = await call('POST', '/api/teams/assign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER2, principal: 'user:beta' });
  // 另一个成员：前一段正好止于整秒 T2，后一段正好从 T2 起；接手在 T2 那一刻，左闭右开归后一段
  const as5 = await call('POST', '/api/teams/assign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER3, principal: 'user:no-flag' });
  const un5 = await call('POST', '/api/teams/unassign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER3 });
  const as6 = await call('POST', '/api/teams/assign', WHO.负责人, { host: HOST, team: TEAM, ...MEMBER3, principal: 'user:beta' });
  if (![dept, claim, as1, as2, as3, un3, as4, as5, un5, as6].every((r) => r.status >= 200 && r.status < 300)) throw new Error(`团队搭不起来：${show({ dept, claim, as1, as2, as3, un3, as4, as5, un5, as6 })}`);
  const T = Math.floor(now / 1000) * 1000 - 3_600_000;
  db.prepare("UPDATE seat_assignments SET assigned_at = ?, ended_at = ? WHERE seat_id = ? AND principal_id = 'user:no-flag'").run(T - 86_400_000, T + 500, MEMBER2.seat_id);
  db.prepare("UPDATE seat_assignments SET assigned_at = ? WHERE seat_id = ? AND principal_id = 'user:beta'").run(T + 600, MEMBER2.seat_id);
  const T2 = T + 2000;
  db.prepare("UPDATE seat_assignments SET assigned_at = ?, ended_at = ? WHERE seat_id = ? AND principal_id = 'user:no-flag'").run(T - 86_400_000, T2, MEMBER3.seat_id);
  db.prepare("UPDATE seat_assignments SET assigned_at = ? WHERE seat_id = ? AND principal_id = 'user:beta'").run(T2, MEMBER3.seat_id);
  // 承接：阶段七还没写这两列，这里直接放（接手时刻：分配之后 / 分配之前）
  const setSeat = db.prepare('UPDATE work_items SET seat = ?, seat_id = ?, seat_at = ? WHERE id = ?');
  const after = sqlTime(Date.now() + 2000), before = sqlTime(now - 86_400_000);
  setSeat.run(MEMBER.seat, MEMBER.seat_id, after, I.owned);
  setSeat.run(MEMBER.seat, MEMBER.seat_id, before, I.before);
  setSeat.run(LEGACY.seat, '', after, I.legacy);
  setSeat.run('', '', after, I.noSeat); // 句柄和 seat_id 都空：不能被「旧席位」那一段配上
  setSeat.run(MEMBER.seat, MEMBER.seat_id, after, I.xh); // 别的节点上 seat_id 相同
  setSeat.run(LEGACY.seat, '', after, I.sub); // 名字只多一个字的团队里句柄相同
  setSeat.run(MEMBER2.seat, MEMBER2.seat_id, sqlTime(T), I.zo);
  setSeat.run(MEMBER3.seat, MEMBER3.seat_id, sqlTime(T2), I.zq); // 接手正好在换主人那一刻 // 接手在 T 这一秒：前一段还没止（T < T+500），后一段还没起
  db.close();

  const list = (h, q = '') => call('GET', `/api/work-items${q}`, h);
  const ids = (r) => (r.body?.items ?? []).map((x) => x.id).sort();
  const sorted = (...a) => [...a].sort();
  const views = (r) => Object.fromEntries(Object.entries(r.body?.views ?? {}).map(([k, v]) => [k, v.available ? v.count : null]));

  // ---------- 建立人 ----------
  {
    const r = await list(WHO.建立人);
    check(r.status === 200 && r.body.view === 'mine' && show(views(r)) === show({ mine: 4, seats: null, team: null, all: null }) && show(ids(r)) === show(sorted(I.owned, I.before, I.legacy, I.noSeat)),
      '建立人：只有「我安排的」，4 件（别人建的不在）', show({ v: r.body?.view, views: views(r) }));
    const d = await call('GET', `/api/work-items/${I.owned}`, WHO.建立人), o = await call('GET', `/api/work-items/${I.other}`, WHO.建立人);
    check(d.status === 200 && o.status === 404, '建立人：自己的详情能看；别人建、别的团队的 404', show({ d: d.status, o: o.status }));
    const t = await list(WHO.建立人, '?view=team'), all = await list(WHO.建立人, '?view=all');
    check(t.status === 403 && t.body?.error === 'work_items_view_unavailable' && all.status === 403, '建立人要「我团队的」「全部」：403（这两个视角对他不可用）', show({ t: t.status, all: all.status }));
  }
  // ---------- 负责人 ----------
  {
    const dflt = await list(WHO.负责人), r = await list(WHO.负责人, '?view=team');
    check(dflt.body?.view === 'seats', '负责人：不带 view 落在第一个有内容的视角（「我的 AI 员工手上的」有 1 件，排在「我团队的」前面）', show(dflt.body?.view));
    check(r.status === 200 && r.body.view === 'team' && show(views(r)) === show({ mine: 0, seats: 1, team: 7, all: null }) && show(ids(r)) === show(sorted(I.owned, I.before, I.legacy, I.noSeat, I.zo, I.zq, I.rd)),
      '负责人：「我团队的」7 件（这个节点上交给团队 A 的全部）；别的团队、别的节点上同名团队的、名字只多一个字的团队的都不在', show({ v: r.body?.view, views: views(r), ids: ids(r) }));
    const d = await call('GET', `/api/work-items/${I.before}`, WHO.负责人), o = await call('GET', `/api/work-items/${I.other}`, WHO.负责人);
    check(d.status === 200 && o.status === 404, '负责人：本团队的事项详情能看（不是建立人也能）；别的团队的 404', show({ d: d.status, o: o.status }));
    const s = await list(WHO.负责人, `?view=team&seat=${MEMBER.seat_id}`);
    check(show(ids(s)) === show(sorted(I.owned, I.before)) && s.body.counts.held === 2, '按席位筛（seatId）：只剩这个成员的两件；按状态的件数跟着筛', show({ ids: ids(s), counts: s.body?.counts }));
    const sl = await list(WHO.负责人, `?view=team&seat=${encodeURIComponent(LEGACY.seat)}`);
    check(show(ids(sl)) === show([I.legacy]), '按席位筛（旧席位的句柄）：只剩这一件', show(ids(sl)));
  }
  // ---------- 成员的主人 ----------
  {
    const r = await list(WHO.成员的主人);
    check(r.status === 200 && r.body.view === 'seats' && show(views(r)) === show({ mine: 0, seats: 3, team: null, all: null }) && show(ids(r)) === show(sorted(I.owned, I.legacy, I.zo)),
      '成员的主人：「我的 AI 员工手上的」3 件——分配之后接手的（按 seatId）、旧席位按句柄认的、换主人那一秒里还归他的；分配之前接手的、没有承接的都不算', show({ v: r.body?.view, views: views(r), ids: ids(r) }));
    const d = await call('GET', `/api/work-items/${I.owned}`, WHO.成员的主人), b = await call('GET', `/api/work-items/${I.before}`, WHO.成员的主人), n = await call('GET', `/api/work-items/${I.noSeat}`, WHO.成员的主人);
    check(d.status === 200 && b.status === 404 && n.status === 404, '成员的主人：分配之后交到成员手上的能看；分配之前的（前一个主人的事）、没有承接的 404', show({ d: d.status, b: b.status, n: n.status }));
  }
  // ---------- 管理层、别人 ----------
  {
    const r = await list(ADMIN);
    check(r.status === 200 && r.body.view === 'all' && views(r).all === 10 && ids(r).length === 10, '管理层（管理口令）：「全部」10 件', show({ v: r.body?.view, views: views(r) }));
    const d = await call('GET', `/api/work-items/${I.other}`, ADMIN);
    check(d.status === 200, '管理层：任何一件的详情能看', show(d.status));
    const bad = await list(WHO.建立人, '?view=bogus'), seat = await list(WHO.建立人, '?seat=');
    check(bad.status === 400 && bad.body?.error === 'work_items_view_invalid' && seat.status === 400, '坏的 view、空的 seat：400', show({ bad: bad.status, seat: seat.status }));
    const anon = await list({ 'x-forwarded-for': '198.51.100.7' });
    check(anon.status === 401, '远程匿名：401', show(anon.status));
  }
  // ---------- 席位按完整的键 ----------
  {
    const r = await list(WHO.成员的主人, '?view=seats');
    const xh = await call('GET', `/api/work-items/${I.xh}`, WHO.成员的主人), sub = await call('GET', `/api/work-items/${I.sub}`, WHO.成员的主人);
    check(!ids(r).includes(I.xh) && xh.status === 404, '别的节点上 seat_id 相同的事项：不在成员的主人的列表里，详情 404', show({ ids: ids(r), xh: xh.status }));
    check(!ids(r).includes(I.sub) && sub.status === 404, '名字只多一个字的团队里句柄相同的旧席位事项：不在列表里，详情 404（团队相等，不做子串）', show({ ids: ids(r), sub: sub.status }));
  }
  // ---------- 换主人那一秒 ----------
  {
    const nf = await list(WHO.成员的主人, '?view=seats'), lead = await list(WHO.负责人, '?view=seats');
    const d = await call('GET', `/api/work-items/${I.zo}`, WHO.成员的主人);
    check(ids(nf).includes(I.zo) && d.status === 200 && !ids(lead).includes(I.zo),
      '接手在前一段止之前、后一段起之前（同一秒）：归前一个主人——他的列表里有、详情 200；后一个主人的「我的 AI 员工手上的」里没有', show({ nf: ids(nf), d: d.status, lead: ids(lead) }));
    const q = await call('GET', `/api/work-items/${I.zq}`, WHO.成员的主人);
    check(!ids(nf).includes(I.zq) && q.status === 404 && show(ids(lead)) === show([I.zq]) && lead.body?.views?.seats?.count === 1,
      '接手正好在换主人那一刻（左闭右开）：归后一个主人——他的列表里有、件数 1；前一个主人列表里没有、详情 404', show({ nf: ids(nf), q: q.status, lead: ids(lead), n: lead.body?.views }));
  }
  // ---------- 「关注」的验收条目 ----------
  {
    const accept = async (h) => ((await call('GET', '/api/attention', h)).body?.items ?? []).filter((x) => x.source === 'work-items' && x.category === 'accept');
    const lead = await accept(WHO.负责人), nf = await accept(WHO.成员的主人), creator = await accept(WHO.建立人);
    const g = lead.find((x) => x.source_id === I.rd);
    check(g && g.mine === false && !nf.some((x) => x.source_id === I.rd) && !creator.some((x) => x.source_id === I.rd),
      '「关注」的验收：负责人看得到本团队的（mine:false，代办那一栏）；看不到这件事项的人没有这一条', show({ lead: lead.map((x) => [x.source_id, x.mine]), nf: nf.map((x) => x.source_id) }));
  }
  // ---------- 不变量：列表里的每一条，详情都是 200 ----------
  {
    const bad = [];
    for (const [who, h] of [...Object.entries(WHO), ['管理口令', ADMIN]]) {
      const first = await list(h);
      for (const [v, x] of Object.entries(first.body?.views ?? {})) {
        if (!x.available) continue;
        for (const id of ids(await list(h, `?view=${v}`))) { const d = await call('GET', `/api/work-items/${id}`, h); if (d.status !== 200) bad.push([who, v, id, d.status]); }
      }
    }
    check(bad.length === 0, '每个人、每个可用的视角：列表里的每一条，详情都是 200', show(bad));
  }
  // ---------- 名册里同一个节点号下别的节点（撞号）：按节点号认团队只经 a2a_rosters_live ----------
  {
    // 另一个根地址报了同一个节点号 HOST（指纹前 8 位撞了）；对端登记成停用，视图里不算它。rd 这件改投到它那里
    const w = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
    const SQ = 'http://squat.synthetic.invalid', t0 = new Date(now).toISOString();
    w.prepare("INSERT INTO a2a_roster_nodes (peer_root, key_fingerprint, host, peer_zone, reported_at, received_at) VALUES (?, ?, ?, 'zone1', ?, ?)").run(SQ, 'sha256:' + 'f'.repeat(64), HOST, t0, t0);
    w.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, registered_by, registered_at, updated_at) VALUES ('peer-squat', ?, 'zone1', '撞号的', 'disabled', 'test', ?, ?)").run(SQ, t0, t0);
    w.prepare('UPDATE workbench_event_deliveries SET target_url = ? WHERE event_id = ?').run(SQ, I.rd.slice(3));
    const teamIds = async () => ids(await list(WHO.负责人, '?view=team'));
    const a = await teamIds(), ra = await call('GET', `/api/work-items/${I.rd}`, WHO.负责人);
    check(!a.includes(I.rd) && ra.status === 404 && a.includes(I.before),
      '撞号：投到另一个根地址（同一节点号、对端停用、视图里不算）的事项，不算进这个节点号下团队 A 的——负责人列表里没有、详情 404；本节点的照常', show({ has: a.includes(I.rd), st: ra.status }));
    // 撞号的那台恢复成可用：同一节点号下两个都算，两个都不认——本节点团队 A 的也认不出来了
    w.prepare("UPDATE a2a_peers SET status = 'active' WHERE root_url = ?").run(SQ);
    const b = await teamIds(), bb = await call('GET', `/api/work-items/${I.before}`, WHO.负责人);
    check(!b.includes(I.before) && !b.includes(I.rd) && bb.status === 404, '撞号的两台都可用：两个都不认，负责人「我团队的」里本节点的也没了（不是先报的那台赢）', show({ ids: b, st: bb.status }));
    // 管理员停用撞号的那台：本节点的恢复，投到撞号那台的仍然不算
    w.prepare("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = ?").run(SQ);
    const c = await teamIds();
    check(c.includes(I.before) && !c.includes(I.rd), '……停用撞号的那台之后，本节点团队 A 的恢复；投到撞号那台的仍不算', show({ ids: c }));
    w.close();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
