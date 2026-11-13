#!/usr/bin/env node
/**
 * 规范 14 第九节：放行归负责人（对抗组）。起隔离实例（假的登录提供方，NODE_ENV=test），合成名册、部门、团队认领、负责人：
 *
 *   负责人：自己团队的事项 can、turn 都真；POST /api/work-items/:id/release 放行，留痕记本人、不记代办
 *   团队有负责人时，管理层（会话登录的管理员）、口令管理员都不放（403），建立人不放（403），看不到的人 404
 *   团队没有负责人：持有管理层授予的人代办（can 真、turn 假），事件日志和事项日志记 acting_for = team-lead；
 *     只过了管理门的（管理口令、没有管理层授予的身份来源管理员）不能代办，「关注」里只给他们撤回
 *   建立人勾了「先给我过目」（review_by = requester）：建立人本人放，负责人、管理层都不放
 *   幂等：放过的再来一次 200、duplicate=true，不再放、不再记；没放过、已经不在等过目的 409
 *   「关注」：过目条目只给能放的人；带 answer_via 指向这个入口；不是管理员的只有 release 这一种答法
 *   跨站来的拒；坏 id 400
 *   等谁放行（release_by，详情和列表）：团队和负责人的名字（看不到这个团队的人负责人是 null）；没有负责人是管理层；自审是建立人；不在等过目是 null
 *
 *   node scripts/work-item-lead-release-test.mjs              测本仓库
 *   node scripts/work-item-lead-release-test.mjs --root DIR   测另一棵目录树（变异测试用）
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
const OUT = join(HERE, '..', 'tmp', `work-item-lead-release-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'lead-release-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid';
const TEAM = 'zone1/canvas/Team A', VACANT = 'zone1/canvas/Team B';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  // 事项：都由 alpha 建、都先过目（held）；团队 A 有负责人（部门负责人 beta），团队 B 在名册里但没有负责人
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    const ev = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/workbench-events.ts')).href)});
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService, itemIdForEvent } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    ev.initWorkbenchEvents();
    await root.plugin(WorkItemService);
    const items = root.get('workItems');
    const b = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', ?, 'notify', 'read', ?, 'seed')");
    b.run(${JSON.stringify(TEAM)}, ${JSON.stringify(PEER)}); b.run(${JSON.stringify(VACANT)}, ${JSON.stringify(PEER)});
    const mk = (title, team, extra = {}) => {
      const id = Number(db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'published')").run(title).lastInsertRowid);
      const f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
      db.exec('BEGIN IMMEDIATE');
      const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: 'user:alpha', publisherPrincipal: 'user:alpha', templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: 'user:alpha', ...extra } });
      db.exec('COMMIT');
      items.syncEvent(e);
      return { item: itemIdForEvent(e), event: e, task: id };
    };
    const out = { lead: mk('合成：交给有负责人的团队', ${JSON.stringify(TEAM)}), vacant: mk('合成：交给没有负责人的团队', ${JSON.stringify(VACANT)}),
      requester: mk('合成：建立人自己过目', ${JSON.stringify(TEAM)}, { handoff: 'own-seat', reviewBy: 'requester', directedSeatId: 'seat-0000000b' }),
      withdrawn: mk('合成：会被撤回', ${JSON.stringify(TEAM)}) };
    console.log('SEEDED ' + JSON.stringify(out));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
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
  const WHO = { 建立人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, 负责人: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 管理层: { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, 无关的人: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    const now = Date.now();
    db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at, key_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, char(115, 104, 97, 50, 53, 54, 58) || substr(?1 || hex(zeroblob(32)), 1, 64))').run(HOST, PEER, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
    const seatIns = db.prepare('INSERT INTO a2a_roster_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ((SELECT peer_root FROM a2a_rosters WHERE host = ?1 ORDER BY rowid LIMIT 1), (SELECT key_fingerprint FROM a2a_rosters WHERE host = ?1 ORDER BY rowid LIMIT 1), ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)');
    seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', now, now);
    seatIns.run(HOST, VACANT, 'zone1/0000000d', 'seat-0000000d', '合成别队', 'router', now, now);
    db.close();
  }
  // 部门负责人、团队认领由属主（本机命令行）做，直接生效：这里要的是已确认的负责人
  const dept = await call('PUT', '/api/departments/sales', {}, { name: '合成销售部', lead: 'user:beta' });
  const claim = await call('POST', '/api/teams/claim', {}, { host: HOST, team: TEAM, department: 'sales' });
  if (![dept, claim].every((r) => r.status >= 200 && r.status < 300)) throw new Error(`团队搭不起来：${show({ dept, claim })}`);

  const q = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };
  const release = (id, h) => call('POST', `/api/work-items/${id}/release`, h, {});
  const detail = async (id, h) => { const r = await call('GET', `/api/work-items/${id}`, h); return r.status === 200 ? { can: r.body.can.release, turn: r.body.turn.release } : { status: r.status }; };
  const released = (ev) => q("SELECT actor, detail FROM workbench_event_log WHERE event_id = ? AND action = 'released'", ev).map((r) => ({ actor: r.actor, acting_for: JSON.parse(r.detail || '{}').acting_for ?? null }));
  const factOf = (id) => q("SELECT actor, detail FROM work_item_log WHERE item_id = ? AND fact = 'release'", id).map((r) => ({ actor: r.actor, acting_for: JSON.parse(r.detail || '{}').acting_for ?? null }));
  const glances = async (h) => ((await call('GET', '/api/attention', h)).body?.items ?? []).filter((x) => x.source === 'work-items' && x.category === 'glance');

  // ---------- 等谁放行（release_by）：详情和列表同一个；负责人的名字按看的人裁 ----------
  {
    const rb = async (id, h) => { const r = await call('GET', `/api/work-items/${id}`, h); return r.status === 200 ? r.body.release_by : { status: r.status }; };
    const lead = { 负责人: await rb(I.lead.item, WHO.负责人), 口令管理员: await rb(I.lead.item, ADMIN), 建立人: await rb(I.lead.item, WHO.建立人), 无关的人: await rb(I.lead.item, WHO.无关的人) };
    const named = { kind: 'team-lead', text: 'Team A 的负责人 Synthetic beta', teams: [{ team: TEAM, name: 'Team A', leads: [{ principal: 'user:beta', display_name: 'Synthetic beta' }] }] };
    check(show(lead.负责人) === show(named) && show(lead.口令管理员) === show(named),
      '等谁放行：团队有负责人，看得到这个团队的人（负责人本人、管理员）拿到团队名和负责人的名字', show(lead));
    check(show(lead.建立人) === show({ kind: 'team-lead', text: 'Team A 的负责人', teams: [{ team: TEAM, name: 'Team A', leads: null }] }) && lead.无关的人.status === 404,
      '等谁放行：看不到这个团队的人（建立人不在这个团队、部门里）负责人是 null，文字里也不带名字；看不到事项的人 404', show(lead));
    const vac = await rb(I.vacant.item, WHO.建立人), req = await rb(I.requester.item, WHO.负责人);
    check(show(vac) === show({ kind: 'management', text: '管理层' }) && req?.kind === 'creator' && req.creator?.principal === 'user:alpha' && req.text === `建立人 ${req.creator.display_name}`,
      '等谁放行：团队没有负责人 → 管理层；建立人自己过目 → 建立人', show({ vac, req }));
    const rows = (await call('GET', '/api/work-items?view=mine', WHO.建立人)).body?.items ?? [];
    const row = (id) => rows.find((x) => x.id === id)?.release_by;
    check(show(row(I.lead.item)) === show(lead.建立人) && show(row(I.vacant.item)) === show(vac) && rows.filter((x) => x.state !== 'held').every((x) => x.release_by === null) && rows.length > 0,
      '等谁放行：列表每一行和详情一样（同样按看的人裁）；不在等过目的是 null', show(rows.map((x) => [x.state, x.release_by])));
  }

  // ---------- 代办只认管理层授予，不认管理门 ----------
  {
    const t = await detail(I.vacant.item, ADMIN), s0 = await detail(I.vacant.item, WHO.管理层);
    const rt = await release(I.vacant.item, ADMIN), rs = await release(I.vacant.item, WHO.管理层);
    const g = (await glances(WHO.管理层)).find((x) => x.source_id === I.vacant.item);
    check(show(t) === show({ can: false, turn: false }) && show(s0) === show({ can: false, turn: false }) && rt.status === 403 && rs.status === 403 && rs.body?.error === 'work_item_release_not_yours'
      && released(I.vacant.event).length === 0 && g && show(g.answers) === show(['withdraw']) && !g.answer_via,
      '团队没有负责人：管理口令、没有管理层授予的身份来源管理员都不能代办（can 假，放行 403，没放）；「关注」里只给撤回、不带放行地址', show({ t, s0, rt: rt.status, rs: [rs.status, rs.body?.error], g: g && [g.answers, !!g.answer_via] }));
    // 有别的生效授予（普通员工）不算持有管理层授予
    const m = await call('POST', '/api/grants', {}, { principal: 'user:alpha', role: 'member', scope: '*', reason: '合成：普通员工' });
    await call('POST', `/api/grants/${m.body?.grant?.id}/submit`, {}, {});
    await call('POST', `/api/grants/${m.body?.grant?.id}/approve`, {}, {});
    const h = await call('GET', '/api/health', ADMIN), hAnon = await call('GET', '/api/health', {});
    check(h.body?.work_items?.management_grant_holders === 0 && !('work_items' in (hAnon.body ?? {})), 'health：管理口令看得到「持有管理层授予的主体」是 0（只有普通员工授予的不算）；别人看不到这一项', show({ h: h.body?.work_items, anon: 'work_items' in (hAnon.body ?? {}) }));
  }
  // 给身份来源管理员一份管理层授予（本机命令行即属主，走完起草→提交→放行）：下面「管理层」都是持有授予的
  {
    const d = await call('POST', '/api/grants', {}, { principal: 'user:root-admin', role: 'management', scope: '*', reason: '合成：持有管理层授予的人' });
    await call('POST', `/api/grants/${d.body?.grant?.id}/submit`, {}, {});
    const a = await call('POST', `/api/grants/${d.body?.grant?.id}/approve`, {}, {});
    const h = await call('GET', '/api/health', ADMIN);
    check(a.status === 200 && h.body?.work_items?.management_grant_holders === 1, '授予管理层之后：health 里持有管理层授予的主体是 1', show({ a: a.status, h: h.body?.work_items }));
    // 之后又有 600 份普通授予（比那份管理层授予新）：按角色在库里数，不按「最近的 500 份授予」数
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    try {
      const now = Date.now();
      db.exec('BEGIN');
      // 授予只能从草稿起步、状态只往前走（表上的触发器）：照着走 draft → pending → active
      const ins = db.prepare("INSERT INTO grants (principal_id, role, scope, reason, created_by, created_at, updated_at) VALUES (?, 'member', '*', '合成：普通授予', 'test', ?, ?)");
      const ids = [];
      for (let i = 0; i < 600; i++) ids.push(Number(ins.run(`user:filler-${i}`, now, now).lastInsertRowid));
      const step = db.prepare("UPDATE grants SET status = ?, approved_by = CASE WHEN ? = 'active' THEN 'test-approver' ELSE approved_by END WHERE id = ?");
      for (const id of ids) { step.run('pending', 'pending', id); step.run('active', 'active', id); }
      db.exec('COMMIT');
    } finally { db.close(); }
    const h2 = await call('GET', '/api/health', ADMIN);
    check(h2.body?.work_items?.management_grant_holders === 1, '又有 600 份更新的普通授予：持有管理层授予的主体照旧是 1（按角色在库里数，不受条数上限影响）', show(h2.body?.work_items));
  }
  // ---------- 团队有负责人：只有负责人能放 ----------
  {
    const d = { 负责人: await detail(I.lead.item, WHO.负责人), 管理层: await detail(I.lead.item, WHO.管理层), 建立人: await detail(I.lead.item, WHO.建立人), 无关的人: await detail(I.lead.item, WHO.无关的人) };
    check(show(d) === show({ 负责人: { can: true, turn: true }, 管理层: { can: false, turn: false }, 建立人: { can: false, turn: false }, 无关的人: { status: 404 } }),
      '详情：负责人 can、turn 都真；团队有负责人时管理层不能代办；建立人不能；看不到的人 404', show(d));
    const r = { 建立人: await release(I.lead.item, WHO.建立人), 管理层: await release(I.lead.item, WHO.管理层), 口令管理员: await release(I.lead.item, ADMIN), 无关的人: await release(I.lead.item, WHO.无关的人) };
    check(r.建立人.status === 403 && r.建立人.body?.error === 'work_item_release_not_yours' && r.管理层.status === 403 && r.口令管理员.status === 403 && r.无关的人.status === 404 && r.无关的人.body?.error === 'work_item_not_found',
      '放行入口：建立人、管理层、口令管理员 403（不归他放），看不到的人 404（不说有没有这件）', show(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.status, v.body?.error]]))));
    check(released(I.lead.event).length === 0 && q('SELECT state FROM work_items WHERE id = ?', I.lead.item)[0]?.state === 'held', '被拒的都没放：没有 released 那一行，事项还在 held');
    const cross = await release(I.lead.item, { ...WHO.负责人, 'sec-fetch-site': 'cross-site' }), bad = await release('wi_bad%2Fx', WHO.负责人), badAdmin = await release('wi_bad%2Fx', ADMIN);
    check(cross.status === 403 && cross.body?.error === 'work_items_cross_origin_denied' && bad.status === 403 && badAdmin.status === 400 && badAdmin.body?.error === 'work_item_id_invalid',
      '跨站来的负责人请求拒（403）；坏 id：写请求总门只放 wi_ 形状的这一条子路径，非管理员 403，管理员到路由里 400', show({ cross, bad: bad.status, badAdmin }));
  }
  // ---------- 「关注」：过目只给能放的人，带 answer_via ----------
  {
    const lead = await glances(WHO.负责人), mgmt = await glances(WHO.管理层), creator = await glances(WHO.建立人);
    const g = lead.find((x) => x.source_id === I.lead.item);
    check(g && g.mine === true && show(g.answers) === show(['release']) && show(g.answer_via) === show({ method: 'POST', path: `/api/work-items/${I.lead.item}/release`, answers: { release: { body: {} } } }),
      '负责人的「关注」：过目条目轮到他（mine）、只有 release、answer_via 指向事项的放行入口', show(g));
    check(!lead.some((x) => x.source_id === I.vacant.item) && !lead.some((x) => x.source_id === I.requester.item), '负责人看不到别的团队、建立人自己过目的那件');
    const v = mgmt.find((x) => x.source_id === I.vacant.item);
    const l = mgmt.find((x) => x.source_id === I.lead.item);
    check(l && show(l.answers) === show(['withdraw']) && !l.answer_via && v && v.mine === false && show(v.answers) === show(['release', 'withdraw']) && v.answer_via?.path === `/api/work-items/${I.vacant.item}/release`,
      '管理层的「关注」：团队有负责人的那件只给撤回（不能放）；没有负责人的那件是代办（mine:false）、能放能撤回', show({ l: l && [l.answers, !!l.answer_via], v }));
    const c = creator.find((x) => x.source_id === I.requester.item);
    check(creator.length === 1 && c?.mine === true && show(c.answers) === show(['release']), '建立人的「关注」：只有自己过目的那件，轮到他', show(creator.map((x) => [x.source_id, x.mine])));
  }
  // ---------- 负责人放行 + 幂等 ----------
  {
    const r = await release(I.lead.item, WHO.负责人);
    check(r.status === 200 && r.body?.released >= 1 && r.body.duplicate === false && !('acting_for' in r.body), '负责人放行：200，放了，不是代办', show(r));
    check(show(released(I.lead.event)) === show([{ actor: 'user:beta', acting_for: null }]) && show(factOf(I.lead.item)) === show([{ actor: 'user:beta', acting_for: null }]),
      '留痕：事件日志、事项日志记负责人本人，没有 acting_for', show({ ev: released(I.lead.event), f: factOf(I.lead.item) }));
    const again = await release(I.lead.item, WHO.负责人);
    check(again.status === 200 && again.body?.duplicate === true && again.body.released === 0 && released(I.lead.event).length === 1 && factOf(I.lead.item).length === 1,
      '再放一次：200、duplicate=true，不再放、不再记', show(again));
    const after = await detail(I.lead.item, WHO.负责人);
    check(show(after) === show({ can: false, turn: false }), '放行之后：不再能放', show(after));
  }
  // ---------- 只是提议的负责人不放（关系确认制）----------
  {
    // 没有负责人的团队 B：先认领到一个没有部门负责人的部门（属主，直接生效），再由管理口令提议一个负责人（只记成提议，待确认）
    await call('PUT', '/api/departments/nolead', {}, { name: '合成没有负责人的部门' });
    const c = await call('POST', '/api/teams/claim', {}, { host: HOST, team: VACANT, department: 'nolead' });
    const p = await call('POST', '/api/teams/leads', ADMIN, { host: HOST, team: VACANT, principal: 'user:no-flag' });
    const r = await release(I.vacant.item, WHO.无关的人), d = await detail(I.vacant.item, WHO.管理层);
    check(c.status === 200 && p.status === 202 && r.status === 404 && show(d) === show({ can: true, turn: false }),
      '管理口令提议的负责人（待确认）不算负责人：放不了（看不到，404）；团队仍算没有负责人，管理层照旧能代办', show({ claim: c.status, propose: p.status, r: r.status, d }));
  }
  // ---------- 团队没有负责人：管理层代办 ----------
  {
    const d = { 管理层: await detail(I.vacant.item, WHO.管理层), 负责人: await detail(I.vacant.item, WHO.负责人) };
    check(show(d) === show({ 管理层: { can: true, turn: false }, 负责人: { status: 404 } }), '没有负责人的团队：管理层能代办、不轮到他；别的团队的负责人看不到', show(d));
    const r = await release(I.vacant.item, WHO.管理层);
    check(r.status === 200 && r.body?.acting_for === 'team-lead' && show(released(I.vacant.event)) === show([{ actor: 'user:root-admin', acting_for: 'team-lead' }]) && show(factOf(I.vacant.item)) === show([{ actor: 'user:root-admin', acting_for: 'team-lead' }]),
      '管理层代办放行：应答、事件日志、事项日志都记 acting_for = team-lead，人记管理层本人', show({ r: r.body, ev: released(I.vacant.event), f: factOf(I.vacant.item) }));
  }
  // ---------- 建立人勾了先过目 ----------
  {
    const d = { 建立人: await detail(I.requester.item, WHO.建立人), 负责人: await detail(I.requester.item, WHO.负责人), 管理层: await detail(I.requester.item, WHO.管理层) };
    check(show(d) === show({ 建立人: { can: true, turn: true }, 负责人: { can: false, turn: false }, 管理层: { can: false, turn: false } }), '建立人自己过目：建立人 can、turn 都真；负责人、管理层都不能', show(d));
    const l = await release(I.requester.item, WHO.负责人), g = await release(I.requester.item, WHO.管理层), c = await release(I.requester.item, WHO.建立人);
    check(l.status === 403 && g.status === 403 && c.status === 200 && show(factOf(I.requester.item)) === show([{ actor: 'user:alpha', acting_for: null }]), '放行入口：负责人、管理层 403；建立人 200，留痕记建立人', show({ l: l.status, g: g.status, c: c.body }));
  }
  // ---------- 没放过、已经不在等过目 ----------
  {
    const w = await call('POST', `/api/task-center/tasks/${I.withdrawn.task}/withdraw`, ADMIN, {});
    const r = await release(I.withdrawn.item, WHO.负责人);
    check(w.status === 200 && r.status === 409 && r.body?.error === 'work_item_not_held' && released(I.withdrawn.event).length === 0, '撤回之后（没放过）：409 work_item_not_held，什么都没放', show({ w: w.status, r }));
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
