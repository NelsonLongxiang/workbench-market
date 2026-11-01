#!/usr/bin/env node
/** #159 M3 B2 冒烟：①C9 无口令拒 ②C10 跨源拒 ③C1 口令+同源 201 ④读开放 ⑤C7 policy ⑥C17 template 六步 ⑦事件恰一条 ⑧C13 MCP 拒 slug。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-159b2-' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'b2' }, stdio: ['ignore', 'pipe', 'pipe'] });
const B = 'http://127.0.0.1:' + PORT;
child.stderr?.on('data', (c) => process.stderr.write('[srv] ' + c));
child.on('exit', (c2, s) => console.log('[srv exit]', c2, s));
try {
  await waitReady(B + '/api/health');
  const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'b2' };
  // ① C9 无口令
  const r1 = await fetch(B + '/api/task-center/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x' }) });
  ok('① C9 无口令拒（401/403）', r1.status === 401 || r1.status === 403, String(r1.status));
  // ② C10 跨源
  const r2 = await fetch(B + '/api/task-center/tasks', { method: 'POST', headers: { ...H, Origin: 'http://evil.example.com' }, body: JSON.stringify({ title: 'x' }) });
  ok('② C10 跨源拒 403', r2.status === 403, String(r2.status));
  // ③ C1 同源+口令 201（无 Origin 头=curl 同源）
  const r3 = await fetch(B + '/api/task-center/tasks', { method: 'POST', headers: H, body: JSON.stringify({ title: '首个任务', payload: { k: 1 } }) });
  const j3 = await r3.json().catch(() => ({}));
  ok('③ C1 口令+同源 201 draft', r3.status === 201 && j3.status === 'draft', r3.status + '/' + String(j3.status));
  // ④ 读开放
  const r4 = await fetch(B + '/api/task-center/tasks');
  ok('④ GET /api/tasks 读开放 200', r4.status === 200, String(r4.status));
  // ⑤ C7 policy
  const r5 = await fetch(B + '/api/task-center/policy');
  const j5 = await r5.json().catch(() => []);
  ok('⑤ C7 policy 读开放含 center_switch=off', r5.status === 200 && JSON.stringify(j5).includes('center_switch'), JSON.stringify(j5).slice(0, 60));
  // ⑥ C17 template
  const r6 = await fetch(B + '/api/task-center/template');
  const j6 = await r6.json().catch(() => ({ steps: [] }));
  ok('⑥ C17 template 六固定步骤', Array.isArray(j6.steps) && j6.steps.length === 6, String(j6.steps?.length));
  // ⑦ 事件恰一条（created）
  const r7 = await fetch(B + '/api/task-center/tasks/' + j3.id);
  const j7 = await r7.json().catch(() => ({ events: [] }));
  ok('⑦ created 事件恰一条（只增）', Array.isArray(j7.events) && j7.events.filter((e) => e.type === 'created').length === 1, JSON.stringify(j7.events?.length));
  // ⑧ C13 MCP 拒 slug
  const r8 = await fetch(B + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_publish', arguments: { slug: 'task-center', title: 'x', files: [{ path: 'index.html', content: '<h1>x</h1>' }] } } }), signal: AbortSignal.timeout(15000) });
  const j8 = await r8.json().catch(() => ({}));
  ok('⑧ C13 MCP 拒 task-center slug', /人工面|403/.test(JSON.stringify(j8)), JSON.stringify(j8).slice(0, 60));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #159 B2 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
