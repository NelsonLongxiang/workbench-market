// E2E/透传验证用的 echo fixture 站：把收到的 path/query/关键头原样回显成 JSON body。
// 用途：给 /go/ 统一门户的反向代理做「内容源断言」——只有真实目标回显的内容才能证明
// 请求真的透传到了上游（状态码/响应头都可能来自 SPA fallback 的假绿）。
// 用法：node scripts/echo-fixture.mjs [port]   （默认 9901）
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.argv[2] ?? 9901);
const server = createServer((req, res) => {
  const body = {
    fixture: 'echo',
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization ?? null,
    cookie: req.headers.cookie ? (/dsh-auth-/.test(req.headers.cookie) ? 'has-dsh-auth' : 'other') : null,
    xCustom: req.headers['x-custom'] ?? null,
  };
  // /xfo 前缀：模拟带 X-Frame-Options:DENY 的源——验证门户 proxyRes 确实剥掉禁嵌头
  const headers = req.url.startsWith('/xfo')
    ? { 'content-type': 'application/json', 'x-frame-options': 'DENY' }
    : { 'content-type': 'application/json' };
  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`echo fixture listening on http://127.0.0.1:${port}`);
});

// WS 握手回执（不处理帧，只完成 101 握手）——验证门户 /go/ 的 upgrade 代理链路
// （路由到正确上游 + Origin/Host 改写）。上游若因 Origin fence 拒绝会回 403，
// 握手级断言即可分辨。
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.end();
});
