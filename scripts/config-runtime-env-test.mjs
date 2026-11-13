#!/usr/bin/env node
/**
 * 安全面的配置启动时取一次（对抗组）：进程跑起来之后，有代码改了 process.env（扩展、依赖、注入进来的脚本），
 * 管理口令、凭据库、对外断开的判断都不跟着变——要改就改启动环境并重启。
 *
 *   A 起真实例（口令校验、登录门、管理口令路由都是真的），由预加载脚本按测试的要求在运行中改 process.env：
 *     A1 启动环境给了 ADMIN_TOKEN，运行中删掉它：原口令照旧是管理员（whoami）、照旧能换登录会话；/api/admin-token/state 仍报 env、不可设；PUT、DELETE 仍回 400
 *     A2 启动时没给 ADMIN_TOKEN，运行中塞进一个：拿它不是管理员、换不到登录会话；状态仍报 none
 *   V 启动时没配服务端主密码、库在 A：运行中塞进 DSH_VAULT_PASSWORD、DSH_VAULT_PASSWORD_FILE、把 WM_VAULT_PATH 指到 B，
 *     /api/vault/status 仍报没有服务端主密码、库在 A（不会变成按需自动解锁，也不会被指到别的库文件）
 *   O 启动时 WM_OUTBOUND=off：运行中改成 on，outboundOff() 仍为真
 *   变异：任一处改回用到时现读 process.env，都必须红（O 原来就是启动时取，守的是以后别改成现读）
 *
 * 每组在自己的子进程里跑（凭据库开库、出站闸替换内置模块，互不影响）；只用合成值，不访问外部。
 *   node scripts/config-runtime-env-test.mjs              测本仓库
 *   node scripts/config-runtime-env-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const src = (p) => JSON.stringify(pathToFileURL(join(ROOT, 'server/src', p)).href);
const EXPRESS = JSON.stringify(pathToFileURL(join(ROOT, 'server/node_modules/express/index.js')).href);

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };

/** 起一个只挂被测路由的 Express（HTTP 服务的注册写法：路径、动作、处理函数），返回 call */
const SERVE = `
const express = (await import(${EXPRESS})).default;
const app = express(); app.use(express.json());
const http = {}; for (const m of ['get', 'post', 'put', 'delete']) http[m] = (p, _action, ...h) => app[m](p, ...h);
const serve = async () => {
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
  return { call, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
};
`;

const CASES = {
  V: { env: {}, code: `${SERVE}
const { mountVault } = await import(${src('vault-api.ts')});
mountVault(http, () => true);
const s = await serve();
const before = await s.call('GET', '/api/vault/status');
process.env.DSH_VAULT_PASSWORD = 'synthetic-injected-master-42';
process.env.DSH_VAULT_PASSWORD_FILE = process.env.VAULT_B + '.pw';
process.env.WM_VAULT_PATH = process.env.VAULT_B;
const after = await s.call('GET', '/api/vault/status');
await s.close();
console.log('RESULT ' + JSON.stringify({ before: before.body, after: after.body }));
process.exit(0);` },
  O: { env: { WM_OUTBOUND: 'off' }, code: `
const gate = await import(${src('outbound-gate.ts')});
const before = gate.outboundOff();
process.env.WM_OUTBOUND = 'on';
console.log('RESULT ' + JSON.stringify({ before, after: gate.outboundOff() }));
process.exit(0);` },
};

const tmp = mkdtempSync(join(tmpdir(), 'wm-config-runtime-env-'));

