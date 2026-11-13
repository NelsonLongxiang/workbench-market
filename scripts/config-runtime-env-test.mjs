#!/usr/bin/env node
/**
 * 安全面的配置启动时取一次（对抗组）：进程跑起来之后，有代码改了 process.env（扩展、依赖、注入进来的脚本），
 * 管理口令、凭据库、对外断开的判断都不跟着变——要改就改启动环境并重启。
 *
 *   A 启动环境给了 ADMIN_TOKEN：运行中删掉它，/api/admin-token/state 仍报 env、不可设；PUT、DELETE 仍回 400（页面不能趁机设一个自己的口令）
 *   V 启动时没配服务端主密码、库在 A：运行中塞进 DSH_VAULT_PASSWORD、DSH_VAULT_PASSWORD_FILE、把 WM_VAULT_PATH 指到 B，
 *     /api/vault/status 仍报没有服务端主密码、库在 A（不会变成按需自动解锁，也不会被指到别的库文件）
 *   O 启动时 WM_OUTBOUND=off：运行中改成 on，outboundOff() 仍为真
 *   变异：三处任一改回用到时现读 process.env，都必须红（O 原来就是启动时取，守的是以后别改成现读）
 *
 * 每组在自己的子进程里跑（凭据库开库、出站闸替换内置模块，互不影响）；只用合成值，不访问外部。
 *   node scripts/config-runtime-env-test.mjs              测本仓库
 *   node scripts/config-runtime-env-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  A: { env: { ADMIN_TOKEN: 'synthetic-env-admin-token' }, code: `${SERVE}
const { registerAdminTokenRoutes } = await import(${src('routes/admin-token.ts')});
registerAdminTokenRoutes(http, { adminTokenCheck: () => false, odooAdminReqs: new WeakMap(), dbAdminTokenSet: () => false, dbAdminTokenOk: () => false, hashAdminToken: () => 'h', browserSameSite: () => false, devOriginOk: () => false });
const s = await serve();
const before = await s.call('GET', '/api/admin-token/state');
delete process.env.ADMIN_TOKEN;
const after = await s.call('GET', '/api/admin-token/state');
const put = await s.call('PUT', '/api/admin-token', { token: 'page-chosen-token' });
const del = await s.call('DELETE', '/api/admin-token');
await s.close();
console.log('RESULT ' + JSON.stringify({ before: before.body, after: after.body, put: put.status, del: del.status }));
process.exit(0);` },
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
    const r = run('A');
    check(r.before?.source === 'env' && r.before?.settable === false, '启动环境给了 ADMIN_TOKEN：状态报 env、页面不可设', show(r.before));
    check(r.after?.source === 'env' && r.after?.settable === false, '运行中删掉 process.env.ADMIN_TOKEN：状态仍报 env、不可设', show(r.after));
    check(r.put === 400 && r.del === 400, `运行中删掉之后，PUT（${r.put}）、DELETE（${r.del}）仍回 400：页面不能趁机设一个自己的口令、也清不掉`, show(r));
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
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nconfig-runtime-env-test: ${pass} 过，${fail} 没过`);
process.exit(fail ? 1 : 0);
