#!/usr/bin/env node
/**
 * 身份接缝的对抗组（安全面）。真实的 server/src/index.ts，登录提供方换成假的（scripts/identity-fake-provider.mjs），
 * 不访问任何真实的外部系统。请求都带反代转发头，按远程浏览器算（本机命令行的免口令不适用）。
 *
 * 每一例是一个谓词对：拒绝的那一头，加上合法对照的那一头，两头都对才算过。
 * 对照的作用是证明核心确实在问身份服务——核心要是绕开服务，拒绝例照样全绿，对照例会红。
 *
 * 五个入口，都是原来直接引用身份实现的地方：
 *   whoami（index.ts）· 管理员认定（index.ts）· 统一待办读权（tasks-read-access.ts）·
 *   run 私有读授权（sop-read-auth.ts）· 全站登录门（login-gate.ts 经 index.ts 的装配）
 *
 *   node scripts/identity-seam-smoke.mjs              测本仓库
 *   node scripts/identity-seam-smoke.mjs --root DIR   测另一棵目录树（变异测试用）
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
const OUT = join(HERE, '..', 'tmp', `identity-seam-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-identity-seam-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.10' }; // 文档网段：经反代进来的远程请求
const RUN_ID = 4101;
const PRIVATE = 'SYNTHETIC_PRIVATE_RUN_VALUE';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/** 起一个隔离实例；提供方在 index.ts 装配之前换成假的。 */
async function boot(name, extraEnv = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (!ready) { await stop(); throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`); }
  const call = async (method, path, sid, body) => {
    const headers = { ...REMOTE, ...(sid ? { cookie: `session_id=${sid}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json, text };
  };
  return { data, call, stop };
}

/** 一个会话在五个入口上各是什么结果 */
async function observe(srv, sid) {
  const [viewer, admin, write, tasks, run] = await Promise.all([
    srv.call('GET', '/api/auth/viewer', sid),
    srv.call('GET', '/api/admin/whoami', sid),
    srv.call('POST', '/api/workbenches', sid, { name: '', url: '' }), // 过了管理员门才会走到校验（400，不落库）；过不了是 403
    srv.call('GET', '/api/tasks', sid),
    srv.call('GET', `/api/sop/runs/${RUN_ID}`, sid),
  ]);
  return {
    viewer: viewer.status, viewerAdmin: viewer.json?.viewer?.admin ?? null, login: viewer.json?.viewer?.login ?? null,
    admin: admin.json?.admin ?? null, adminLogin: admin.json?.login ?? null,
    write: write.status,
    tasks: tasks.status, tasksError: tasks.json?.error ?? null,
    runPrivate: run.text.includes(PRIVATE), run: run.status,
  };
}

