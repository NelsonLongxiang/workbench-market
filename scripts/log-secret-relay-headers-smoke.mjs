#!/usr/bin/env node
/** 日志不泄露上游会话 + 登录中继安全头（运维席 direct-cb457b75 / direct-b2e1f6fe 复现的两个问题，合成实例与替身上游）：
 *  ① 门户 /go/<id>/ 上游下发 Set-Cookie（含 Odoo session_id），进程 stdout/stderr 里不出现 cookie 值，只记 cookie 名；查询串也不进日志；
 *  ② 同域登录中继 /web/login：上游没给时补 X-Frame-Options: SAMEORIGIN、X-Content-Type-Options: nosniff、CSP frame-ancestors 'self'；
 *     上游给了 X-Frame-Options 原样保留，上游 CSP 原样保留并另加 frame-ancestors；中继登录下发的会话值同样不进日志。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = resolve('tmp/log-secret-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });

const PORTAL_SECRET = 'portalSidSECRETvalue000000000000001';
const OTHER_SECRET = 'otherCookieSECRETvalue000000000002';
const RELAY_SECRET = 'relaySidSECRETvalue0000000000000003';
const QUERY_SECRET = 'querySECRETstate00000000000000004';
let upstreamMode = 'bare';
const up = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const p = new URL(req.url, 'http://upstream');
    if (p.pathname === '/web/login') {
      const h = { 'content-type': 'text/html', 'set-cookie': [`session_id=${RELAY_SECRET}; Path=/; HttpOnly`] };
      if (upstreamMode === 'own') { h['x-frame-options'] = 'DENY'; h['content-security-policy'] = "default-src 'self'"; }
      res.writeHead(200, h);
      return res.end('<form method="post" action="/web/login"><input name="csrf_token"></form>');
    }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [`session_id=${PORTAL_SECRET}; Path=/; HttpOnly`, `tracker=${OTHER_SECRET}; Path=/`] });
    res.end('<!doctype html><title>upstream</title><p>synthetic upstream</p>');
  });
});
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${up.address().port}`;

const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'log-secret-admin', REDIS_URL: '', LAYERFS_SERVICE_URL: '',
  WM_ODOO_LOGIN_PROXY: '1', WM_ODOO_URL: UP, LC_ODOO_URL: UP, WM_LOGIN_GATE: 'off' }; // b217168 还只认旧名 LC_ODOO_URL
for (const k of ['WM_EXTENSIONS_DIR', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let logs = ''; server.stdout.on('data', (c) => (logs += c)); server.stderr.on('data', (c) => (logs += c));

try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready ' + logs.slice(-300)); await sleep(200); }

  // ① 门户：普通外部台（不是可信 Odoo 源）——上游 Set-Cookie 只该以 cookie 名出现在日志里
  const other = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [`session_id=${PORTAL_SECRET}; Path=/`, `tracker=${OTHER_SECRET}; Path=/`] }); res.end('<p>other upstream</p>'); }); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const reg = await (await fetch(base + '/api/workbenches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'synthetic portal target', url: `http://127.0.0.1:${other.address().port}/`, type: 'web' }) })).json();
  ok('合成外部台已登记', Number.isInteger(reg.id), JSON.stringify(reg));
  const go = await fetch(`${base}/go/${reg.id}/?state=${QUERY_SECRET}`, { redirect: 'manual' });
  await go.text(); await sleep(400);
  ok('门户请求经过代理', go.status === 200, String(go.status));
  ok('proxres-entry 日志只记 cookie 名', /\[proxres-entry\][^\n]*sc: [^\n]*session_id/.test(logs) && /\[proxres-entry\][^\n]*tracker/.test(logs), logs.split('\n').filter((l) => l.includes('proxres-entry')).join(' / ').slice(0, 200));
  ok('上游 Odoo session_id 的值不进日志', !logs.includes(PORTAL_SECRET));
  ok('其它上游 cookie 的值不进日志', !logs.includes(OTHER_SECRET));
  ok('查询串（SSO state 等）不进日志', !logs.includes(QUERY_SECRET), logs.split('\n').filter((l) => l.includes(QUERY_SECRET)).join(' / ').replaceAll(QUERY_SECRET, '<Q>').slice(0, 300));
  other.close();

  // ② 同域登录中继
  upstreamMode = 'bare';
  let r = await fetch(base + '/web/login', { headers: { host: 'market.example.test' }, redirect: 'manual' });
  await r.text();
  ok('上游没给：补 X-Frame-Options: SAMEORIGIN', r.headers.get('x-frame-options') === 'SAMEORIGIN', String(r.headers.get('x-frame-options')));
  ok('上游没给：补 X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff', String(r.headers.get('x-content-type-options')));
  ok("上游没给：补 CSP frame-ancestors 'self'", /frame-ancestors 'self'/.test(String(r.headers.get('content-security-policy'))), String(r.headers.get('content-security-policy')));
  upstreamMode = 'own';
  r = await fetch(base + '/web/login', { headers: { host: 'market.example.test' }, redirect: 'manual' });
  await r.text();
  ok('上游给了 X-Frame-Options：原样保留（DENY 不被放宽）', r.headers.get('x-frame-options') === 'DENY', String(r.headers.get('x-frame-options')));
  const csp = String(r.headers.get('content-security-policy'));
  ok("上游 CSP 原样保留，另加 frame-ancestors 'self'", csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'self'"), csp);
  ok('中继：nosniff 仍在', r.headers.get('x-content-type-options') === 'nosniff');
  await sleep(300);
  ok('中继下发的会话值不进日志', !logs.includes(RELAY_SECRET));
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  server.kill(); up.close(); await sleep(300); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nlog-secret-relay-headers-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
