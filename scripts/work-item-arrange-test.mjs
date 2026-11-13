#!/usr/bin/env node
/**
 * 「安排一件事」：POST /api/work-items 和 GET /api/work-items/teams（放宽访问的对抗组）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   可派团队：只列绑在任务中心上的通知绑定（别的台的、撤销了的不列）；建事项时用同一个函数核，列表外的 400
 *   建出来：事项的建立人是本人（请求体自报的建立人、提需求人一概不认），标题取任务标题，派给是选中的团队，object、phase 带上；
 *          投递只有选中的那一个团队；别人看不到
 *   先过目：缺省 held（开关都开、不带 review 也是）；review:false 而中心总开关没开、或员工直派开关没开，照样 held 带原因；两个都开才直接派出
 *   「关注」：安排出来的那件只算一次（事项的等你过目），统一待办里不再有它；旧录入路径的任务和 /api/tasks 本身不变
 *   幂等：同一个人同一个键再发回同一件（duplicate）；键相同、请求体不同 409；别人用同一个键是另一件
 *   限流：按设置（管理员可调）每人每分钟几件，超了 429；重放不算新的一件、也不被限流挡
 *   拒绝：没登录、提供方不认的会话、只带管理口令 401；主体停用 403；跨站 403；坏参数 400
 *   启动自检：远程匿名打这个入口必须 401
 *
 *   node scripts/work-item-arrange-test.mjs              测本仓库
 *   node scripts/work-item-arrange-test.mjs --root DIR   测另一棵目录树
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
const OUT = join(HERE, '..', 'tmp', `work-item-arrange-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'arrange-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
let keyN = 0;
const key = () => `arrange-key-${String(++keyN).padStart(8, '0')}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  // 绑定：任务中心上两个通知团队、一条撤销了的；别的台上一个
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    const b = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by, revoked_at) VALUES ('sop', ?, ?, 'notify', 'read', 'http://127.0.0.1:1', 'seed', ?)");
    b.run('task-center', 'dsh/canvas/team-a', ''); b.run('task-center', 'dsh/canvas/team-b', ''); b.run('task-center', 'dsh/canvas/team-old', '2026-01-01 00:00:00'); b.run('sop-x', 'dsh/canvas/team-x', '');
    console.log('SEEDED');`], { env, encoding: 'utf8' });
  if (!seed.stdout.includes('SEEDED')) throw new Error(`造数据失败：${seed.stderr.slice(-600)}`);
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
  const ALPHA = { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, BETA = { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  await call('GET', '/api/work-items/teams', ALPHA); await call('GET', '/api/work-items/teams', BETA); // 先登录一次，主体建出来
  const defaults = await call('POST', '/api/work-items', BETA, { title: 't', intent: 'i', deliverable: 'd', team: 'dsh/canvas/team-a', idempotency_key: 'default-limit-probe-0' });
  check(defaults.status === 201, '缺省限流下能建（每分钟 5 件）', show(defaults));
  await call('PUT', '/api/settings', ADMIN, { arrange_rate_per_minute: '100' }); // 下面几节一个人要建好多件；限流单独一节测
  const dbr = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const dbw = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 }); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
  const deliveries = (eventId) => { const d = dbr(); try { return d.prepare('SELECT target_team, status FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id').all(eventId).map((r) => ({ ...r })); } finally { d.close(); } };
  const past0 = () => { const d = dbr(); try { return d.prepare("SELECT id FROM work_items WHERE id LIKE 'wi_wbe-%' ORDER BY rowid LIMIT 1").get()?.id; } finally { d.close(); } };
  const past0Event = () => { const d = dbr(); try { return d.prepare("SELECT event_id FROM workbench_events ORDER BY rowid LIMIT 1").get()?.event_id; } finally { d.close(); } };
  const form = (extra = {}) => ({ title: '对一下上周的出货', intent: '把上周的出货单和对账单对一遍，列出对不上的', deliverable: '一张差异表', team: 'dsh/canvas/team-a', idempotency_key: key(), ...extra });

  // ---------- 可派的团队 ----------
  {
    const asAdmin = await call('GET', '/api/work-items/teams', ADMIN);
    check(asAdmin.status === 200 && asAdmin.body?.teams?.length === 2, '可派团队：管理员也能读', show(asAdmin));
    const t = await call('GET', '/api/work-items/teams', ALPHA);
    check(t.status === 200 && show(t.body?.teams?.map((x) => x.team)) === show(['dsh/canvas/team-a', 'dsh/canvas/team-b']), '可派团队：只列绑在任务中心上的通知绑定（别的台的、撤销了的不列）', show(t.body));
    const anon = await call('GET', '/api/work-items/teams', { 'x-forwarded-for': '198.51.100.7' });
    const cross = await call('GET', '/api/work-items/teams', { ...ALPHA, 'sec-fetch-site': 'cross-site' });
    check(anon.status === 401 && cross.status === 403, '可派团队：没登录 401，跨站 403', show({ anon: anon.status, cross: cross.status }));
  }

  // ---------- 建一件（缺省先过目） ----------
  let first;
  {
    const body = form({ object: 'po:7', phase: '对账', created_by: 'user:beta', requester: 'user:beta', creator_principal: 'user:beta', published_by: 'root-admin' });
    first = await call('POST', '/api/work-items', ALPHA, body);
    const b = first.body ?? {};
    check(first.status === 201 && /^wi_wbe-[0-9a-f]{16}$/.test(b.item_id) && b.held === true && b.state === 'held' && b.duplicate === false, '建一件：201，缺省先过目（held）', show(first));
    const detail = await call('GET', `/api/work-items/${b.item_id}`, ALPHA);
    const it = detail.body?.item ?? {};
    check(detail.status === 200 && it.creator_principal === 'user:alpha' && it.created_by === 'user:alpha', '建立人是本人：请求体自报的建立人、提需求人、发布人一概不认', show({ status: detail.status, cp: it.creator_principal, by: it.created_by }));
    check(it.title === '对一下上周的出货' && it.target_team === 'dsh/canvas/team-a' && it.object === 'po:7' && it.phase === '对账', '标题取任务标题，派给是选中的团队，object、phase 带上', show({ t: it.title, team: it.target_team, o: it.object, p: it.phase }));
    check(show(deliveries(b.event_id)) === show([{ target_team: 'dsh/canvas/team-a', status: 'held' }]), '投递只有选中的那一个团队，等放行（held）', show(deliveries(b.event_id)));
    const other = await call('GET', `/api/work-items/${b.item_id}`, BETA);
    check(other.status === 404, '别人看不到这一件（404）', show(other.status));
  }

  // ---------- 「关注」里同一件不算两次 ----------
  {
    // 旧的录入发布路径建出来的任务（kind 是「录入」）：照旧在统一待办里
    const old = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))}, { timeout: 5000 });
      console.log('OLD ' + d.prepare("INSERT INTO tasks (title, kind, status, published_at, published_by) VALUES ('旧路径的任务', '录入', 'published', '2026-01-01 00:00:00', 'x')").run().lastInsertRowid);`], { encoding: 'utf8' });
    const oldId = /OLD (\d+)/.exec(old.stdout)?.[1];
    const att = (await call('GET', '/api/attention', ADMIN)).body?.items ?? [];
    const taskItems = att.filter((x) => x.source === 'tasks' && x.source_id.startsWith('market:task-'));
    const glance = att.filter((x) => x.source === 'work-items' && x.source_id === first.body?.item_id);
    check(glance.length === 1 && !taskItems.some((x) => x.source_id === `market:task-${first.body?.task_id}`) && taskItems.some((x) => x.source_id === `market:task-${oldId}`),
      '「关注」里安排出来的那件只出现一次（事项的等你过目）；统一待办里不再有它，旧录入路径的任务照旧在', show({ oldId, glance: glance.length, tasks: taskItems.map((x) => x.source_id) }));
    const inbox = (await call('GET', '/api/tasks', ADMIN)).body?.tasks ?? [];
    check(inbox.some((x) => x.id === `market:task-${first.body?.task_id}`), '统一待办接口本身（/api/tasks）不变：安排出来的任务照旧列着', show(inbox.map((x) => x.id)));
  }

  // ---------- 幂等 ----------
  {
    const body = form();
    const a = await call('POST', '/api/work-items', ALPHA, body), again = await call('POST', '/api/work-items', ALPHA, body);
    check(a.status === 201 && again.status === 200 && again.body?.duplicate === true && again.body.item_id === a.body?.item_id && again.body.task_id === a.body.task_id, '同一个人同一个键再发：回同一件（duplicate）', show({ a: a.body, again: again.body }));
    const changed = await call('POST', '/api/work-items', ALPHA, { ...body, title: '换了个标题' });
    check(changed.status === 409 && changed.body?.error === 'idempotency_conflict', '键相同、请求体不同：409', show(changed));
    const theirs = await call('POST', '/api/work-items', BETA, body);
    check(theirs.status === 201 && theirs.body?.item_id !== a.body?.item_id, '别人用同一个键：是另一件（键按人分）', show(theirs.body));
  }

  // ---------- 派给 ----------
  {
    const x = await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/canvas/team-x' }));
    const old = await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/canvas/team-old' }));
    const none = await call('POST', '/api/work-items', ALPHA, form({ team: '' }));
    check(x.status === 400 && x.body?.error === 'team_not_assignable' && old.status === 400 && old.body?.error === 'team_not_assignable' && none.status === 400, '派给别的台的团队、撤销了的、空的：400', show([x.body, old.body, none.body]));
  }

  // ---------- 坏参数 ----------
  {
    const cases = [form({ title: '' }), form({ title: 'x'.repeat(201) }), form({ intent: 3 }), form({ deliverable: '  ' }), form({ object: 'o'.repeat(201) }), form({ due: '2026/11/11' }), form({ review: 'false' }), form({ idempotency_key: 'short' }), form({ idempotency_key: undefined })];
    const rs = await Promise.all(cases.map((c) => call('POST', '/api/work-items', ALPHA, c)));
    check(rs.every((r) => r.status === 400), '坏参数（标题空或过长、intent 不是字符串、交付要求只有空白、object 过长、日期格式、review 不是布尔、幂等键过短或没有）：400', show(rs.map((r) => [r.status, r.body?.error])));
    const arr = await call('POST', '/api/work-items', ALPHA, [form()]);
    check(arr.status === 400, '请求体是数组：400', show(arr));
  }

  // ---------- 先过目和员工直派 ----------
  {
    const policyOff = await call('POST', '/api/work-items', ALPHA, form({ review: false }));
    check(policyOff.status === 201 && policyOff.body?.held === true && policyOff.body.reason === 'review_required_by_policy', 'review:false 而中心总开关没开：照样 held，带原因', show(policyOff.body));
    const center = await call('PUT', '/api/task-center/policy', ADMIN, { agent_dispatch_enabled: true });
    const staffOff = await call('POST', '/api/work-items', ALPHA, form({ review: false }));
    check(center.status === 200 && staffOff.body?.held === true && staffOff.body.reason === 'review_required_by_policy', '中心总开关开了、员工直派开关没开：照样 held', show({ center: center.status, b: staffOff.body }));
    const sw = await call('PUT', '/api/settings', ADMIN, { staff_direct_dispatch: 'on' });
    const direct = await call('POST', '/api/work-items', ALPHA, form({ review: false, team: 'dsh/canvas/team-b' }));
    const reviewed = await call('POST', '/api/work-items', ALPHA, form({ review: true }));
    const ds = deliveries(direct.body?.event_id);
    check(sw.status === 200 && direct.status === 201 && direct.body?.held === false && !('reason' in direct.body) && ds.length === 1 && ds[0].target_team === 'dsh/canvas/team-b' && ds[0].status !== 'held',
      '两个开关都开、review:false：直接派出（投递不是 held）', show({ sw: sw.status, b: direct.body, ds }));
    check(reviewed.body?.held === true && !('reason' in reviewed.body), '开关都开但 review:true（要先过目）：照样 held', show(reviewed.body));
    const noReview = await call('POST', '/api/work-items', ALPHA, form());
    check(noReview.status === 201 && noReview.body?.held === true && !('reason' in noReview.body), '开关都开、请求不带 review：缺省先过目，照样 held', show(noReview.body));
    await call('PUT', '/api/task-center/policy', ADMIN, { agent_dispatch_enabled: false });
    const centerOff = await call('POST', '/api/work-items', ALPHA, form({ review: false }));
    check(centerOff.status === 201 && centerOff.body?.held === true && centerOff.body.reason === 'review_required_by_policy', '中心总开关关、员工直派开着、review:false：照样 held，带原因', show(centerOff.body));
    const staffSet = await call('PUT', '/api/settings', ALPHA, { staff_direct_dispatch: 'on' });
    check(staffSet.status === 403 || staffSet.status === 401, '员工自己改不了员工直派开关（设置只给管理员写）', show(staffSet.status));
    await call('PUT', '/api/settings', ADMIN, { staff_direct_dispatch: 'off' });
  }

  // ---------- 限流（管理员可调） ----------
  {
    await call('PUT', '/api/settings', ADMIN, { arrange_rate_per_minute: '3' });
    const gammaBody = [form(), form(), form()];
    const r1 = await call('POST', '/api/work-items', BETA, gammaBody[0]), r2 = await call('POST', '/api/work-items', BETA, gammaBody[1]);
    // beta 这一分钟里已经建过两件（开头一件、幂等那一节一件），上限调成 3：再建一件到顶，下一件就超
    const r3 = await call('POST', '/api/work-items', BETA, gammaBody[2]);
    const replay = await call('POST', '/api/work-items', BETA, gammaBody[0]);
    check(r1.status === 201 && r2.status === 429 && r2.body?.error === 'rate_limited' && r2.body.window === 'minute' && r2.body.limit === 3 && r3.status === 429,
      '限流：每分钟上限调成 3，超了 429（带窗口和上限）', show([r1.status, r2.body, r3.status]));
    check(replay.status === 200 && replay.body?.duplicate === true, '重放已经建过的那件：照样回第一次的结果，不被限流挡', show(replay));
    await call('PUT', '/api/settings', ADMIN, { arrange_rate_per_minute: '100' });
  }

  // ---------- 指名（规范 14 第 3 步）：带 seat_id 才指名；谁能指名谁、对端不支持就退回整队派发 ----------
  {
    // 合成数据：任务中心上再绑三条（对端不支持指名的、绑的是总工句柄的旧写法、名册还没来的）；名册、对端名片、分配、负责人
    const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))});
      const now = '2026-11-12 00:00:00', ms = Date.now() - 60000;
      const b = d.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by, revoked_at) VALUES ('sop', 'task-center', ?, 'notify', 'read', ?, 'seed', '')");
      b.run('dsh/canvas/team-c', 'http://127.0.0.1:2'); b.run('dsh/1a2b3c4d', 'http://127.0.0.1:1'); b.run('dsh/canvas/team-d', 'http://127.0.0.1:3');
      const r = d.prepare('INSERT INTO a2a_roster_nodes (host, peer_root, peer_zone, reported_at, received_at, key_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, char(115, 104, 97, 50, 53, 54, 58) || substr(?1 || hex(zeroblob(32)), 1, 64))');
      r.run('a1b2c3d4', 'http://127.0.0.1:1', 'dsh', now, now); r.run('c3c3c3c3', 'http://127.0.0.1:2', 'dsh', now, now);
      const st = d.prepare('INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ((SELECT peer_root FROM a2a_roster_nodes WHERE host = ?1 ORDER BY rowid LIMIT 1), (SELECT key_fingerprint FROM a2a_roster_nodes WHERE host = ?1 ORDER BY rowid LIMIT 1), ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)');
      st.run('a1b2c3d4', 'dsh/canvas/team-a', 'dsh/00000001', 'seat-00000001', '合成总工', 'router', now, now);
      st.run('a1b2c3d4', 'dsh/canvas/team-a', 'dsh/0000000a', 'seat-0000000a', '合成成员甲', 'member', now, now);
      st.run('a1b2c3d4', 'dsh/canvas/team-a', 'dsh/0000000b', 'seat-0000000b', '合成成员乙', 'member', now, now);
      st.run('a1b2c3d4', 'dsh/canvas/team-a', 'dsh/0000000c', 'seat-0000000c', '合成观察者', 'observer', now, now);
      st.run('c3c3c3c3', 'dsh/canvas/team-c', 'dsh/0000000e', 'seat-0000000e', '合成成员丙', 'member', now, now);
      const p = d.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, registered_by, registered_at, updated_at, card_capabilities, key_fingerprint) VALUES (?1, ?2, 'dsh', ?3, 'active', 'seed', ?4, ?5, ?6, CASE WHEN ?7 IS NULL THEN '' ELSE COALESCE((SELECT key_fingerprint FROM a2a_roster_nodes WHERE peer_root = ?2 ORDER BY rowid LIMIT 1), '') END) ON CONFLICT(root_url) DO UPDATE SET status = 'active', zone = excluded.zone, name = excluded.name, card_capabilities = excluded.card_capabilities, key_fingerprint = excluded.key_fingerprint");
      p.run('peer-syn-a', 'http://127.0.0.1:1', '合成节点甲', now, now, JSON.stringify({ directedSeats: true, reworkReturns: true }), 'peer-syn-a');
      p.run('peer-syn-c', 'http://127.0.0.1:2', '合成节点丙', now, now, JSON.stringify({}), 'peer-syn-c');
      const a = d.prepare("INSERT INTO seat_assignments (host, team, seat, seat_id, principal_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, 'seed', ?)");
      a.run('a1b2c3d4', 'dsh/canvas/team-a', 'dsh/0000000a', 'seat-0000000a', 'user:alpha', ms);
      a.run('c3c3c3c3', 'dsh/canvas/team-c', 'dsh/0000000e', 'seat-0000000e', 'user:alpha', ms);
      d.prepare("INSERT INTO team_leads (host, team, principal_id, added_by, added_at) VALUES ('a1b2c3d4', 'dsh/canvas/team-a', 'user:beta', 'seed', ?)").run(ms);
      d.prepare("INSERT INTO team_leads (host, team, principal_id, added_by, added_at) VALUES ('c3c3c3c3', 'dsh/canvas/team-c', 'user:beta', 'seed', ?)").run(ms);
      for (const t of ['teams', 'team_leads', 'seat_assignments']) d.prepare(\`UPDATE \${t} SET peer_root = COALESCE((SELECT r.peer_root FROM a2a_roster_nodes r WHERE r.host = \${t}.host), ''), key_fingerprint = COALESCE((SELECT p.key_fingerprint FROM a2a_roster_nodes r JOIN a2a_peers p ON p.root_url = r.peer_root WHERE r.host = \${t}.host), '') WHERE peer_root = ''\`).run(); // 种子行按当前名册记下节点
      console.log('SEEDED');`], { encoding: 'utf8' });
    if (!seeded.stdout.includes('SEEDED')) throw new Error(`造指名数据失败：${seeded.stderr.slice(-600)}`);
    const msg = (eventId) => { const d = dbr(); try { return d.prepare('SELECT message FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id').all(eventId).map((r) => r.message); } finally { d.close(); } };
    const recorded = (eventId) => { const d = dbr(); try { return JSON.parse(d.prepare("SELECT detail FROM workbench_event_log WHERE event_id = ? AND action = 'recorded'").get(eventId).detail); } finally { d.close(); } };
    const itemRow = (itemId) => { const d = dbr(); try { return { ...d.prepare('SELECT handoff, review_by, directed_seat_id FROM work_items WHERE id = ?').get(itemId) }; } finally { d.close(); } };

    // 成员的主人指名分给自己的席位：own-seat，缺省不过目；派工正文第一行是指名，后面是原来的信封
    const own = await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000a' }));
    const ownMsg = msg(own.body?.event_id)[0] ?? '';
    const [line1, ...rest] = ownMsg.split('\n');
    let env1 = null; try { env1 = JSON.parse(rest.join('\n')); } catch { /* 不是 JSON */ }
    check(own.status === 201 && own.body.handoff === 'own-seat' && own.body.directed === 'seat' && line1 === '[A2A dispatch] {"for":"seat-0000000a"}' && env1?.type === 'workbench-event' && rest.length === 1,
      '主人指名自己的席位：201、own-seat；投递正文第一行是 [A2A dispatch] {"for":"seat-0000000a"}，第二行是原来的信封，没有第三行', show({ b: own.body, line1, rest: rest.length }));
    const ownItem = itemRow(own.body?.item_id);
    check(ownItem.handoff === 'own-seat' && ownItem.review_by === '' && ownItem.directed_seat_id === 'seat-0000000a' && recorded(own.body?.event_id).directed_seat_id === 'seat-0000000a',
      '……事项上记交给方式 own-seat、不过目、指名的 seatId（走事件层 recorded 那一行）', show(ownItem));
    const ownReview = await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000a', review: true }));
    check(ownReview.status === 201 && itemRow(ownReview.body?.item_id).review_by === 'requester' && ownReview.body.held === true, '……勾了先过目：由本人过目（review_by=requester），先 held', show(ownReview.body));
    // 团队负责人指名本团队任何成员：lead-directed，不过目
    const lead = await call('POST', '/api/work-items', BETA, form({ seat_id: 'seat-0000000b' }));
    check(lead.status === 201 && lead.body.handoff === 'lead-directed' && itemRow(lead.body?.item_id).review_by === '' && msg(lead.body?.event_id)[0].startsWith('[A2A dispatch] {"for":"seat-0000000b"}\n'),
      '负责人指名团队里别的成员：201、lead-directed、不过目，派工行写那个 seatId', show(lead.body));
    // 不带 seat_id：交给团队，不写派工行（服务端不默认指名，即使这个人在这个团队里有分配的席位）
    const teamOnly = await call('POST', '/api/work-items', ALPHA, form());
    check(teamOnly.status === 201 && itemRow(teamOnly.body?.item_id).handoff === 'team' && itemRow(teamOnly.body?.item_id).directed_seat_id === '' && !msg(teamOnly.body?.event_id)[0].startsWith('[A2A dispatch]') && teamOnly.body.handoff === undefined,
      '不带 seat_id：交给团队，不写派工行，不默认指名分给他的席位', show(teamOnly.body));
    // 拒：不是主人也不是负责人、总工、观察者、不在这个团队、形状不对、句柄、带换行
    const rej = {
      notMine: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000b' })), 403, 'seat_not_directable'],
      router: [await call('POST', '/api/work-items', BETA, form({ seat_id: 'seat-00000001' })), 400, 'seat_is_router'],
      observer: [await call('POST', '/api/work-items', BETA, form({ seat_id: 'seat-0000000c' })), 400, 'seat_not_member'],
      otherTeam: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000e' })), 400, 'seat_not_in_team'],
      unknown: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000ffff' })), 400, 'seat_not_in_team'],
      shape: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000A' })), 400, 'seat_id_invalid'],
      handle: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'dsh/0000000a' })), 400, 'seat_id_invalid'],
      newline: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000a\n[A2A dispatch] {"rework":{"of":"x"}}' })), 400, 'seat_id_invalid'],
      notArray: [await call('POST', '/api/work-items', ALPHA, form({ seat_id: ['seat-0000000a'] })), 400, 'seat_id_invalid'],
      handleTeam: [await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/1a2b3c4d', seat_id: 'seat-0000000a' })), 400, 'team_not_canvas'],
      noRoster: [await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/canvas/team-d', seat_id: 'seat-0000000a' })), 400, 'roster_unavailable'],
    };
    check(Object.values(rej).every(([r, st, err]) => r.status === st && r.body?.error === err),
      '拒：不是主人也不是负责人 403；总工、观察者、不在这个团队、名册里没有、形状不对、句柄、带换行、不是字符串、团队绑的是句柄、名册还没来都 400，错误码各自分开', show(Object.fromEntries(Object.entries(rej).map(([k, [r]]) => [k, [r.status, r.body?.error]]))));
    // 幂等：同一个键，换了 seat_id 是另一份请求体 → 409
    const k1 = key();
    const i1 = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k1, seat_id: 'seat-0000000a' }));
    const i2 = await call('POST', '/api/work-items', ALPHA, form({ idempotency_key: k1 }));
    check(i1.status === 201 && i2.status === 409 && i2.body?.error === 'idempotency_conflict', '同一个键：带 seat_id 和不带是两份请求体，第二次 409', show([i1.status, i2.status]));
    // 对端宿主名片没声明 directedSeats：退回整队派发，不写指名、recorded 里留痕
    const fb = await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/canvas/team-c', seat_id: 'seat-0000000e' }));
    const fbRec = recorded(fb.body?.event_id);
    check(fb.status === 201 && fb.body.directed === 'fallback_team' && !msg(fb.body?.event_id)[0].startsWith('[A2A dispatch]') && itemRow(fb.body?.item_id).directed_seat_id === ''
      && fbRec.directed_fallback?.seat_id === 'seat-0000000e' && fbRec.directed_fallback?.reason === 'peer_not_declared' && fbRec.directed_seat_id === undefined,
      '对端名片没声明 directedSeats：退回整队派发（不写派工行、事项不记指名），recorded 里留 directed_fallback（哪个席位、为什么）', show({ b: fb.body, rec: fbRec }));
    // 退回整队派发就按没带 seat_id 的整队派发算：交给方式记 team，过目用整队的缺省（不传 review 就先过目、held），
    // 应答不说成指名。主人指名、负责人指名退回时都一样。开着中心总开关和员工直派：指名自己的席位缺省不过目会直接派出，
    // 退回整队后必须照整队的缺省先 held
    await call('PUT', '/api/task-center/policy', ADMIN, { agent_dispatch_enabled: true });
    await call('PUT', '/api/settings', ADMIN, { staff_direct_dispatch: 'on' });
    try {
      const fbItem = itemRow(fb.body?.item_id);
      const fbOwn = await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/canvas/team-c', seat_id: 'seat-0000000e' }));
      const fbOwnItem = itemRow(fbOwn.body?.item_id);
      check(fbItem.handoff === 'team' && fbOwn.status === 201 && fbOwn.body.directed === 'fallback_team' && fbOwnItem.handoff === 'team' && fbOwn.body.held === true
        && fbOwn.body.handoff !== 'own-seat' && recorded(fbOwn.body?.event_id).handoff === 'team',
        '主人指名退回整队：事项 handoff=team；直派开着时不传 review 也先过目（held），和整队的缺省一样；应答不带 own-seat', show({ b: fbOwn.body, item: fbOwnItem, first: fbItem }));
      const fbLead = await call('POST', '/api/work-items', BETA, form({ team: 'dsh/canvas/team-c', seat_id: 'seat-0000000e' }));
      const fbLeadItem = itemRow(fbLead.body?.item_id);
      check(fbLead.status === 201 && fbLead.body.directed === 'fallback_team' && fbLeadItem.handoff === 'team' && fbLead.body.held === true && fbLead.body.handoff !== 'lead-directed'
        && recorded(fbLead.body?.event_id).directed_fallback?.seat_id === 'seat-0000000e',
        '负责人指名退回整队：同样 handoff=team、先过目（held）、应答不带 lead-directed，recorded 照留 directed_fallback', show({ b: fbLead.body, item: fbLeadItem }));
      // 对照：同样开着直派，退回整队时本人明说 review:false 照样直接派出（和整队派发一样，不比整队更严）
      const fbDirect = await call('POST', '/api/work-items', ALPHA, form({ team: 'dsh/canvas/team-c', seat_id: 'seat-0000000e', review: false }));
      check(fbDirect.status === 201 && fbDirect.body.held === false && itemRow(fbDirect.body?.item_id).handoff === 'team',
        '对照：退回整队、本人 review:false、直派开着 → 直接派出，handoff=team', show(fbDirect.body));
      // 撞号：另一个根地址也报了节点号 a1b2c3d4（对端停用，视图里不算），它的名册里 team-a 有一个本节点没有的成员席位。
      // 指名按节点号找席位只经 a2a_rosters_live：这个席位找不到，不指名、不派
      { const w = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
        try {
          const t1 = new Date().toISOString(), SQ = 'http://squat.synthetic.invalid', FP = 'sha256:' + 'e'.repeat(64);
          w.prepare("INSERT INTO a2a_roster_nodes (peer_root, key_fingerprint, host, peer_zone, reported_at, received_at) VALUES (?, ?, 'a1b2c3d4', 'dsh', ?, ?)").run(SQ, FP, t1, t1);
          w.prepare("INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, first_seen_at) VALUES (?, ?, 'a1b2c3d4', 'dsh/canvas/team-a', 'dsh/0000005a', 'seat-0000005a', '撞号节点上的成员', 'member', ?)").run(SQ, FP, t1);
          w.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, registered_by, registered_at, updated_at) VALUES ('peer-squat', ?, 'dsh', '撞号的', 'disabled', 'seed', ?, ?)").run(SQ, t1, t1);
        } finally { w.close(); } }
      const sqCount = () => { const d = dbr(); try { return Number(d.prepare("SELECT COUNT(*) AS c FROM work_items WHERE directed_seat_id = 'seat-0000005a'").get().c) + Number(d.prepare("SELECT COUNT(*) AS c FROM workbench_event_deliveries WHERE message LIKE '%seat-0000005a%'").get().c); } finally { d.close(); } };
      const sq = await call('POST', '/api/work-items', BETA, form({ seat_id: 'seat-0000005a' }));
      check(sq.status === 400 && sq.body?.error === 'seat_not_in_team' && sqCount() === 0,
        '撞号：同一节点号下另一个根地址（对端停用）名册里的席位，负责人指名它 → 400 seat_not_in_team，不指名、不派', show({ st: sq.status, body: sq.body, n: sqCount() }));
    } finally {
      await call('PUT', '/api/settings', ADMIN, { staff_direct_dispatch: 'off' });
      await call('PUT', '/api/task-center/policy', ADMIN, { agent_dispatch_enabled: false });
      // 指名这一段让 beta 当了团队负责人；后面截止、附件那几段拿 beta 当「看不到这件事项的别人」，这里还原
      const unlead = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
        const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))}, { timeout: 5000 });
        d.prepare("DELETE FROM team_leads WHERE principal_id = 'user:beta' AND added_by = 'seed'").run(); console.log('UNLEAD');`], { encoding: 'utf8' });
      if (!unlead.stdout.includes('UNLEAD')) throw new Error(`还原负责人失败：${unlead.stderr.slice(-600)}`);
    }
  }

  // ---------- 截止日期 ----------
  {
    const past = await call('POST', '/api/work-items', ALPHA, form({ due: '2026-01-01' }));
    const future = await call('POST', '/api/work-items', ALPHA, form({ due: '2099-12-31' }));
    const none = await call('POST', '/api/work-items', ALPHA, form());
    const dp = await call('GET', `/api/work-items/${past.body?.item_id}`, ALPHA), df = await call('GET', `/api/work-items/${future.body?.item_id}`, ALPHA), dn = await call('GET', `/api/work-items/${none.body?.item_id}`, ALPHA);
    check(dp.body?.due === '2026-01-01' && dp.body?.item?.due_at === '2026-01-01T00:00:00.000Z' && dp.body.overdue === true && df.body?.due === '2099-12-31' && df.body.overdue === false && dn.body?.due === null && dn.body.overdue === false,
      '截止日期：详情给 due（YYYY-MM-DD，没填是 null），事项上存那天的 UTC 零点；过了期还没完成 overdue 为真，没过期、没填的为假', show({ p: [dp.body?.due, dp.body?.overdue], f: [df.body?.due, df.body?.overdue], n: [dn.body?.due, dn.body?.overdue] }));
    const list = (await call('GET', '/api/work-items?view=mine', ALPHA)).body?.items ?? [];
    const lp = list.find((x) => x.id === past.body?.item_id);
    check(lp?.due === '2026-01-01' && lp.overdue === true, '事项列表也带 due 和 overdue', show(lp));
    const d = dbr(); let pm = ''; try { pm = d.prepare('SELECT message FROM workbench_event_deliveries WHERE event_id = ?').get(past.body?.event_id)?.message ?? ''; } finally { d.close(); }
    check(JSON.parse(pm).task?.due === '2026-01-01', '派给节点的正文里带截止日期（task.due）', pm.slice(0, 160));
    // 详情的 can.due 和改截止接口同一处（dueWriterOk）：建立人真、管理口令假（接口 401）、别人看不到详情
    const canAlpha = (await call('GET', `/api/work-items/${past.body?.item_id}`, ALPHA)).body?.can?.due;
    const canAdmin = (await call('GET', `/api/work-items/${past.body?.item_id}`, ADMIN)).body?.can?.due;
    const betaSees = (await call('GET', `/api/work-items/${past.body?.item_id}`, BETA)).status;
    check(canAlpha === true && canAdmin === false && betaSees === 404, '详情 can.due：建立人真；管理口令假（改不了）；别人读不到这件', show({ canAlpha, canAdmin, betaSees }));
    // 建立人改：改成新的、清掉；别人（看不到这件）404；只带管理口令 401；坏格式 400
    const ch = await call('POST', `/api/work-items/${past.body?.item_id}/due`, ALPHA, { due: '2099-01-02' });
    const clr = await call('POST', `/api/work-items/${future.body?.item_id}/due`, ALPHA, { due: null });
    const other = await call('POST', `/api/work-items/${past.body?.item_id}/due`, BETA, { due: '2026-02-02' });
    const adminOnly = await call('POST', `/api/work-items/${past.body?.item_id}/due`, ADMIN, { due: '2026-02-02' });
    const anonRemote = await call('POST', `/api/work-items/${past.body?.item_id}/due`, { 'x-forwarded-for': '198.51.100.7' }, { due: '2026-02-02' });
    const badFmt = await call('POST', `/api/work-items/${past.body?.item_id}/due`, ALPHA, { due: '2026-02-30' });
    const missing = await call('POST', `/api/work-items/${past.body?.item_id}/due`, ALPHA, {});
    const after = (await call('GET', `/api/work-items/${past.body?.item_id}`, ALPHA)).body;
    check(ch.status === 200 && ch.body?.due === '2099-01-02' && ch.body.overdue === false && clr.status === 200 && clr.body?.due === null && after?.due === '2099-01-02',
      '建立人改截止日期：改成新的、清掉都行，改后 overdue 跟着变', show({ ch: ch.body, clr: clr.body }));
    check(other.status === 404 && adminOnly.status === 401 && anonRemote.status === 401 && badFmt.status === 400 && badFmt.body?.error === 'due_invalid' && missing.status === 400 && missing.body?.error === 'due_required' && after?.due === '2099-01-02',
      '改截止日期：别人（看不到这件）404、只带管理口令 401、远程匿名 401、不存在的日期 400、没带 due 400，都不改', show([other.status, adminOnly.status, anonRemote.status, badFmt.status, missing.status]));
    const d2 = dbr(); let trail = []; try { trail = d2.prepare("SELECT actor, detail FROM workbench_event_log WHERE event_id = ? AND action = 'due-changed'").all(past.body?.event_id).map((r) => ({ ...r })); } finally { d2.close(); }
    check(trail.length === 1 && trail[0].actor === 'user:alpha' && JSON.parse(trail[0].detail).from === '2026-01-01T00:00:00.000Z' && JSON.parse(trail[0].detail).to === '2099-01-02T00:00:00.000Z', '改截止日期留痕：谁改的、从几号改成几号', show(trail));
    // 同步到节点：派工正文不改（证据），给这个事件每条还活着的投递排一条「[截止变更]」，同一 context 的新任务；拒掉的改动一条不排
    const d3 = dbr(); let notes = [], body = '', dlv = []; try {
      notes = d3.prepare("SELECT r.kind, r.delivery_id, r.context_id, r.message, r.status FROM workbench_event_replies r WHERE r.event_id = ?").all(past.body?.event_id).map((r) => ({ ...r }));
      body = d3.prepare('SELECT message FROM workbench_event_deliveries WHERE event_id = ?').get(past.body?.event_id)?.message ?? '';
      dlv = d3.prepare("SELECT id FROM workbench_event_deliveries WHERE event_id = ? AND status IN ('held','pending','sent')").all(past.body?.event_id).map((r) => r.id);
    } finally { d3.close(); }
    const nm = notes.map((n) => JSON.parse(n.message));
    check(ch.body?.notified === dlv.length && dlv.length >= 1 && notes.length === dlv.length && notes.every((n) => n.kind === 'answer' && n.status === 'pending' && dlv.includes(n.delivery_id) && n.context_id !== '')
      && nm.every((m) => m.notice === 'due-changed' && m.by === 'user:alpha' && m.text.startsWith('[截止变更]') && m.text.includes('2099-01-02') && m.text.includes('2026-01-01') && !m.text.includes('\n'))
      && JSON.parse(body).task?.due === '2026-01-01',
      '改截止日期同步到节点：每条还活着的投递排一条「[截止变更]」（一行字，新旧日期都写），作为同一 context 的新任务；派工正文里的 task.due 原样不改', show({ notified: ch.body?.notified, dlv, notes: nm }));
    // 管理员不代改截止：会话登录的管理员改 alpha 的事项 → 404（不说有没有这件），不改动；只带管理口令的不是人，401；管理员看详情 can.due 为假
    const dueBefore = (() => { const d = dbr(); try { return d.prepare('SELECT due_at FROM work_items WHERE id = ?').get(past.body?.item_id)?.due_at; } finally { d.close(); } })();
    const SESSION_ADMIN = { ...SAME, cookie: `session_id=${SESSIONS.admin}` };
    const byAdmin = await call('POST', `/api/work-items/${past.body?.item_id}/due`, SESSION_ADMIN, { due: '2099-05-05' });
    const byToken = await call('POST', `/api/work-items/${past.body?.item_id}/due`, ADMIN, { due: '2099-05-06' });
    const dueAfter = (() => { const d = dbr(); try { return d.prepare('SELECT due_at FROM work_items WHERE id = ?').get(past.body?.item_id)?.due_at; } finally { d.close(); } })();
    const adminView = await call('GET', `/api/work-items/${past.body?.item_id}`, SESSION_ADMIN);
    check(byAdmin.status === 404 && byToken.status === 401 && dueAfter === dueBefore && adminView.status === 200 && adminView.body?.can?.due === false,
      '管理员不代改截止：会话登录的管理员改 → 404、只带管理口令 → 401，都没改动；管理员看详情 can.due 为假', show({ st: byAdmin.status, token: byToken.status, dueBefore, dueAfter, can: adminView.body?.can }));
    // 来自未验证提交方的事项（建立人主体记着 alpha，context 说 unverified，不是票据认出的）：creatorCheck 是 not_eligible，
    // 只能由管理员处理。改截止会往节点发通知，也是写，同样挡住：建立人改不了（404，不说有没有这件），详情 can.due 为假
    const uvSeed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))}, { timeout: 5000 });
      const t = new Date().toISOString();
      d.prepare("INSERT INTO work_items (id, title, created_by, creator_principal, source_kind, context, state, created_at, updated_at) VALUES ('wi_unverified_due', '未验证来源的事项', 'user:alpha', 'user:alpha', 'agent', ?, 'draft', ?, ?)").run(JSON.stringify({ submitter_kind: 'unverified' }), t, t);
      console.log('UV');`], { encoding: 'utf8' });
    const uvDue = await call('POST', '/api/work-items/wi_unverified_due/due', ALPHA, { due: '2099-03-03' });
    const uvDetail = await call('GET', '/api/work-items/wi_unverified_due', ALPHA);
    const uvRow = (() => { const d = dbr(); try { return d.prepare("SELECT due_at FROM work_items WHERE id = 'wi_unverified_due'").get(); } finally { d.close(); } })();
    check(uvSeed.stdout.includes('UV') && uvDue.status === 404 && uvDue.body?.error === 'work_item_not_found' && uvDetail.status === 200 && uvDetail.body?.can?.due === false && uvRow?.due_at === '',
      '未验证来源的事项（creatorCheck 是 not_eligible）：建立人改截止 404、没改动；详情 can.due 为假', show({ seed: uvSeed.stderr.slice(-200), due: uvDue, st: uvDetail.status, can: uvDetail.body?.can, row: uvRow }));
  }

  // 登录门开着时再验一次接单节点取件（最后另起实例）：要用到的事件、令牌、附件
  let gateCase = null;
  // ---------- 附件 ----------
  {
    const { createHash } = await import('node:crypto');
    const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');
    const up = async (headers, name, body, extra = {}) => {
      const r = await fetch(`${base}/api/work-items/attachments/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...headers, ...extra }, body });
      let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
      return { status: r.status, body: j };
    };
    const bytes = Buffer.from('合成附件：上周出货差异的草稿\n第二行\n', 'utf8');
    const a1 = await up(ALPHA, '差异草稿.txt', bytes, { 'x-content-sha256': shaOf(bytes) });
    const a2 = await up(ALPHA, '第二个.txt', Buffer.from('二'));
    const wrong = await up(ALPHA, '核不对.txt', bytes, { 'x-content-sha256': '0'.repeat(64) });
    const asJson = await up(ALPHA, 'j.txt', '{"a":1}', { 'content-type': 'application/json' });
    const anon = await up({ 'x-forwarded-for': '198.51.100.7' }, 'x.txt', bytes);
    const betaFile = await up(BETA, '别人的.txt', Buffer.from('b'));
    check(a1.status === 201 && a1.body?.sha256 === shaOf(bytes) && a1.body.size === bytes.length && a1.body.integrity === 'sha256-verified' && a2.status === 201 && a2.body?.integrity === 'unverified',
      '上传附件：登录的人传原始字节，带 X-Content-SHA256 核对过（sha256-verified），不带也能传', show({ a1: a1.body, a2: a2.body }));
    check(wrong.status === 400 && wrong.body?.error === 'sha256_mismatch' && asJson.status === 415 && anon.status === 401,
      '上传附件：sha256 对不上 400 不保存；按 JSON 发 415（请求体已被读走，不存空文件）；远程匿名 401', show({ wrong: wrong.status, asJson: asJson.status, anon: anon.status }));
    // 安排时带附件：正文只带引用（名字、大小、sha256、取件地址），不带内容
    const withAtt = await call('POST', '/api/work-items', ALPHA, form({ attachments: [a1.body?.id, a2.body?.id] }));
    const d = dbr(); let msgRow; try { msgRow = d.prepare('SELECT id, message FROM workbench_event_deliveries WHERE event_id = ?').get(withAtt.body?.event_id); } finally { d.close(); }
    const env = JSON.parse(msgRow?.message ?? '{}');
    check(withAtt.status === 201 && env.attachments?.length === 2 && env.attachments[0].name === '差异草稿.txt' && env.attachments[0].sha256 === shaOf(bytes) && env.attachments[0].url.endsWith(`/api/workbench-events/${withAtt.body?.event_id}/attachments/${a1.body?.id}`)
      && typeof env.attachments_fetch === 'string' && !msgRow.message.includes('上周出货差异的草稿'),
      '安排时带附件：派工正文列名字、大小、sha256、取件地址和取件方式，不带文件内容', show(env.attachments));
    const again = await call('POST', '/api/work-items', ALPHA, form({ attachments: [a1.body?.id] }));
    const notMine = await call('POST', '/api/work-items', ALPHA, form({ attachments: [betaFile.body?.id] }));
    const tooMany = await call('POST', '/api/work-items', ALPHA, form({ attachments: [1, 2, 3, 4, 5, 6] }));
    const dup = await call('POST', '/api/work-items', ALPHA, form({ attachments: [a2.body?.id, a2.body?.id] }));
    const notArr = await call('POST', '/api/work-items', ALPHA, form({ attachments: 'x' }));
    check([again, notMine, tooMany, dup, notArr].every((r) => r.status === 400 && r.body?.error === 'attachments_invalid'),
      '附件：已挂到别的事上的、别人上传的、超过 5 个、重复的、不是数组的：一律 400（同一个错误，不说是哪一种）', show([again, notMine, tooMany, dup, notArr].map((r) => r.status)));
    // 人读：跟事项走
    const item = withAtt.body?.item_id;
    const detail = (await call('GET', `/api/work-items/${item}`, ALPHA)).body;
    const getRaw = async (path, headers) => { const r = await fetch(base + path, { headers }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), sha: r.headers.get('x-content-sha256'), cc: r.headers.get('cache-control') }; };
    const mine = await getRaw(`/api/work-items/${item}/attachments/${a1.body?.id}`, ALPHA);
    const theirs = await getRaw(`/api/work-items/${item}/attachments/${a1.body?.id}`, BETA);
    const wrongItem = await getRaw(`/api/work-items/${past0()}/attachments/${a1.body?.id}`, ALPHA);
    const nope = await getRaw(`/api/work-items/${item}/attachments/999999`, ALPHA);
    check(detail?.attachments?.length === 2 && detail.attachments[0].name === '差异草稿.txt' && detail.attachments[0].size === bytes.length && detail.attachments[0].url === `/api/work-items/${item}/attachments/${a1.body?.id}` && mine.status === 200 && mine.buf.equals(bytes) && mine.sha === shaOf(bytes) && mine.cc === 'private, no-store',
      '人读附件：事项详情列出附件；建立人取得到原样的字节（带 sha256、不进共享缓存）', show({ n: detail?.attachments?.length, st: mine.status }));
    check(theirs.status === 404 && wrongItem.status === 404 && nope.status === 404, '人读附件：看不到这件事项的人、附件不属于这件事项、附件不存在：一律 404', show([theirs.status, wrongItem.status, nope.status]));
    // 接单节点取件：凭派工时给的回执令牌；投递送达之前、令牌不对、没带令牌都取不到
    const token = env.reply?.token ?? '';
    const ev = withAtt.body?.event_id;
    const heldTry = await getRaw(`/api/workbench-events/${ev}/attachments/${a1.body?.id}`, { 'x-reply-token': token });
    const sent = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))});
      d.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(${msgRow?.id}); console.log('SENT');`], { encoding: 'utf8' });
    const ok = await getRaw(`/api/workbench-events/${ev}/attachments/${a1.body?.id}`, { 'x-reply-token': token });
    const badTok = await getRaw(`/api/workbench-events/${ev}/attachments/${a1.body?.id}`, { 'x-reply-token': token + 'x' });
    const noTok = await getRaw(`/api/workbench-events/${ev}/attachments/${a1.body?.id}`, {});
    const otherEv = await getRaw(`/api/workbench-events/${past0Event()}/attachments/${a1.body?.id}`, { 'x-reply-token': token });
    check(sent.stdout.includes('SENT') && heldTry.status === 404 && ok.status === 200 && ok.buf.equals(bytes) && badTok.status === 404 && noTok.status === 404 && otherEv.status === 404,
      '接单节点取件：投递送达之后凭回执令牌取得到原样字节；送达之前、令牌不对、没带令牌、换了事件号都是 404', show([heldTry.status, ok.status, badTok.status, noTok.status, otherEv.status]));

    // (b) 令牌只取得到它那件任务挂的附件：另一件任务（ev2，挂 a4）各有各的令牌，交叉取一律 404；任务结束之后自己的也取不到
    const bytes4 = Buffer.from('第二件事的附件', 'utf8');
    const a4 = await up(ALPHA, '另一件.txt', bytes4);
    const second = await call('POST', '/api/work-items', ALPHA, form({ attachments: [a4.body?.id] }));
    const ev2 = second.body?.event_id;
    const d2r = dbr(); let row2; try { row2 = d2r.prepare('SELECT id, message FROM workbench_event_deliveries WHERE event_id = ?').get(ev2); } finally { d2r.close(); }
    const token2 = JSON.parse(row2?.message ?? '{}').reply?.token ?? '';
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))});
      d.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(${row2?.id});`], { encoding: 'utf8' });
    const own2 = await getRaw(`/api/workbench-events/${ev2}/attachments/${a4.body?.id}`, { 'x-reply-token': token2 });
    const crossA = await getRaw(`/api/workbench-events/${ev2}/attachments/${a4.body?.id}`, { 'x-reply-token': token });
    const crossB = await getRaw(`/api/workbench-events/${ev}/attachments/${a4.body?.id}`, { 'x-reply-token': token });
    const crossC = await getRaw(`/api/workbench-events/${ev2}/attachments/${a1.body?.id}`, { 'x-reply-token': token2 });
    const crossD = await getRaw(`/api/workbench-events/${ev}/attachments/${a1.body?.id}`, { 'x-reply-token': token2 });
    check(second.status === 201 && token2 !== '' && token2 !== token && own2.status === 200 && own2.buf.equals(bytes4) && [crossA, crossB, crossC, crossD].every((r) => r.status === 404),
      '取件（b）：令牌只取得到它那件任务挂的附件——拿 A 的令牌取 B 的附件（换不换事件号）、拿 B 的令牌取 A 的附件，一律 404', show([own2.status, crossA.status, crossB.status, crossC.status, crossD.status]));
    gateCase = { ev, token, a1: a1.body?.id, bytes, ev2, token2, a4: a4.body?.id, item };

    // 人读：看得到 X 也看得到 Y 的人，用 X 的地址读 Y 挂的附件 → 404（附件要属于地址里的这件事项）
    const crossItem = await getRaw(`/api/work-items/${item}/attachments/${a4.body?.id}`, ALPHA);
    const ownY = await getRaw(`/api/work-items/${second.body?.item_id}/attachments/${a4.body?.id}`, ALPHA);
    check(ownY.status === 200 && crossItem.status === 404, '人读附件：同一个人看得到两件事项，拿 X 的地址读 Y 的附件 → 404（Y 的地址读得到）', show({ ownY: ownY.status, cross: crossItem.status }));

    // 接单节点取件的三种「令牌还在、但不该再给」：事项到了终态、投递没在已发出（比如判死了）、送达超过 7 天
    const armed = async (label) => {
      const up1 = await up(ALPHA, `${label}.txt`, Buffer.from(label));
      const arr = await call('POST', '/api/work-items', ALPHA, form({ attachments: [up1.body?.id] }));
      const ev3 = arr.body?.event_id;
      const d5 = dbr(); let r5; try { r5 = d5.prepare('SELECT id, message FROM workbench_event_deliveries WHERE event_id = ?').get(ev3); } finally { d5.close(); }
      dbw("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = datetime('now') WHERE id = ?", r5?.id);
      return { ev: ev3, item: arr.body?.item_id, aid: up1.body?.id, delivery: r5?.id, tok: JSON.parse(r5?.message ?? '{}').reply?.token ?? '' };
    };
    const fetchAs = (x) => getRaw(`/api/workbench-events/${x.ev}/attachments/${x.aid}`, { 'x-reply-token': x.tok });
    const term = await armed('终态'), dead = await armed('判死'), old = await armed('过期');
    const ctl = await Promise.all([term, dead, old].map(fetchAs));
    const lastTo = (() => { const d = dbr(); try { return d.prepare('SELECT to_state FROM work_item_log WHERE item_id = ? ORDER BY seq DESC LIMIT 1').get(term.item)?.to_state; } finally { d.close(); } })();
    dbw("INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, actor, detail) VALUES (?, 'failed', 'test', 'n2', ?, 'failed', 'test', '{}')", term.item, lastTo ?? 'draft');
    dbw("UPDATE work_items SET state = 'failed' WHERE id = ?", term.item);
    dbw("UPDATE workbench_event_deliveries SET status = 'dead' WHERE id = ?", dead.delivery);
    dbw("UPDATE workbench_event_deliveries SET sent_at = datetime('now', '-8 days') WHERE id = ?", old.delivery);
    const [fTerm, fDead, fOld] = await Promise.all([term, dead, old].map(fetchAs));
    check(ctl.every((r) => r.status === 200), '对照：三件都送达、令牌对，先都取得到', show(ctl.map((r) => r.status)));
    check(fTerm.status === 404, '取件：事项到了终态（这里是没办成）、令牌还在 → 404', show(fTerm.status));
    check(fDead.status === 404, '取件：投递不在已发出（判死了）、令牌还在 → 404', show(fDead.status));
    check(fOld.status === 404, '取件：送达超过 7 天、令牌还在 → 404', show(fOld.status));

    // 上传可执行文件：ELF、MZ 头一律 400 attachment_executable_refused，不落盘、不记录
    const { readdirSync } = await import('node:fs');
    const filesIn = (dir) => { try { return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length; } catch { return 0; } };
    const rowsNow = () => { const d = dbr(); try { return d.prepare('SELECT COUNT(*) AS c FROM work_item_attachments').get().c; } finally { d.close(); } };
    const f0 = filesIn(join(data, 'uploads')), r0 = rowsNow();
    const elf = await up(ALPHA, 'tool.bin', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64)]));
    const mz = await up(ALPHA, 'setup.txt', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
    check([elf, mz].every((r) => r.status === 400 && r.body?.error === 'attachment_executable_refused') && filesIn(join(data, 'uploads')) === f0 && rowsNow() === r0,
      '上传：ELF、MZ（改成 .txt 也一样）一律 400 attachment_executable_refused，不落盘、不记录', show({ elf: [elf.status, elf.body], mz: [mz.status, mz.body], files: [f0, filesIn(join(data, 'uploads'))], rows: [r0, rowsNow()] }));
    // 撤回这件任务（管理员经「关注」撤回；投递已发出，事项本身不一定立刻到终态）：之后凭自己的令牌也取不到
    const wd = await call('POST', '/api/attention/answer', ADMIN, { source: 'work-items', source_id: second.body?.item_id, answer: 'withdraw', input: {} });
    const st2 = (await call('GET', `/api/work-items/${second.body?.item_id}`, ALPHA)).body?.item?.state;
    const after2 = await getRaw(`/api/workbench-events/${ev2}/attachments/${a4.body?.id}`, { 'x-reply-token': token2 });
    check(wd.status === 200 && wd.body?.result?.status === 'withdrawn' && after2.status === 404, '取件（b）：任务撤回之后凭自己的令牌也取不到，和不存在一样 404', show({ wd: [wd.status, wd.body?.result], st2, after: after2.status }));

    // (a) 没挂上的上传要有收场：24 小时没被引用的自动清掉（文件和记录一起）；每人没挂的总量有上限
    const stale = await up(ALPHA, '放了一天.txt', Buffer.from('没人用'));
    const back = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))});
      d.prepare("UPDATE work_item_attachments SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), ${stale.body?.id});
      console.log('PATH ' + d.prepare('SELECT path FROM work_item_attachments WHERE id = ?').get(${stale.body?.id}).path);`], { encoding: 'utf8' });
    const stalePath = join(data, (back.stdout.match(/PATH (.+)/) ?? [])[1] ?? 'missing');
    const { existsSync } = await import('node:fs');
    const fileBefore = existsSync(stalePath);
    const fresh = await up(ALPHA, '新的.txt', Buffer.from('新'));
    const d4 = dbr(); let gone, keptFresh, keptBound; try {
      gone = d4.prepare('SELECT COUNT(*) AS n FROM work_item_attachments WHERE id = ?').get(stale.body?.id).n === 0;
      keptFresh = d4.prepare('SELECT COUNT(*) AS n FROM work_item_attachments WHERE id = ?').get(fresh.body?.id).n === 1;
      keptBound = d4.prepare("SELECT COUNT(*) AS n FROM work_item_attachments WHERE id = ? AND event_id != ''").get(a1.body?.id).n === 1;
    } finally { d4.close(); }
    const useStale = await call('POST', '/api/work-items', ALPHA, form({ attachments: [stale.body?.id] }));
    check(stale.status === 201 && fileBefore && gone && !existsSync(stalePath) && keptFresh && keptBound && useStale.status === 400 && useStale.body?.error === 'attachments_invalid',
      '收场（a）：上传后 24 小时没被引用的清掉（记录和文件都没了，再拿它安排 400）；新传的、已挂出去的不动', show({ fileBefore, gone, fileAfter: existsSync(stalePath), keptFresh, keptBound, use: useStale.status }));
    // 总量上限：库里给 alpha 记上将近 500MB 没挂出去的（合成记录，不落文件），再传一个就超 → 429，不落盘；别人不受影响
    const fill = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))});
      const r = d.prepare("INSERT INTO work_item_attachments (uploaded_by, name, mime, size, sha256, path, created_at) VALUES ('user:alpha', '合成大文件', 'application/octet-stream', ?, ?, 'uploads/none/synthetic', ?)").run(500 * 1024 * 1024 - 4, '0'.repeat(64), new Date().toISOString());
      console.log('FILL ' + r.lastInsertRowid);`], { encoding: 'utf8' });
    const fillId = Number((fill.stdout.match(/FILL (\d+)/) ?? [])[1] ?? 0);
    const over = await up(ALPHA, '超了.txt', Buffer.from('超过总量'));
    const betaOk = await up(BETA, 'b.txt', Buffer.from('b'));
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))});
      d.prepare('DELETE FROM work_item_attachments WHERE id = ?').run(${fillId});`], { encoding: 'utf8' });
    const afterFree = await up(ALPHA, '腾出来了.txt', Buffer.from('ok'));
    check(fillId > 0 && over.status === 429 && over.body?.error === 'attachments_pending_bytes_limit' && over.body?.limit_bytes === 500 * 1024 * 1024 && betaOk.status === 201 && afterFree.status === 201,
      '收场（a）：每人没挂出去的总量上限 500MB——超了先拒（429，不保存），别人不受影响；腾出来以后又能传', show({ over: [over.status, over.body], afterFree: afterFree.status, betaOk: betaOk.status }));
  }

  // ---------- 拒绝 ----------
  {
    const anon = await call('POST', '/api/work-items', { 'x-forwarded-for': '198.51.100.7' }, form());
    const local = await call('POST', '/api/work-items', SAME, form());
    const forged = await call('POST', '/api/work-items', { ...SAME, cookie: `session_id=${SESSIONS.forged}` }, form());
    const tokenOnly = await call('POST', '/api/work-items', ADMIN, form());
    const cross = await call('POST', '/api/work-items', { ...ALPHA, 'sec-fetch-site': 'cross-site' }, form());
    check(anon.status === 401 && local.status === 401 && forged.status === 401 && tokenOnly.status === 401 && cross.status === 403,
      '远程匿名、本机页面没登录、提供方不认的会话、只带管理口令（不是人）：401；跨站：403', show({ anon: anon.status, local: local.status, forged: forged.status, token: tokenOnly.status, cross: cross.status }));
    const off = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', `
      const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(join(data, 'workbench-market.db'))}, { timeout: 5000 });
      d.prepare("UPDATE principals SET status = 'disabled' WHERE id = 'user:beta'").run(); console.log('OFF');`], { encoding: 'utf8' });
    const disabled = await call('POST', '/api/work-items', BETA, form());
    check(off.stdout.includes('OFF') && [401, 403].includes(disabled.status) && disabled.body?.error !== undefined, '主体停用了：拒绝（身份服务每次现查主体，不用缓存）', show({ off: off.stderr.slice(-200), d: disabled }));
  }

  // ---------- 启动自检 ----------
  check(/"id":"market\.work-items\.arrange-anonymous"[^}]*"verdict":"pass"/.test(log), '启动自检有一行：远程匿名打「安排一件事」必须 401，而且过了');

  // ---------- WM_A2A_DIRECTED_SEATS=off：同一份库另起一个实例，安排这一侧不收指名 ----------
  {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
    const port2 = await freePort();
    let log2 = '';
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port2), WM_A2A_DIRECTED_SEATS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log2 += String(d); }); child.stderr.on('data', (d) => { log2 += String(d); });
    const base2 = `http://127.0.0.1:${port2}`;
    for (let i = 0, ok = false; !ok; i++) {
      if (i > 200 || child.exitCode !== null) throw new Error(`directedSeats=off 的实例没起来：${log2.slice(-800)}`);
      try { ok = (await fetch(`${base2}/api/health`)).status === 200; } catch { /* 还没起来 */ }
      if (!ok) await new Promise((r) => setTimeout(r, 200));
    }
    const call2 = async (method, path, headers, json) => {
      const r = await fetch(base2 + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
      let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
      return { status: r.status, body };
    };
    const counts = () => { const d = dbr(); try { return { items: Number(d.prepare('SELECT COUNT(*) AS c FROM work_items').get().c), deliveries: Number(d.prepare('SELECT COUNT(*) AS c FROM workbench_event_deliveries').get().c), events: Number(d.prepare('SELECT COUNT(*) AS c FROM workbench_events').get().c) }; } finally { d.close(); } };
    const before = counts();
    // seat-0000000a 是 alpha 分到的席位，team-a 的对端名片声明了 directedSeats：开着时这一件会真指名（上面「指名」一节）
    const offSeat = await call2('POST', '/api/work-items', ALPHA, form({ seat_id: 'seat-0000000a' }));
    const afterSeat = counts();
    check(/不声明 directedSeats/.test(log2) && offSeat.status === 400 && offSeat.body?.error === 'directed_seats_off'
      && afterSeat.items === before.items && afterSeat.deliveries === before.deliveries && afterSeat.events === before.events,
      'WM_A2A_DIRECTED_SEATS=off：带合法 seat_id 安排 → 400 directed_seats_off，没建事项、没记事件、没有投递', show({ r: offSeat, before, afterSeat }));
    const offPlain = await call2('POST', '/api/work-items', ALPHA, form());
    check(offPlain.status === 201 && offPlain.body?.directed === undefined && counts().items === afterSeat.items + 1,
      '……不带 seat_id 照常 201（整队派发）', show(offPlain));
  }

  // ---------- WM_LOGIN_GATE=enforce：同一份库再起一个实例，接单节点凭回执令牌取件不该被登录门挡住；人读附件仍要登录 ----------
  {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
    if (!gateCase) throw new Error('附件那一段没跑到，登录门这一段没有可用的令牌');
    const port3 = await freePort();
    let log3 = '';
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port3), WM_LOGIN_GATE: 'enforce' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { log3 += String(d); }); child.stderr.on('data', (d) => { log3 += String(d); });
    const base3 = `http://127.0.0.1:${port3}`;
    for (let i = 0, ok = false; !ok; i++) {
      if (i > 200 || child.exitCode !== null) throw new Error(`登录门开着的实例没起来：${log3.slice(-800)}`);
      try { ok = (await fetch(`${base3}/api/health`)).status === 200; } catch { /* 还没起来 */ }
      if (!ok) await new Promise((r) => setTimeout(r, 200));
    }
    // 接单节点从外面来：不带会话，只带回执令牌
    const REMOTE = { 'x-forwarded-for': '198.51.100.7' };
    const fetch3 = async (path, headers, method = 'GET') => { const r = await fetch(base3 + path, { method, headers: { ...REMOTE, ...headers } }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };
    const g = gateCase;
    const gOk = await fetch3(`/api/workbench-events/${g.ev}/attachments/${g.a1}`, { 'x-reply-token': g.token });
    const gNoTok = await fetch3(`/api/workbench-events/${g.ev}/attachments/${g.a1}`, {});
    const gBadTok = await fetch3(`/api/workbench-events/${g.ev}/attachments/${g.a1}`, { 'x-reply-token': g.token + 'x' });
    const gOtherEv = await fetch3(`/api/workbench-events/${g.ev2}/attachments/${g.a1}`, { 'x-reply-token': g.token });
    const gWithdrawn = await fetch3(`/api/workbench-events/${g.ev2}/attachments/${g.a4}`, { 'x-reply-token': g.token2 });
    check(gOk.status === 200 && gOk.buf.equals(g.bytes) && [gNoTok, gBadTok, gOtherEv, gWithdrawn].every((r) => r.status === 404),
      '登录门开着：接单节点凭回执令牌取得到原样字节；没令牌、令牌不对、换了事件、任务已撤回的一律 404（不是登录门的 401）',
      show([gOk.status, gNoTok.status, gBadTok.status, gOtherEv.status, gWithdrawn.status]));
    // 放行只放这一条取件路径的 GET：同一路径的写、人读附件、取件路径换形状都仍由登录门挡（401）
    const gHuman = await fetch3(`/api/work-items/${g.item}/attachments/${g.a1}`, {});
    const gPost = await fetch3(`/api/workbench-events/${g.ev}/attachments/${g.a1}`, { 'x-reply-token': g.token }, 'POST');
    const gShape = await fetch3(`/api/workbench-events/${g.ev}/attachments/0${g.a1}`, { 'x-reply-token': g.token });
    check(gHuman.status === 401 && gPost.status === 401 && gShape.status === 401,
      '登录门开着：人读附件（/api/work-items/:id/attachments/:aid）远程匿名仍 401；取件路径的 POST、id 带前导 0 的不在放行里，也是 401',
      show({ human: gHuman.status, post: gPost.status, shape: gShape.status }));
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