/** 预加载：实例照常起；测试在 DATA_DIR 下放 mutate-env.json 时，按它改 process.env（null 是删），改完写 mutate-env.done */
const MUTATE = join(tmp, 'mutate-env-preload.mjs');
writeFileSync(MUTATE, `import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.DATA_DIR;
setInterval(() => {
  const m = join(dir, 'mutate-env.json');
  if (!existsSync(m)) return;
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(m, 'utf8')))) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  rmSync(m); writeFileSync(join(dir, 'mutate-env.done'), '1');
}, 50).unref();
`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const running = [];
async function boot(name, extra) {
  const data = join(tmp, name, 'data'), home = join(tmp, name, 'home'), ext = join(tmp, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  const port = await freePort();
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extra });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, '--import', pathToFileURL(MUTATE).href, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  running.push(stop);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例 ${name} 没起来：${log.slice(-800)}`);
    try { ok = (await fetch(base + '/api/health')).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers = {}, body) => { const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
  const mutate = async (ops) => {
    writeFileSync(join(data, 'mutate-env.json'), JSON.stringify(ops));
    for (let i = 0; !existsSync(join(data, 'mutate-env.done')); i++) { if (i > 100) throw new Error('预加载没改环境'); await new Promise((r) => setTimeout(r, 50)); }
    rmSync(join(data, 'mutate-env.done'));
  };
  return { call, mutate, stop };
}
const run = (name, extra = {}) => {
  const base = {};
  for (const k of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'HOME']) if (process.env[k]) base[k] = process.env[k];
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', CASES[name].code], { cwd: join(ROOT, 'server'), env: { ...base, NODE_ENV: 'test', DATA_DIR: join(tmp, name, 'data'), ...CASES[name].env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  const m = /RESULT (.*)/.exec(r.stdout ?? '');
  if (!m) throw new Error(`${name} 没跑出结果：${(r.stderr ?? '').slice(-800)}`);
  return JSON.parse(m[1]);
};
const show = (o) => JSON.stringify(o);

try {
  {
    const T = 'synthetic-startup-admin-token-1', X = 'synthetic-injected-admin-token-2';
    const a1 = await boot('a1', { ADMIN_TOKEN: T });
    const pre = await a1.call('GET', '/api/admin/whoami', { 'x-admin-token': T });
    await a1.mutate({ ADMIN_TOKEN: null });
    const who = await a1.call('GET', '/api/admin/whoami', { 'x-admin-token': T });
    const login = await a1.call('POST', '/api/auth/login', {}, { token: T });
    const state = await a1.call('GET', '/api/admin-token/state');
    const put = await a1.call('PUT', '/api/admin-token', { 'x-admin-token': T }, { token: 'page-chosen-token' });
    const del = await a1.call('DELETE', '/api/admin-token', { 'x-admin-token': T });
    await a1.stop();
    check(pre.body?.admin === true && who.body?.admin === true && who.body?.via === 'token', '真实例 A1：运行中删掉 process.env.ADMIN_TOKEN，启动时的口令照旧是管理员', JSON.stringify({ pre: pre.body, who: who.body }));
    check(login.status === 200, `真实例 A1：删掉之后照旧能拿启动时的口令换登录会话（${login.status}，登录门的指纹和口令校验是同一份）`, JSON.stringify(login.body));
    check(state.body?.source === 'env' && state.body?.settable === false && put.status === 400 && del.status === 400, `真实例 A1：状态仍报 env、不可设；PUT（${put.status}）、DELETE（${del.status}）仍回 400——页面不能趁机设一个自己的口令、也清不掉`, JSON.stringify({ state: state.body, put: put.body, del: del.body }));
    const a2 = await boot('a2', {});
    await a2.mutate({ ADMIN_TOKEN: X });
    const who2 = await a2.call('GET', '/api/admin/whoami', { 'x-admin-token': X });
    const login2 = await a2.call('POST', '/api/auth/login', {}, { token: X });
    const state2 = await a2.call('GET', '/api/admin-token/state');
    await a2.stop();
    check(who2.body?.admin === false, '真实例 A2：启动时没有口令，运行中塞进一个——拿它不是管理员', JSON.stringify(who2.body));
    check(login2.status === 401, `真实例 A2：拿塞进来的口令换不到登录会话（${login2.status}）`, JSON.stringify(login2.body));
    check(state2.body?.source === 'none', '真实例 A2：状态仍报 none（没有凭空多出一个环境口令）', JSON.stringify(state2.body));
  }
  {
    const A = join(tmp, 'V', 'vault-a.json'), B = join(tmp, 'V', 'vault-b.json');
    const r = run('V', { WM_VAULT_PATH: A, VAULT_B: B });
    check(r.before?.path === A && r.before?.env_password === false, '启动时库在 A、没配服务端主密码', show(r.before));
    check(r.after?.env_password === false, '运行中塞进 DSH_VAULT_PASSWORD、DSH_VAULT_PASSWORD_FILE：仍报没有服务端主密码（不会变成按需自动解锁）', show(r.after));
    check(r.after?.path === A, '运行中把 WM_VAULT_PATH 指到 B：库仍在 A', show({ path: r.after?.path }));
  }
  {
    const r = run('O');
    check(r.before === true && r.after === true, '启动时 WM_OUTBOUND=off：运行中改成 on，仍是对外断开', show(r));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const stop of running) await stop();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nconfig-runtime-env-test: ${pass} 过，${fail} 没过`);
process.exit(fail ? 1 : 0);
