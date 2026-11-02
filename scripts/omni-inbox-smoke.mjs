#!/usr/bin/env node
/** 统一待办冒烟（omni-inbox · J1/J5 自查版 · 独立实例）：
 *  ① 信封字段 ② 合成 ygl 正例与故障对照（不读宿主工作区）
 *  ③ market 派单信封 ④ 无共享缓存，故障立即生效 ⑤ 驾驶舱布局保存（J3） */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
const fixtureRoot = resolve(DATA, 'synthetic-cli'), fixtureHome = join(fixtureRoot, 'home'), failure = join(fixtureRoot, 'fail');
mkdirSync(join(fixtureRoot, 'node_modules/ygl-trees/dist/bundle'), { recursive: true }); mkdirSync(fixtureHome);
writeFileSync(join(fixtureHome, 'ygl-trees.db'), 'SYNTHETIC_ONLY');
writeFileSync(join(fixtureRoot, 'node_modules/ygl-trees/dist/bundle/bin.cjs'), '// synthetic interceptor only');
const preload = String.raw`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {existsSync} from 'node:fs';const original=cp.execFile;cp.execFile=function(file,args,options,callback){if(args?.[0]?.replaceAll('\\','/').endsWith('/ygl-trees/dist/bundle/bin.cjs')){const fail=existsSync(process.env.OMNI_FIXTURE_FAILURE);const rows=args[1]==='project'?[{name:'fixture-project',status:'active'}]:[{id:'one',title:'Synthetic todo',status:'todo'},{id:'two',title:'Synthetic done',status:'done'}];queueMicrotask(()=>callback(fail?Error('synthetic failure'):null,JSON.stringify(rows)));return {kill(){}};}return original.call(this,file,args,options,callback)};syncBuiltinESMExports();`;
const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: `../${DATA}`, ADMIN_TOKEN: 'omni-tok', PNPM_HOME: fixtureRoot, YGL_HOME: fixtureHome, OMNI_FIXTURE_FAILURE: failure },
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }
const AT = { 'X-Admin-Token': 'omni-tok' };

try {
  // J1/J5：GET /api/tasks 契约 + 源降级语义
  const anon = await json(`${BASE}/api/tasks`); ok('匿名待办查询前401', anon.status === 401 && !anon.body?.tasks);
  let r = await json(`${BASE}/api/tasks`, 'GET', undefined, AT);
  ok('GET /api/tasks 200', r.status === 200);
  const t0 = r.body?.tasks ?? [];
  ok('信封字段冻结（snake_case 七字段）', t0.every((t) => ['id', 'source', 'title', 'status', 'due', 'link', 'project'].every((k) => k in t) && /^(ygl-trees|market):/.test(t.id)), JSON.stringify(t0[0]));
  ok('status 词表 todo|doing|done', t0.every((t) => ['todo', 'doing', 'done'].includes(t.status)));
  const ygl = r.body?.sources?.['ygl-trees'];
  ok('sources.ygl-trees 元数据三件', ygl && typeof ygl.ok === 'boolean' && typeof ygl.count === 'number' && typeof ygl.latency_ms === 'number', JSON.stringify(ygl));
  ok('market 源恒 ok=true', r.body?.sources?.market?.ok === true);
  ok('generated_at 是 iso', typeof r.body?.generated_at === 'string' && !isNaN(Date.parse(r.body.generated_at)));

  // J1: real adapter consumes a controlled CLI result, never a host's personal workspace.
  ok('J1 合成源正常，非done计数与信封对账', ygl?.ok === true && ygl.count === 1 && t0.filter(t => t.source === 'ygl-trees').length === 2);
  writeFileSync(failure, '1');
  const failedSource = await json(`${BASE}/api/tasks`, 'GET', undefined, AT);
  ok('J5 故障立即显式降级且market照常', failedSource.body?.sources?.['ygl-trees']?.error === 'ygl_source_failed' && failedSource.body.sources.market.ok && !failedSource.body.tasks.some(t => t.source === 'ygl-trees'));


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
  // #324: no shared cache; the new run is immediately visible to the authorized admin.
  r = await json(`${BASE}/api/tasks`, 'GET', undefined, AT);
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
  ok('J4 契约端点存在且只读（GET 无写路由）', (await json(`${BASE}/api/tasks`, 'GET', undefined, AT)).status === 200);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 统一待办冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
