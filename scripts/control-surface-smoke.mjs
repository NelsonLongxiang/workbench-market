#!/usr/bin/env node
/** #292 M1 控制面冒烟（全新 DATA_DIR + 随机回环端口；合成口令，不碰真实实例）：
 *  浏览器管理写只认控制面 + 控制面 Origin + 口令；从业务面（含 127.0.0.1:9800 页面）发的一律 403；
 *  本机 CLI（无 Origin）照旧免口令；同机反代转进来的（X-Forwarded-For）按远程要口令；业务写白名单不变；
 *  控制面 404 掉 /go、/sop、/apps 并带禁嵌头；index.html 按面注入 wm-surface；WM_CONTROL_PORT=0 关控制面。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/control-surface-smoke-' + Date.now().toString(36));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const servers = [];

function boot(tag, extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = join(TMP, `data-${tag}`); mkdirSync(data, { recursive: true });
  const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(port), DATA_DIR: data, ...extraEnv };
  for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
  if (!('ADMIN_TOKEN' in extraEnv)) delete env.ADMIN_TOKEN;
  if (!('WM_DEV_ORIGIN' in extraEnv)) delete env.WM_DEV_ORIGIN;
  if (!('WM_CONTROL_PORT' in extraEnv)) delete env.WM_CONTROL_PORT; // 用缺省：业务端口 + 1
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
  let err = ''; child.stderr.on('data', (c) => (err += c));
  const s = { port, control: env.WM_CONTROL_PORT === undefined ? port + 1 : Number(env.WM_CONTROL_PORT) || 0, child, err: () => err };
  servers.push(s);
  return s;
}
const http = (port, method, path, headers = {}, body) => new Promise((done) => {
  const h = { ...headers }; if (body !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
  const rq = request({ host: '127.0.0.1', port, method, path, headers: h }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j, text: s }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) }, text: '' }));
  if (body !== undefined) rq.write(body);
  rq.end();
});
const up = async (port) => { const end = Date.now() + 40_000; while (Date.now() < end) { if ((await http(port, 'GET', '/api/health')).status === 200) return true; await new Promise((x) => setTimeout(x, 250)); } return false; };
const wb = (n) => JSON.stringify({ name: `cs-${n}`, url: 'http://127.0.0.1:9/', type: 'web' });

try {
  const TOK = 'synthetic-control-token';
  const A = boot('a', { ADMIN_TOKEN: TOK });
  ok('业务面与控制面都起来', (await up(A.port)) && (await up(A.control)));
  const M = `http://127.0.0.1:${A.port}`, C = `http://127.0.0.1:${A.control}`;

  console.log('浏览器管理写');
  let r = await http(A.port, 'POST', '/api/workbenches', { origin: M, host: `127.0.0.1:${A.port}` }, wb(1));
  ok('127.0.0.1:9800 页面（业务面 Origin）发管理写 → 403，指向控制面', r.status === 403 && r.body?.control_surface_required === true && r.body?.control_url === C, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.port, 'POST', '/api/workbenches', { origin: M, 'x-admin-token': TOK }, wb(2));
  ok('业务面带对口令也拒（口令不该出现在业务面）', r.status === 403 && r.body?.control_surface_required === true, `${r.status}`);
  for (const v of ['/API/workbenches', '/Api/Workbenches', '/API/WORKBENCHES']) {
    r = await http(A.port, 'POST', v, { origin: M }, wb('c' + v));
    ok(`业务面浏览器大写变体 ${v} 无口令 → 403`, r.status === 403, `${r.status}`);
    r = await http(A.port, 'POST', v, { origin: M, 'x-admin-token': TOK }, wb('t' + v));
    ok(`业务面浏览器大写变体 ${v} 带口令 → 403`, r.status === 403, `${r.status}`);
  }
  r = await http(A.port, 'POST', '/api/workbenches', { 'sec-fetch-site': 'same-origin' }, wb(3));
  ok('只有 Sec-Fetch-Site、没有 Origin 也算浏览器 → 403', r.status === 403, `${r.status}`);
  r = await http(A.control, 'POST', '/api/workbenches', { origin: C, 'x-admin-token': TOK }, wb(4));
  ok('控制面 + 控制面 Origin + 口令 → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.control, 'POST', '/api/workbenches', { origin: C }, wb(5));
  ok('控制面不带口令 → 403', r.status === 403 && !r.body?.control_surface_required, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.control, 'POST', '/api/workbenches', { origin: M, 'x-admin-token': TOK }, wb(6));
  ok('控制面收到业务面 Origin（跨源）+ 口令 → 403', r.status === 403, `${r.status}`);
  r = await http(A.port, 'POST', '/api/workbenches', { origin: 'http://localhost:5173', 'x-admin-token': TOK }, wb(7));
  ok('web dev 源（vite 5173）+ 口令：默认（未开 --dev-origin）→ 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);

  console.log('本机 CLI 与反代');
  r = await http(A.port, 'POST', '/api/workbenches', {}, wb(8));
  ok('本机 CLI（无 Origin）不带口令 → 201（属主口径保留）', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.port, 'POST', '/api/workbenches', { 'sec-fetch-mode': 'cors' }, wb('8b'));
  ok('本机 Node fetch（自带 sec-fetch-mode: cors、无 Origin）不带口令 → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.port, 'POST', '/api/workbenches', { 'x-forwarded-for': '10.0.0.8' }, wb(9));
  ok('本机但带 X-Forwarded-For（同机反代转进来）不带口令 → 403', r.status === 403, `${r.status}`);
  r = await http(A.port, 'POST', '/API/workbenches', { 'x-forwarded-for': '10.0.0.8' }, wb('9u'));
  ok('同上大写路径不带口令 → 403', r.status === 403, `${r.status}`);
  r = await http(A.port, 'POST', '/api/workbenches', { 'x-forwarded-for': '10.0.0.8', 'x-admin-token': TOK }, wb(10));
  ok('同上带口令 → 201（远程 CLI 照旧凭口令）', r.status === 201, `${r.status}`);

  console.log('绝对形式请求目标（#299：POST http://x/api/… 曾绕过按原始 req.url 分类的门）');
  for (const v of ['http://x/api/workbenches', 'HTTP://X/API/workbenches', `http://127.0.0.1:${A.port}/api/workbenches`]) {
    r = await http(A.port, 'POST', v, { origin: M }, wb('abs-b' + v));
    ok(`业务面浏览器绝对形式 ${v} 无口令 → 403`, r.status === 403 && r.body?.control_surface_required === true, `${r.status} ${JSON.stringify(r.body)}`);
    r = await http(A.port, 'POST', v, { 'x-forwarded-for': '10.0.0.9' }, wb('abs-r' + v));
    ok(`反代转发的绝对形式 ${v} 无口令 → 403`, r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  }
  r = await http(A.port, 'DELETE', 'http://x/api/workbenches/1', { 'x-forwarded-for': '10.0.0.9' });
  ok('反代转发的绝对形式 DELETE 无口令 → 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.control, 'POST', `http://127.0.0.1:${A.control}/api/workbenches`, { origin: C, 'x-admin-token': TOK }, wb('abs-ok'));
  ok('合法正例：控制面绝对形式 + 控制面 Origin + 口令 → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.port, 'POST', 'http://x/api/sop/runs', { origin: M }, JSON.stringify({ slug: 'no-such-sop' }));
  ok('合法正例：业务面绝对形式 /api/sop/runs 仍按业务白名单放行（不是 403 控制面）', !r.body?.control_surface_required && r.status !== 403, `${r.status} ${JSON.stringify(r.body)}`);

  console.log('业务写白名单不变');
  r = await http(A.port, 'POST', '/api/sop/runs', { origin: M }, JSON.stringify({ slug: 'no-such-sop' }));
  ok('业务面浏览器 POST /api/sop/runs 不被总门拦（不是 403 控制面）', !r.body?.control_surface_required && r.status !== 403, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(A.port, 'POST', '/api/lifecycle/approve', { origin: M }, '{}');
  ok('业务面 /api/lifecycle/approve 不被总门拦（仍由自身只读 503）', !r.body?.control_surface_required, `${r.status}`);

  console.log('控制面围栏');
  for (const p of ['/go/1/', '/sop/x/', '/apps/x/', '/mcp', '/MCP', '/A2A/direct', '/a2a/direct', '/GO/1/', '/Sop/x/', '/APPS/x/', 'http://x/go/1/', 'HTTP://X/MCP', 'http://x/a2a/direct', 'http://x/Sop/x/', 'http://x/APPS/x/']) {
    r = await http(A.control, /mcp|a2a/i.test(p) ? 'POST' : 'GET', p);
    ok(`控制面 ${p} → 404`, r.status === 404, `${r.status}`);
  }
  r = await http(A.control, 'GET', '/api/health');
  ok('控制面响应带 frame-ancestors none 与 X-Frame-Options DENY', /frame-ancestors 'none'/.test(String(r.headers['content-security-policy'])) && r.headers['x-frame-options'] === 'DENY', JSON.stringify(r.headers));
  r = await http(A.port, 'GET', '/api/health');
  ok('业务面不加控制面禁嵌头', r.headers['x-frame-options'] === undefined);
  const wsC = await new Promise((done) => {
    const rq = request({ host: '127.0.0.1', port: A.control, path: '/go/1/', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    rq.on('upgrade', () => done('upgraded')); rq.on('response', (rs) => done(`http ${rs.statusCode}`)); rq.on('error', () => done('destroyed')); rq.end();
  });
  ok('控制面 WS 升级被拒（不升级）', wsC !== 'upgraded', wsC);

  console.log('口令设置（无 ENV 口令的实例）');
  const B = boot('b', {});
  await up(B.port); await up(B.control);
  const CB = `http://127.0.0.1:${B.control}`, MB = `http://127.0.0.1:${B.port}`;
  r = await http(B.port, 'PUT', '/api/admin-token', { origin: MB }, JSON.stringify({ token: 'set-from-market' }));
  ok('业务面页面设口令 → 403', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(B.control, 'PUT', '/api/admin-token', { origin: CB }, JSON.stringify({ token: 'set-from-control' }));
  ok('本机控制面页面首次设口令 → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(B.control, 'POST', '/api/workbenches', { origin: CB, 'x-admin-token': 'set-from-control' }, wb(11));
  ok('新口令在控制面生效 → 201', r.status === 201, `${r.status}`);
  r = await http(B.port, 'GET', '/api/admin-token/state', { origin: MB });
  ok('业务面 state.settable=false', r.body?.settable === false, JSON.stringify(r.body));

  console.log('web dev 来源例外（显式开启）');
  const D = boot('d', { ADMIN_TOKEN: TOK, WM_DEV_ORIGIN: '1', NODE_ENV: 'production' });
  await up(D.port);
  r = await http(D.port, 'POST', '/api/workbenches', { origin: 'http://localhost:5173', 'x-admin-token': TOK }, wb(14));
  ok('WM_DEV_ORIGIN=1：vite 5173 源 + 口令 → 201', r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(D.port, 'POST', '/api/workbenches', { origin: 'http://localhost:5173' }, wb(15));
  ok('WM_DEV_ORIGIN=1：vite 5173 源不带口令 → 403（例外只免面、不免口令）', r.status === 403, `${r.status}`);
  r = await http(D.port, 'POST', '/api/workbenches', { origin: 'http://localhost:5173', 'x-admin-token': TOK, 'x-forwarded-for': '10.0.0.8' }, wb(16));
  ok('WM_DEV_ORIGIN=1：带转发头（非本机直连）→ 403', r.status === 403, `${r.status}`);
  const P = boot('p', { ADMIN_TOKEN: TOK, NODE_ENV: 'production' });
  await up(P.port);
  r = await http(P.port, 'POST', '/api/workbenches', { origin: 'http://localhost:5173', 'x-admin-token': TOK }, wb(17));
  ok('NODE_ENV=production、未开例外：vite 5173 源 + 口令 → 403', r.status === 403, `${r.status}`);

  console.log('控制面关闭（WM_CONTROL_PORT=0）');
  const Z = boot('z', { ADMIN_TOKEN: TOK, WM_CONTROL_PORT: '0' });
  await up(Z.port);
  r = await http(Z.port, 'POST', '/api/workbenches', { origin: `http://127.0.0.1:${Z.port}`, 'x-admin-token': TOK }, wb(12));
  ok('浏览器管理写一律 403、control_url 为空', r.status === 403 && r.body?.control_url === null, `${r.status} ${JSON.stringify(r.body)}`);
  r = await http(Z.port, 'POST', '/api/workbenches', {}, wb(13));
  ok('本机 CLI 仍可用 → 201', r.status === 201, `${r.status}`);
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  for (const s of servers) s.child.kill();
  await new Promise((x) => setTimeout(x, 500));
  if (fail) for (const s of servers) if (s.err()) console.log(s.err().slice(-800));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`control-surface-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
