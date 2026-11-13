#!/usr/bin/env node
/**
 * 事项列表各视角的「等你拍板」件数（GET /api/work-items 的 views.<视角>.decide）和侧栏角标同一个判法（对抗组）。
 * 起隔离实例（假的登录提供方，NODE_ENV=test），合成名册、部门、团队认领、负责人、管理层授予：
 *
 *   身份：alpha（建立人）、beta（Team A 的负责人，自己也建了事项）、管理层（持有管理层授予的身份来源管理员，自己也建了一件）
 *   事项：交给有负责人的 Team A 等过目的、交给没有负责人的 Team B 等过目的、建立人自己过目的、在问的（席位提问一条）、等验收的，
 *         轮到 alpha 却办不了的（来源未验证的建立人，等验收），
 *         beta 自己建、交给自己团队的等过目的（同时在 beta 的「我发起的」和「我负责的团队」两个视角里，并集要去重），管理层自己建的等验收的
 *   守的：
 *   - 同一身份下，各视角 decide 等于这个视角的列表里「关注」中轮到他、能当场办的事项件数（mine 不为假、有答法，和角标同一个判法）；
 *     各视角里这些事项去重后的并集，等于「关注」里事项来源轮到他的全部
 *   - 件数写死：alpha 3（自己过目、在问、等验收）；beta 我发起的 1、我负责的团队 2、并集 2；管理层 我发起的 1、全部 1（代办的不算轮到他）
 *   - 不可用的视角不给 decide
 *   - 当场办掉一件，decide 跟着少一件
 *   - 开销：另压 3000 件别人的没结束事项（2000 件等验收、1000 件等过目），管理层看「全部」的中位数不到 250 ms（只判可能轮到他的候选）
 *   变异：判断换成按状态算（held、ready、有提问就算）、只看轮到（不看能不能办）、只看能办（不看轮到）都必须红
 *
 *   node scripts/work-item-view-decide-test.mjs              测本仓库
 *   node scripts/work-item-view-decide-test.mjs --root DIR   测另一棵目录树（变异测试用）
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
const OUT = join(HERE, '..', 'tmp', `work-item-view-decide-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'view-decide-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid';
const TEAM = 'zone1/canvas/Team A', VACANT = 'zone1/canvas/Team B';
const LOAD_READY = 2000, LOAD_HELD = 1000;
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
const held = (title, team, by, extra = {}) => {
  const id = task(title), f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
  db.exec('BEGIN IMMEDIATE');
  const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: by, publisherPrincipal: by, templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: by, ...extra } });
  db.exec('COMMIT');
  items.syncEvent(e);
  return itemIdForEvent(e);
};
// 在问：派到 Team A，席位问了一句、还没人答
const asked = (title) => {
  const id = task(title), f = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
  db.exec('BEGIN IMMEDIATE');
  const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: 'user:alpha', publisherPrincipal: 'user:alpha', templateVersion: 1, materialSha256: 'h', agentDispatch: true, centerOn: true });
  db.exec('COMMIT');
  const d = db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ? AND target_team = ?').get(e, ${JSON.stringify(TEAM)});
  db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = '2026-01-01 00:00:00', decision = 'ask', decision_reason = '哪个店？', decided_by = 'bob', decided_at = '2026-01-01 00:00:01' WHERE id = ?").run(d.id);
  db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(e, d.id);
  db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(e, d.id, JSON.stringify({ reason: '哪个店？' }));
  items.syncEvent(e);
  return itemIdForEvent(e);
};
const ready = (title, by) => {
  const it = items.create({ title, created_by: by, creator_principal: by, source_kind: 'agent' });
  for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? x.verdict ?? ''), ...x });
  return it.id;
};
// 压测用的量，先造：别人建的 2000 件等验收、1000 件交给没有负责人的 Team B 等过目（管理层看得到、能代办，但都不轮到下面三个人，件数断言不受影响）。
// （「关注」的席位提问原先只看最近 200 个事件，这里曾因此先造量；现在全库直接查，见 attention-seat-asks-full-test）
for (let i = 0; i < ${LOAD_READY}; i++) ready('合成压测：等验收 ' + i, 'user:load');
for (let i = 0; i < ${LOAD_HELD}; i++) held('合成压测：等过目 ' + i, ${JSON.stringify(VACANT)}, 'user:load');
const out = {
  leadHeld: held('合成：交给有负责人的团队', ${JSON.stringify(TEAM)}, 'user:alpha'),
  vacantHeld: held('合成：交给没有负责人的团队', ${JSON.stringify(VACANT)}, 'user:alpha'),
  selfHeld: held('合成：建立人自己过目', ${JSON.stringify(TEAM)}, 'user:alpha', { handoff: 'own-seat', reviewBy: 'requester', directedSeatId: 'seat-0000000b' }),
  asked: asked('合成：在问'),
  ready: ready('合成：等 alpha 验收', 'user:alpha'),
  betaHeld: held('合成：beta 自己建、交给自己的团队', ${JSON.stringify(TEAM)}, 'user:beta'),
  mgmtReady: ready('合成：等管理层自己验收', 'user:root-admin'),
  // 管理层自己建、交给没有负责人的 Team B 等过目：他能放（代办负责人），但不轮到他
  mgmtVacantHeld: held('合成：管理层自己建、交给没有负责人的团队', ${JSON.stringify(VACANT)}, 'user:root-admin'),
  // 轮到 alpha（他是建立人、在等验收）、他却办不了：来源未验证的建立人只能由管理员处理
  unverified: ready('合成：来源未验证的建立人', 'user:alpha'),
};
db.prepare('UPDATE work_items SET context = ? WHERE id = ?').run(JSON.stringify({ submitter_kind: 'unverified' }), out.unverified);
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
  const WHO = { alpha: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, beta: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 管理层: { ...SAME, cookie: `session_id=${SESSIONS.admin}` } };
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

  const VIEWS = ['mine', 'seats', 'team', 'all'];
  const itemIdOf = (x) => x.source === 'work-items' ? x.source_id : (/^\/work-items\/([^/?#]+)/.exec(x.link || '') ?? [])[1] ?? null;
  /** 角标的判法（web/src/attention-view.ts 的 isMyDecision）：mine 不为假、有答法；只取事项来源的，按事项去重 */
  const turned = async (h) => new Set(((await call('GET', '/api/attention', h)).body?.items ?? []).filter((x) => x.mine !== false && (x.answers ?? []).length > 0).map(itemIdOf).filter(Boolean));
  const listAll = async (h, view) => {
    const ids = [];
    for (let cursor = null, n = 0; n < 50; n++) {
      const r = await call('GET', `/api/work-items?view=${view}&limit=200${cursor ? `&cursor=${cursor}` : ''}`, h);
      ids.push(...(r.body?.items ?? []).map((x) => x.id));
      cursor = r.body?.next_cursor; if (!cursor) break;
    }
    return ids;
  };
  const decides = async (h) => (await call('GET', '/api/work-items', h)).body?.views ?? {};

  /** 同一身份下：每个视角 decide = 这个视角列表 ∩ 关注里轮到他的；各视角的并集 = 关注里轮到他的全部 */
  const agree = async (who, expect) => {
    const h = WHO[who], views = await decides(h), att = await turned(h);
    const union = new Set(), per = {};
    for (const v of VIEWS) {
      if (!views[v]?.available) { check(!('decide' in (views[v] ?? {})), `${who}：不可用的视角「${v}」不给 decide`, show(views[v])); continue; }
      const inView = (await listAll(h, v)).filter((id) => att.has(id));
      inView.forEach((id) => union.add(id));
      per[v] = views[v].decide;
      check(views[v].decide === inView.length, `${who}：「${v}」的 decide（${views[v].decide}）等于这个视角里「关注」中轮到他、能当场办的件数（${inView.length}）`, show({ decide: views[v].decide, inView }));
    }
    check(union.size === att.size && [...att].every((id) => union.has(id)), `${who}：各视角去重后的并集（${union.size}）等于「关注」里事项来源轮到他的（${att.size}）`, show({ union: [...union], att: [...att] }));
    check(show(per) === show(expect.per) && att.size === expect.union, `${who}：件数是 ${show(expect.per)}，并集 ${expect.union}`, show({ per, att: [...att] }));
    return att;
  };

  const a = await agree('alpha', { per: { mine: 3 }, union: 3 });
  check([I.selfHeld, I.asked, I.ready].every((id) => a.has(id)) && ![I.leadHeld, I.vacantHeld, I.unverified].some((id) => a.has(id)), 'alpha：轮到的是自己过目、在问、等验收那三件；等负责人或管理层放行的两件不算，轮到他却办不了的（来源未验证）也不算', show([...a]));
  const b = await agree('beta', { per: { mine: 1, team: 2 }, union: 2 });
  check([I.leadHeld, I.betaHeld].every((id) => b.has(id)) && !b.has(I.selfHeld) && !b.has(I.asked), 'beta：放行自己团队的两件（其中一件自己建的，两个视角都有、并集只算一次）；建立人自审的、席位问建立人的不算', show([...b]));
  const g2 = await agree('管理层', { per: { mine: 1, all: 1 }, union: 1 });
  check(g2.has(I.mgmtReady) && !g2.has(I.vacantHeld) && !g2.has(I.mgmtVacantHeld) && !g2.has(I.ready), '管理层：只有自己建的那件等验收；没有负责人的团队那两件（包括他自己建的）是代办（能办、不轮到他），不算', show([...g2]));

  // 开销：3000 件没结束的事项压着，持管理层授予的人看「全部」。decide 只在可能轮到他的候选上判，列表要和没有 decide 时同一个量级。
  // 量 7 次取中位数；本机只判候选时 20～60 ms（四个并行跑），逐件判全部时 400～1100 ms；上限 250 ms 留了慢机器的余量，又分得开
  {
    const times = [];
    for (let i = 0; i < 7; i++) { const t0 = performance.now(); const r = await call('GET', '/api/work-items?view=all', WHO.管理层); times.push(Math.round(performance.now() - t0)); if (r.status !== 200) throw new Error(`列表 ${r.status}`); }
    const med = [...times].sort((x, y) => x - y)[3];
    console.log(`  · 管理层看「全部」（${LOAD_READY + LOAD_HELD} 件压测事项）：${times.join('、')} ms，中位数 ${med} ms`);
    check(med < 250, `压着 ${LOAD_READY + LOAD_HELD} 件没结束的事项，管理层看「全部」的列表中位数 ${med} ms，不到 250 ms（不逐件判全部）`, show(times));
  }

  // 当场办掉一件：decide 跟着少
  const r = await call('POST', `/api/work-items/${I.leadHeld}/release`, WHO.beta, {});
  const after = await decides(WHO.beta);
  check(r.status === 200 && after.team?.decide === 1 && after.mine?.decide === 1, 'beta 放行一件之后：「我负责的团队」2 → 1，「我发起的」不变', show({ r: r.status, team: after.team, mine: after.mine }));
  await agree('beta', { per: { mine: 1, team: 1 }, union: 1 });
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}\n${log.slice(-1500)}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); }); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
