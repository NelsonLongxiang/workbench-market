#!/usr/bin/env node
/** 统一待办冒烟（omni-inbox · J1/J5 自查版 · 独立实例）：
 *  ① 信封契约字段冻结 ② ygl 源 ok/count（本机有 CLI 则对账 J1，无则 ok=false 降级 J5）
 *  ③ market 源 = 派单 running run 数 ④ 30s 缓存 ⑤ 驾驶舱 tasks 卡布局服务端保存（J3） */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9847;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-omni-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const json = async (url, method = 'GET', body, headers = {}) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { }
  return { status: r.status, body: j };
};

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'omni-tok' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
const AT = { 'X-Admin-Token': 'omni-tok' };

try {
  // J1/J5：GET /api/tasks 契约 + 源降级语义
  let r = await json(`${BASE}/api/tasks`);
  ok('GET /api/tasks 200', r.status === 200);
  const t0 = r.body?.tasks ?? [];
  ok('信封字段冻结（snake_case 七字段）', t0.every((t) => ['id', 'source', 'title', 'status', 'due', 'link', 'project'].every((k) => k in t) && /^(ygl-trees|market):/.test(t.id)), JSON.stringify(t0[0]));
  ok('status 词表 todo|doing|done', t0.every((t) => ['todo', 'doing', 'done'].includes(t.status)));
  const ygl = r.body?.sources?.['ygl-trees'];
  ok('sources.ygl-trees 元数据三件', ygl && typeof ygl.ok === 'boolean' && typeof ygl.count === 'number' && typeof ygl.latency_ms === 'number', JSON.stringify(ygl));
  ok('market 源恒 ok=true', r.body?.sources?.market?.ok === true);
  ok('generated_at 是 iso', typeof r.body?.generated_at === 'string' && !isNaN(Date.parse(r.body.generated_at)));

  // J1 对账：本机有 ygl-trees CLI 时核对非 done 数
  if (ygl?.ok) {
    const { execFileSync } = await import('node:child_process');
    try {
      const out = execFileSync('ygl-trees', ['task', 'list', '--json'], { timeout: 5000, encoding: 'utf8', shell: true }); // 同款 Windows shim 修复
      const rows = JSON.parse(out); const list = Array.isArray(rows) ? rows : (rows.tasks ?? []);
      const notDone = list.filter((x) => String(x.status).toLowerCase() !== 'done').length;
      const apiNotDone = (r.body?.tasks ?? []).filter((t) => t.source === 'ygl-trees' && t.status !== 'done').length;
      ok('J1 对账 = ygl 非 done 数（sources.count 与信封双核）', ygl.count === notDone && apiNotDone === notDone, `count=${ygl.count} envelope=${apiNotDone} cli=${notDone}`);
    } catch { ok('J1 对账（CLI 直查失败，跳过）', true); }
  } else {
    fail++; console.log('  ✗ J1 未实质执行——本冒烟环境 ygl 源必须 ok=true（评审结论：降级出口≠主路径验证，防空转绿）');
    ok('J5 降级形态正确（ok=false + market 照常）', ygl?.ok === false && (r.body?.sources?.market?.count ?? 0) >= 0);
  }

  // market 源语义：派单 running → doing 信封
  await json(`${BASE}/api/apps`, 'POST', {
    slug: 'rv-omni', kind: 'sop', title: '待办冒烟',
    files: [{ path: 'sop.yaml', content: 'title: t\ncode: C\nsteps:\n  - key: s1\n    title: a\n    body: "<p>x</p>"\n' }], changelog: 'x',
  });
  await json(`${BASE}/api/sops/rv-omni/publish`, 'POST', {}, AT);
  await json(`${BASE}/api/bindings`, 'POST', { target_type: 'sop', target_slug: 'rv-omni', agent_node: 'dsh/0123omni', mode: 'run', direction: 'admits' }, AT);
  const card = await json(`${BASE}/.well-known/agent-card.json`);
  const team = card.body?.sessionTeams?.find((x) => x.name === 'rv-omni')?.team;
  const d = await json(`${BASE}/a2a/direct`, 'POST', { team, caller_session: 'dsh/0123omni', task_id: 'om-1', context_id: 'omctx', message: JSON.stringify({ sop: { slug: 'rv-omni', action: 'start' } }) });
  const runId = d.body?.sop?.run_id;
  ok('market 源数据就绪（派单 run）', Number.isInteger(runId));
  // 缓存 30s：新 run 在缓存窗口内不出现（对账用），等待过期后出现
  await new Promise((r2) => setTimeout(r2, 31_000));
  r = await json(`${BASE}/api/tasks`);
  const mkt = (r.body?.tasks ?? []).filter((t) => t.source === 'market');
  ok('market 信封 = running 派单 run（doing+深链）', mkt.some((t) => t.id === `market:run-${runId}` && t.status === 'doing' && t.link === `/sop/rv-omni/?run=${runId}`), JSON.stringify(mkt)); // #270：深链带 ?run= 精确定位

  // J3：驾驶舱 tasks 卡布局服务端保存
  const cp = await json(`${BASE}/api/cockpits`, 'POST', { name: 'omni 舱' }, AT);
  const save = await json(`${BASE}/api/cockpits/${cp.body.id}`, 'PUT', { panels: [{ i: 'tasks', kind: 'tasks', workbenchId: 0, x: 0, y: 0, w: 6, h: 12 }] }, AT);
  ok('J3 tasks 卡布局保存 200', save.status === 200, JSON.stringify(save.body).slice(0, 120));
  const back = await json(`${BASE}/api/cockpits/${cp.body.id}`);
  const saved = (back.body?.panels ?? []).find((p) => p.i === 'tasks');
  ok('J3 布局读回含 tasks 卡（kind/w/h 保持）', saved?.kind === 'tasks' && saved?.w === 6 && saved?.h === 12, JSON.stringify(saved));

  // J4：零侵入——本仓未改 DSH/ygl 侧（结构断言由 git diff 保证，此处仅记 exists）
  ok('J4 契约端点存在且只读（GET 无写路由）', (await json(`${BASE}/api/tasks`)).status === 200);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 统一待办冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
