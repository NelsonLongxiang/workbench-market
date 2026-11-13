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
  const deliveries = (eventId) => { const d = dbr(); try { return d.prepare('SELECT target_team, status FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id').all(eventId).map((r) => ({ ...r })); } finally { d.close(); } };
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
