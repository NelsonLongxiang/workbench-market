#!/usr/bin/env node
/** #170 P8/P9/P10 冒烟：①回跳绝对地址 ②伪造 state 的 /sso/callback 400 ③无 wm_sso_ok 时 session_id 不转发。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const TP = PORT + 1;
const DATA = 'tmp/e2e-p810-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'p810' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
let seenCookie = '';
const target = createServer((req, res) => { seenCookie = String(req.headers.cookie ?? ''); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>ok</h1>'); });
await new Promise((r) => target.listen(TP, '127.0.0.1', r));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync('server/data/' + d, DATA + '/' + d, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p810' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
try {
  await waitReady(B + '/api/health');
  await fetch(B + '/api/types', { method: 'POST', headers: H, body: JSON.stringify({ key: 'odoo', name: 'Odoo', default_port: 8069 }) });
  const wb = await (await fetch(B + '/api/workbenches', { method: 'POST', headers: H, body: JSON.stringify({ name: 'p810', url: 'http://127.0.0.1:' + TP + '/', type: 'odoo' }) })).json();
  // ① P8 回跳绝对
  const r1 = await fetch(B + '/go/' + wb.id + '/', { redirect: 'manual' });
  const loc = String(r1.headers.get('location') ?? '');
  ok('① 回跳绝对地址（含市场 host·不落 Odoo 主机）', /redirect=http%3A%2F%2F|redirect=https%3A%2F%2F/.test(loc) && loc.includes(encodeURIComponent('/go/' + wb.id + '/')), loc.slice(0, 140));
  // ② P9 伪造 state → 400
  const r2 = await fetch(B + '/sso/callback?redirect=' + encodeURIComponent('/go/' + wb.id + '/') + '&state=forged', { redirect: 'manual' });
  ok('② 伪造 state 的 /sso/callback → 400', r2.status === 400, String(r2.status));
  // ③ P10 无 ok cookie：session_id 不转发（上游看不到 session_id）
  seenCookie = '';
  await fetch(B + '/go/' + wb.id + '/', { headers: { cookie: 'session_id=evil-fixed' }, redirect: 'manual' });
  ok('③ 无 wm_sso_ok 时 session_id 不转发（防固定）', !seenCookie.includes('evil-fixed'), seenCookie.slice(0, 60));
} finally { child.kill(); await new Promise((r) => target.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== P8/P9/P10 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
