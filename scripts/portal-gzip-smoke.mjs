#!/usr/bin/env node
/** #170 P0 冒烟（判据先红）：①强制 gzip 的上游响应经 /go/ 字节完好（不因文本改写损坏）②identity 上游收到 accept-encoding:identity③明文 HTML 仍能改写（回归）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const TP = PORT + 1;
const DATA = 'tmp/e2e-gz-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'gz' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const html = '<html><body><img src="/assets/a.png"><h1>gz</h1></body></html>';
const gzHtml = gzipSync(Buffer.from(html));
let sawIdentity = '';
const target = createServer((req, res) => {
  sawIdentity = String(req.headers['accept-encoding'] ?? '');
  if (req.url === '/plain') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
  // 强制 gzip（无视 identity 的应用面）
  res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Length': String(gzHtml.length) });
  res.end(gzHtml);
});
await new Promise((r) => target.listen(TP, '127.0.0.1', r));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'gz' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
try {
  await waitReady(`${B}/api/health`);
  const wb = await (await fetch(`${B}/api/workbenches`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'gz', url: `http://127.0.0.1:${TP}/`, type: 'web' }) })).json();
  // ① gzip 面字节完好（解压后=原文·未被改写）
  const r1 = await fetch(`${B}/go/${wb.id}/`, { headers: { 'accept-encoding': 'gzip' } });
  const raw = Buffer.from(await r1.arrayBuffer());
  let decoded = raw;
  try { decoded = (await import('node:zlib')).gunzipSync(raw); } catch {}
  ok('① gzip 响应字节完好（解压=原文·未被改写损坏）', decoded.toString('utf8') === html, `len=${raw.length} dec=${decoded.length}`);
  // ② identity 上游请求头
  const r2 = await fetch(`${B}/go/${wb.id}/plain`);
  const body2 = await r2.text();
  ok('② 上游收 accept-encoding:identity', sawIdentity === 'identity', sawIdentity);
  ok('②b 明文 HTML 仍改写（/go/<id>/ 前缀）', body2.includes(`/go/${wb.id}/assets/a.png`), body2.slice(0, 80));
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log(`\n===== /go/ gzip P0 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
