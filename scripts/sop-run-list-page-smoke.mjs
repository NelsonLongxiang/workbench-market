#!/usr/bin/env node
/** sop_run_list 翻页冒烟（独立实例 + 合成 run 行）：缺省 50 条、limit 上限 200、offset 翻页不漏不重、
 *  同一 updated_at 也按 id 排定、坏参数回落缺省。直接往合成库插 sop_runs 行，不经发布链。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = resolve('tmp/sop-run-list-page-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-runlist-admin' };
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const list = async (args) => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sop_run_list', arguments: args } }) });
  const j = await r.json();
  return JSON.parse(j.result?.content?.[0]?.text ?? 'null');
};
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await sleep(250); }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(TMP, 'data', 'workbench-market.db'), { timeout: 5000 });
  const ins = db.prepare("INSERT INTO sop_runs (sop_slug, sop_version, status, data, updated_at) VALUES ('runlist-probe', 1, 'running', '{}', ?)");
  // 前 120 条共用同一时间戳（打开页面批量建 run 的真实形态），后 110 条时间各不相同
  for (let i = 0; i < 120; i++) ins.run('2026-11-01 00:00:00');
  for (let i = 0; i < 110; i++) ins.run(`2026-11-02 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
  db.close();

  const dflt = await list({ slug: 'runlist-probe' });
  ok('缺省回 50 条', Array.isArray(dflt) && dflt.length === 50, String(dflt?.length));
  ok('limit 上限 200', (await list({ slug: 'runlist-probe', limit: 1000 })).length === 200);
  ok('坏 limit 回落缺省 50', (await list({ slug: 'runlist-probe', limit: 'x' })).length === 50);
  const seen = [];
  for (let off = 0; off < 1000; off += 70) { const page = await list({ slug: 'runlist-probe', status: 'running', limit: 70, offset: off }); seen.push(...page.map((r) => r.id)); if (page.length < 70) break; }
  ok('offset 翻页取全 230 条', seen.length === 230, String(seen.length));
  ok('翻页不重', new Set(seen).size === seen.length);
  ok('越界 offset 回空', (await list({ slug: 'runlist-probe', offset: 5000 })).length === 0);
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.message ?? e, serverErr.slice(-400));
} finally {
  server.kill(); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nsop-run-list-page-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
