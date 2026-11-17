#!/usr/bin/env node
/** 导入/导出行为冒烟（独立实例：独立 DATA_DIR+PORT——replace 全表清写不再碰活库，根治并发撞车）。
 *  覆盖：issue #7 的 query mode 语义 + 内部路径行不丢 + replace 后驾驶舱悬空面板 prune + 掩码行整批拒（#258）。 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const reserve = createServer();await new Promise((r) => reserve.listen(0, '127.0.0.1', r));const PORT = reserve.address().port;await new Promise((r) => reserve.close(r));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-import-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const gh = await startFakeGithub();
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: `../${DATA}`, WM_GITHUB_API: gh.api },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(String(d)));
child.on('exit', (c) => { if (c !== null && c !== 0) console.error('[import-smoke] 子进程异常退出', c); });
async function waitReady(ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(BASE + '/api/health'); if (r.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
if (!(await waitReady())) { console.error('[import-smoke] 实例未就绪（30s 超时）'); process.exit(1); }

async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  // 准备：一个 http 台 + 一个驾驶舱面板引用 + 一个 market 内部路径台（模拟自产注册行）
  const http1 = (await call('POST', '/api/workbenches', { name: 'A1', url: 'http://127.0.0.1:9990/a1', type: 'web', category: 'X' })).body;
  // #258：内部路径只收已存在的托管台——先发布台（发布即自动入册），再拿它的注册行
  await ghPublish(BASE, gh, { slug: 'e2e-import-probe', title: 'probe', files: [{ path: 'index.html', content: '<p>p</p>' }] });
  const probe_app = (await call('GET', '/api/workbenches')).body.find((w) => w.url === '/apps/e2e-import-probe/');
  const cp = (await call('POST', '/api/cockpits', { name: '舱', panels: [{ i: 'p1', workbenchId: http1.id, x: 0, y: 0, w: 4, h: 3 }] })).body;
  // 视图面板不引用工作台（workbenchId=0 占位）：replace 剔悬空面板时不能把它当悬空的一起剔掉
  const cpv = (await call('POST', '/api/cockpits', { name: '视图舱', panels: [{ kind: 'bench-view', bench: 'probe', view: 'main' }, { i: 'p1', workbenchId: http1.id }] })).body;

  // ① export → 删内部路径台（模拟丢注册）→ query mode replace 导回
  const exp = (await call('GET', '/api/export')).body;
  await call('DELETE', `/api/workbenches/${probe_app.id}`);
  const r1 = await call('POST', '/api/import?mode=replace', { workbenches: exp.workbenches, types: exp.types, settings: {} });
  ok('query replace 200', r1.status === 200 && r1.body.mode === 'replace', JSON.stringify(r1.body).slice(0, 120));
  const urls = (await call('GET', '/api/workbenches')).body.map((w) => w.url);
  ok('replace 后内部路径注册行不丢（issue #7）', urls.includes('/apps/e2e-import-probe/'));
  ok('http 台仍在', urls.includes('http://127.0.0.1:9990/a1'));

  // ② replace 重排 id 后：驾驶舱悬空面板被 prune（面板引用旧 id 已不存在）
  const cp2 = (await call('GET', `/api/cockpits/${cp.id}`)).body;
  const wids = new Set((await call('GET', '/api/workbenches')).body.map((w) => w.id));
  const dangling = (cp2.panels || []).filter((p) => !wids.has(p.workbenchId));
  ok('replace 后悬空面板已剔除（PR#15 prune 吸收面）', dangling.length === 0, JSON.stringify(cp2.panels));
  const cpv2 = (await call('GET', `/api/cockpits/${cpv.id}`)).body;
  ok('replace 后视图面板还在（不引用工作台，不算悬空）', (cpv2.panels || []).some((p) => p.kind === 'bench-view' && p.bench === 'probe' && p.view === 'main'), JSON.stringify(cpv2.panels));
  const rsave = await call('PUT', `/api/cockpits/${cp.id}`, { panels: cp2.panels });
  ok('清舱后保存布局 200（不再 400）', rsave.status === 200);

  // ③ 掩码行整批拒（#258 D：不 skip 后报成功，掩码数据永不落库）
  const n0 = (await call('GET', '/api/workbenches')).body.length;
  const rim = await call('POST', '/api/import', { workbenches: [{ name: 'OK', url: 'http://127.0.0.1:9990/ok', type: 'web' }, { name: 'M', url: 'http://127.0.0.1:9990/x?token=****', type: 'web' }], types: [] });
  ok('掩码 url 行整批拒 400 masked_import_value（零写）', rim.status === 400 && rim.body.error === 'masked_import_value' && rim.body.row_index === 1 && (await call('GET', '/api/workbenches')).body.length === n0, JSON.stringify(rim.body));

  // ④ body mode 与 query 等价（body.mode=merge 不清表）
  const before = (await call('GET', '/api/workbenches')).body.length;
  const rm2 = await call('POST', '/api/import', { mode: 'merge', workbenches: [{ name: 'B2', url: 'http://127.0.0.1:9990/b2', type: 'web' }], types: [] });
  const after = (await call('GET', '/api/workbenches')).body.length;
  ok('body mode=merge 增量不清表', rm2.body.mode === 'merge' && after === before + 1, `before=${before} after=${after}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  await gh.close();
}
console.log(`\n===== 导入冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
