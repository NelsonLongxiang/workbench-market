#!/usr/bin/env node
/** 扩展挂载点冒烟（WM_EXTENSIONS_DIR · server/src/extensions.ts · web/vite-extensions.mjs）：独立实例 + 合成扩展，
 *  不设目录 → 什么都不加载；目录不存在 / 相对路径 / 模块加载失败 / 没导出 register / register 抛错 / 空子目录 /
 *  业务写面落在宿主命名空间 → 拒绝启动并点名；正常扩展：路由挂上、待办来源并入（带 label/color，抛错降级为稳定码）、
 *  业务写面进 S3 快照且远程浏览器写不被管理写门拦、登录回跳页登记生效。 */
import { freePort } from './lib/free-port.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { extensionWebEntries } from '../web/vite-extensions.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = resolve('tmp/extensions-smoke-' + Date.now().toString(36));
mkdirSync(TMP, { recursive: true });
const ADMIN = 'synthetic-ext-admin';

async function boot(name, extDir, extra = {}) {
  const port = await freePort();
  const data = join(TMP, `data-${name}`);
  mkdirSync(data, { recursive: true });
  const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, ADMIN_TOKEN: ADMIN, REDIS_URL: '', LAYERFS_SERVICE_URL: '' };
  for (const k of ['WM_EXTENSIONS_DIR', 'WM_ODOO_URL', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_LOGIN_GATE']) delete env[k];
  if (extDir !== undefined) env.WM_EXTENSIONS_DIR = extDir;
  Object.assign(env, extra);
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
  p.out = ''; p.stdout.on('data', (c) => (p.out += c)); p.stderr.on('data', (c) => (p.out += c));
  p.done = new Promise((r) => p.on('exit', (code) => r(code)));
  return { p, port, base: `http://127.0.0.1:${port}` };
}
async function ready(s) {
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    if (s.p.exitCode !== null) return false;
    try { if ((await fetch(s.base + '/api/health')).ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}
/** 期望拒绝启动：40 秒内退出码 1，日志点名 */
async function refuses(label, extDir, want) {
  const s = await boot(label, extDir);
  const code = await Promise.race([s.p.done, sleep(40_000).then(() => 'timeout')]);
  if (code === 'timeout') s.p.kill();
  ok(`${label}：拒绝启动并点名`, code === 1 && want.test(s.p.out), `code=${code} log=${s.p.out.slice(-300)}`);
}
const ext = (root, name, files) => { const d = join(root, name); mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c); } return d; };

const GOOD = `export function register(ctx) {
  if (ctx.apiVersion !== 1) throw new Error('api version');
  ctx.odoo.addReturnPath('/demo-page');
  ctx.remoteWrite.allowExact('/api/demo-ext/act');
  ctx.app.get('/api/demo-ext/ping', ctx.wrap(async (_req, res) => { res.json({ ok: true, ext: ctx.name }); }));
  ctx.app.post('/api/demo-ext/act', ctx.wrap(async (_req, res) => { res.status(202).json({ ok: true }); }));
  ctx.app.get('/api/demo-ext/admin', ctx.wrap(async (req, res) => { if (!(await ctx.adminGuard(req, res))) return; res.json({ ok: true }); }));
  ctx.tasks.addSource({ key: 'demo', label: '演示来源', color: 'purple', collect: async () => ({ meta: { ok: true, count: 1, latency_ms: 0 }, tasks: [{ id: 'demo:1', source: 'demo', title: '演示待办', status: 'todo', due: null, link: null, project: null, readonly_note: '只读' }, { id: 'x:1', source: 'market', title: '冒名', status: 'todo', due: null, link: null, project: null }] }) });
  ctx.tasks.addSource({ key: 'demo-broken', label: '坏来源', collect: async () => { throw new Error('PRIVATE_DETAIL'); } });
}
`;

try {
  // ---- web 构建期入口 ----
  ok('web：不设目录 → 无入口', extensionWebEntries('').length === 0);
  let threw = ''; try { extensionWebEntries(join(TMP, 'nope')); } catch (e) { threw = String(e.message); }
  ok('web：目录不存在 → 构建失败并点名', /不存在或不是目录/.test(threw), threw);
  threw = ''; try { extensionWebEntries('relative/dir'); } catch (e) { threw = String(e.message); }
  ok('web：相对路径 → 构建失败', /绝对路径/.test(threw), threw);
  const webRoot = join(TMP, 'web-ext');
  ext(webRoot, 'b-ext', { 'web/index.tsx': 'export default { name: "b" };\n' });
  ext(webRoot, 'a-ext', { 'web/index.tsx': 'export default { name: "a" };\n', 'server.mjs': 'export function register() {}\n' });
  ext(webRoot, 'srv-only', { 'server.mjs': 'export function register() {}\n' });
  const entries = extensionWebEntries(webRoot);
  ok('web：只收含 web/index.tsx 的扩展，按名排序', entries.length === 2 && entries[0].endsWith(join('a-ext', 'web', 'index.tsx')) && entries[1].endsWith(join('b-ext', 'web', 'index.tsx')), JSON.stringify(entries));

  // ---- 不设目录 ----
  const plain = await boot('plain');
  ok('不设 WM_EXTENSIONS_DIR：正常启动', await ready(plain), plain.p.out.slice(-300));
  ok('不设目录：日志里没有加载扩展', !/\[extensions\] 已加载/.test(plain.p.out));
  let r = await fetch(plain.base + '/api/tasks', { headers: { 'X-Admin-Token': ADMIN } });
  let j = await r.json();
  ok('不设目录：统一待办只有内置来源', r.status === 200 && Object.keys(j.sources ?? {}).every((k) => ['ygl-trees', 'market', 'a2a'].includes(k)), JSON.stringify(j.sources));
  plain.p.kill(); await plain.done;

  // ---- 拒绝启动的各种形态 ----
  await refuses('目录不存在', join(TMP, 'missing-dir'), /\[extensions\] 拒绝启动：WM_EXTENSIONS_DIR 不存在/);
  await refuses('相对路径', 'relative/extensions', /WM_EXTENSIONS_DIR 须为绝对路径/);
  const bad = join(TMP, 'bad-syntax'); ext(bad, 'broken', { 'server.mjs': 'export function register( {\n' });
  await refuses('模块加载失败', bad, /扩展 broken 加载失败/);
  const noReg = join(TMP, 'no-register'); ext(noReg, 'noreg', { 'server.mjs': 'export const x = 1;\n' });
  await refuses('没导出 register', noReg, /扩展 noreg 未导出 register/);
  const regThrows = join(TMP, 'register-throws'); ext(regThrows, 'boom', { 'server.mjs': 'export function register() { throw new Error("boom-reason"); }\n' });
  await refuses('register 抛错', regThrows, /扩展 boom 的 register 失败：boom-reason/);
  const empty = join(TMP, 'empty-sub'); ext(empty, 'hollow', { 'README.md': 'x' });
  await refuses('子目录没有入口', empty, /扩展 hollow 没有 server\.ts/);
  const hostNs = join(TMP, 'host-ns'); ext(hostNs, 'grabby', { 'server.mjs': 'export function register(ctx) { ctx.remoteWrite.allowExact("/api/tasks/approve"); }\n' });
  await refuses('业务写面落在宿主命名空间', hostNs, /不能落在宿主命名空间 \/api\/tasks\//);
  const dupSrc = join(TMP, 'dup-src'); ext(dupSrc, 'dup', { 'server.mjs': 'export function register(ctx) { ctx.tasks.addSource({ key: "market", label: "x", collect: async () => ({}) }); }\n' });
  await refuses('待办来源与内置重名', dupSrc, /与内置来源重名/);

  // ---- 正常扩展 ----
  const goodRoot = join(TMP, 'good'); ext(goodRoot, 'demo', { 'server.mjs': GOOD });
  const g = await boot('good', goodRoot);
  ok('正常扩展：启动', await ready(g), g.p.out.slice(-300));
  ok('正常扩展：日志点名已加载', /\[extensions\] 已加载：demo/.test(g.p.out), g.p.out.slice(-300));
  r = await fetch(g.base + '/api/demo-ext/ping'); j = await r.json().catch(() => null);
  ok('扩展路由挂上（在 SPA 回落之前）', r.status === 200 && j?.ext === 'demo', `${r.status} ${JSON.stringify(j)}`);
  r = await fetch(g.base + '/api/demo-ext/admin', { headers: { 'x-forwarded-for': '198.51.100.7' } });
  ok('ctx.adminGuard：远程无口令被拒', r.status === 401 || r.status === 403, String(r.status));
  r = await fetch(g.base + '/api/demo-ext/admin', { headers: { 'X-Admin-Token': ADMIN } });
  ok('ctx.adminGuard：带口令放行', r.status === 200, String(r.status));
  const browser = { 'content-type': 'application/json', origin: g.base, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.7' };
  r = await fetch(g.base + '/api/demo-ext/act', { method: 'POST', headers: browser, body: '{}' });
  ok('业务写面：远程浏览器写不被管理写门拦', r.status === 202, String(r.status));
  r = await fetch(g.base + '/api/remote-allow/diff', { headers: { 'X-Admin-Token': ADMIN } }); j = await r.json().catch(() => null);
  ok('业务写面进 S3 豁免面快照', r.status === 200 && (j?.current ?? []).includes('/api/demo-ext/act'), JSON.stringify(j?.current));
  r = await fetch(g.base + '/api/tasks', { headers: { 'X-Admin-Token': ADMIN } }); j = await r.json();
  ok('待办来源并入，带 label/color', j.sources?.demo?.ok === true && j.sources.demo.label === '演示来源' && j.sources.demo.color === 'purple', JSON.stringify(j.sources?.demo));
  ok('来源只收自己键的条目（冒名条目丢弃）', j.tasks.some((t) => t.id === 'demo:1' && t.readonly_note === '只读') && !j.tasks.some((t) => t.id === 'x:1'));
  ok('来源抛错：降级为稳定码，不回原始错误', j.sources?.['demo-broken']?.ok === false && j.sources['demo-broken'].error === 'demo-broken_source_unavailable' && !JSON.stringify(j).includes('PRIVATE_DETAIL'), JSON.stringify(j.sources?.['demo-broken']));
  // 已弃用的兼容壳 ctx.odoo：扩展照常加载（addReturnPath 不抛错、什么都不做），用到时打一行弃用警告，只打一次
  const deprec = (g.p.out.match(/ctx\.odoo 已弃用/g) ?? []).length;
  ok('ctx.odoo 兼容壳：扩展照常加载，用到时警告一次「已弃用、改用 ctx.identity」', deprec === 1 && /\[ext:demo\] ctx\.odoo 已弃用/.test(g.p.out), `出现 ${deprec} 次`);
  g.p.kill(); await g.done;

  // ---- Odoo 已下线（2026-11-17）：旧变量（含旧名 LC_ODOO_URL、内容面那几个）还设着照常启动、逐个告警「已下线、忽略」，带 Odoo 会话认不出人 ----
  {
    const SID = 'sidCompat' + '0'.repeat(23);
    const both = await boot('odoo-retired', undefined, { WM_ODOO_URL: 'http://127.0.0.1:9', LC_ODOO_URL: 'http://127.0.0.1:9', WM_CONTENT_PORT: '0', WM_CONTENT_IP: '127.0.0.2', WM_CONTENT_TARGETS: '[{bad json' });
    ok('旧的 Odoo 变量还设着：照常启动（不拒启动）', await ready(both), both.p.out.slice(-300));
    const x = await fetch(both.base + '/api/auth/viewer', { headers: { cookie: `session_id=${SID}` } });
    const j = await x.json().catch(() => null);
    ok('带 Odoo 会话：认不出人（不再有身份来源）', x.status !== 200 && j?.ok !== true, JSON.stringify({ status: x.status, j }));
    ok('旧变量逐个告警已下线、忽略（内容面的变量配错了也不拒启动）', ['WM_ODOO_URL', 'LC_ODOO_URL', 'WM_CONTENT_IP', 'WM_CONTENT_TARGETS'].every((n) => both.p.out.includes(`"name":"${n}"`)) && /已下线/.test(both.p.out), both.p.out.slice(-300));
    both.p.kill(); await both.done;
  }
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nextensions-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
