/**
 * 录制回放用的夹具（--import 预加载）：Odoo 同域登录中继（WM_ODOO_LOGIN_PROXY=1）后面的假 Odoo，起在市场进程里（只听 127.0.0.1）。
 *
 * 台的 Odoo 源写成固定的 http://odoo.replay.test（端口每次随机的话录不下来）：进程里 http.Agent 建连时，主机是这个名字的连到假 Odoo，
 * 别的主机原样走。登录中继的代理每个请求新建 Agent，建连走 Agent.prototype.createConnection，所以改原型。
 *
 * 假 Odoo 的应答都是固定的；查询参数 case 选几种上游的跳转：
 *   GET  /web/login              登录页 HTML，发 session_id（带 Domain、Path=/web）和一个 frontend_lang；上游 CSP 一条
 *        ?case=echo              回 JSON：上游收到的方法、路径（含查询串）、几样请求头
 *        ?case=to-odoo           303 到 /odoo?x=1（市场不认的去处）
 *        ?case=to-login          303 到 /web/login?redirect=/odoo/evil（回到登录页、redirect 要再过一遍白名单）
 *        ?case=to-ext            303 到跨源地址
 *        ?case=deny              上游 X-Frame-Options: DENY
 *   POST /web/login              回 JSON：上游收到的请求头和表单正文（看正文是不是原样到了、redirect 有没有被改），并发一个新 session_id
 *   GET  /web/login/totp         二次验证页，X-Frame-Options: DENY
 *   GET  /web/assets/app.js、/web/static/logo.png、/web/binary/company_logo   静态资源
 *   GET  /website/translations   303 到 /zh_CN/website/translations；那里回 JSON
 *   别的                          404 一行文本
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里改建连。
 */
import http from 'node:http';
import net from 'node:net';

if (process.env.NODE_ENV !== 'test') {
  console.error('[odoo-login-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const HOST = 'odoo.replay.test';
const SID = 'replay-odoo-session-0001';
const ECHO = ['cookie', 'origin', 'referer', 'host', 'authorization', 'x-admin-token', 'accept-encoding', 'content-type', 'x-forwarded-for'];
const pick = (h) => Object.fromEntries(ECHO.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));

const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (code, type, text, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(text); };
    if (u.pathname === '/web/login' && req.method === 'POST') {
      return send(200, 'application/json', JSON.stringify({ method: req.method, url: req.url, headers: pick(req.headers), body }),
        { 'set-cookie': [`session_id=${SID}-new; Path=/web; Domain=${HOST}; HttpOnly`, 'frontend_lang=en_US; Path=/'] });
    }
    if (u.pathname === '/web/login') {
      const c = u.searchParams.get('case');
      if (c === 'echo') return send(200, 'application/json', JSON.stringify({ method: req.method, url: req.url, headers: pick(req.headers) }));
      if (c === 'to-odoo') return send(303, 'text/plain', 'see other', { location: '/odoo?x=1' });
      if (c === 'to-login') return send(303, 'text/plain', 'see other', { location: '/web/login?redirect=/odoo/evil' });
      if (c === 'to-ext') return send(303, 'text/plain', 'see other', { location: 'https://elsewhere.example/x' });
      if (c === 'deny') return send(200, 'text/html; charset=utf-8', '<form>deny</form>', { 'x-frame-options': 'DENY' });
      return send(200, 'text/html; charset=utf-8', '<!doctype html><form method="post" action="/web/login"><input name="login"></form>', {
        'set-cookie': [`session_id=${SID}; Path=/web; Domain=${HOST}; SameSite=None`, 'frontend_lang=en_US; Path=/'],
        'content-security-policy': "default-src 'self'", 'service-worker-allowed': '/',
      });
    }
    if (u.pathname === '/web/login/totp') return send(200, 'text/html; charset=utf-8', '<form>totp</form>', { 'x-frame-options': 'DENY' });
    if (u.pathname === '/web/assets/app.js') return send(200, 'application/javascript', 'console.log("odoo");');
    if (u.pathname === '/web/static/logo.png') return send(200, 'image/png', 'PNG');
    if (u.pathname === '/web/binary/company_logo') return send(200, 'image/png', 'LOGO');
    if (u.pathname === '/website/translations') return send(303, 'text/plain', 'see other', { location: '/zh_CN/website/translations' });
    if (u.pathname === '/zh_CN/website/translations') return send(200, 'application/json', '{"lang":"zh_CN"}');
    return send(404, 'text/plain', 'odoo: no such path\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
server.unref();

const original = http.Agent.prototype.createConnection;
http.Agent.prototype.createConnection = function (options, ...rest) {
  if (String(options?.host ?? options?.hostname ?? '') === HOST) return net.createConnection({ host: '127.0.0.1', port });
  return original.call(this, options, ...rest);
};
