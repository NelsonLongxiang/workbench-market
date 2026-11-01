#!/usr/bin/env node
/** #170 P6/P7/P11 冒烟：①HTML 同源绝对链接改 /go/<id>/ ②Referer 只到目标源 ③自产台响应带 CSP sandbox。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const TP = PORT + 1;
const DATA = 'tmp/e2e-p6711-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'p67' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
let seenReferer = '';
const url = 'http://127.0.0.1:' + TP;
const target = createServer((req, res) => { seenReferer = String(req.headers.referer ?? ''); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body><a href="' + url + '/assets/a.png">x</a><a href="https://cdn.other.com/x.png">y</a></body></html>'); });
await new Promise((r) => target.listen(TP, '127.0.0.1', r));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync('server/data/' + d, DATA + '/' + d, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p67' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
try {
  await waitReady(B + '/api/health');
  const wb = await (await fetch(B + '/api/workbenches', { method: 'POST', headers: H, body: JSON.stringify({ name: 'p67', url: url + '/', type: 'web' }) })).json();
  const html = await (await fetch(B + '/go/' + wb.id + '/')).text();
  ok('① 同源绝对链接 → /go/<id>/', html.includes('/go/' + wb.id + '/assets/a.png'), html.slice(0, 100));
  ok('①b 跨源外链不动', html.includes('https://cdn.other.com/x.png'), '');
  ok('② Referer 只到目标源（不含 /go/）', seenReferer === url + '/' || seenReferer === url, seenReferer);
  // P11：自产台 CSP sandbox
  await fetch(B + '/api/apps', { method: 'POST', headers: H, body: JSON.stringify({ slug: 'p67', title: 't', files: [{ path: 'index.html', content: '<h1>x</h1>' }] }) });
  const r11 = await fetch(B + '/apps/p67/');
  const csp = String(r11.headers.get('content-security-policy') ?? '');
  ok('③ 自产台 CSP sandbox（无 allow-same-origin）', /sandbox/.test(csp) && !/allow-same-origin/.test(csp), csp);
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== P6/P7/P11 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
