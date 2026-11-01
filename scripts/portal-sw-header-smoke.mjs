#!/usr/bin/env node
/** #292 M5：/go/ 代理剥掉上游 Service-Worker-Allowed（防上游把 SW 作用域扩到市场全站），其它上游头照常透传。
 *  合成上游 + 全新 DATA_DIR + 随机回环端口；不碰真实工作台。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';

const TMP = resolve('tmp/portal-sw-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const upstream = createServer((rq, rs) => {
  rq.resume();
  const js = rq.url?.endsWith('.js');
  rs.writeHead(200, { 'content-type': js ? 'text/javascript' : 'text/html', 'service-worker-allowed': '/', 'x-upstream-probe': 'kept' });
  rs.end(js ? 'self.addEventListener("fetch",()=>{})' : '<!doctype html><title>sw probe</title>');
});
await new Promise((x) => upstream.listen(0, '127.0.0.1', x));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'sw-smoke' };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));

const http = (method, path, { headers = {}, body } = {}) => new Promise((done) => {
  const rq = request({ host: '127.0.0.1', port: PORT, method, path, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (rs) => {
    let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} done({ status: rs.statusCode, headers: rs.headers, body: j, text: s }); });
  });
  rq.on('error', (e) => done({ status: 0, headers: {}, body: { error: String(e) } }));
  if (body !== undefined) rq.write(body);
  rq.end();
});

try {
  const end = Date.now() + 40_000;
  while (Date.now() < end && (await http('GET', '/api/health')).status !== 200) await new Promise((x) => setTimeout(x, 250));
  const wb = await http('POST', '/api/workbenches', { headers: { 'content-type': 'application/json', 'x-admin-token': 'sw-smoke' }, body: JSON.stringify({ name: 'sw-probe', url: `http://127.0.0.1:${upstream.address().port}/`, type: 'web' }) });
  const id = wb.body?.id;
  ok('登记合成上游', Number.isInteger(id), JSON.stringify(wb.body));
  for (const p of ['', 'sw.js']) {
    const r = await http('GET', `/go/${id}/${p}`);
    ok(`/go/${id}/${p || '(根)'}：200 且没有 Service-Worker-Allowed`, r.status === 200 && r.headers['service-worker-allowed'] === undefined, `${r.status} ${r.headers['service-worker-allowed']}`);
    ok(`/go/${id}/${p || '(根)'}：其它上游头照常透传（不是整包丢头）`, r.headers['x-upstream-probe'] === 'kept', JSON.stringify(r.headers));
  }
} catch (e) {
  ok('冒烟运行', false, String(e?.stack ?? e));
} finally {
  server.kill(); upstream.close();
  await new Promise((x) => setTimeout(x, 400));
  if (fail && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`portal-sw-header-smoke: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
