#!/usr/bin/env node
/**
 * 停太久的事项进「等你拍板」（规范 14 第九节：卡住的冒给负责人，没有负责人冒给管理层）。起隔离实例（假的登录提供方，NODE_ENV=test）：
 *
 *   算停太久：已转交、已接单、在做、在等、卡住这几步里，最后一次变动早于 WM_WORK_ITEM_STUCK_HOURS（缺省 24）小时
 *     差一分钟到阈值的不算；等过目（held）、等验收（ready）、有在等答复的提问的不算（它们另有条目）
 *   冒给谁：事项交给的团队的负责人（mine 为真）；团队没有负责人时持有管理层授予的人（不认管理门）；
 *     建立人、无关的人、只授系统管理员的人、只过了管理门没有授予的系统管理员、只有管理口令的都没有（stuck_count 0）
 *   不算进角标：没有当场的答法（answers 空、没有 answer_via）；/api/attention 的 counts.stuck_count 单独数，含超出上限的
 *   上限：一次最多 50 条，按停得最久的排；来源的件数和 stuck_count 是总数
 *   WM_WORK_ITEM_STUCK_HOURS 坏值拒绝启动
 *
 *   node scripts/work-item-stuck-test.mjs              测本仓库
 *   node scripts/work-item-stuck-test.mjs --root DIR   测另一棵目录树（变异测试用）
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
const OUT = join(HERE, '..', 'tmp', `work-item-stuck-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'stuck-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid';
const TEAM = 'zone1/canvas/Team A', VACANT = 'zone1/canvas/Team B';
const MANY = 55;

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

  // ---------- 坏的阈值拒绝启动 ----------
  for (const bad of ['0', '721', 'x', '1.5', '-3']) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: '0', DATA_DIR: join(OUT, `bad-${bad}`), WM_WORK_ITEM_STUCK_HOURS: bad }, encoding: 'utf8', timeout: 60_000 });
    check(r.status === 1 && r.stderr.includes('WM_WORK_ITEM_STUCK_HOURS'), `WM_WORK_ITEM_STUCK_HOURS=${bad}：拒绝启动`, show({ status: r.status, err: r.stderr.slice(-200) }));
  }

  // 事项：都经任务中心的事件建，推到各自的状态（只经事项服务）
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
    let n = 0;
    const mk = (team, who, facts) => {
      const title = '合成：第 ' + (++n) + ' 件';
      const id = Number(db.prepare("INSERT INTO tasks (title, status) VALUES (?, 'published')").run(title).lastInsertRowid);
      const f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
      db.exec('BEGIN IMMEDIATE');
      const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: who, publisherPrincipal: who, templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: who } });
      db.exec('COMMIT');
      items.syncEvent(e);
      const wid = itemIdForEvent(e);
      for (const [k, x] of facts) items.apply(wid, { kind: k, source: 'seed', id: wid + ':' + k, ...x });
      return { id: wid, event: e };
    };
    const REL = [['release', {}]];
    const out = {
      old: mk(${JSON.stringify(TEAM)}, 'user:alpha', REL), edge: mk(${JSON.stringify(TEAM)}, 'user:zeta', REL), fresh: mk(${JSON.stringify(TEAM)}, 'user:zeta', REL),
      held: mk(${JSON.stringify(TEAM)}, 'user:zeta', []), ready: mk(${JSON.stringify(TEAM)}, 'user:zeta', [['release', {}], ['receipt', { outcome: 'completed' }]]),
      asked: mk(${JSON.stringify(TEAM)}, 'user:zeta', REL), vac: mk(${JSON.stringify(VACANT)}, 'user:zeta', REL),
      many: Array.from({ length: ${MANY} }, () => mk(${JSON.stringify(TEAM)}, 'user:zeta', REL).id),
    };
    // 「在问」：接单节点问了一句，还没答
    const d = db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ?').get(out.asked.event).id;
    db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = '2026-01-01 00:00:00', decision = 'ask', decision_reason = '合成：哪一批？', decided_by = 'bob', decided_at = '2026-01-01 00:00:01' WHERE id = ?").run(d);
    db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(out.asked.event, d);
    db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(out.asked.event, d, JSON.stringify({ reason: '合成：哪一批？' }));
    items.syncEvent(out.asked.event);
    out.states = Object.fromEntries(['old', 'held', 'ready', 'asked', 'vac'].map((k) => [k, items.get(out[k].id).state]));
    console.log('SEEDED ' + JSON.stringify(out));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
  if (show(I.states) !== show({ old: 'delivered', held: 'held', ready: 'ready', asked: 'blocked', vac: 'delivered' })) throw new Error(`状态没推对：${show(I.states)}`);
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
  // 管理层：一个普通员工（no-flag，身份来源不说他是管理员）拿一份管理层授予；只过管理门的系统管理员（root-admin，没有任何授予）、只有管理口令的都不算
  const WHO = { 负责人: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 管理层: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` }, 建立人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` },
    无关的人: { ...SAME, cookie: `session_id=${SESSIONS.strasse}` }, 只过管理门: { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, 只有管理口令: { ...SAME, 'x-admin-token': ADMIN_TOKEN } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  const grantRole = async (principal, role) => {
    const d = await call('POST', '/api/grants', {}, { principal, role, scope: '*', reason: `合成：${role}` });
    await call('POST', `/api/grants/${d.body?.grant?.id}/submit`, {}, {});
    return call('POST', `/api/grants/${d.body?.grant?.id}/approve`, {}, {});
  };
  {
    const g = await grantRole('user:no-flag', 'management');
    if (g.status !== 200) throw new Error(`管理层授予没放成：${show(g)}`);
  }
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'));
    const now = Date.now();
    db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)').run(HOST, PEER, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
    const seatIns = db.prepare('INSERT INTO a2a_roster_seats (peer_root, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ((SELECT peer_root FROM a2a_rosters WHERE host = ?1 ORDER BY rowid LIMIT 1), ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)');
    seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', now, now);
    seatIns.run(HOST, VACANT, 'zone1/0000000d', 'seat-0000000d', '合成别队总工', 'router', now, now);
    // 最后一次变动的时间：停太久的 25～30 小时前（越靠前越久），差一分钟到阈值的、刚动过的
    const H = 3_600_000;
    const at = db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?');
    at.run(sqlTime(now - 30 * H), I.old.id);
    at.run(sqlTime(now - 24 * H + 60_000), I.edge.id);
    at.run(sqlTime(now - 1 * H), I.fresh.id);
    for (const k of ['held', 'ready', 'asked', 'vac']) at.run(sqlTime(now - 40 * H), I[k].id);
    I.many.forEach((id, i) => at.run(sqlTime(now - 25 * H - i * 60_000), id));
    db.close();
  }
  // 部门负责人、团队认领由属主（本机命令行）做：团队 A 有负责人（beta），团队 B 认领到没有负责人的部门
  for (const [m2, p, b] of [['PUT', '/api/departments/sales', { name: '合成销售部', lead: 'user:beta' }], ['PUT', '/api/departments/nolead', { name: '合成没有负责人的部门' }],
    ['POST', '/api/teams/claim', { host: HOST, team: TEAM, department: 'sales' }], ['POST', '/api/teams/claim', { host: HOST, team: VACANT, department: 'nolead' }]]) {
    const r = await call(m2, p, {}, b);
    if (r.status >= 300) throw new Error(`团队搭不起来：${p} ${show(r)}`);
  }
  const attention = (h) => call('GET', '/api/attention', h);
  const stuckOf = (r) => (r.body?.items ?? []).filter((x) => x.source === 'work-items-stuck');

  // ---------- 负责人 ----------
  {
    const r = await attention(WHO.负责人);
    const s = stuckOf(r), ids = s.map((x) => x.source_id);
    const expectTotal = 1 + MANY;
    check(r.status === 200 && s.length === 50 && r.body.counts.stuck_count === expectTotal && r.body.sources['work-items-stuck']?.count === expectTotal,
      `负责人：一次最多 50 条；来源件数和 stuck_count 是总数（${expectTotal}）`, show({ n: s.length, stuck: r.body?.counts?.stuck_count, src: r.body?.sources?.['work-items-stuck'] }));
    check(ids[0] === I.old.id && show(ids.slice(1)) === show([...I.many].reverse().slice(0, 49)), '按停得最久的排：30 小时的那件在最前，其余按停的时间从久到短（超出 50 条的是停得最短的那几件）', show(ids.slice(0, 3)));
    check(![I.edge.id, I.fresh.id, I.held.id, I.ready.id, I.asked.id, I.vac.id].some((id) => ids.includes(id)),
      '不算停太久的：差一分钟到阈值的、刚动过的、等过目的、等验收的、有在等答复的提问的；别的团队（没有负责人）的不冒给他', show(ids.filter((id) => [I.edge.id, I.fresh.id, I.held.id, I.ready.id, I.asked.id, I.vac.id].includes(id))));
    check(s.every((x) => x.mine === true && x.answers.length === 0 && !x.answer_via && x.category === 'glance' && x.link === `/work-items/${x.source_id}`),
      '条目：轮到他（mine）、没有当场的答法（不算进角标）、链到事项页', show(s[0]));
    check(r.body.counts.total === (r.body.items ?? []).length, 'counts.total 照旧只数给出来的条目（角标的数不变）', show(r.body.counts));
  }
  // ---------- 管理层 ----------
  {
    const r = await attention(WHO.管理层), ids = stuckOf(r).map((x) => x.source_id);
    check(show(ids) === show([I.vac.id]) && r.body.counts.stuck_count === 1, '持有管理层授予的人：只有没有负责人的团队的那件（有负责人的冒给负责人，不冒给管理层）', show({ ids, n: r.body?.counts?.stuck_count }));
  }
  // ---------- 过了管理门、没有管理层授予（#634 的过渡不往这里扩） ----------
  {
    const grants = await call('GET', '/api/grants', {});
    const rootGrants = (grants.body?.grants ?? grants.body ?? []).filter?.((g) => g.principal_id === 'user:root-admin' && g.status === 'active') ?? [];
    const g = await attention(WHO.只过管理门), t = await attention(WHO.只有管理口令);
    check(g.status === 200 && rootGrants.length === 0 && stuckOf(g).length === 0 && g.body.counts.stuck_count === 0,
      '只过了管理门的系统管理员（身份来源说是管理员、没有任何授予）：一条没有，stuck_count 是 0（条目带事项标题，不冒给他）', show({ s: g.status, grants: rootGrants.length, n: g.body?.counts?.stuck_count, ids: stuckOf(g).map((x) => x.title) }));
    check(t.status === 200 && stuckOf(t).length === 0 && t.body.counts.stuck_count === 0,
      '只有管理口令：一条没有，stuck_count 是 0', show({ s: t.status, n: t.body?.counts?.stuck_count, ids: stuckOf(t).map((x) => x.title) }));
  }
  // ---------- 别人 ----------
  {
    const c = await attention(WHO.建立人), o = await attention(WHO.无关的人);
    check(stuckOf(c).length === 0 && c.body.counts.stuck_count === 0 && stuckOf(o).length === 0 && o.body.counts.stuck_count === 0,
      '建立人（停太久那件就是他建的）、无关的人：一条没有，stuck_count 是 0', show({ c: c.body?.counts?.stuck_count, o: o.body?.counts?.stuck_count }));
    // 只授系统管理员（不是身份来源管理员）：授予由本机命令行（属主）走完
    const a = await grantRole('user:strasse', 'admin');
    const s = await attention(WHO.无关的人);
    check(a.status === 200 && stuckOf(s).length === 0 && s.body.counts.stuck_count === 0, '只授系统管理员角色：一条没有（不看事项内容，没有负责人的团队也不冒给他）', show({ g: a.status, n: s.body?.counts?.stuck_count }));
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
