#!/usr/bin/env node
/**
 * 门户转发前去掉市场自身的认证信息（对抗组）：经 /go/<台号>/… 转给台的请求里，不能有市场的管理口令、市场发的令牌（Authorization: Bearer 的 MCP 会话令牌）、台令牌、
 * SOP run 的凭据、x-wm-/x-a2a- 头，也不能有市场会话、登录门等市场自己的 cookie；台自己的头和 cookie 原样留下。
 * HTTP（GET、POST）和 WebSocket 握手（普通台、Odoo 台）都看。
 *
 * 隔离：空的 DATA_DIR（tmp/ 下现建、跑完删），本机起两个假上游（普通台、Odoo 台），不读任何真实数据、不连外网。
 *   node scripts/portal-forward-strip-test.mjs
 */
import { spawn } from './owned-script-fixture.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const PORT = 20000 + Math.floor(Math.random() * 12000);
const ADMIN = 'pfs-admin-token';
mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'portal-forward-strip-'));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

// 假上游：记下收到的每个请求（含 WebSocket 握手）的头和体，应答把它回给测试
const seen = [];
function upstream() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ kind: 'http', url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers, body }));
    });
  });
  srv.on('upgrade', (req, socket) => {
    seen.push({ kind: 'ws', url: req.url, headers: req.headers });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
const plain = await upstream();
const odoo = await upstream();

const MARKET_HEADERS = {
  'x-admin-token': ADMIN, 'x-app-token': 'pfs-app', 'x-run-read-capability': 'pfs-cap', 'x-run-upload-token': 'pfs-up',
  'x-sop-run-capability': 'pfs-run', 'x-sop-upload-capability': 'pfs-sup', 'x-sop-finish-capability': 'pfs-fin',
  'x-market-client': 'web', 'x-wm-anything': 'pfs-wm', 'x-a2a-caller-sig': 'pfs-sig',
};
const MARKET_COOKIES = 'wm_session=pfs-sess; wm_login=pfs-login; wm_login_state=pfs-st; wm_content_context=pfs-ctx';
const leaked = (h) => [
  ...Object.keys(MARKET_HEADERS).filter((k) => k in h),
  ...['wm_session', 'wm_login', 'wm_login_state', 'wm_content_context', 'wm_sso_'].filter((c) => String(h.cookie ?? '').includes(c + (c.endsWith('_') ? '' : '='))),
];

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), stdio: 'ignore',
  env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: ADMIN, REDIS_URL: '', LAYERFS_SERVICE_URL: '', WM_LOGIN_GATE: '', WM_ODOO_URL: `http://127.0.0.1:${odoo.port}` },
});
const B = `http://127.0.0.1:${PORT}`;
async function waitReady(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(`${B}/api/health`); if (r.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const register = async (name, url, auth) => (await (await fetch(`${B}/api/workbenches`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify({ name, url, ...(auth ? { auth } : {}) }),
})).json()).id;

/** 经门户发一个 WebSocket 握手，等上游记下它 */
function wsHandshake(path, headers) {
  return new Promise((resolveWs) => {
    const before = seen.length;
    const sock = connect(PORT, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${PORT}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let done = false;
    const finish = () => { if (done) return; done = true; sock.destroy(); resolveWs(seen.slice(before).find((s) => s.kind === 'ws') ?? null); };
    sock.on('data', finish); sock.on('close', finish); sock.on('error', finish);
    setTimeout(finish, 5000);
  });
}

try {
  if (!(await waitReady())) throw new Error('市场实例没起来');
  const p = await register('pfs 普通台', `http://127.0.0.1:${plain.port}/`);
  const bearer = await register('pfs bearer 台', `http://127.0.0.1:${plain.port}/`, { type: 'bearer', value: 'bench-secret' });
  const o = await register('pfs Odoo 台', `http://127.0.0.1:${odoo.port}/`);

  // ① GET：市场的头和 cookie 全带上，外加台自己的头、cookie、浏览器自带的 Authorization
  const r1 = await fetch(`${B}/go/${p}/echo`, { headers: {
    ...MARKET_HEADERS, 'x-bench-custom': 'keep', authorization: 'Bearer from-browser',
    cookie: `${MARKET_COOKIES}; wm_sso_ok_${p}=1; wm_sso_${p}=pfs-state; wm_sso_ret_${p}=r; pref=1; wm_pref=2`,
  } });
  const h1 = (await r1.json()).headers ?? {};
  ok('① GET 经门户到了上游', r1.status === 200, `status=${r1.status}`);
  for (const k of Object.keys(MARKET_HEADERS)) ok(`①a 上游收不到 ${k}`, !(k in h1), `${k}=${h1[k]}`);
  ok('①b 上游的 Cookie 里没有市场的会话、登录门、登录 state、内容面上下文、门户 SSO 状态', leaked(h1).length === 0, `cookie=${h1.cookie}`);
  ok('①c 台自己的 cookie 原样留下（pref、wm_pref）', h1.cookie === 'pref=1; wm_pref=2', `cookie=${h1.cookie}`);
  ok('①d 台自己的头原样留下', h1['x-bench-custom'] === 'keep', JSON.stringify(h1));
  ok('①e 没配凭据的台：浏览器自带的 Authorization 照旧转', h1.authorization === 'Bearer from-browser', `authorization=${h1.authorization}`);

  // ② POST 带体：体原样，管理口令不带
  const r2 = await fetch(`${B}/go/${p}/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN, cookie: MARKET_COOKIES }, body: '{"a":1}' });
  const j2 = await r2.json();
  ok('② POST 的体原样到上游', j2.body === '{"a":1}', `body=${j2.body}`);
  ok('②a POST：上游收不到管理口令', !('x-admin-token' in (j2.headers ?? {})), JSON.stringify(j2.headers));
  ok('②b 只有市场 cookie 时整个 Cookie 头去掉', !('cookie' in (j2.headers ?? {})), `cookie=${j2.headers?.cookie}`);

  // ③ 配了凭据的台：Authorization 是台的，管理口令不带
  const h3 = (await (await fetch(`${B}/go/${bearer}/echo`, { headers: { 'x-admin-token': ADMIN, authorization: 'Bearer from-browser' } })).json()).headers ?? {};
  ok('③ 配了凭据的台：Authorization 换成台的凭据', h3.authorization === 'Bearer bench-secret', `authorization=${h3.authorization}`);
  ok('③a 配了凭据的台：上游收不到管理口令', !('x-admin-token' in h3), JSON.stringify(h3));

  // ④ Odoo 台过了 SSO 检：Cookie 只剩 session_id（对照组，修之前也是这样）
  const h4 = (await (await fetch(`${B}/go/${o}/echo`, { headers: { 'x-admin-token': ADMIN, cookie: `session_id=odoo-sid; wm_sso_ok_${o}=1; ${MARKET_COOKIES}; pref=1` } })).json()).headers ?? {};
  ok('④ Odoo 台：Cookie 只剩 session_id', h4.cookie === 'session_id=odoo-sid', `cookie=${h4.cookie}`);
  ok('④a Odoo 台：上游收不到管理口令', !('x-admin-token' in h4), JSON.stringify(h4));

  // ⑤ WebSocket 握手：同样摘
  const ws = await wsHandshake(`/go/${p}/ws`, { ...MARKET_HEADERS, 'x-bench-custom': 'keep', cookie: `${MARKET_COOKIES}; wm_sso_ok_${p}=1; pref=1` });
  ok('⑤ WebSocket 握手经门户到了上游', ws !== null, '');
  const h5 = ws?.headers ?? {};
  for (const k of Object.keys(MARKET_HEADERS)) ok(`⑤a 握手里上游收不到 ${k}`, ws !== null && !(k in h5), `${k}=${h5[k]}`);
  ok('⑤b 握手的 Cookie 里没有市场自己的 cookie，台的留下', ws !== null && leaked(h5).length === 0 && h5.cookie === 'pref=1', `cookie=${h5.cookie}`);
  ok('⑤c 握手里台自己的头原样留下', h5['x-bench-custom'] === 'keep', '');
  // ⑤d Odoo 台的握手：session_id 走 Odoo 的规则（照转），市场自己的头和 cookie 一样不带
  const wsO = await wsHandshake(`/go/${o}/ws`, { ...MARKET_HEADERS, cookie: `session_id=odoo-sid; wm_sso_ok_${o}=1; ${MARKET_COOKIES}; pref=1` });
  const h5o = wsO?.headers ?? {};
  ok('⑤d Odoo 台的 WebSocket 握手经门户到了上游', wsO !== null, '');
  ok('⑤e Odoo 台的握手里上游收不到市场的头', wsO !== null && Object.keys(MARKET_HEADERS).every((k) => !(k in h5o)), JSON.stringify(Object.keys(h5o)));
  ok('⑤f Odoo 台的握手的 Cookie 里没有市场自己的 cookie，session_id 和台的 cookie 留下', wsO !== null && leaked(h5o).length === 0 && /(^|; )session_id=odoo-sid(;|$)/.test(String(h5o.cookie ?? '')) && /(^|; )pref=1(;|$)/.test(String(h5o.cookie ?? '')), `cookie=${h5o.cookie}`);

  // ⑦ Authorization 是市场的 MCP 会话令牌：不往台带（HTTP、WebSocket 握手都看）；查不到的 Bearer、Basic 照常转给台
  const sess = await (await fetch(`${B}/api/mcp/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify({ name: 'pfs-agent' }) })).json();
  ok('⑦ 布置：建了一个 MCP 会话、拿到 64 位令牌', /^[0-9a-f]{64}$/.test(String(sess.token ?? '')), JSON.stringify(sess).slice(0, 80));
  const h7 = (await (await fetch(`${B}/go/${p}/echo`, { headers: { authorization: `Bearer ${sess.token}` } })).json()).headers ?? {};
  ok('⑦a 带市场的 MCP 会话令牌访问门户：上游收不到这个 Authorization', !('authorization' in h7), `authorization=${h7.authorization}`);
  const h7u = (await (await fetch(`${B}/go/${p}/echo`, { headers: { authorization: `Bearer ${String(sess.token).toUpperCase()}` } })).json()).headers ?? {};
  ok('⑦b 令牌写成大写十六进制：一样认得、一样不带', !('authorization' in h7u), `authorization=${h7u.authorization}`);
  const unknown = 'ab'.repeat(32);
  const h7x = (await (await fetch(`${B}/go/${p}/echo`, { headers: { authorization: `Bearer ${unknown}` } })).json()).headers ?? {};
  ok('⑦c 形状一样、市场查不到的 Bearer：照常转给台', h7x.authorization === `Bearer ${unknown}`, `authorization=${h7x.authorization}`);
  const h7b = (await (await fetch(`${B}/go/${p}/echo`, { headers: { authorization: 'Basic dTpw' } })).json()).headers ?? {};
  ok('⑦d 浏览器带的 Basic：照常转给台', h7b.authorization === 'Basic dTpw', `authorization=${h7b.authorization}`);
  const h7c = (await (await fetch(`${B}/go/${bearer}/echo`, { headers: { authorization: `Bearer ${sess.token}` } })).json()).headers ?? {};
  ok('⑦e 配了凭据的台：照旧换成台的凭据', h7c.authorization === 'Bearer bench-secret', `authorization=${h7c.authorization}`);
  const ws7 = await wsHandshake(`/go/${p}/ws`, { authorization: `Bearer ${sess.token}` });
  ok('⑦f WebSocket 握手带市场的 MCP 会话令牌：上游收不到', ws7 !== null && !('authorization' in (ws7?.headers ?? {})), `authorization=${ws7?.headers?.authorization}`);
  const ws7x = await wsHandshake(`/go/${p}/ws`, { authorization: `Bearer ${unknown}` });
  ok('⑦g WebSocket 握手带查不到的 Bearer：照常转给台', ws7x?.headers?.authorization === `Bearer ${unknown}`, `authorization=${ws7x?.headers?.authorization}`);

  // ⑥ 启动自检有这一行，并且过了
  const health = await (await fetch(`${B}/api/health`)).json();
  const row = (health.self_probe?.rows ?? []).find((r) => r.id === 'market.portal.forward-strips-market-auth');
  ok('⑥ 启动自检有「门户转发前去掉市场认证信息」这一行，并且过了', row?.verdict === 'pass', JSON.stringify(row ?? null));
} finally {
  child.kill();
  await new Promise((r) => plain.srv.close(r)); await new Promise((r) => odoo.srv.close(r));
  await new Promise((r) => setTimeout(r, 400));
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n===== 门户转发去掉市场认证信息 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
