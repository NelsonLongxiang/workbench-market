#!/usr/bin/env node
/** 自产台 / SOP 台卡片健康与 run 读回字段冒烟（独立实例、合成数据）：
 *  ① /apps/<slug>/、/sop/<slug>/ 卡片探测不发 HTTP，但要核实台本身还在——台不存在、SOP 未上架都记 down 并写明原因；
 *  ② sop_run_get（带读能力）返回 started_at / updated_at / finished_at，与无读能力的元数据视图一致。 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const TMP = resolve('tmp/self-hosted-health-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN = 'synthetic-selfhealth-admin';
const gh = await startFakeGithub();
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: ADMIN, WM_GITHUB_API: gh.api };
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tool = async (name, args) => {
  const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = r.body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : r.body;
};
const cardOf = async (url) => ((await call('GET', '/api/workbenches')).body ?? []).find((w) => w.url === url);
const check = async (id) => { const b = (await call('POST', `/api/workbenches/${id}/check`)).body; return { status: b?.last_status, error: String(b?.last_error ?? '') }; };
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  await ghPublish(base, gh, { slug: 'hc-app', title: '健康冒烟台', files: [{ path: 'index.html', content: '<!doctype html><html><body><div>ok</div></body></html>' }] }, { 'x-admin-token': ADMIN });
  await ghPublish(base, gh, { slug: 'hc-sop', kind: 'sop', title: '健康冒烟 SOP', changelog: 'v1', files: [{ path: 'sop.yaml', content: 'title: 健康冒烟\nsteps:\n  - key: a\n    title: 第一步\n' }] }, { 'x-admin-token': ADMIN });
  await call('POST', '/api/sops/hc-sop/publish', {});

  const appCard = await cardOf('/apps/hc-app/');
  const sopCard = await cardOf('/sop/hc-sop/');
  ok('发布即入册：两张卡都在', !!appCard && !!sopCard);
  ok('存在的自产台 → up', (await check(appCard.id))?.status === 'up');
  ok('已上架的 SOP → up', (await check(sopCard.id))?.status === 'up');

  // ② run 读回字段（MCP 网关关时 tools/call 免会话；带读能力走完整视图）
  const run = await tool('sop_run_start', { slug: 'hc-sop', started_by: 'smoke' });
  const runId = Number(run?.id ?? run?.run_id), cap = String(run?.read_capability ?? '');
  ok('sop_run_start 返回 run 与读能力', runId > 0 && cap.length > 0, JSON.stringify(run).slice(0, 160));
  await tool('sop_run_finish', { run_id: runId });
  const full = await tool('sop_run_get', { run_id: runId, read_capability: cap });
  ok('带读能力的 sop_run_get 是完整视图（有 data）', full && typeof full.data === 'object', JSON.stringify(full).slice(0, 160));
  ok('完整视图带 started_at / updated_at', !!full?.started_at && !!full?.updated_at);
  ok('结束后完整视图带 finished_at', full?.status === 'finished' && !!full?.finished_at, JSON.stringify(full).slice(0, 200));
  const meta = await tool('sop_run_get', { run_id: runId });
  ok('无读能力的元数据视图 finished_at 与完整视图一致', meta?.finished_at === full?.finished_at);

  // ① 下架 / 不存在
  await call('POST', '/api/sops/hc-sop/deprecate', {});
  const dep = await check(sopCard.id);
  ok('SOP 下架后 → down 并写明原因', dep?.status === 'down' && /未上架/.test(dep?.error), JSON.stringify(dep).slice(0, 200));
  // 卡还在、台已经没了（历史遗留的卡）：直接往合成库插一张指向不存在自产台的卡
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(TMP, 'data', 'workbench-market.db'));
  const ghostId = Number(db.prepare("INSERT INTO workbenches (name, url, type) VALUES ('幽灵台', '/apps/ghost-app/', 'market-app')").run().lastInsertRowid);
  db.close();
  const g = await check(ghostId);
  ok('指向不存在自产台的卡 → down 并写明原因', g.status === 'down' && /不存在/.test(g.error), JSON.stringify(g));
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.message ?? e, serverErr.slice(-400));
} finally {
  server.kill(); await gh.close();
}
console.log(`\nself-hosted-health-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
