#!/usr/bin/env node
/**
 * 部门读写接口的对抗组（安全面）。真实的 server/src/index.ts，身份来源是假提供方（identity-fake-provider.mjs），
 * 只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、空就是空：没建部门时登录的人读到空数组
 *   二、读：登录的人、管理员、本机命令行能读；远程匿名、身份来源不可达、门户账号 401；跨站 403；主体停用的读不到
 *   三、写：只有管理员和本机命令行；登录的员工、远程匿名、带有效口令的跨站都拒，库里没有变化
 *   四、输入：标识、名称、职能代号的写法，负责人要是已有的人，职能代号唯一，成员要是人或席位
 *   五、读到的形状：负责人（主体和显示名）、成员人数、成员列表、某人属于哪些部门（成员的、负责的）；不写的字段改时保持原样、null 清掉
 *   六、和授予的关系：dept:<标识> 只认部门表里有的部门；还有没结束的部门授予时不能删，撤销之后能删，成员一起删
 *   七、读接口不带事项内容；写记一行日志
 *
 *   node scripts/departments-smoke.mjs              测本仓库
 *   node scripts/departments-smoke.mjs --root DIR   测另一棵目录树
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `departments-smoke-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-departments-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.61' };
const token = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

let child = null;
async function boot() {
  const port = await freePort();
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  return { base, host: new URL(base).host, call, log: () => log, db: () => new DatabaseSync(join(data, 'workbench-market.db')) };
}

try {
  const srv = await boot();
  const db = srv.db();
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };
  const asAlpha = { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha };
  const asRoot = { headers: { ...REMOTE, ...same }, session: SESSIONS.admin };
  // 让假提供方认出的人进主体表；再放一个席位和一个系统身份
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  db.exec("INSERT INTO principals (id, id_key, kind, display_name, owner) VALUES ('seat:bot', 'seat:bot', 'seat', '合成席位', 'user:alpha'), ('system:cron', 'system:cron', 'system', '合成系统', 'user:alpha')");
  const rows = () => Number(db.prepare('SELECT (SELECT COUNT(*) FROM departments) + (SELECT COUNT(*) FROM department_members) AS n').get().n);

  // ---------- 一、空就是空 ----------
  {
    const r = await srv.call('GET', '/api/departments', asAlpha);
    check(r.status === 200 && show(r.json) === '{"departments":[]}' && r.text.length < 40, '没建部门时，登录的人读到空数组，不造数据', show({ status: r.status, body: r.text.slice(0, 80) }));
  }

  // ---------- 三、写：只有管理员和本机命令行 ----------
  {
    const body = { name: '合成部门' };
    const denied = {
      staff: await srv.call('PUT', '/api/departments/sales', { ...asAlpha, body }),
      anonymous: await srv.call('PUT', '/api/departments/sales', { headers: REMOTE, body }),
      wrongToken: await srv.call('PUT', '/api/departments/sales', { headers: { ...REMOTE, 'x-admin-token': 'nope' }, body }),
      crossSiteToken: await srv.call('PUT', '/api/departments/sales', { headers: { ...token, ...cross }, body }),
      staffMember: await srv.call('PUT', '/api/departments/sales/members/user:alpha', asAlpha),
      staffDelete: await srv.call('DELETE', '/api/departments/sales', asAlpha),
    };
    const bad = Object.entries(denied).filter(([, r]) => r.status !== 401 && r.status !== 403).map(([k, r]) => [k, r.status]);
    check(bad.length === 0 && rows() === 0, '写部门：登录的员工、远程匿名、口令错的、带有效口令的跨站一律被拒（401/403），库里没有变化', show({ bad, rows: rows() }));
    const t0 = Date.now();
    const byToken = await srv.call('PUT', '/api/departments/sales', { headers: token, body: { name: '  合成销售部  ', function_code: 'dp_sales', lead: 'user:alpha' } });
    const byRoot = await srv.call('PUT', '/api/departments/ops', { ...asRoot, body: { name: '合成运营部' } });
    const byCli = await srv.call('PUT', '/api/departments/rnd', { body: { name: '合成研发部', function_code: 'dp_product' } });
    const at = Number(db.prepare("SELECT updated_at FROM departments WHERE id = 'sales'").get()?.updated_at);
    check(byToken.status === 201 && byToken.json?.department?.name === '合成销售部' && byRoot.status === 201 && byCli.status === 201
      && db.prepare("SELECT updated_by FROM departments WHERE id = 'ops'").get()?.updated_by === 'odoo:root-admin' && at >= t0 && at <= Date.now(),
      '对照：口令管理员、管理员登录同源、本机命令行能建部门；名称去掉首尾空白；改动的人和时间（代码给的毫秒）记下',
      show({ token: byToken.status, root: byRoot.status, cli: byCli.status, at, t0 }));
  }

  // ---------- 四、输入 ----------
  {
    const put = (id, body) => srv.call('PUT', `/api/departments/${id}`, { headers: token, body });
    const cases = {
      badId: [await put('Sales', { name: 'x' }), 400],
      longId: [await put('a'.repeat(49), { name: 'x' }), 400],
      noName: [await put('x1', {}), 400],
      blankName: [await put('x1', { name: '   ' }), 400],
      longName: [await put('x1', { name: '名'.repeat(65) }), 400],
      ctrlName: [await put('x1', { name: 'a\u0007b' }), 400],
      badCode: [await put('x1', { name: 'x', function_code: 'DP-1' }), 400],
      takenCode: [await put('x1', { name: 'x', function_code: 'dp_sales' }), 409],
      leadUnknown: [await put('x1', { name: 'x', lead: 'user:nobody' }), 422],
      leadSeat: [await put('x1', { name: 'x', lead: 'seat:bot' }), 422],
      leadType: [await put('x1', { name: 'x', lead: 42 }), 400],
      memberSystem: [await srv.call('PUT', '/api/departments/sales/members/system:cron', { headers: token }), 422],
      memberMissing: [await srv.call('PUT', '/api/departments/sales/members/user:nobody', { headers: token }), 404],
      memberBadId: [await srv.call('PUT', '/api/departments/sales/members/nobody', { headers: token }), 400],
      deptMissing: [await srv.call('PUT', '/api/departments/nope/members/user:alpha', { headers: token }), 404],
      readMissing: [await srv.call('GET', '/api/departments/nope', asAlpha), 404],
      readBadId: [await srv.call('GET', '/api/departments/NOPE', asAlpha), 400],
    };
    const bad = Object.entries(cases).filter(([, [r, want]]) => r.status !== want).map(([k, [r, want]]) => [k, r.status, want]);
    check(bad.length === 0 && !db.prepare("SELECT 1 FROM departments WHERE id = 'x1'").get(),
      '输入：标识、名称、职能代号的写法不对 400；职能代号被占 409；负责人不存在或不是人 422；成员是系统身份 422、不存在 404；部门不存在 404；被拒的一条都没写进去', show(bad));
  }

  // ---------- 五、读到的形状 ----------
  {
    await srv.call('PUT', '/api/departments/sales/members/user:alpha', { headers: token });
    await srv.call('PUT', '/api/departments/sales/members/user:beta', { headers: token });
    const again = await srv.call('PUT', '/api/departments/sales/members/user:beta', { headers: token });
    await srv.call('PUT', '/api/departments/sales/members/seat:bot', { headers: token });
    await srv.call('PUT', '/api/departments/ops/members/user:alpha', { headers: token });
    const list = await srv.call('GET', '/api/departments', asAlpha);
    const sales = list.json?.departments?.find((d) => d.id === 'sales');
    const ops = list.json?.departments?.find((d) => d.id === 'ops');
    check(list.status === 200 && show(list.json.departments.map((d) => d.id)) === '["ops","rnd","sales"]'
      && sales?.lead?.principal === 'user:alpha' && typeof sales.lead.display_name === 'string' && sales.member_count === 3 && sales.function_code === 'dp_sales' && sales.source === 'manual'
      && ops?.lead === null && ops.member_count === 1 && ops.function_code === null && again.status === 200 && again.json?.added === false,
      '部门列表：负责人（主体和显示名）、成员人数（重复加不重复算）、职能代号（没配是 null）、来源；按标识排序', show({ sales, ops, again: again.status }));
    const one = await srv.call('GET', '/api/departments/sales', asAlpha);
    check(one.status === 200 && show(one.json.members.map((m) => [m.principal, m.kind, m.is_lead])) === show([['seat:bot', 'seat', false], ['user:alpha', 'person', true], ['user:beta', 'person', false]]),
      '单个部门：成员列表带主体、类型、是不是负责人', show(one.json?.members));
    // 负责人不一定是成员：beta 当 rnd 的负责人，但不进 rnd
    await srv.call('PUT', '/api/departments/rnd', { headers: token, body: { name: '合成研发部', lead: 'user:beta' } });
    const ofBeta = await srv.call('GET', '/api/departments/of/user:beta', asAlpha);
    const ofNobody = await srv.call('GET', '/api/departments/of/user:nobody', asAlpha);
    check(ofBeta.status === 200 && show(ofBeta.json.departments.map((d) => [d.id, d.is_member, d.is_lead])) === show([['rnd', false, true], ['sales', true, false]])
      && ofNobody.status === 200 && show(ofNobody.json.departments) === '[]',
      '某人属于哪些部门：是成员的、是负责人的分开标；不在任何部门的是空数组', show({ beta: ofBeta.json, nobody: ofNobody.json }));
    // 不写的字段改时保持原样；null 清掉
    const keep = await srv.call('PUT', '/api/departments/rnd', { headers: token, body: { name: '合成研发中心' } });
    const clear = await srv.call('PUT', '/api/departments/rnd', { headers: token, body: { name: '合成研发中心', lead: null, function_code: '' } });
    check(keep.status === 200 && keep.json.department.function_code === 'dp_product' && keep.json.department.lead?.principal === 'user:beta'
      && clear.status === 200 && clear.json.department.function_code === null && clear.json.department.lead === null,
      '改部门：不写的职能代号、负责人保持原样；给 null 或空串清掉', show({ keep: keep.json?.department, clear: clear.json?.department }));
    const removed = await srv.call('DELETE', '/api/departments/sales/members/seat:bot', { headers: token });
    const removedAgain = await srv.call('DELETE', '/api/departments/sales/members/seat:bot', { headers: token });
    check(removed.json?.removed === true && removedAgain.status === 200 && removedAgain.json?.removed === false, '移出成员：第二次移出不报错，removed=false', show({ removed: removed.json, again: removedAgain.json }));
  }

  // ---------- 二、读 ----------
  {
    const readers = {
      staff: await srv.call('GET', '/api/departments', asAlpha),
      tokenRemote: await srv.call('GET', '/api/departments', { headers: token }),
      odooAdmin: await srv.call('GET', '/api/departments', asRoot),
      cli: await srv.call('GET', '/api/departments'),
    };
    const refused = {
      anonymous: [await srv.call('GET', '/api/departments', { headers: REMOTE }), 401],
      wrongToken: [await srv.call('GET', '/api/departments', { headers: { ...REMOTE, 'x-admin-token': 'nope' } }), 401],
      unreachable: [await srv.call('GET', '/api/departments', { headers: { ...REMOTE, ...same }, session: SESSIONS.unreachable }), 401],
      portal: [await srv.call('GET', '/api/departments', { headers: { ...REMOTE, ...same }, session: SESSIONS.portal }), 401],
      crossSite: [await srv.call('GET', '/api/departments', { headers: { ...REMOTE, ...cross }, session: SESSIONS.alpha }), 403],
      crossSiteToken: [await srv.call('GET', '/api/departments/sales', { headers: { ...token, ...cross } }), 403],
      anonymousOne: [await srv.call('GET', '/api/departments/sales', { headers: REMOTE }), 401],
      anonymousOf: [await srv.call('GET', '/api/departments/of/user:alpha', { headers: REMOTE }), 401],
    };
    const okBad = Object.entries(readers).filter(([, r]) => r.status !== 200 || !Array.isArray(r.json?.departments)).map(([k, r]) => [k, r.status]);
    const refusedBad = Object.entries(refused).filter(([, [r, want]]) => r.status !== want || r.text.includes('合成')).map(([k, [r, want]]) => [k, r.status, want]);
    check(okBad.length === 0 && refusedBad.length === 0,
      '读：登录的员工、口令管理员、管理员登录、本机命令行能读；远程匿名、口令错、身份来源不可达、门户账号 401；跨站 403；被拒的应答里没有部门内容', show({ okBad, refusedBad }));
    // 主体停用：本机命令行停用 beta，beta 的会话读部门 403
    const off = await srv.call('POST', '/api/principals/disable', { body: { id: 'user:beta', reason: '合成：停用对抗例' } });
    const betaRead = await srv.call('GET', '/api/departments', { headers: { ...REMOTE, ...same }, session: SESSIONS.beta });
    check(off.status === 200 && [401, 403].includes(betaRead.status) && !betaRead.text.includes('合成'), '主体停用了：同一个会话读不到部门（认人时拦下 401，或部门读拦下 403）', show({ off: off.status, read: betaRead.status }));
    await srv.call('POST', '/api/principals/restore', { body: { id: 'user:beta', reason: '合成：恢复' } });
  }

  // ---------- 六、和授予的关系 ----------
  {
    const unknown = await srv.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'dept-lead', scope: 'dept:nope', reason: '合成：部门不存在' } });
    const badScope = await srv.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'dept-lead', scope: 'dept:Sales', reason: '合成：写法不对' } });
    const d = await srv.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'dept-lead', scope: 'dept:sales', reason: '合成：销售部负责人' } });
    const del = await srv.call('DELETE', '/api/departments/sales', { headers: token });
    const still = await srv.call('GET', '/api/departments/sales', asAlpha);
    check(unknown.status === 422 && unknown.json?.error === 'department_unknown' && badScope.status === 400 && d.status === 201
      && del.status === 409 && del.json?.error === 'department_in_use' && still.status === 200,
      '授予范围 dept:<标识>：部门表里没有的 422、写法不对 400、有的能起草；还有没结束的部门授予时删部门 409，部门还在',
      show({ unknown: [unknown.status, unknown.json?.error], badScope: badScope.status, draft: d.status, del: [del.status, del.json?.error] }));
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/revoke`, { body: { reason: '合成：作废' } });
    const del2 = await srv.call('DELETE', '/api/departments/sales', { headers: token });
    const left = Number(db.prepare("SELECT COUNT(*) AS n FROM department_members WHERE department_id = 'sales'").get().n);
    const approveGone = await srv.call('POST', '/api/grants', { body: { principal: 'user:alpha', role: 'dept-lead', scope: 'dept:sales', reason: '合成：删了之后' } });
    check(del2.status === 200 && del2.json?.members_removed === 2 && left === 0 && approveGone.status === 422,
      '授予撤销之后能删部门，成员归属一起删；删了之后再起草到这个部门 422', show({ del2: del2.json, left, after: approveGone.status }));
  }

  // ---------- 七、读接口不带事项内容；写记日志 ----------
  {
    db.exec("INSERT INTO work_items (id, title, created_by, creator_principal, source_kind) VALUES ('wi_dept_canary', 'CANARY-WORK-ITEM-TITLE-91', 'user:alpha', 'user:alpha', 'agent')");
    const texts = [await srv.call('GET', '/api/departments', asAlpha), await srv.call('GET', '/api/departments/ops', asAlpha), await srv.call('GET', '/api/departments/of/user:alpha', asAlpha)];
    const keys = texts.map((r) => Object.keys(r.json ?? {}).sort().join(','));
    check(texts.every((r) => r.status === 200 && !r.text.includes('CANARY-WORK-ITEM') && !r.text.includes('wi_dept_canary')) && show(keys) === show(['departments', 'department,members', 'departments,principal']),
      '读接口只给部门和人：事项的标题、标识都不出现；顶层只有约定的键', show(keys));
    const lines = srv.log().split('\n').filter((l) => l.includes('"source":"departments"'));
    check(['create', 'update', 'delete', 'member-add', 'member-remove'].every((e) => lines.some((l) => l.includes(`"event":"${e}"`))) && lines.every((l) => !l.includes('合成')),
      '写部门每一步记一行日志（谁、做了什么、哪个部门）；日志里不带部门名称', `${lines.length} 行`);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await sleep(500); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`departments-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
