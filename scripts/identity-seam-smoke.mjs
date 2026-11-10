#!/usr/bin/env node
/**
 * 身份接缝的对抗组（安全面）。真实的 server/src/index.ts，登录提供方换成假的（scripts/identity-fake-provider.mjs），
 * 不访问任何真实的外部系统。请求都带反代转发头，按远程浏览器算（本机命令行的免口令不适用）。
 *
 * 每一例是一个谓词对：拒绝的那一头，加上合法对照的那一头，两头都对才算过。
 * 对照的作用是证明核心确实在问身份服务——核心要是绕开服务，拒绝例照样全绿，对照例会红。
 *
 * 七个入口，都是原来直接引用身份实现的地方：
 *   whoami（index.ts）· 管理员认定（index.ts，缓存和中继两支）· 统一待办读权（tasks-read-access.ts）·
 *   run 私有读授权（sop-read-auth.ts）· 交给扩展的认人和管理员门（index.ts）· 全站登录门（login-gate.ts，缓存和中继两支）
 *
 * 四个隔离实例：缺省、登录门 enforce、同域登录中继、中继加登录门。核心里「中继开没开」各走一支，两支都要守。
 *
 * 主体（阶段五）：提供方认出的人要对到一个主体上才算数。同样的七个入口再过一遍——
 *   停用一个主体，每个入口立即不认它（缓存热着也一样），别人不受影响；恢复之后立即照常；
 *   主体管理接口只有管理员能用；标识被占着的不自动认领；另一个共用数据目录的实例同样立即生效，重启之后还在。
 *
 *   node scripts/identity-seam-smoke.mjs              测本仓库
 *   node scripts/identity-seam-smoke.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS, onceSession } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `identity-seam-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-identity-seam-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.10' }; // 文档网段：经反代进来的远程请求
const RUN_ID = 4101;
const PRIVATE = 'SYNTHETIC_PRIVATE_RUN_VALUE';

/** 探针扩展：把宿主交给扩展的认人和管理员门原样用一遍 */
const EXT_PROBE = `export function register(ctx) {
  ctx.app.get('/api/seam-probe/who', ctx.wrap(async (req, res) => {
    const cookie = String(req.headers.cookie ?? '');
    res.json({ sid: ctx.odoo.sessionOf(cookie), who: await ctx.odoo.resolveViewer(cookie) });
  }));
  ctx.app.get('/api/seam-probe/admin', ctx.wrap(async (req, res) => { if (!(await ctx.adminGuard(req, res))) return; res.json({ admin: true }); }));
}
`;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

function baseEnv(name, extraEnv) {
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), ...extraEnv });
  return { env, data };
}

