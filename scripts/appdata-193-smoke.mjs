#!/usr/bin/env node
/** #193 五缺���冒烟：F3 匿名写删 401/403 · F4 软删后下载/改 note 404 · F5 删不存在 404 · F8 配额全量计数 · F11 MCP publish 过锁。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-193-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'k193' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
const B = 'http://127.0.0.1:' + PORT;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync('server/data/' + d, DATA + '/' + d, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'k193' }, stdio: 'ignore' });
const mcp = async (name, args) => { const r = await fetch(B + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(15000) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
try {
  await waitReady(B + '/api/health');
  await fetch(B + '/api/apps', { method: 'POST', headers: H, body: JSON.stringify({ slug: 'f193', title: 't', files: [{ path: 'index.html', content: '<h1>x</h1>' }] }) });
  // 建文件 + 数据
  const fd = new FormData(); fd.append('file', new Blob(['a,b'], { type: 'text/csv' }), 'f.csv');
  const AT = { 'X-Admin-Token': 'k193' };
  const uf = await (await fetch(B + '/api/apps/f193/files', { method: 'POST', headers: AT, body: fd })).json();
  const ud = await (await fetch(B + '/api/apps/f193/data', { method: 'POST', headers: H, body: JSON.stringify({ data: { k: 1 } }) })).json();
  // F3：匿名 PATCH/DELETE 被拒
  const p1 = await fetch(B + '/api/apps/f193/files/' + uf.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'x' }) });
  const d1 = await fetch(B + '/api/apps/f193/files/' + uf.id, { method: 'DELETE' });
  const d2 = await fetch(B + '/api/apps/f193/data/' + ud.id, { method: 'DELETE' });
  ok('F3 匿名 PATCH/DELETE 全拒（401/403）', [p1.status, d1.status, d2.status].every((s) => s === 401 || s === 403), [p1.status, d1.status, d2.status].join(','));
  // F4：软删后下载 404 / 改 note 404
  const del = await fetch(B + '/api/apps/f193/files/' + uf.id, { method: 'DELETE', headers: H });
  const g1 = await fetch(B + '/api/apps/f193/files/' + uf.id);
  const p2 = await fetch(B + '/api/apps/f193/files/' + uf.id, { method: 'PATCH', headers: H, body: JSON.stringify({ note: 'y' }) });
  ok('F4 软删后下载 404·改 note 404', del.ok && g1.status === 404 && p2.status === 404, [del.status, g1.status, p2.status].join(','));
  // F5：删不存在 → 404
  const d3 = await fetch(B + '/api/apps/f193/data/999999', { method: 'DELETE', headers: H });
  const d4 = await fetch(B + '/api/apps/f193/files/999999', { method: 'DELETE', headers: H });
  ok('F5 删不存在 → 404', d3.status === 404 && d4.status === 404, [d3.status, d4.status].join(','));
  // F8：配额全量计数（灌 200 条后第 201 个 413）
  { const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(DATA + '/workbench-market.db'); for (let i = 0; i < 200; i++) db.prepare("INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by) VALUES ('f193', ?, 'text/plain', 1, 'x', '')").run('bulk' + i); db.close(); }
  const r8 = await mcp('app_files_upload', { slug: 'f193', name: 'over.txt', content_base64: Buffer.from('x').toString('base64') });
  ok('F8 配额按全量计数（201→413）', /413|上限/.test(JSON.stringify(r8.j)), JSON.stringify(r8.j).slice(0, 80));
  // F11：MCP publish 过锁（异会话 60s 内 409）
  await mcp('app_publish', { slug: 'f193b', title: 'a', created_by: 'cli-A', files: [{ path: 'index.html', content: '<h1>a</h1>' }] });
  const r11 = await mcp('app_publish', { slug: 'f193b', title: 'a', created_by: 'cli-B', files: [{ path: 'index.html', content: '<h1>b</h1>' }] });
  ok('F11 MCP publish 异会话锁 409', /409|同 slug/.test(JSON.stringify(r11.j)), JSON.stringify(r11.j).slice(0, 80));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #193 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
