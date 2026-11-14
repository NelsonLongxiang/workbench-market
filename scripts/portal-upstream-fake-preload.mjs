/**
 * 录制回放用的夹具（--import 预加载）：门户 /go/<台号>/… 代理的假上游台，起在市场进程里（只听 127.0.0.1）。
 *
 * 台的地址写成固定的主机名 http://upstream.replay.test/（端口每次随机的话，录下来的应答对不上）：
 * 进程里 http.Agent 建连时，主机是这个名字（或假 Odoo 源 odoo.replay.test）的连到假上游；主机是 down.replay.test 的直接回连接被拒（录「上游连不上」）。
 * 别的主机原样走，不改。门户的代理每个请求新建 Agent（agent: false），建连走 Agent.prototype.createConnection，所以改原型。
 *
 * 假上游的应答都是固定的（不带时间、不带随机数），台地址带路径 /base 时把 /base 去掉再按下面分：
 *   /                 HTML：/assets/ 绝对路径、同源完整地址、跨源外链、协议相对、data:、已带 /go/N/ 的、meta refresh
 *   /assets/app.js    JS：/assets/、/api/、跨源外链、Vite helper、泛化根路径、已带 /go/ 的
 *   /assets/s.css     CSS：url(/assets/…)、url(/api/…)、跨源外链
 *   /echo…            JSON：上游收到的方法、路径（含查询串）、几样请求头（Authorization、Cookie、Referer、Origin、Host、Accept-Encoding、Content-Type）和请求体
 *   /redirect-abs     302 到同源完整地址；/redirect-rel 302 到 /login；/redirect-ext 302 到跨源地址
 *   /cookies          三个 Set-Cookie：普通（Path=/、Secure、Domain）、__Host-、__Secure-
 *   /status/<三位数>  回那个状态码，一行文本
 *   别的              404 一行文本
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里改建连。
 */
import http from 'node:http';
import net from 'node:net';

if (process.env.NODE_ENV !== 'test') {
  console.error('[portal-upstream-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const UP = 'upstream.replay.test';
const ODOO = 'odoo.replay.test';
const DOWN = 'down.replay.test';
const ORIGIN = `http://${UP}`;

const HTML = '<!doctype html><html><head><meta http-equiv="refresh" content="0; url=/">'
  + '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/s.css">'
  + `<link rel="icon" href='/favicon.ico'></head><body><a href="${ORIGIN}/page?a=1">同源完整地址</a>`
  + '<a href="https://cdn.example.com/assets/x.png">外链</a><a href="//cdn.example.com/y.css">协议相对</a>'
  + '<img src="data:image/png;base64,AAA"><a href="/go/987654/keep">已带前缀</a><a href="/base/inner">base 下</a></body></html>';
const JS = 'import("/assets/chunk.js"); fetch("/api/v1/items"); const pay="https://pay.example.com/assets/p.js";'
  + ' const Qa=function(e){return"/"+e}; const s="/static/x.json"; const g="/go/1/already";\n//# sourceMappingURL=/assets/app.js.map\n';
const CSS = '.a{background:url(/assets/bg.png)}.b{background:url(/api/v1/i.png)}.c{background:url(https://cdn.example.com/assets/z.png)}';

const ECHO_HEADERS = ['authorization', 'cookie', 'referer', 'origin', 'host', 'accept-encoding', 'content-type'];
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const full = req.url ?? '/';
    const path = full.replace(/^\/base(?=\/|\?|$)/, '') || '/';
    const pathname = path.split('?')[0] || '/';
    const send = (code, type, text, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(text); };
    if (pathname === '/') return send(200, 'text/html; charset=utf-8', HTML);
    if (pathname === '/assets/app.js') return send(200, 'application/javascript', JS);
    if (pathname === '/assets/s.css') return send(200, 'text/css', CSS);
    if (pathname.startsWith('/echo')) {
      const headers = Object.fromEntries(ECHO_HEADERS.filter((h) => req.headers[h] !== undefined).map((h) => [h, req.headers[h]]));
      return send(200, 'application/json', JSON.stringify({ method: req.method, url: full, headers, body }));
    }
    if (pathname === '/redirect-abs') return send(302, 'text/plain', 'moved', { location: `${ORIGIN}/base/next?x=1#h` });
    if (pathname === '/redirect-rel') return send(302, 'text/plain', 'moved', { location: '/login' });
    if (pathname === '/redirect-ext') return send(302, 'text/plain', 'moved', { location: 'https://elsewhere.example/x' });
    if (pathname === '/cookies') {
      return send(200, 'text/plain', 'cookies', {
        'set-cookie': ['sid=abc; Path=/; Domain=upstream.replay.test; Secure; HttpOnly', '__Host-h=1; Path=/; Secure', '__Secure-k=2; Path=/x; Secure'],
      });
    }
    const st = /^\/status\/([1-5]\d\d)$/.exec(pathname);
    if (st) return send(Number(st[1]), 'text/plain', `upstream ${st[1]}\n`);
    return send(404, 'text/plain', 'upstream: no such path\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
server.unref();

const original = http.Agent.prototype.createConnection;
http.Agent.prototype.createConnection = function (options, ...rest) {
  const host = String(options?.host ?? options?.hostname ?? '');
  if (host === UP || host === ODOO) return net.createConnection({ host: '127.0.0.1', port });
  if (host === DOWN) {
    const sock = new net.Socket();
    process.nextTick(() => sock.destroy(Object.assign(new Error(`connect ECONNREFUSED ${DOWN}`), { code: 'ECONNREFUSED' })));
    return sock;
  }
  return original.call(this, options, ...rest);
};