/** 起一个隔离实例；提供方在 index.ts 装配之前换成假的。dataOf 给了就和那个实例共用数据目录。 */
async function boot(name, extraEnv = {}, dataOf = null) {
  const port = extraEnv.PORT ? Number(extraEnv.PORT) : await freePort(); // 内容面要预先知道市场的端口
  const { env, data } = baseEnv(name, { PORT: String(port), ...(dataOf ? { DATA_DIR: dataOf.data } : {}), ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40000;
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
  };
  if (!ready) {
    await stop();
    // 启动自检有行没过，实例自己拒绝启动：这是一项检查没过（不安全的启动被拦下了），不是脚本没跑成
    const refused = [...log.matchAll(/"source":"self-probe","id":"([^"]+)"[^}]*"verdict":"fail"/g)].map((m) => m[1]);
    const error = new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
    if (refused.length) error.selfProbe = [...new Set(refused)];
    throw error;
  }
  /** remote=false 时不带反代转发头：服务端看到的就是本机命令行直连 */
  const call = async (method, path, sid, body, extra = {}, remote = true) => {
    const headers = { ...(remote ? REMOTE : {}), ...(sid ? { cookie: `session_id=${sid}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra };
    try {
      // 8 秒没应答就算这一问失败：身份服务有期限，请求不该一直挂着
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, json, text };
    } catch (e) {
      return { status: 0, json: null, text: `没有应答：${String(e?.name ?? e)}` };
    }
  };
  return { name, port, data: dataOf ? dataOf.data : data, call, stop, log: () => log };
}

/** 给实例种一个带私有值的已结束 run，只授权给 user:alpha */
function seedRun(srv) {
  const db = new DatabaseSync(join(srv.data, 'workbench-market.db'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare("INSERT INTO sop_runs(id,sop_slug,sop_version,status,started_by,data,finished_at) VALUES(?,?,1,'finished','synthetic',?,datetime('now'))").run(RUN_ID, 'synthetic-private', JSON.stringify({ step: { value: PRIVATE } }));
    db.prepare("INSERT INTO sop_run_read_grants(run_id,subject,expires_at,granted_by) VALUES(?,?,datetime('now','+1 day'),'synthetic-seed')").run(RUN_ID, 'user:alpha');
  } finally { db.close(); }
}

/** 一个会话在各个入口上是什么结果（登录门关着的实例） */
async function observe(srv, sid) {
  const [viewer, admin, write, tasks, run, ext, extGuard] = await Promise.all([
    srv.call('GET', '/api/auth/viewer', sid),
    srv.call('GET', '/api/admin/whoami', sid),
    srv.call('POST', '/api/workbenches', sid, { name: '', url: '' }), // 过了管理员门才会走到校验（400，不落库）；过不了是 403
    srv.call('GET', '/api/tasks', sid),
    srv.call('GET', `/api/sop/runs/${RUN_ID}`, sid),
    srv.call('GET', '/api/seam-probe/who', sid), // 扩展拿到的认人
    srv.call('GET', '/api/seam-probe/admin', sid), // 扩展拿到的管理员门
  ]);
  return {
    viewer: viewer.status, viewerAdmin: viewer.json?.viewer?.admin ?? null, login: viewer.json?.viewer?.login ?? null,
    admin: admin.json?.admin ?? null, adminLogin: admin.json?.login ?? null,
    write: write.status,
    tasks: tasks.status, tasksError: tasks.json?.error ?? null,
    runPrivate: run.text.includes(PRIVATE), run: run.status,
    ext: ext.json?.who?.ok ?? null, extLogin: ext.json?.who?.viewer?.login ?? null, extAdmin: ext.json?.who?.viewer?.admin ?? null,
    extGuard: extGuard.status,
  };
}

/** 认不出的各种情形：[说法, 会话, whoami 的状态码, 待办的状态码, 待办的错误码] */
const DOWN = [502, 503, 'tasks_identity_unavailable'];
const REFUSALS = [
  ['① 没有会话', null, 401, 401, 'tasks_auth_required'],
  ['② 伪造的会话', SESSIONS.forged, 401, 401, 'tasks_auth_required'],
  ['③ 身份来源不可达：按失败处理，不放行', SESSIONS.unreachable, ...DOWN],
  ['④ 提供方抛错：按失败处理，不放行、不 500', SESSIONS.throws, ...DOWN],
  ['⑤ 非内部账号', SESSIONS.portal, 403, 403, 'tasks_internal_user_required'],
  ['⑥ 回答畸形（ok:true 却没有查看者）', SESSIONS.malformed, ...DOWN],
  ['⑦ 冒名主体（登录名 mallory，主体写成持有授权的 user:alpha，还自称管理员）', SESSIONS.impersonate, ...DOWN],
  ['⑧ 登录名形状不对（前面带空格，自称管理员）', SESSIONS.paddedLogin, ...DOWN],
  ['⑨ uid 不是数（自称管理员）', SESSIONS.stringUid, ...DOWN],
  ['⑩ 显示名不是字符串（自称管理员）', SESSIONS.numberName, ...DOWN],
  ['⑪ 说认不出、状态码却是 200', SESSIONS.refusal200, ...DOWN],
  ['⑫ 提供方永远不回答：到期限按失败处理，不一直挂着', SESSIONS.hangs, ...DOWN],
  ['⑬ 回答对象一读就抛错：按失败处理，不 500', SESSIONS.okThrows, ...DOWN],
];
/** 认得出人、但管理员标记不算数的情形 */
const NOT_ADMIN = [
  ['⑭ 管理员标记缺失', SESSIONS.noAdminFlag, 'no-flag'],
  ['⑮ 管理员标记是字符串 "true"', SESSIONS.truthyAdmin, 'truthy-flag'],
];

/** 登录门关着的实例：whoami、管理员认定、待办、run 私有读、扩展 */
async function openChecks(srv, tag) {
  seedRun(srv);
  // 合法对照：先确认「该放行的」确实经身份服务放行了
  const alpha = await observe(srv, SESSIONS.alpha);
  const beta = await observe(srv, SESSIONS.beta);
  const admin = await observe(srv, SESSIONS.admin);
  const alphaOk = alpha.viewer === 200 && alpha.login === 'alpha' && alpha.viewerAdmin === false && alpha.tasks === 200 && alpha.runPrivate && alpha.admin === false && alpha.write === 403
    && alpha.ext === true && alpha.extLogin === 'alpha' && alpha.extAdmin === false && alpha.extGuard === 403;
  const betaOk = beta.viewer === 200 && beta.login === 'beta' && beta.tasks === 200 && !beta.runPrivate && beta.run === 200 && beta.ext === true && beta.extLogin === 'beta';
  const adminOk = admin.viewer === 200 && admin.viewerAdmin === true && admin.admin === true && admin.adminLogin === 'root-admin' && admin.write === 400 && admin.tasks === 200
    && admin.ext === true && admin.extAdmin === true && admin.extGuard === 200;
  check(alphaOk, `${tag}对照·内部员工 alpha：认得出、读得到待办和授权给自己的 run 私有值、扩展认得出；不是管理员，管理写 403、扩展的管理员门 403`, show(alpha));
  check(betaOk, `${tag}对照·内部员工 beta：认得出、读得到待办；别人的 run 只看到元数据`, show(beta));
  check(adminOk, `${tag}对照·管理员：管理员认定成立，管理写过得了管理员门（400=走到了校验），扩展的管理员门放行`, show(admin));

  for (const [label, sid, viewer, tasks, tasksError] of REFUSALS) {
    const o = await observe(srv, sid);
    const refused = o.viewer === viewer && o.login === null && o.admin === false && o.write === 403 && o.tasks === tasks && o.tasksError === tasksError && !o.runPrivate && o.run === 200
      && o.ext === false && o.extLogin === null && o.extGuard === 403;
    check(refused && alphaOk && adminOk, `${tag}${label} → whoami ${viewer}、不是管理员、管理写 403、待办 ${tasks}、run 私有值不给、扩展认不出`, show(o));
  }
  for (const [label, sid, login] of NOT_ADMIN) {
    const o = await observe(srv, sid);
    const demoted = o.viewer === 200 && o.login === login && o.viewerAdmin === false && o.admin === false && o.write === 403 && o.tasks === 200 && !o.runPrivate
      && o.ext === true && o.extAdmin === false && o.extGuard === 403;
    check(demoted && adminOk, `${tag}${label} → 认得出人，按「不是管理员」处理：管理写 403、扩展的管理员门 403`, show(o));
  }
}

/** 登录门开着的实例：没有身份什么都拿不到 */
async function gateChecks(srv, tag) {
  const gate = async (sid) => {
    const [api, me] = await Promise.all([srv.call('GET', '/api/apps', sid), srv.call('GET', '/api/auth/me', sid)]);
    return { api: api.status, error: api.json?.error ?? null, authenticated: me.json?.authenticated ?? null, via: me.json?.via ?? null, login: me.json?.login ?? null };
  };
  const inside = await gate(SESSIONS.alpha);
  const insideOk = inside.api === 200 && inside.authenticated === true && inside.via === 'odoo' && inside.login === 'alpha';
  check(insideOk, `${tag}对照：内部员工进得来`, show(inside));
  for (const [label, sid] of REFUSALS) {
    const o = await gate(sid);
    check(o.api === 401 && o.error === 'login_required' && o.authenticated === false && insideOk, `${tag}${label.replace(/：.*$/, '')} → 401，进不来`, show(o));
  }
}

const TOKEN = { 'x-admin-token': ADMIN_TOKEN };
const principalsOf = async (srv) => (await srv.call('GET', '/api/principals', null, undefined, TOKEN)).json?.principals ?? null;
/** 停用（disable）或恢复（restore）。by 是带的请求头（缺省带管理员口令），sid 是带的会话 */
const setStatus = (srv, action, id, by = TOKEN, sid = null, reason = undefined) => srv.call('POST', `/api/principals/${action}`, sid, { id, ...(reason === undefined ? {} : { reason }) }, by);

/** 登录门关着的实例：主体管理接口，停用与恢复在各个入口上的效果。relay 表示这个实例开着同域登录中继 */
async function principalChecks(srv, tag, relay) {
  // 进来之前 openChecks 已经让 alpha、beta、管理员各认过一遍：主体都建好了，管理员认定的缓存也是热的
  const before = { alpha: await observe(srv, SESSIONS.alpha), beta: await observe(srv, SESSIONS.beta), admin: await observe(srv, SESSIONS.admin) };
  const fine = (o, login) => o.viewer === 200 && o.login === login && o.tasks === 200 && o.ext === true && o.extLogin === login;
  const controls = fine(before.alpha, 'alpha') && before.alpha.runPrivate && fine(before.beta, 'beta') && fine(before.admin, 'root-admin') && before.admin.admin === true && before.admin.write === 400 && before.admin.extGuard === 200;

  // ① 管理接口只有管理员能用
  {
    const [anon, staff, forged, byAdmin, byToken] = await Promise.all([
      srv.call('GET', '/api/principals'), srv.call('GET', '/api/principals', SESSIONS.alpha), srv.call('GET', '/api/principals', SESSIONS.forged),
      srv.call('GET', '/api/principals', SESSIONS.admin), srv.call('GET', '/api/principals', null, undefined, TOKEN)]);
    const leak = [anon, staff, forged].some((r) => r.text.includes('user:alpha'));
    check(anon.status === 403 && staff.status === 403 && forged.status === 403 && !leak && byAdmin.status === 200 && byToken.status === 200 && Array.isArray(byAdmin.json?.principals) && controls,
      `${tag}主体①·列出主体：没登录、普通员工、伪造会话都是 403，一个主体也看不到；对照：管理员登录和口令看得到`, show({ anon: anon.status, staff: staff.status, forged: forged.status, admin: byAdmin.status, token: byToken.status }));
  }
  // ② 认出来的人各有一个主体；没认出来的不建
  {
    const list = await principalsOf(srv) ?? [];
    const ids = list.map((p) => p.id).sort();
    const alpha = list.find((p) => p.id === 'user:alpha');
    check(show(ids) === show(['user:alpha', 'user:beta', 'user:no-flag', 'user:root-admin', 'user:truthy-flag']) && alpha?.kind === 'person' && alpha.status === 'active' && show(alpha.identities.map((i) => [i.provider, i.external_id])) === show([['fake', 'alpha']]),
      `${tag}主体②·同一个人反复登录只有一个主体：认出来的 5 个人各一个；没认出来的（伪造、冒名、畸形……）一个也没建`, show(ids));
  }
  // ③ 不是管理员，停用不了别人
  {
    const [anon, staff, cross] = await Promise.all([
      setStatus(srv, 'disable', 'user:beta', {}), setStatus(srv, 'disable', 'user:beta', {}, SESSIONS.alpha),
      setStatus(srv, 'disable', 'user:beta', { ...TOKEN, 'sec-fetch-site': 'cross-site', origin: 'http://attacker.invalid' })]);
    const beta = await observe(srv, SESSIONS.beta);
    check(anon.status === 403 && staff.status === 403 && cross.status === 403 && fine(beta, 'beta') && controls, `${tag}主体③·停用别人：没登录 403、普通员工 403、带着口令的跨站请求 403；beta 照常认得出`, show({ anon: anon.status, staff: staff.status, cross: cross.status }));
  }
  // ④ 停用：每个入口立即不认，别人不受影响
  {
    const off = await setStatus(srv, 'disable', 'user:alpha', TOKEN, null, '合成：离职');
    const alpha = await observe(srv, SESSIONS.alpha), beta = await observe(srv, SESSIONS.beta);
    const whoami = await srv.call('GET', '/api/auth/viewer', SESSIONS.alpha);
    const refused = alpha.viewer === 403 && alpha.login === null && alpha.admin === false && alpha.write === 403 && alpha.tasks === 403 && !alpha.runPrivate && alpha.run === 200 && alpha.ext === false && alpha.extLogin === null && alpha.extGuard === 403;
    check(off.status === 200 && off.json?.changed === true && off.json.principal?.status === 'disabled' && off.json.principal.status_changed_by === 'admin-token' && off.json.principal.status_reason === '合成：离职'
      && refused && whoami.json?.error === '主体已停用' && whoami.json?.auth_required === false && controls,
      `${tag}主体④·停用 alpha → whoami 403（主体已停用）、待办 403、授权给它的 run 私有值不给、扩展认不出`, show(alpha));
    check(fine(beta, 'beta') && refused, `${tag}主体④·对照：停用 alpha 不影响 beta`, show(beta));
    // 停用之后再来多少次都一样，也不会另建一个主体
    for (let i = 0; i < 5; i++) await srv.call('GET', '/api/auth/viewer', SESSIONS.alpha);
    const rows = (await principalsOf(srv) ?? []).filter((p) => p.id === 'user:alpha');
    check(rows.length === 1 && rows[0].status === 'disabled' && rows[0].identities.length === 1 && (await srv.call('GET', '/api/auth/viewer', SESSIONS.alpha)).status === 403, `${tag}主体④·停用之后反复登录：一直不认，主体还是那一个、还是停用`, show(rows));
    // 每次变更写一行日志，带谁做的；重复停用（没有变更）不写
    const lines = srv.log().split('\n').filter((l) => l.includes('"source":"principals"') && l.includes('"id":"user:alpha"'));
    check(lines.length === 1 && lines[0].includes('"event":"disable"') && lines[0].includes('"by":"admin-token"') && !lines[0].includes(SESSIONS.alpha), `${tag}主体④·停用写了一行日志（source=principals、谁做的），不带会话值`, show(lines));
  }
  // ⑤ 恢复：立即照常（这回由管理员登录来做，留痕记的是它）
  {
    const on = await setStatus(srv, 'restore', 'user:alpha', {}, SESSIONS.admin, '合成：回来了');
    const alpha = await observe(srv, SESSIONS.alpha);
    check(on.status === 200 && on.json?.changed === true && on.json.principal?.status === 'active' && on.json.principal.status_changed_by === 'odoo:root-admin' && show(alpha) === show(before.alpha) && controls,
      `${tag}主体⑤·恢复 alpha → 每个入口立即和停用之前一模一样`, show(alpha));
    const lines = srv.log().split('\n').filter((l) => l.includes('"source":"principals"') && l.includes('"id":"user:alpha"'));
    check(lines.length === 2 && lines[1].includes('"event":"restore"') && lines[1].includes('"by":"odoo:root-admin"'), `${tag}主体⑤·恢复也写一行日志，记下是管理员登录做的`, show(lines));
  }
  // ⑥ 停用管理员：管理员认定立即不成立（它的缓存是热的），自己也恢复不了自己
  {
    const off = await setStatus(srv, 'disable', 'user:root-admin');
    const admin = await observe(srv, SESSIONS.admin);
    const list = await srv.call('GET', '/api/principals', SESSIONS.admin), selfRestore = await setStatus(srv, 'restore', 'user:root-admin', {}, SESSIONS.admin);
    check(off.status === 200 && admin.viewer === 403 && admin.admin === false && admin.adminLogin === null && admin.write === 403 && admin.extGuard === 403 && admin.tasks === 403 && admin.ext === false
      && list.status === 403 && selfRestore.status === 403 && controls,
      `${tag}主体⑥·停用管理员 → 管理员认定立即不成立：管理写 403、扩展的管理员门 403、列不出主体、恢复不了自己`, show({ ...admin, list: list.status, selfRestore: selfRestore.status }));
    const on = await setStatus(srv, 'restore', 'user:root-admin');
    const back = await observe(srv, SESSIONS.admin);
    check(on.status === 200 && show(back) === show(before.admin) && admin.admin === false, `${tag}主体⑥·对照：用口令恢复之后，管理员认定立即照常`, show(back));
  }
  // ⑦ 管理员不能停用自己；入参不对、主体不存在都改不了任何东西
  {
    const self = await setStatus(srv, 'disable', 'user:root-admin', {}, SESSIONS.admin);
    const other = await setStatus(srv, 'disable', 'user:no-flag', {}, SESSIONS.admin);
    const undo = await setStatus(srv, 'restore', 'user:no-flag', {}, SESSIONS.admin);
    const admin = await observe(srv, SESSIONS.admin);
    check(self.status === 409 && admin.admin === true && other.status === 200 && other.json?.changed === true && undo.status === 200, `${tag}主体⑦·管理员登录停用自己 → 409，自己还是管理员；对照：它停用别人可以`, show({ self: self.status, other: other.status, admin: admin.admin }));
    const bad = [];
    for (const [id, reason] of [['user:nobody-here'], ['alpha'], [undefined], ['user:alpha', 5], [' user:alpha'], ['robot:alpha'], [['user:alpha']]]) bad.push((await setStatus(srv, 'disable', id, TOKEN, null, reason)).status);
    const list = await principalsOf(srv) ?? [];
    check(show(bad) === show([404, 400, 400, 400, 400, 400, 400]) && list.length === 5 && list.every((p) => p.status === 'active'),
      `${tag}主体⑦·主体不存在 404、标识或理由写得不对 400：一个主体也没被改，也没有凭空多出来`, show(bad));
  }
  // ⑧ 标识被一个已有的主体占着：新来的登录不自动认领它
  {
    const db = new DatabaseSync(join(srv.data, 'workbench-market.db'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare("INSERT INTO principals (id, id_key, kind, display_name) VALUES ('user:squatted', 'user:squatted', 'person', 'Synthetic owner')").run(); } finally { db.close(); }
    const o = await observe(srv, SESSIONS.squatter);
    const row = (await principalsOf(srv) ?? []).find((p) => p.id === 'user:squatted');
    check(o.viewer === 403 && o.login === null && o.admin === false && o.write === 403 && o.tasks === 403 && o.ext === false && o.extGuard === 403 && row?.identities.length === 0 && controls,
      `${tag}主体⑧·标识已被占用、外部身份没绑定（还自称管理员）→ 不认、不替它绑上`, show(o));
  }
  // ⑨ 缓存：提供方的回答可以留一会儿，主体停没停用每次现查。用「提供方只认第一次」的会话看得出走没走缓存
  {
    const sid = onceSession(relay ? 'relay-admin' : 'cached-admin', true);
    const whoami = async () => (await srv.call('GET', '/api/admin/whoami', sid)).json?.admin ?? null;
    const first = await whoami(), second = await whoami();
    if (relay) {
      check(first === true && second === false, `${tag}主体⑨·登录中继开着：管理员认定每次现查，提供方那边会话一失效立即不认（不用缓存）`, show({ first, second }));
    } else {
      check(first === true && second === true, `${tag}主体⑨·管理员认定用了缓存：30 秒内不重问提供方`, show({ first, second }));
      const off = await setStatus(srv, 'disable', 'user:cached-admin');
      const third = await whoami();
      const write = await srv.call('POST', '/api/workbenches', sid, { name: '', url: '' });
      check(off.status === 200 && third === false && write.status === 403 && second === true, `${tag}主体⑨·缓存还热着时停用主体 → 管理员认定立即不成立，不等缓存过期`, show({ third, write: write.status }));
      await setStatus(srv, 'restore', 'user:cached-admin');
      const fourth = await whoami();
      check(fourth === true && third === false, `${tag}主体⑨·恢复 → 立即成立`, show({ fourth }));
      // 停用期间才第一次来的会话：提供方认得出，目录不认。这一次的拒绝不能进缓存，否则恢复之后还要等缓存过期
      await srv.call('GET', '/api/auth/viewer', onceSession('late-admin', false)); // 先让 user:late-admin 这个主体建出来
      await setStatus(srv, 'disable', 'user:late-admin');
      const later = onceSession('late-admin', true); // 同一个登录名的另一个会话，缓存里还没有它
      const during = (await srv.call('GET', '/api/admin/whoami', later)).json?.admin ?? null;
      await setStatus(srv, 'restore', 'user:late-admin');
      const after = (await srv.call('GET', '/api/admin/whoami', later)).json?.admin ?? null;
      check(during === false && after === true, `${tag}主体⑨·停用期间的拒绝不进缓存：恢复之后立即成立`, show({ during, after }));
    }
  }
  // ⑩ 本机命令行（回环直连，不带反代转发头和浏览器标记）：和别的管理面一样免口令，留痕记 cli；带了浏览器标记就不算命令行
  {
    const list = await srv.call('GET', '/api/principals', null, undefined, {}, false);
    const off = await srv.call('POST', '/api/principals/disable', null, { id: 'user:truthy-flag', reason: '合成：本机应急' }, {}, false);
    const refused = await observe(srv, SESSIONS.truthyAdmin);
    const on = await srv.call('POST', '/api/principals/restore', null, { id: 'user:truthy-flag' }, {}, false);
    const marked = { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' };
    const browserList = await srv.call('GET', '/api/principals', null, undefined, { 'sec-fetch-site': 'same-origin' }, false);
    const browserOff = await srv.call('POST', '/api/principals/disable', null, { id: 'user:truthy-flag' }, marked, false);
    const still = (await principalsOf(srv) ?? []).find((p) => p.id === 'user:truthy-flag');
    check(list.status === 200 && off.status === 200 && off.json?.principal?.status_changed_by === 'cli' && refused.viewer === 403 && on.status === 200 && on.json?.principal?.status === 'active'
      && browserList.status === 403 && browserOff.status === 403 && still?.status === 'active',
      `${tag}主体⑩·本机命令行列得出、停用得了（留痕记 cli）；同样从本机来、带着浏览器标记的不算命令行（403）`, show({ list: list.status, off: off.status, by: off.json?.principal?.status_changed_by, browserList: browserList.status, browserOff: browserOff.status }));
  }
  // ⑫ 登录名的等价写法（大小写、全角、夹零宽字符）：不另建主体，alpha 启用时不认、停用时更不认
  {
    const variants = [['大小写', SESSIONS.alphaUpper], ['全角', SESSIONS.alphaWide], ['夹零宽字符', SESSIONS.alphaZeroWidth]];
    const refusedEverywhere = (o) => o.viewer === 403 && o.login === null && o.admin === false && o.write === 403 && o.tasks === 403 && !o.runPrivate && o.ext === false && o.extGuard === 403;
    const seen = [];
    for (const [label, sid] of variants) seen.push([label, 'active', await observe(srv, sid)]);
    await setStatus(srv, 'disable', 'user:alpha', TOKEN, null, '合成：测等价写法');
    for (const [label, sid] of variants) seen.push([label, 'disabled', await observe(srv, sid)]);
    const stillOff = await observe(srv, SESSIONS.alpha);
    await setStatus(srv, 'restore', 'user:alpha');
    const ids = (await principalsOf(srv) ?? []).map((p) => p.id);
    const extra = ids.filter((id) => id !== 'user:alpha' && id.toLowerCase().normalize('NFKC').replace(/\u200b/g, '') === 'user:alpha');
    const leaked = seen.filter(([, , o]) => !refusedEverywhere(o)).map(([label, state, o]) => `${label}/${state}：${show(o)}`);
    check(leaked.length === 0 && extra.length === 0 && stillOff.viewer === 403 && fine(await observe(srv, SESSIONS.alpha), 'alpha'),
      `${tag}主体⑫·登录名只差大小写、全角、夹零宽字符：不另建主体；alpha 启用和停用时都不认（停用绕不过去）；对照：alpha 恢复后照常`, `${leaked.join('；')} 多出来的主体：${show(extra)}`);
  }
  // ⑪ 授权跟着主体走，不跟着登录名走：把 beta 这个外部身份改绑到 alpha 的主体上，它就是 user:alpha，读得到授权给 user:alpha 的 run 私有值
  {
    const rebind = (to) => { const db = new DatabaseSync(join(srv.data, 'workbench-market.db')); try { db.exec('PRAGMA busy_timeout=5000'); db.prepare("UPDATE principal_identities SET principal_id = ? WHERE provider = 'fake' AND external_id = 'beta'").run(to); } finally { db.close(); } };
    rebind('user:alpha');
    const who = await srv.call('GET', '/api/auth/viewer', SESSIONS.beta), as = await observe(srv, SESSIONS.beta), ext = await srv.call('GET', '/api/seam-probe/who', SESSIONS.beta);
    rebind('user:beta');
    const back = await observe(srv, SESSIONS.beta);
    check(who.json?.viewer?.sub === 'user:alpha' && who.json.viewer.login === 'beta' && ext.json?.who?.viewer?.sub === 'user:alpha' && as.runPrivate === true && back.runPrivate === false && back.login === 'beta' && before.beta.runPrivate === false,
      `${tag}主体⑪·一个主体多个外部身份：beta 这个登录改绑到 alpha 的主体上，查看者的主体就是 user:alpha，授权按主体算；对照：绑回去之后读不到`, show({ sub: who.json?.viewer?.sub, as: as.runPrivate, back: back.runPrivate }));
  }
}

/** 登录门开着的实例：停用的主体进不来 */
async function gatePrincipalChecks(srv, tag, relay) {
  const gate = async (sid) => {
    const [api, me, page] = await Promise.all([srv.call('GET', '/api/apps', sid), srv.call('GET', '/api/auth/me', sid), srv.call('GET', '/', sid, undefined, { accept: 'text/html' })]);
    return { api: api.status, error: api.json?.error ?? null, authenticated: me.json?.authenticated ?? null, login: me.json?.login ?? null, page: page.status };
  };
  const inside = (o, login) => o.api === 200 && o.authenticated === true && o.login === login && o.page !== 302 && o.page !== 401;
  const outside = (o) => o.api === 401 && o.error === 'login_required' && o.authenticated === false && o.login === null && o.page === 302;
  const before = { alpha: await gate(SESSIONS.alpha), beta: await gate(SESSIONS.beta) };
  const controls = inside(before.alpha, 'alpha') && inside(before.beta, 'beta');
  check(controls, `${tag}主体·对照：alpha、beta 都进得来`, show(before));
  {
    const anon = await srv.call('GET', '/api/principals'), staff = await srv.call('GET', '/api/principals', SESSIONS.alpha), token = await srv.call('GET', '/api/principals', null, undefined, TOKEN);
    check(anon.status === 401 && staff.status === 403 && token.status === 200, `${tag}主体·列出主体：没登录 401（登录门先拦）、普通员工 403；对照：口令 200`, show({ anon: anon.status, staff: staff.status, token: token.status }));
  }
  const off = await setStatus(srv, 'disable', 'user:alpha');
  const alpha = await gate(SESSIONS.alpha), beta = await gate(SESSIONS.beta);
  check(off.status === 200 && outside(alpha) && controls, `${tag}主体·停用 alpha → 立即进不来：接口 401、页面跳去登录、/api/auth/me 说没登录`, show(alpha));
  check(inside(beta, 'beta') && outside(alpha), `${tag}主体·对照：beta 照常进得来`, show(beta));
  const on = await setStatus(srv, 'restore', 'user:alpha');
  const back = await gate(SESSIONS.alpha);
  check(on.status === 200 && show(back) === show(before.alpha) && outside(alpha), `${tag}主体·恢复 alpha → 立即进得来`, show(back));
  {
    // 登录门的缓存：同上，用「提供方只认第一次」的会话
    const sid = onceSession(relay ? 'relay-gate' : 'cached-gate');
    const api = async () => (await srv.call('GET', '/api/apps', sid)).status;
    const first = await api(), second = await api();
    if (relay) {
      check(first === 200 && second === 401, `${tag}主体·登录中继开着：登录门每次现查，提供方那边会话一失效立即进不来（不用缓存）`, show({ first, second }));
    } else {
      check(first === 200 && second === 200, `${tag}主体·登录门用了缓存：30 秒内不重问提供方`, show({ first, second }));
      await setStatus(srv, 'disable', 'user:cached-gate');
      const third = await api();
      check(third === 401 && second === 200, `${tag}主体·缓存还热着时停用主体 → 立即进不来，不等缓存过期`, show({ third }));
      await setStatus(srv, 'restore', 'user:cached-gate');
      const fourth = await api();
      check(fourth === 200 && third === 401, `${tag}主体·恢复 → 立即进得来`, show({ fourth }));
      // 停用期间才第一次来的会话：这一次的拒绝不能进缓存
      const later = onceSession('cached-gate', true); // 同一个登录名的另一个会话
      await setStatus(srv, 'disable', 'user:cached-gate');
      const during = (await srv.call('GET', '/api/apps', later)).status;
      await setStatus(srv, 'restore', 'user:cached-gate');
      const after = (await srv.call('GET', '/api/apps', later)).status;
      check(during === 401 && after === 200, `${tag}主体·停用期间的拒绝不进缓存：恢复之后立即进得来`, show({ during, after }));
    }
  }
}

/** 开着内容面的实例：内容面启动页现查认人，停用的主体拿不到票据 */
async function contentChecks(tag) {
  const contentPort = await freePort();
  const port = await freePort();
  const source = 'http://identity-source.invalid';
  const srv = await boot('content', {
    PORT: String(port), IDENTITY_FAKE_TRUSTED_ORIGIN: source, WM_CONTENT_ODOO_ORIGIN: source,
    WM_CONTENT_PORT: String(contentPort), WM_CONTENT_IP: '127.0.0.1', WM_CONTENT_MARKET_ORIGIN: `http://127.0.0.1:${port}`,
    WM_CONTENT_TARGETS: JSON.stringify([{ id: 2, origin: `http://w-2-test.internal:${contentPort}`, upstreamUrl: 'http://127.0.0.1:9/' }]),
  });
  running.push(srv);
  const launch = async (sid) => { const r = await srv.call('GET', '/content/open/2', sid); return { status: r.status, ticket: /ticket/i.test(r.text) }; };
  const before = await launch(SESSIONS.alpha), beta = await launch(SESSIONS.beta), anon = await launch(null);
  await setStatus(srv, 'disable', 'user:alpha');
  const off = await launch(SESSIONS.alpha), betaOff = await launch(SESSIONS.beta);
  await setStatus(srv, 'restore', 'user:alpha');
  const back = await launch(SESSIONS.alpha);
  const issued = (x) => x.status === before.status && x.ticket === before.ticket;
  check(before.status === 200 && before.ticket && issued(beta) && !anon.ticket && !off.ticket && off.status !== 200 && issued(betaOff) && issued(back),
    `${tag}主体·内容面：停用 alpha → 启动页不发票据；beta 照常；恢复 → alpha 照常`, show({ before, anon, off, betaOff, back }));
}

/** 两个实例共用一个数据目录：在一个上停用，另一个立即不认；重启之后还是停用 */
async function sharedChecks(a, tag) {
  const fine = (o, login) => o.viewer === 200 && o.login === login && o.tasks === 200 && o.ext === true;
  let b = await boot('open-b', {}, a);
  running.push(b);
  const before = await observe(b, SESSIONS.beta); // 让那一边的缓存也热起来
  await setStatus(a, 'disable', 'user:beta', TOKEN, null, '合成：在另一个实例上停用');
  const off = await observe(b, SESSIONS.beta), alpha = await observe(b, SESSIONS.alpha);
  check(fine(before, 'beta') && off.viewer === 403 && off.login === null && off.tasks === 403 && off.ext === false && fine(alpha, 'alpha'), `${tag}共用数据目录的另一个实例：这边停用 beta，那边立即不认；对照：alpha 不受影响`, show(off));
  await b.stop();
  running.splice(running.indexOf(b), 1);
  b = await boot('open-b2', {}, a);
  running.push(b);
  const restarted = await observe(b, SESSIONS.beta);
  check(restarted.viewer === 403 && restarted.login === null && off.viewer === 403, `${tag}重启之后：beta 还是停用，照样不认`, show(restarted));
  await setStatus(b, 'restore', 'user:beta');
  const back = await observe(a, SESSIONS.beta);
  check(fine(back, 'beta') && restarted.viewer === 403, `${tag}那边恢复，这边立即照常`, show(back));
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'ext', 'seam-probe'), { recursive: true });
writeFileSync(join(OUT, 'ext', 'seam-probe', 'server.mjs'), EXT_PROBE);
const running = [];
try {
  // 夹具的守卫：不是测试环境，带着预加载的进程直接退出，真实入口不会运行（数据目录里连库文件都不会有）
  {
    const { env, data } = baseEnv('guard', { PORT: String(await freePort()), NODE_ENV: 'production' });
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, encoding: 'utf8', timeout: 8000 });
    check(r.status === 1 && /拒绝加载/.test(r.stderr) && !existsSync(join(data, 'workbench-market.db')), '夹具守卫·NODE_ENV=production 带着假提供方的预加载：进程退出，实例起不来', `status=${r.status} signal=${r.signal} ${String(r.stderr).trim().slice(0, 160)}`);
  }

  const [open, gated, relay, relayGated] = await Promise.all([
    boot('open'),
    boot('gated', { WM_LOGIN_GATE: 'enforce' }),
    boot('relay', { WM_ODOO_LOGIN_PROXY: '1' }),
    boot('relay-gated', { WM_ODOO_LOGIN_PROXY: '1', WM_LOGIN_GATE: 'enforce' }),
  ].map((p) => p.then((srv) => { running.push(srv); return srv; })));

  await openChecks(open, '');
  await principalChecks(open, '', false);
  await sharedChecks(open, '');
  await contentChecks('内容面·');
  await gateChecks(gated, '登录门·');
  await gatePrincipalChecks(gated, '登录门·', false);
  // 同域登录中继开着：管理员认定和登录门各走另一支（不缓存，每次现查），同样的例子再过一遍
  await openChecks(relay, '中继·');
  await principalChecks(relay, '中继·', true);
  await gateChecks(relayGated, '中继＋登录门·');
  await gatePrincipalChecks(relayGated, '中继＋登录门·', true);
} catch (e) {
  if (e?.selfProbe) check(false, `启动自检：实例拒绝启动，没过的行是 ${e.selfProbe.join('、')}`, '后面的检查都没有跑');
  else { fail++; console.log(`  ✗ 对抗组没跑完：${String(e?.message ?? e).slice(0, 400)}`); }
} finally {
  for (const srv of running) await srv.stop();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`identity-seam-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
