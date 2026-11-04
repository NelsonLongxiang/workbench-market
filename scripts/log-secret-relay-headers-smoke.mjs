#!/usr/bin/env node
/** 日志不泄露上游会话 + 登录中继安全头（运维席 direct-cb457b75 / direct-b2e1f6fe 复现的两个问题，合成实例与替身上游）：
 *  ① 门户 /go/<id>/ 上游下发 Set-Cookie（含 Odoo session_id），进程 stdout/stderr 里不出现 cookie 值，只记 cookie 名；查询串也不进日志；
 *  ② 同域登录中继 /web/login 的嵌入策略取交集：上游 CSP 头逐条原样保留，另追加一条市场的 frame-ancestors
 *     （上游 XFO DENY 或任一条 frame-ancestors 'none' → 'none'，否则 'self'）；XFO 只留上游 DENY、其余 SAMEORIGIN；nosniff 恒设。
 *     六种上游（无头 / 只有 XFO DENY / CSP none+DENY / frame-ancestors 指向别的源 / 多条 CSP / XFO ALLOW-FROM）逐一核对响应头，
 *     带 CHROME_BIN 时每一种都用 Chromium 分别从同源、跨源 iframe 加载：原本禁止的照旧禁止，别的源一律挡住，不会比上游放宽。
 *  对抗（direct-d9c28a29 / direct-871e4312 / direct-237dbde1）：路径里藏 %3F / %253F 编码的查询串不进日志。 */
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
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
const ENC_SECRET = 'encodedSECRETmarker0000000000000005';
const DBL_SECRET = 'doubleSECRETmarker00000000000000006';
// 「别的源」：另一个端口就是另一个源；它的页面 iframe 嵌市场的 /web/login
const evil = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><iframe id="f" src="${globalThis.__MARKET}/web/login" width="400" height="300"></iframe>`); }); });
await new Promise((r) => evil.listen(0, '127.0.0.1', r));
const EVIL = `http://127.0.0.1:${evil.address().port}`;
let upstreamMode = 'bare';
/** 六种上游登录页响应头（ev = 别的源） */
const UPSTREAM = {
  bare: () => ({}),
  xfoDeny: () => ({ 'x-frame-options': 'DENY' }),
  noneDeny: () => ({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }),
  foreign: (ev) => ({ 'x-frame-options': `ALLOW-FROM ${ev}`, 'content-security-policy': `default-src 'self'; frame-ancestors ${ev}` }),
  multiCsp: () => ({ 'content-security-policy': ["default-src 'self'", "script-src 'self' 'unsafe-inline'"] }),
  allowFrom: (ev) => ({ 'x-frame-options': `ALLOW-FROM ${ev}` }),
};
const up = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const p = new URL(req.url, 'http://upstream');
    if (p.pathname === '/web/login') {
      const h = { 'content-type': 'text/html', 'set-cookie': [`session_id=${RELAY_SECRET}; Path=/; HttpOnly`] };
      Object.assign(h, UPSTREAM[upstreamMode](EVIL));
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
globalThis.__MARKET = base;
const env = { ...process.env, NODE_ENV: 'test', MCP_GATEWAY: 'off', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'log-secret-admin', REDIS_URL: '', LAYERFS_SERVICE_URL: '',
  WM_ODOO_LOGIN_PROXY: '1', WM_ODOO_URL: UP, LC_ODOO_URL: UP, WM_LOGIN_GATE: 'off' }; // b217168 还只认旧名 LC_ODOO_URL
for (const k of ['WM_EXTENSIONS_DIR', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let logs = ''; server.stdout.on('data', (c) => (logs += c)); server.stderr.on('data', (c) => (logs += c));

/** Chromium 里分别从同源（市场页面里插 iframe）、跨源（别的源的页面）iframe 嵌市场 /web/login；
 *  返回 { same, cross }，各为 blocked（子框落到 chrome-error）或 loaded */
let chrome = null, cdp = null;
async function browser() {
  if (cdp) return cdp;
  chrome = spawn(process.env.CHROME_BIN, ['--headless', '--no-sandbox', '--disable-gpu', '--no-proxy-server', '--user-data-dir=' + join(TMP, 'chrome'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((done, no) => { let t = ''; const tm = setTimeout(() => no(new Error('chrome timeout')), 15000); chrome.stderr.on('data', (d) => { t += d; const m = t.match(/127[.]0[.]0[.]1:(\d+)/); if (m) { clearTimeout(tm); done(m[1]); } }); });
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((o, n) => { ws.onopen = o; ws.onerror = n; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const j = JSON.parse(e.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j.result); pending.delete(j.id); } };
  const send = (method, params = {}) => new Promise((o) => { const n = ++id; pending.set(n, o); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  cdp = { ws, send };
  return cdp;
}
async function childVerdict(send) {
  await sleep(2500);
  const tree = await send('Page.getFrameTree');
  const child = tree?.frameTree?.childFrames?.[0]?.frame;
  if (!child) return 'no-child-frame';
  return /^chrome-error:/.test(child.url) || child.unreachableUrl ? 'blocked' : 'loaded';
}
async function framed() {
  const { send } = await browser();
  // 同源：先打开市场自己的一个页面，再往里插 iframe（同一个源）
  await send('Page.navigate', { url: base + '/api/health' }); await sleep(800);
  await send('Runtime.evaluate', { expression: `document.body.innerHTML='';const f=document.createElement('iframe');f.src='/web/login';document.body.appendChild(f);true` });
  const same = await childVerdict(send);
  // 跨源：别的源的页面里 iframe 市场 /web/login
  await send('Page.navigate', { url: EVIL + '/' });
  const cross = await childVerdict(send);
  return { same, cross };
}

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
  for (const [label, path] of [['%3F', `/go/${reg.id}/safe%3F${ENC_SECRET}`], ['%253F', `/go/${reg.id}/safe%253F${DBL_SECRET}`]]) {
    const x = await fetch(base + path, { redirect: 'manual' }); await x.text();
  }
  await sleep(400);
  ok('路径里 %3F 编码的查询串不进日志', !logs.includes(ENC_SECRET), logs.split('\n').filter((l) => l.includes(ENC_SECRET)).join(' / ').replaceAll(ENC_SECRET, '<E>').slice(0, 300));
  ok('路径里 %253F 双重编码的查询串不进日志', !logs.includes(DBL_SECRET), logs.split('\n').filter((l) => l.includes(DBL_SECRET)).join(' / ').replaceAll(DBL_SECRET, '<D>').slice(0, 300));
  ok('查询串（SSO state 等）不进日志', !logs.includes(QUERY_SECRET), logs.split('\n').filter((l) => l.includes(QUERY_SECRET)).join(' / ').replaceAll(QUERY_SECRET, '<Q>').slice(0, 300));
  other.close();

  // ② 同域登录中继：六种上游，核对响应头；带 CHROME_BIN 时逐一用 Chromium 同源 / 跨源 iframe 加载
  const EXPECT = {
    bare:     { fa: "'self'", xfo: 'SAMEORIGIN', same: 'loaded',  cross: 'blocked', keep: [] },
    xfoDeny:  { fa: "'none'", xfo: 'DENY',       same: 'blocked', cross: 'blocked', keep: [] },
    noneDeny: { fa: "'none'", xfo: 'DENY',       same: 'blocked', cross: 'blocked', keep: ["default-src 'self'; frame-ancestors 'none'"] },
    // 上游只许别的源嵌，市场只许同源：两条取交集后谁都嵌不了（不放宽上游，也不放别的源）
    foreign:  { fa: "'self'", xfo: 'SAMEORIGIN', same: 'blocked', cross: 'blocked', keep: [`default-src 'self'; frame-ancestors ${EVIL}`] },
    multiCsp: { fa: "'self'", xfo: 'SAMEORIGIN', same: 'loaded',  cross: 'blocked', keep: ["default-src 'self'", "script-src 'self' 'unsafe-inline'"] },
    allowFrom:{ fa: "'self'", xfo: 'SAMEORIGIN', same: 'loaded',  cross: 'blocked', keep: [] },
  };
  if (!process.env.CHROME_BIN) console.log('  - Chromium iframe 检查 SKIP（设 CHROME_BIN 才跑）');
  for (const [mode, want] of Object.entries(EXPECT)) {
    upstreamMode = mode;
    const raw = await new Promise((done) => {
      const q = request({ host: '127.0.0.1', port: PORT, path: '/web/login', headers: { host: 'market.example.test' } }, (rs) => { rs.resume(); rs.on('end', () => done(rs)); });
      q.end();
    });
    // 用 rawHeaders 看真实的多条头（node 解析后的 headers 会把重复的 CSP 用逗号并成一条）
    const csps = raw.rawHeaders.flatMap((v, i) => (i % 2 === 0 && v.toLowerCase() === 'content-security-policy' ? [raw.rawHeaders[i + 1]] : []));
    const market = csps.at(-1), upstream = csps.slice(0, -1);
    ok(`${mode}：上游 CSP 逐条原样保留`, JSON.stringify(upstream) === JSON.stringify(want.keep), JSON.stringify(csps));
    ok(`${mode}：追加一条 frame-ancestors ${want.fa}`, market === `frame-ancestors ${want.fa}`, String(market));
    ok(`${mode}：XFO ${want.xfo}，nosniff`, raw.headers['x-frame-options'] === want.xfo && raw.headers['x-content-type-options'] === 'nosniff', `${raw.headers['x-frame-options']} ${raw.headers['x-content-type-options']}`);
    if (process.env.CHROME_BIN) {
      const v = await framed();
      ok(`${mode}：Chromium 同源 iframe ${want.same}`, v.same === want.same, v.same);
      ok(`${mode}：Chromium 跨源 iframe ${want.cross}`, v.cross === want.cross, v.cross);
    }
  }
  await sleep(300);
  ok('中继下发的会话值不进日志', !logs.includes(RELAY_SECRET));
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  try { cdp?.ws.close(); chrome?.kill(); } catch {}
  server.kill(); up.close(); evil.close(); await sleep(300); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nlog-secret-relay-headers-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
