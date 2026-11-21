#!/usr/bin/env node
/**
 * 任务带领域（领域第 2 步 4a，docs/domains-step1.md 第三节第 1 小节、第七节第 1 条）：建事项时显式选领域。隔离实例（NODE_ENV=test，假的登录提供方）。
 * 合成的人：alpha 持 area:sales 的领域成员；beta 只持停写前的 dept:sales 部门成员；no-flag 是管理层；strasse 只有范围「全部」的普通员工。
 * 领域 sales 有负责人（active），ops 还没有（pending-lead），old 撤了；部门 sales 还在（停写前的）。任务中心上绑一个通知团队 team-a。
 * 授予一律直接写库造，并先断言它们确实在、是 active（统筹 11-20：前置没造出来时，「被拒」的断言不能白白成立）。
 *
 *   T1 持 area:sales 的领域成员带 area=sales 建事项：201，事项记下领域（area_id=sales、area_source=chosen），详情带领域名
 *   T2 没有这个领域授予的人（只有「全部」的普通员工）：403 area_trigger_forbidden，没有建出事项
 *   T3 只持 dept:sales 的人：403（新的 area.* 不认 dept:，过渡期等同只给台和经验库）
 *   T4 领域还没有负责人（ops，pending-lead）：管理层建也是 409 area_no_lead
 *   T5 领域撤了（old）：409 area_retired；不存在（nope）：管理层 404 area_missing，看不到全部领域的人 403（不透露在不在）
 *   T6 写法不对（大写、带符号、数字）：400 area_invalid；空串当成没给
 *   T7 不带 area：和今天一样建，事项上没有领域
 *   T8 列表按领域筛 ?area=sales：只有带这个领域的；写法不对 400
 *   T9 幂等：同一个键换了领域 409 idempotency_conflict；同样的请求再来一次 200 duplicate
 *   T10 「以某人的身份看」：area.trigger 在 area:sales 上，alpha allow、beta 和 strasse deny——和实际一致
 *   T11 判定切换开关开着（WM_JUDGMENT_ENFORCE=area,work-items）：建事项这条路由声明了状态码不代表授权，持 area:sales 的人照样能带领域建
 *
 *   node scripts/area-task-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { legacySeed } from './lib/legacy-dept-seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `area-task-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const REMOTE = { 'x-forwarded-for': '192.0.2.73' };
const TEAM = 'dsh/canvas/team-a';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const children = [];
async function start(name, extra = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, ...extra });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例 ${name} 没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
  const host = new URL(base).host;
  const call = async (method, path, { session, body } = {}) => {
    const h = session ? { ...REMOTE, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', cookie: `session_id=${session}` } : {};
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json, text };
  };
  const dbFile = join(data, 'workbench-market.db');
  const q = (sql, ...a) => { const d = new DatabaseSync(dbFile, { timeout: 10000 }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
  const exec = (fn) => { const d = new DatabaseSync(dbFile, { timeout: 10000 }); try { return fn(d); } finally { d.close(); } };
  for (const s of [SESSIONS.alpha, SESSIONS.beta, SESSIONS.noAdminFlag, SESSIONS.strasse]) await call('GET', '/api/auth/viewer', { session: s });
  // 现场：通知团队、领域、停写前的部门、授予（直接写库；授予起草、提交、放行三步各记一行痕）
  exec((d) => {
    d.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by, revoked_at) VALUES ('sop', 'task-center', ?, 'notify', 'read', 'http://127.0.0.1:1', 'seed', '')").run(TEAM);
    for (const [id, status] of [['sales', 'active'], ['ops', 'pending-lead'], ['old', 'retired']]) d.prepare("INSERT INTO areas (id, name, status, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 0, 'cli', 0, 'cli')").run(id, `合成${id}`, status);
  });
  const seed = legacySeed(dbFile);
  seed.department('sales', '合成销售部');
  seed.grant('user:alpha', 'area-member', 'area:sales', { reason: '合成' });
  seed.grant('user:beta', 'dept-member', 'dept:sales', { reason: '合成：停写前就有的' });
  seed.grant('user:no-flag', 'management', '*', { reason: '合成' });
  seed.grant('user:strasse', 'member', '*', { reason: '合成' });
  return { call, q, exec };
}

let keyN = 0;
const body = (area, extra = {}) => ({ title: '合成：对一下出货', intent: '把出货单和对账单对一遍', deliverable: '一张差异表', team: TEAM, idempotency_key: `area-task-key-${String(++keyN).padStart(6, '0')}`, ...(area === undefined ? {} : { area }), ...extra });

rmSync(OUT, { recursive: true, force: true });
try {
  const A = await start('main');
  const P = { alpha: SESSIONS.alpha, beta: SESSIONS.beta, mgmt: SESSIONS.noAdminFlag, staff: SESSIONS.strasse };
  const items = () => Number(A.q('SELECT COUNT(*) AS n FROM work_items')[0].n);
  const grantsNow = A.q("SELECT principal_id, role, scope, status FROM grants WHERE principal_id IN ('user:alpha', 'user:beta', 'user:no-flag', 'user:strasse') ORDER BY principal_id, role").map((r) => `${r.principal_id} ${r.role} ${r.scope} ${r.status}`);
  const areasNow = A.q('SELECT id, status FROM areas ORDER BY id').map((r) => `${r.id}:${r.status}`);
  check(JSON.stringify(grantsNow) === JSON.stringify(['user:alpha area-member area:sales active', 'user:beta dept-member dept:sales active', 'user:no-flag management * active', 'user:strasse member * active'])
    && JSON.stringify(areasNow) === JSON.stringify(['old:retired', 'ops:pending-lead', 'sales:active']),
    '（前置）四条授予确实在、都是 active；领域 sales active、ops pending-lead、old retired', { grantsNow, areasNow });

  // ---- T1 ----
  let t1Item = null;
  {
    const r = await A.call('POST', '/api/work-items', { session: P.alpha, body: body('sales') });
    t1Item = r.json?.item_id ?? null;
    const row = A.q('SELECT * FROM work_items WHERE id = ?', t1Item ?? '')[0];
    const det = await A.call('GET', `/api/work-items/${t1Item}`, { session: P.alpha });
    const s = { status: r.status, row: row && { area_id: row.area_id, area_source: row.area_source }, area: det.json?.item?.area ?? det.json?.area };
    check(r.status === 201 && row?.area_id === 'sales' && row.area_source === 'chosen' && s.area?.id === 'sales' && s.area?.name === '合成sales',
      'T1 持 area:sales 的领域成员带 area=sales 建事项：201，事项记下领域（chosen），详情带领域名', s);
  }

  // ---- T2、T3 ----
  {
    const before = items();
    const staff = await A.call('POST', '/api/work-items', { session: P.staff, body: body('sales') });
    const dept = await A.call('POST', '/api/work-items', { session: P.beta, body: body('sales') });
    const s = { staff: `${staff.status}/${staff.json?.error}`, dept: `${dept.status}/${dept.json?.error}`, made: items() - before };
    check(s.staff === '403/area_trigger_forbidden' && s.made === 0, 'T2 没有这个领域授予的人（只有「全部」的普通员工）：403 area_trigger_forbidden，没有建出事项', s);
    check(s.dept === '403/area_trigger_forbidden' && s.made === 0, 'T3 只持 dept:sales 的人：403（新的 area.* 不认 dept:）', s);
  }

  // ---- T4、T5 ----
  {
    const before = items();
    const pend = await A.call('POST', '/api/work-items', { session: P.mgmt, body: body('ops') });
    const ret = await A.call('POST', '/api/work-items', { session: P.mgmt, body: body('old') });
    const missMgmt = await A.call('POST', '/api/work-items', { session: P.mgmt, body: body('nope') });
    const missAlpha = await A.call('POST', '/api/work-items', { session: P.alpha, body: body('nope') });
    const retAlpha = await A.call('POST', '/api/work-items', { session: P.alpha, body: body('old') });
    const c = (r) => `${r.status}/${r.json?.error}`;
    const s = { pend: c(pend), ret: c(ret), missMgmt: c(missMgmt), missAlpha: c(missAlpha), retAlpha: c(retAlpha), made: items() - before };
    check(s.pend === '409/area_no_lead' && s.made === 0, 'T4 领域还没有负责人（ops）：管理层建也是 409 area_no_lead', s);
    check(s.ret === '409/area_retired' && s.missMgmt === '404/area_missing' && s.missAlpha === '403/area_trigger_forbidden' && s.retAlpha === '403/area_trigger_forbidden' && s.made === 0,
      'T5 领域撤了：409 area_retired；不存在：管理层 404，看不到全部领域的人 403（不透露在不在、撤没撤）', s);
  }

  // ---- T6、T7 ----
  {
    const before = items();
    const bad = [await A.call('POST', '/api/work-items', { session: P.mgmt, body: body('Sales') }), await A.call('POST', '/api/work-items', { session: P.mgmt, body: body('a b') }), await A.call('POST', '/api/work-items', { session: P.mgmt, body: body(7) })];
    const made = items() - before;
    const empty = await A.call('POST', '/api/work-items', { session: P.alpha, body: body('') });
    const none = await A.call('POST', '/api/work-items', { session: P.staff, body: body(undefined) });
    const rows = A.q('SELECT * FROM work_items WHERE id IN (?, ?)', empty.json?.item_id ?? '', none.json?.item_id ?? '');
    const s = { bad: bad.map((r) => `${r.status}/${r.json?.error}`), made, empty: empty.status, none: none.status, rows: rows.map((r) => [r.area_id, r.area_source]) };
    check(s.bad.every((x) => x === '400/area_invalid') && made === 0, 'T6 领域写法不对（大写、带空格、数字）：400 area_invalid，没有建出事项', s);
    check(empty.status === 201 && none.status === 201 && rows.length === 2 && rows.every((r) => 'area_id' in r && r.area_id === null && r.area_source === null),
      'T7 不带 area、给空串：和今天一样建，事项上没有领域（普通员工照样能建）', s);
  }

  // ---- T8 ----
  {
    const list = await A.call('GET', '/api/work-items?area=sales', { session: P.alpha });
    const all = await A.call('GET', '/api/work-items', { session: P.alpha });
    const bad = await A.call('GET', '/api/work-items?area=Bad!', { session: P.alpha });
    const ids = (list.json?.items ?? []).map((x) => x.id);
    const s = { status: list.status, ids, all: (all.json?.items ?? []).length, bad: `${bad.status}/${bad.json?.error}` };
    check(list.status === 200 && ids.length === 1 && ids[0] === t1Item && s.all >= 2 && s.bad === '400/area_invalid',
      'T8 列表按领域筛：?area=sales 只有带这个领域的那一件；不筛照旧全列；写法不对 400', s);
  }

  // ---- T9 ----
  {
    const b1 = body('sales');
    const first = await A.call('POST', '/api/work-items', { session: P.alpha, body: b1 });
    const same = await A.call('POST', '/api/work-items', { session: P.alpha, body: b1 });
    const other = await A.call('POST', '/api/work-items', { session: P.alpha, body: { ...b1, area: '' } });
    const s = { first: first.status, same: `${same.status}/${same.json?.duplicate}`, other: `${other.status}/${other.json?.error}` };
    check(first.status === 201 && s.same === '200/true' && s.other === '409/idempotency_conflict',
      'T9 幂等：同样的请求再来一次 200 duplicate；同一个键换了领域 409 idempotency_conflict', s);
  }

  // ---- T10 ----
  {
    const ask = async (who) => (await A.call('GET', `/api/principals/${who}/access?action=area.trigger&scope=area:sales`)).json?.decision?.verdict;
    const s = { alpha: await ask('user:alpha'), beta: await ask('user:beta'), staff: await ask('user:strasse') };
    check(s.alpha === 'allow' && s.beta === 'deny' && s.staff === 'deny', 'T10 「以某人的身份看」：area.trigger 在 area:sales 上 alpha allow、beta 和 strasse deny——和 T1～T3 实际一致', s);
  }

  // ---- T11 ----
  {
    const B = await start('enforce', { WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_ENFORCE: 'area,work-items' });
    const r = await B.call('POST', '/api/work-items', { session: SESSIONS.alpha, body: body('sales') });
    const staff = await B.call('POST', '/api/work-items', { session: SESSIONS.strasse, body: body('sales') });
    const s = { alpha: `${r.status}/${r.json?.error ?? ''}`, staff: `${staff.status}/${staff.json?.error}` };
    check(r.status === 201 && s.staff === '403/area_trigger_forbidden',
      'T11 判定切换开关开着（area、work-items 两个域）：建事项按事项上的规则判（状态码不代表授权），持 area:sales 的人照样能带领域建，没授予的照样 403', s);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) { c.kill('SIGTERM'); }
  await sleep(500);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${fail ? '✗' : '✓'} 任务带领域（4a）：${pass} 过、${fail} 不过`);
process.exit(fail ? 1 : 0);
