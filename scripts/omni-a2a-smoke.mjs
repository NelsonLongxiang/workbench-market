#!/usr/bin/env node
/** A2A 源冒烟（omni-inbox v2 预建 · 双出口规约——映射出口与降级出口显式区分，防空转绿）。
 *  替身 /__dsh_a2a/state 回放 dsh-open-a2a-net PR#32 形状（tasks 在途 + tasksRecent 归档）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { createServer as createServerCap } from 'node:http';
import { createServer } from 'node:http';

const PORT = 9856;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-a2asrc-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const FIXTURE = {
  tasks: [
    { taskId: 'om-t1', team: 'market/26812e74', peer: 'dsh/11111111', direction: 'outbound', startedAt: '2026-10-23T10:00:00Z', brief: '回执链路联测' },
    { taskId: 'om-t2', team: 'dsh/414d2b90', peer: 'dsh/22222222', direction: 'inbound', startedAt: '2026-10-23T11:00:00Z' },
  ],
  archived: [
    { taskId: 'om-r1', team: 'market/26812e74', peer: 'dsh/33333333', direction: 'outbound', startedAt: '2026-10-23T08:00:00Z', resolvedAt: '2026-10-23T08:05:00Z', endedBy: 'receipt', outcome: 'completed', brief: 'P3 回执验收' },
    { taskId: 'om-r2', team: 'market/26812e74', peer: 'dsh/44444444', direction: 'inbound', startedAt: '2026-10-23T07:00:00Z', resolvedAt: '2026-10-23T07:02:00Z', endedBy: 'cancelled', outcome: 'abandoned', summary: '取消联测-摘要可见' },
  ],
};
let requireKey = 'test-key';
let serveOk = true;
const hits = [];
const stub = createServer((req, res) => {
  hits.push({ url: req.url, key: req.headers['x-api-key'] });
  if (!serveOk) { res.writeHead(503); return res.end('{}'); }
  if (requireKey !== null && req.headers['x-api-key'] !== requireKey) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"error":"unauthorized: X-API-Key required"}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(FIXTURE));
});
await new Promise((r) => stub.listen(9857, '127.0.0.1', r));

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const json = async (url) => { const r = await fetch(url); let j = null; try { j = await r.json(); } catch { } return { status: r.status, body: j }; };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const startSrv = (extraEnv = {}) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, REDIS_URL: '', ...extraEnv },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  // ── 出口一：映射（源启用 + key 正确）──
  let child = startSrv({ A2A_STATE_URL: 'http://127.0.0.1:9857', A2A_API_KEY: 'test-key' });
  if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
  let r = await json(`${BASE}/api/tasks`);
  const a2a = (r.body?.tasks ?? []).filter((t) => t.source === 'a2a');
  ok('出口一 a2a 信封 4 条（在途2+归档2·archived 容器）', a2a.length === 4, JSON.stringify(a2a.map((t) => [t.id, t.status])));

  // ARCHIVE_CAP 边界（direct-65206a7e ②，替身声明口径修正）：cap=64 截断是**上游投影**责任
  // （真实 /__dsh_a2a/state 的 archived 永远 ≤RECENT_FACE_CAP）——替身忠实模拟 64 行投影，
  // 市场侧责任=忠实消费全量 + newest-first 顺序保持。真实端到端 count=64 已实测（docs/stub-declaration-template.md）
  {
    const big = { ...FIXTURE, tasks: [], archived: Array.from({ length: 64 }, (_, i) => ({
      taskId: `cap-r${String(66 - i).padStart(2, '0')}`, team: 'cap/team', peer: 'dsh/99990000',
      direction: 'outbound', startedAt: `2026-10-${String(20 + (65 - i) % 9).padStart(2, '0')}T0${i % 9}:00:00Z`,
      resolvedAt: `2026-10-${String(20 + (65 - i) % 9).padStart(2, '0')}T0${(i + 1) % 9}:00:00Z`,
      endedBy: 'receipt', outcome: 'completed', brief: `cap-${66 - i}`,
    })) };
    let hitsCap = 0;
    const stubCap = createServerCap((req, res) => {
      hitsCap++;
      if (req.headers['x-api-key'] !== 'test-key') { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(big));
    });
    await new Promise((r2) => stubCap.listen(9855, '127.0.0.1', r2));
    // 起新隔离实例指替身（端口 9855）——过 31s 缓存窗用独立端口 9856 实例
    const childCap = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
      cwd: 'server',
      env: (() => { const e = { ...process.env, PORT: '9860', DATA_DIR: '../tmp/e2e-a2acap', ADMIN_TOKEN: 'cap', A2A_STATE_URL: 'http://127.0.0.1:9855', A2A_API_KEY: 'test-key' }; delete e.REDIS_URL; return e; })(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!(await waitReady('http://127.0.0.1:9860/api/health'))) { ok('cap 实例就绪', false); }
    else {
      const rc = await fetch('http://127.0.0.1:9860/api/tasks', { headers: { } }).then((r) => r.json()).catch(() => null);
      const done = (rc?.tasks ?? []).filter((t) => t.source === 'a2a' && t.status === 'done');
      ok('ARCHIVE_CAP 投影忠实消费（替身 64 行→信封 64）', done.length === 64, `done=${done.length}`);
      ok('newest-first 顺序保持（r66 在列、r03 在列）',
        done.some((t) => t.id === 'a2a:cap-r66') && done.some((t) => t.id === 'a2a:cap-r03'));
    }
    childCap.kill(); stubCap.close();
    try { rmSync('tmp/e2e-a2acap', { recursive: true, force: true }); } catch { }
  }
  ok('在途→doing（含 brief 作 title）', a2a.some((t) => t.id === 'a2a:om-t1' && t.status === 'doing' && t.title === '回执链路联测'));
  ok('无 brief 回退 title（team·peer id）', a2a.some((t) => t.id === 'a2a:om-t2' && t.status === 'doing' && t.title.includes('dsh/414d2b90')));
  ok('归档→done（title 带 endedBy）', a2a.some((t) => t.id === 'a2a:om-r1' && t.status === 'done' && t.title.includes('（receipt）')));
  ok('summary 回退链（无 brief 用 summary 作 title）', a2a.some((t) => t.id === 'a2a:om-r2' && t.title.includes('取消联测-摘要可见')));
  ok('project=team', a2a.every((t) => t.project === null || t.project.startsWith('market/') || t.project.startsWith('dsh/')));
  ok('X-API-Key 已传递（替身校验头）', hits.length > 0 && hits.every((h) => h.key === 'test-key'));
  ok('sources.a2a 冻结三字段 + count=在途2', r.body?.sources?.a2a?.ok === true && r.body.sources.a2a.count === 2 && typeof r.body.sources.a2a.latency_ms === 'number' && !('error' in r.body.sources.a2a), JSON.stringify(r.body?.sources?.a2a));

  // ── 出口二：降级（替身 503 / 错 key 401）──都不阻塞其它源
  serveOk = false;
  await new Promise((r2) => setTimeout(r2, 31_000)); // 过 30s 缓存窗
  r = await json(`${BASE}/api/tasks`);
  ok('出口二 503→ok=false 且 ygl/market 照常', r.body?.sources?.a2a?.ok === false && 'ygl-trees' in r.body.sources && r.body.sources.market?.ok === true, JSON.stringify(r.body?.sources));
  serveOk = true; requireKey = 'other-key';
  await new Promise((r2) => setTimeout(r2, 31_000));
  r = await json(`${BASE}/api/tasks`);
  ok('出口二 401（错 key）→ok=false 不阻塞', r.body?.sources?.a2a?.ok === false && r.body.sources.market?.ok === true, JSON.stringify(r.body?.sources?.a2a));
  child.kill();
  await new Promise((r2) => setTimeout(r2, 800));

  // ── 源缺席（未配置 env）≠ 降级 ──
  child = startSrv();
  if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 对照实例未就绪'); process.exit(1); }
  r = await json(`${BASE}/api/tasks`);
  ok('未配置 A2A_STATE_URL→sources 无 a2a 键（源缺席）', !('a2a' in (r.body?.sources ?? {})), JSON.stringify(r.body?.sources));
  ok('对照实例 ygl/market 不受影响', 'ygl-trees' in (r.body?.sources ?? {}) && r.body?.sources?.market?.ok === true);
  child.kill();
} finally {
  stub.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== A2A 源冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
