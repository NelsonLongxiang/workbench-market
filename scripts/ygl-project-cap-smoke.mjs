// 统一待办 ygl-trees 适配器的项目上限与总预算（lifecycle-os direct-e0cec900）：
// .156 现网 52 个 active 项目，旧硬上限 40 会跳过 12 个。用合成 ygl-trees 入口（PNPM_HOME 下的假 bin.cjs）验证：
// 缺省全部枚举；显式上限/超预算时如实降级、任务数 + 未读 + 失败 = 项目总数（不静默截断）。不碰真实 ygl-trees 与 YGL_HOME。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(dirname(process.execPath), 'node_modules', 'ygl-trees', 'dist', 'bundle', 'bin.cjs'))) {
  console.log('SKIP node 同级目录已装真实 ygl-trees，入口解析会先命中它，合成入口用不上');
  process.exit(0);
}
const fake = join(root, 'tmp', `ygl-cap-${process.pid}`);
const entryDir = join(fake, 'node_modules', 'ygl-trees', 'dist', 'bundle');
mkdirSync(entryDir, { recursive: true });
const fakeHome = join(fake, 'home'); mkdirSync(fakeHome); writeFileSync(join(fakeHome, 'ygl-trees.db'), 'SYNTHETIC_FAKE_CLI_HOME');
writeFileSync(join(entryDir, 'bin.cjs'), `
const a = process.argv.slice(2), n = Number(process.env.FAKE_N), ms = Number(process.env.FAKE_SLEEP_MS || 0);
if (a[0] === 'project') { console.log(JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: 'p' + i, status: 'active' })))); process.exit(0); }
const p = a.find(x => x.startsWith('--project='))?.slice('--project='.length);
setTimeout(() => console.log(JSON.stringify([{ id: 't-' + p, title: p, status: 'todo' }])), ms);
`);

function run(env) {
  const code = `import(${JSON.stringify(pathToFileURL(join(root, 'server/src/tasks.ts')).href)}).then(async (m) => {
    const r = await m.collectTasks({ runsDispatchedAll: () => [], runsRunning: () => [] }, { subject: 'synthetic-admin', admin: true, yglProjects: 'all', marketRunIds: 'all', a2a: true });
    console.log(JSON.stringify({ tasks: r.tasks.filter((t) => t.source === 'ygl-trees').length, src: r.sources['ygl-trees'] }));
  });`;
  const base = { ...process.env };
  for (const k of ['YGL_MAX_PROJECTS', 'YGL_TOTAL_BUDGET_MS', 'A2A_STATE_URL', 'FAKE_SLEEP_MS']) delete base[k];
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { cwd: root, env: { ...base, PNPM_HOME: fake, YGL_HOME: fakeHome, ...env }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
// 任务数 + 预算未读 + 逐项目失败 = 实际读的项目数；再加超上限数 = 全部 active
function accounted(out) {
  const d = out.src.degraded_projects ?? [];
  const num = (re) => d.reduce((s, x) => s + Number((x.match(re) ?? [0, 0])[1]), 0);
  const failed = d.filter((x) => x === '(project-source-failed)').length;
  return out.tasks + failed + num(/^\(budget-exhausted:(\d+)/) + num(/^\(cap-exceeded:(\d+)/);
}

let passed = 0;
const check = (name, f) => { f(); passed++; console.log('PASS ' + name); };
try {
  check('52 个合成项目、缺省配置：全部枚举，无降级', () => {
    const o = run({ FAKE_N: '52' });
    assert.equal(o.tasks, 52); assert.equal(o.src.ok, true); assert.equal(o.src.degraded_projects, undefined);
  });
  check('非法 YGL_MAX_PROJECTS 回落缺省 200：52 个全部枚举', () => {
    for (const v of ['abc', '0', '-5', '1.5']) { const o = run({ FAKE_N: '52', YGL_MAX_PROJECTS: v }); assert.equal(o.tasks, 52, v); assert.equal(o.src.ok, true, v); }
  });
  check('显式 YGL_MAX_PROJECTS=40：只读 40 个，cap-exceeded:12 如实上报', () => {
    const o = run({ FAKE_N: '52', YGL_MAX_PROJECTS: '40' });
    assert.equal(o.tasks, 40); assert.equal(o.src.ok, false);
    assert.ok(o.src.degraded_projects.includes('(cap-exceeded:12 active projects beyond 40 not read)'), JSON.stringify(o.src));
    assert.equal(accounted(o), 52);
  });
  check('缺省上限 200 之上仍降级：250 个项目报 cap-exceeded:50', () => {
    const o = run({ FAKE_N: '250', YGL_TOTAL_BUDGET_MS: '60000' });
    assert.equal(o.tasks, 200); assert.equal(o.src.ok, false);
    assert.ok(o.src.degraded_projects.includes('(cap-exceeded:50 active projects beyond 200 not read)'), JSON.stringify(o.src));
  });
  check('超总预算：如实报降级，任务数 + 未读 + 失败 = 52，不静默截断', () => {
    const o = run({ FAKE_N: '52', FAKE_SLEEP_MS: '400', YGL_TOTAL_BUDGET_MS: '1000' });
    assert.equal(o.src.ok, false); assert.ok(o.tasks < 52, String(o.tasks));
    assert.ok(o.src.degraded_projects.some((x) => x.startsWith('(budget-exhausted:')), JSON.stringify(o.src));
    assert.equal(accounted(o), 52, JSON.stringify(o));
    assert.ok(o.src.latency_ms < 1000 + 3000, String(o.src.latency_ms)); // 单次超时 = min(3s, 剩余预算)
  });
  check('放宽 YGL_TOTAL_BUDGET_MS 后同样的慢源全部读完', () => {
    const o = run({ FAKE_N: '52', FAKE_SLEEP_MS: '400', YGL_TOTAL_BUDGET_MS: '30000' });
    assert.equal(o.tasks, 52); assert.equal(o.src.ok, true);
  });
} finally { rmSync(fake, { recursive: true, force: true }); }
console.log(`ygl-project-cap-smoke: ${passed}/6 PASS`);
