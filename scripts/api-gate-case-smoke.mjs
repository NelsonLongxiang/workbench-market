#!/usr/bin/env node
/** 远程写总门路径一致性冒烟：Express 路由不区分大小写、也认绝对形式请求目标（#299），总门必须与路由同源分类。
 *  从本机非回环地址发请求（算远程）；找不到非回环 IPv4 时 SKIP（不当通过）。全新 DATA_DIR + 随机端口。 */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
if (!lan) { console.log('api-gate-case-smoke: SKIP（本机没有非回环 IPv4，无法模拟远程请求）'); process.exit(0); }
const TMP = resolve('tmp/api-gate-case-' + Date.now().toString(36)); mkdirSync(TMP, { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const port = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(port), DATA_DIR: TMP, ADMIN_TOKEN: 'case-smoke' };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT']) delete env[k];
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; child.stderr.on('data', (c) => (err += c));
// 原始请求目标（fetch 只发 origin-form，绝对形式要用 http.request 的 path 原样发出）
const rawPost = (target) => new Promise((done) => {
  const body = JSON.stringify({ name: 'case' + Math.random(), url: 'http://127.0.0.1:9/', type: 'web' });
  const q = request({ host: lan, port, method: 'POST', path: target, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); done(r.statusCode); });
  q.on('error', (e) => done(String(e))); q.end(body);
});
const post = (path, headers = {}) => fetch(`http://${lan}:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'case' + Math.random(), url: 'http://127.0.0.1:9/', type: 'web' }) }).then((r) => r.status).catch((e) => String(e));
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  for (const p of ['/api/workbenches', '/API/workbenches', '/Api/Workbenches', '/API/WORKBENCHES', '/api/WORKBENCHES']) {
    const s = await post(p);
    ok(`远程（${lan}）无口令 POST ${p} → 403`, s === 403, String(s));
  }
  for (const t of [`http://${lan}:${port}/api/workbenches`, 'http://x/api/workbenches', 'HTTP://x/API/workbenches']) {
    const s = await rawPost(t);
    ok(`远程无口令 POST 绝对形式 ${t} → 403`, s === 403, String(s));
  }
  ok('远程带口令 POST /API/workbenches → 201（大小写只影响分类，不影响合法调用）', (await post('/API/workbenches', { 'x-admin-token': 'case-smoke' })) === 201);
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  child.kill(); await new Promise((r) => setTimeout(r, 400));
  if (fail && err) console.log(err.slice(-800));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`api-gate-case-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
