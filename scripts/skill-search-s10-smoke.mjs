#!/usr/bin/env node
/** #178 S10 回归冒烟：①候选≤30 全量（不截断）②>30 可排序取前 30 ③全 0/并列不砍（>30 照发·分批）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const GW = PORT + 1;
const DATA = 'tmp/e2e-s10-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 's10' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
let batchSizes = [];
const gw = createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { const j = JSON.parse(b); const n = Object.keys(j.state.skills).length; batchSizes.push(n); const answers = {}; for (const qid of Object.keys(j.state.skills)) answers[qid] = { probability: 0.5 }; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ answers })); }); });
await new Promise((r) => gw.listen(GW, '127.0.0.1', r));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{ const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true }); db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close(); }
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync('server/data/' + d, DATA + '/' + d, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's10', EVAL_GATEWAY_URL: 'http://127.0.0.1:' + GW + '/x', AI_GATEWAY_API_KEY: 'vck_t' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
const call = async (need) => { const r = await fetch(B + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'skill_search', arguments: { need } } }), signal: AbortSignal.timeout(30000) }); return r.json().catch(() => ({})); };
try {
  await waitReady(B + '/api/health');
  // ① 中文需求（词法多 0/并列）→ 全量分批（每批≤15）
  batchSizes = [];
  await call('完全无关的中文需求短语甲乙丙丁');
  const total1 = batchSizes.reduce((a, b) => a + b, 0);
  ok('① 全 0/并列 → 不砍（全量分批·每批≤15）', total1 > 30 && batchSizes.every((n) => n <= 15), 'total=' + total1 + ' batches=' + batchSizes.join(','));
  // ② 可排序需求（精确命中少数）→ 候选显著收敛（≤30）
  batchSizes = [];
  await call('drawio 架构图');
  const total2 = batchSizes.reduce((a, b) => a + b, 0);
  ok('② 可排序 → 取前 30 内（≤30）', total2 <= 30 && total2 > 0, 'total=' + total2);
  ok('③ 每批≤15 恒真', batchSizes.every((n) => n <= 15), batchSizes.join(','));
  const r9 = await fetch(B + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skill_search', arguments: { need: 'drawio 架构图' } } }), signal: AbortSignal.timeout(30000) });
  const j9 = await r9.json().catch(() => ({}));
  let p9 = {}; try { p9 = JSON.parse(j9.result?.content?.[0]?.text ?? '{}'); } catch {}
  ok('④ #007 总量披露（candidates_total+top_n 恒报）', typeof p9.candidates_total === 'number' && p9.top_n === 30, JSON.stringify({ t: p9.candidates_total, n: p9.top_n }));
} finally { child.kill(); await new Promise((r) => gw.close(r)); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== S10 回归冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