const show = (o) => JSON.stringify(o);
rmSync(OUT, { recursive: true, force: true });
let open = null, gated = null;
try {
  // 两个隔离实例一起起：一个登录门关着，一个开着（enforce）
  [open, gated] = await Promise.all([boot('open'), boot('gated', { WM_LOGIN_GATE: 'enforce' })]);

  // ---------- 一、登录门关着：四个入口 ----------
  {
    // 一个带私有值的已结束 run，只授权给 user:alpha
    const db = new DatabaseSync(join(open.data, 'workbench-market.db'));
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare("INSERT INTO sop_runs(id,sop_slug,sop_version,status,started_by,data,finished_at) VALUES(?,?,1,'finished','synthetic',?,datetime('now'))").run(RUN_ID, 'synthetic-private', JSON.stringify({ step: { value: PRIVATE } }));
    db.prepare("INSERT INTO sop_run_read_grants(run_id,subject,expires_at,granted_by) VALUES(?,?,datetime('now','+1 day'),'synthetic-seed')").run(RUN_ID, 'user:alpha');
    db.close();
  }

  // 合法对照：先确认「该放行的」确实经身份服务放行了
  const alpha = await observe(open, SESSIONS.alpha);
  const beta = await observe(open, SESSIONS.beta);
  const admin = await observe(open, SESSIONS.admin);
  const alphaOk = alpha.viewer === 200 && alpha.login === 'alpha' && alpha.viewerAdmin === false && alpha.tasks === 200 && alpha.runPrivate && alpha.admin === false && alpha.write === 403;
  const betaOk = beta.viewer === 200 && beta.login === 'beta' && beta.tasks === 200 && !beta.runPrivate && beta.run === 200;
  const adminOk = admin.viewer === 200 && admin.viewerAdmin === true && admin.admin === true && admin.adminLogin === 'root-admin' && admin.write === 400 && admin.tasks === 200;
  check(alphaOk, '对照·内部员工 alpha：认得出、读得到待办、读得到授权给自己的 run 私有值；不是管理员，管理写 403', show(alpha));
  check(betaOk, '对照·内部员工 beta：认得出、读得到待办；别人的 run 只看到元数据', show(beta));
  check(adminOk, '对照·管理员：管理员认定成立，管理写过得了管理员门（400=走到了校验）', show(admin));

  // 拒绝例：每一种认不出的情形，五个入口没有一个放行
  const refused = (o, viewer, tasks, tasksError) => o.viewer === viewer && o.login === null && o.admin === false && o.write === 403 && o.tasks === tasks && o.tasksError === tasksError && !o.runPrivate && o.run === 200;
  const cases = [
    ['① 没有会话', null, 401, 401, 'tasks_auth_required'],
    ['② 伪造的会话', SESSIONS.forged, 401, 401, 'tasks_auth_required'],
    ['③ 身份来源不可达：按失败处理，不放行', SESSIONS.unreachable, 502, 503, 'tasks_identity_unavailable'],
    ['④ 提供方抛错：按失败处理，不放行、不 500', SESSIONS.throws, 502, 503, 'tasks_identity_unavailable'],
    ['⑤ 非内部账号', SESSIONS.portal, 403, 403, 'tasks_internal_user_required'],
    ['⑥ 回答畸形（ok:true 却没有查看者）', SESSIONS.malformed, 502, 503, 'tasks_identity_unavailable'],
    ['⑦ 冒名主体（登录名 mallory，主体写成持有授权的 user:alpha，还自称管理员）', SESSIONS.impersonate, 502, 503, 'tasks_identity_unavailable'],
  ];
  for (const [label, sid, viewer, tasks, tasksError] of cases) {
    const o = await observe(open, sid);
    check(refused(o, viewer, tasks, tasksError) && alphaOk && adminOk, `${label} → whoami ${viewer}、不是管理员、管理写 403、待办 ${tasks}、run 私有值不给`, show(o));
  }
  // 管理员标记：缺了、或者不是布尔 true，人认得出，但不是管理员
  for (const [label, sid, login] of [['⑧ 管理员标记缺失', SESSIONS.noAdminFlag, 'no-flag'], ['⑨ 管理员标记是字符串 "true"', SESSIONS.truthyAdmin, 'truthy-flag']]) {
    const o = await observe(open, sid);
    check(o.viewer === 200 && o.login === login && o.viewerAdmin === false && o.admin === false && o.write === 403 && o.tasks === 200 && !o.runPrivate && adminOk, `${label} → 认得出人，按「不是管理员」处理：管理写 403`, show(o));
  }

  // ---------- 二、登录门开着（enforce）：没有身份什么都拿不到 ----------
  const gate = async (sid) => {
    const [api, me] = await Promise.all([gated.call('GET', '/api/apps', sid), gated.call('GET', '/api/auth/me', sid)]);
    return { api: api.status, error: api.json?.error ?? null, authenticated: me.json?.authenticated ?? null, via: me.json?.via ?? null, login: me.json?.login ?? null };
  };
  const inside = await gate(SESSIONS.alpha);
  const insideOk = inside.api === 200 && inside.authenticated === true && inside.via === 'odoo' && inside.login === 'alpha';
  check(insideOk, '对照·登录门：内部员工进得来', show(inside));
  for (const [label, sid] of [['⑩ 登录门·没有会话', null], ['⑪ 登录门·伪造的会话', SESSIONS.forged], ['⑫ 登录门·身份来源不可达', SESSIONS.unreachable], ['⑬ 登录门·提供方抛错', SESSIONS.throws], ['⑭ 登录门·非内部账号', SESSIONS.portal], ['⑮ 登录门·回答畸形', SESSIONS.malformed], ['⑯ 登录门·冒名主体', SESSIONS.impersonate]]) {
    const o = await gate(sid);
    check(o.api === 401 && o.error === 'login_required' && o.authenticated === false && insideOk, `${label} → 401，进不来`, show(o));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  for (const srv of [open, gated]) if (srv) await srv.stop();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`identity-seam-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
