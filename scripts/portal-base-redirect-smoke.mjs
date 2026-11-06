#!/usr/bin/env node
/** 台地址带路径（base）时的 /go/ 映射：上游跳到 base 之外且含请求路径（自增长）时不再逐跳叠前缀（Odoo 台登记成 …/web，语言跳转
 *  /web/ → /zh_CN/web/ 曾拼出 /go/N/zh_CN/web/zh_CN/web/…），base 内的跳转与页面绝对链接去掉 base 后再挂 /go/N/。
 *  合成上游 + 全新 DATA_DIR + 随机回环端口；不碰真实工作台。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/portal-base-redirect-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

// 合成 Odoo：路径没有 /zh_CN 前缀就 303 加上（website 非默认语言的行为）；/zh_CN/… 下给一页带绝对资产链接的 HTML
const seen = [];
const upstream = createServer((rq, rs) => {
  rq.resume();
  const path = String(rq.url);
  seen.push(path);
  if (path === '/web/inside') { rs.writeHead(303, { location: '/web/page?x=1', 'content-type': 'text/html' }); return rs.end('<a href="/web/page">moved</a>'); }
  if (path === '/web/root') { rs.writeHead(302, { location: '/web' }); return rs.end(); }
  if (path === '/web/abs') { rs.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/web/page` }); return rs.end(); }
  if (path === '/web/abs-out') { rs.writeHead(302, { location: `http://127.0.0.1:${upstream.address().port}/zh_CN/web/abs-out` }); return rs.end(); }
  if (path === '/web/landing') { rs.writeHead(302, { location: '/landed' }); return rs.end(); }
  if (path === '/shop/') { rs.writeHead(302, { location: '/shopping/cart' }); return rs.end(); }
  if (path === '/web/site') { rs.writeHead(302, { location: '/website/info' }); return rs.end(); }
  if (path === '/web/') { rs.writeHead(303, { location: '/zh_CN/web/', 'content-type': 'text/html' }); rs.statusMessage = 'See Other'; return rs.end('<a href="/zh_CN/web/">redirect</a>'); }
  if (path.startsWith('/web/page')) {
    rs.writeHead(200, { 'content-type': 'text/html' });
    return rs.end('<!doctype html><link rel="stylesheet" href="/web/assets/91d484d/web.assets_frontend.min.css"><script src="/other/x.js"></script><a href="/web">home</a>');
  }
  if (!path.startsWith('/zh_CN/')) { rs.writeHead(303, { location: '/zh_CN' + path, 'content-type': 'text/html' }); return rs.end('<a href="/zh_CN' + path + '">redirect</a>'); }
  rs.writeHead(200, { 'content-type': 'text/plain' });
  rs.end('odoo page ' + path);
});
await new Promise((x) => upstream.listen(0, '127.0.0.1', x));
const UP = `http://127.0.0.1:${upstream.address().port}`;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'base-smoke' };
for (const k of ['WM_ODOO_URL', 'WM_EXTENSIONS_DIR', 'WM_ODOO_ORIGINS', 'WM_ODOO_BROWSER_URL', 'WM_ODOO_LOGIN_PROXY']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));

const http = (method, path, { headers = {}, body } = {}) => new Promise((done) => {
  const rq = request({ host: '127.0.0.1', port: PORT, method, path, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, statusMessage: rs.statusMessage, headers: rs.headers, body: j, text: s }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) } }));
  if (body !== undefined) rq.write(body);
  rq.end();
});
const register = async (name, url) => {
  const r = await http('POST', '/api/workbenches', { headers: { 'content-type': 'application/json', 'x-admin-token': 'base-smoke' }, body: JSON.stringify({ name, url, type: 'web' }) });
  return r.body?.id;
};

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end && (await http('GET', '/api/health')).status !== 200) await new Promise((x) => setTimeout(x, 250));

  const withBase = await register('odoo-with-base', `${UP}/web`);
  ok('登记带路径的台（…/web）', Number.isInteger(withBase));

  // 1) 复现原循环：最多跟 5 跳，前缀不能叠
  let path = `/go/${withBase}/`, hops = [];
  for (let i = 0; i < 5; i++) {
    const r = await http('GET', path);
    hops.push(`${path} → ${r.status} ${r.headers.location ?? ''}`);
    if (r.status < 300 || r.status >= 400 || !r.headers.location) { var last = r; break; }
    path = r.headers.location;
  }
  ok('base 之外的语言跳转被拦成 502，不再逐跳叠 zh_CN/web', last?.status === 502 && last.body?.error === 'go_redirect_outside_base', hops.join(' | '));
  ok('502 说明里点名台与 base，给出改法', /带路径 \/web/.test(last?.body?.detail ?? '') && /不带路径/.test(last?.body?.detail ?? ''), JSON.stringify(last?.body));
  ok('拦下的跳转不带 Location', last?.headers.location === undefined);
  ok('状态行原因短语是 Bad Gateway（不抄上游的 See Other）', last?.statusMessage === 'Bad Gateway', String(last?.statusMessage));
  ok('没有任何请求打到叠出来的上游路径', !seen.some((p) => /zh_CN\/web\/zh_CN/.test(p) || /^\/web\/zh_CN/.test(p)), seen.join(','));

  // 2) 同源绝对地址跳到 base 之外，同样拦下
  const absOut = await http('GET', `/go/${withBase}/abs-out`);
  ok('同源绝对地址自增长跳转（/zh_CN/web/abs-out 含请求路径）：502', absOut.status === 502 && absOut.body?.error === 'go_redirect_outside_base', `${absOut.status} ${absOut.headers.location}`);

  // 2b) base 之外但不含请求路径的跳转：保持 issue #4 契约，照旧映射成 /go/N/<loc>
  const landing = await http('GET', `/go/${withBase}/landing`);
  ok('base 之外的普通跳转 /landed → /go/N/landed（契约不变）', landing.status === 302 && landing.headers.location === `/go/${withBase}/landed`, `${landing.status} ${landing.headers.location}`);

  // 2c) 反例：/website/info 与请求路径 /web 只是子串重叠、不是同一路径段，不能误拦（#458 评审 R1）
  const site = await http('GET', `/go/${withBase}/site`);
  ok('base 外跳 /website/info 按契约映射成 /go/N/website/info（不误拦成 502）', site.status === 302 && site.headers.location === `/go/${withBase}/website/info`, `${site.status} ${site.headers.location}`);

  // 2d) 反例要从台根进：此时上游请求路径就是 base 本身（/shop），子串比会把 /shopping/cart 误判成自增长
  const shop = await register('shop-base', `${UP}/shop`);
  const sh = await http('GET', `/go/${shop}/`);
  ok('台根请求、base 外跳 /shopping/cart 按契约映射（子串重叠不算自增长）', sh.status === 302 && sh.headers.location === `/go/${shop}/shopping/cart`, `${sh.status} ${sh.headers.location}`);

  // 3) base 之内照常映射，去掉 base
  const inside = await http('GET', `/go/${withBase}/inside`);
  ok('base 内跳转 /web/page?x=1 → /go/N/page?x=1', inside.status === 303 && inside.headers.location === `/go/${withBase}/page?x=1`, `${inside.status} ${inside.headers.location}`);
  const root = await http('GET', `/go/${withBase}/root`);
  ok('跳到 base 本身 /web → /go/N/（不是 /go/N/web）', root.status === 302 && root.headers.location === `/go/${withBase}/`, `${root.status} ${root.headers.location}`);
  const abs = await http('GET', `/go/${withBase}/abs`);
  ok('同源绝对地址落在 base 内 → /go/N/page', abs.status === 302 && abs.headers.location === `/go/${withBase}/page`, `${abs.status} ${abs.headers.location}`);

  // 4) 页面里 base 下的绝对链接去掉 base（不再拼成 /go/N/web/assets → 上游 /web/web/assets）
  const page = await http('GET', `/go/${withBase}/page`);
  ok('样式表 /web/assets/… → /go/N/assets/…', page.text.includes(`href="/go/${withBase}/assets/91d484d/web.assets_frontend.min.css"`), page.text);
  ok('链接 /web → /go/N/', page.text.includes(`href="/go/${withBase}/"`), page.text);
  ok('base 之外的链接照旧挂 /go/N/（行为不变）', page.text.includes(`src="/go/${withBase}/other/x.js"`), page.text);
  seen.length = 0;
  const asset = await http('GET', `/go/${withBase}/assets/91d484d/web.assets_frontend.min.css`);
  ok('改写后的资产请求打到上游 /web/assets/…', seen.includes('/web/assets/91d484d/web.assets_frontend.min.css'), `${asset.status} ${seen.join(',')}`);

  // 5) 台地址不带路径：语言跳转照常映射，停在 /go/N/zh_CN/…（这是推荐登记法）
  const bare = await register('odoo-bare', UP);
  const b1 = await http('GET', `/go/${bare}/web`);
  ok('不带路径：/web → 303 /go/N/zh_CN/web', b1.status === 303 && b1.headers.location === `/go/${bare}/zh_CN/web`, `${b1.status} ${b1.headers.location}`);
  const b2 = await http('GET', b1.headers.location ?? '/');
  ok('不带路径：跟一跳就 200 停住', b2.status === 200 && b2.text === 'odoo page /zh_CN/web', `${b2.status} ${b2.text}`);
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  server.kill(); upstream.close();
  await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`portal-base-redirect-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
