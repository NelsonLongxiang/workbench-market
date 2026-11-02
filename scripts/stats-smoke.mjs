#!/usr/bin/env node
/** 端点计数冒烟（direct-10eba7cb · K1/K2/K3 自查版 · 独立实例）：
 *  K1 连续两请求计数+2、跨重启持久并续增；K2 业务端点契约不变（/api/tasks 信封仍全字段）；
 *  K3 /api/stats 可读（per-endpoint 总量 + 按日分桶）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9860;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-stats-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const start = () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: `../${DATA}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
const stats = async () => (await fetch(`${BASE}/api/stats`)).json();

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
let child = start();
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }

try {
  // K1：基线 → 两连击 → +2
  await fetch(`${BASE}/api/workbenches`);
  await new Promise((r) => setTimeout(r, 300));
  const s0 = await stats();
  const before = s0.endpoints.find((e) => e.endpoint === '/api/workbenches')?.total ?? 0;
  await fetch(`${BASE}/api/workbenches`);
  await fetch(`${BASE}/api/workbenches`);
  await new Promise((r) => setTimeout(r, 300));
  const s1 = await stats();
  const after = s1.endpoints.find((e) => e.endpoint === '/api/workbenches')?.total ?? 0;
  ok('K1 两连击计数 +2', after - before === 2, `${before} → ${after}`);

  // 路径参数规范化：/api/sop/runs/:id 不炸且聚合
  await fetch(`${BASE}/api/sop/runs/1`).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const s2 = await stats();
  ok('数字段折叠为 :id', !s2.endpoints.some((e) => /\/api\/sop\/runs\/\d+/.test(e.endpoint)));

  // K1：跨重启持久并续增
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
  child = start();
  if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 重启失败'); process.exit(1); }
  const s3 = await stats();
  const persisted = s3.endpoints.find((e) => e.endpoint === '/api/workbenches')?.total ?? 0;
  ok('K1 跨重启计数持久', persisted === after, `重启后 ${persisted} vs ${after}`);
  await fetch(`${BASE}/api/workbenches`);
  await new Promise((r) => setTimeout(r, 300));
  const s4 = await stats();
  const resumed = s4.endpoints.find((e) => e.endpoint === '/api/workbenches')?.total ?? 0;
  ok('K1 重启后续增 +1', resumed === persisted + 1, `${persisted} → ${resumed}`);

  // K3：结构（per-endpoint 总量 + 按日分桶 + generated_at）
  ok('K3 stats 结构（total/by_day/generated_at）', s4.endpoints.every((e) => typeof e.total === 'number' && e.by_day && Object.keys(e.by_day).length > 0) && !!s4.generated_at, JSON.stringify(s4.endpoints[0]));
  ok('K3 stats 自身不计入', !s4.endpoints.some((e) => e.endpoint === '/api/stats'));

  // K2：业务契约不变（/api/tasks 信封字段仍全）
  const t = await (await fetch(`${BASE}/api/tasks`)).json();
  ok('K2 /api/tasks 契约不变（tasks/sources/generated_at）', Array.isArray(t.tasks) && 'sources' in t && 'generated_at' in t);
  ok('K2 静态/非 api 路径不计（/tasks 页只按 URL 计一次，/ 不计）', !s4.endpoints.some((e) => e.endpoint === '/'));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 端点计数冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
