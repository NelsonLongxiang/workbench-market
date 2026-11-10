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
import { SESSIONS } from './identity-fake-provider.mjs';

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

/** 起一个隔离实例；提供方在 index.ts 装配之前换成假的。 */
async function boot(name, extraEnv = {}) {
  const port = await freePort();
  const { env, data } = baseEnv(name, { PORT: String(port), ...extraEnv });
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
  if (!ready) { await stop(); throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`); }
  const call = async (method, path, sid, body) => {
    const headers = { ...REMOTE, ...(sid ? { cookie: `session_id=${sid}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
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
  return { name, data, call, stop };
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
  await gateChecks(gated, '登录门·');
  // 同域登录中继开着：管理员认定和登录门各走另一支（不缓存，每次现查），同样的例子再过一遍
  await openChecks(relay, '中继·');
  await gateChecks(relayGated, '中继＋登录门·');
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${String(e?.message ?? e).slice(0, 400)}`);
} finally {
  for (const srv of running) await srv.stop();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`identity-seam-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
