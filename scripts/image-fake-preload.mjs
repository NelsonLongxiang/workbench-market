/**
 * 回放与测试用的假图库（docs/image-step1.md）：在本机回环上起一个只给固定字节的静态服务，WM_IMAGE_GALLERY_BASE 指过去。
 * 只认 GET /photos/a.png（image/png）和 GET /photos/page.html（text/html，用来核「不是图片就不转」），其余 404。不访问任何外部系统。
 */
import { createServer } from 'node:http';

// 一张 1×1 的 PNG（字节固定，回放每次一样）
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d3c3b4a90000000049454e44ae426082', 'hex');
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/photos/a.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); return void res.end(PNG); }
  if (req.method === 'GET' && req.url === '/photos/page.html') { res.writeHead(200, { 'content-type': 'text/html' }); return void res.end('<p>x</p>'); }
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
process.env.WM_IMAGE_GALLERY_BASE = `http://127.0.0.1:${server.address().port}/`;
