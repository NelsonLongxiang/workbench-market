#!/usr/bin/env node
/** 19a 任务发布面冒烟（direct-58d60ed6 · 独立实例）：
 *  发布=既有通道组合（开 run → _brief/_desc stepSave → assign → 附件 files），零新后端概念（assign 薄端点除外）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 9879;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-19a-data';
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
  cwd: 'server',
  // REDIS_URL 空串在无 Redis 的干净环境会挂死启动（PR#45 TEST 章）——不传该键，让服务端归一为未设
  env: (() => { const e = { ...process.env, PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 't19a' }; delete e.REDIS_URL; return e; })(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
const AT = { 'X-Admin-Token': 't19a' };

try {
  await json(`${BASE}/api/apps`, 'POST', {
    slug: 'rv-19a', kind: 'sop', title: '19a 冒烟流程',
    files: [{ path: 'sop.yaml', content: 'title: t\ncode: C\nsteps:\n  - key: s1\n    title: a\n    body: "<p>x</p>"\n' }], changelog: 'x',
  });
  await json(`${BASE}/api/sops/rv-19a/publish`, 'POST', {}, AT);

  // 发布序列①：开 run（指派语义 started_by）
  let r = await json(`${BASE}/api/sop/runs`, 'POST', { slug: 'rv-19a', started_by: 'expert:zhang' });
const RC = { 'X-Run-Read-Capability': String(r.body?.read_capability ?? '') }; // #309 phase2：创建即得读能力
  const runId = r.body?.id;
  let RUN_TOKEN = String(r.body?.upload_token ?? ''); // P0：run-scoped 上传令牌（启动响应）
  ok('① 开 run 201', r.status === 201 && Number.isInteger(runId));
  // ② 标题/描述进保留键（Runner 交付区只读渲染面）
  r = await json(`${BASE}/api/sop/runs/${runId}`, 'PUT', { stepKey: '_brief', value: '核对十月物流对账差异' });
  ok('② _brief 写入', r.status === 200, JSON.stringify(r.body).slice(0, 80));
  await json(`${BASE}/api/sop/runs/${runId}`, 'PUT', { stepKey: '_desc', value: '差异清单见附件；按台账口径核' });
  const detail = await json(`${BASE}/api/sop/runs/${runId}`, 'GET', undefined, RC);
  ok('② 读回含 _brief/_desc', detail.body?.data?._brief === '核对十月物流对账差异' && !!detail.body?.data?._desc);
  // ③ 指派（assign 薄端点）→ 待验收——先开分拣开关（PR#87 默认关·dispatched=1 需开关开）
  r = await json(`${BASE}/api/settings`, 'PUT', { dispatch_sorting_enabled: '1' }, AT);
  r = await json(`${BASE}/api/sop/runs/${runId}/assign`, 'POST', { node: 'dsh/6de4035c' });
  ok('③ assign 201', r.status === 201 && r.body?.task_id === `task-${runId}`, JSON.stringify(r.body));
  r = await json(`${BASE}/api/sop/runs/${runId}/assign`, 'POST', { node: 'dsh/6de4035c' });
  ok('③ 重复指派 409', r.status === 409);
  r = await json(`${BASE}/api/sop/runs?dispatched=1`);
  ok('③ 入待验收列表', (r.body ?? []).some((x) => x.id === runId));
  // ④ 附件走交付物通道
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('diff,order,amount\n1,SO-1024,358.00')], { type: 'text/csv' }), '差异清单.csv');
  fd.append('created_by', 'expert:zhang');
  const rf = await fetch(`${BASE}/api/sop/runs/${runId}/files`, { method: 'POST', body: fd, headers: RUN_TOKEN ? { 'X-Run-Upload-Token': RUN_TOKEN } : {} }); // P0 令牌
  const rj = await rf.json();
  ok('④ 附件 201（交付物通道）', rf.status === 201, JSON.stringify(rj).slice(0, 80));
  const fl = await json(`${BASE}/api/sop/runs/${runId}/files`, 'GET', undefined, RC);
  ok('④ 附件列表可见', fl.body?.count === 1 && fl.body.items[0].original_name === '差异清单.csv');
  // ⑤ 不指派路径（自己做）：纯人开 run，不进 dispatched
  r = await json(`${BASE}/api/sop/runs`, 'POST', { slug: 'rv-19a', started_by: 'expert:li' });
  const selfRun = r.body?.id;
  await json(`${BASE}/api/sop/runs/${selfRun}`, 'PUT', { stepKey: '_brief', value: '自查项' });
  r = await json(`${BASE}/api/sop/runs?dispatched=1`);
  ok('⑤ 自己做不进待验收', !(r.body ?? []).some((x) => x.id === selfRun));
  // ⑥ omni-inbox market 源聚合（指派 running 计入）
  const tasks = await json(`${BASE}/api/tasks`, 'GET', undefined, AT);
  ok('⑥ market 源含指派任务', (tasks.body?.tasks ?? []).some((t) => t.id === `market:run-${runId}` && t.status === 'doing'));
  // ⑦ Runner 交付区锚（_brief 非 data-field → 只读渲染面在位）
  const page = await (await fetch(`${BASE}/sop/rv-19a/`)).text();
  ok('⑦ Runner 交付区渲染逻辑在位', page.includes('agent-extras'));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 19a 发布面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
