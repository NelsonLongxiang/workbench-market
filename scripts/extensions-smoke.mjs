#!/usr/bin/env node
/** 扩展挂载点冒烟（WM_EXTENSIONS_DIR · server/src/extensions.ts · web/vite-extensions.mjs）：独立实例 + 合成扩展，
 *  不设目录 → 什么都不加载；目录不存在 / 相对路径 / 模块加载失败 / 没导出 register / register 抛错 / 空子目录 /
 *  业务写面落在宿主命名空间 → 拒绝启动并点名；正常扩展：路由挂上、待办来源并入（带 label/color，抛错降级为稳定码）、
 *  业务写面进 S3 快照且远程浏览器写不被管理写门拦、登录回跳页登记生效。 */
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

function boot(name, extDir, extra = {}) {
  const port = 20000 + Math.floor(Math.random() * 12000);
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
  const s = boot(label, extDir);
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
  const plain = boot('plain');
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
  const g = boot('good', goodRoot);
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
  g.p.kill(); await g.done;

  // ---- Odoo 地址旧名 LC_ODOO_URL 兼容（已弃用）：只设旧名能用；两个都设以 WM_ODOO_URL 为准 ----
  const SID = 'sidCompat' + '0'.repeat(23);
  const odoo = createServer((req, res) => { req.resume(); req.on('end', () => { const ok = String(req.headers.cookie).includes(SID); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(ok ? { result: { uid: 7, username: 'compat', name: 'Compat', is_internal_user: true } } : { error: { code: 100 } })); }); });
  await new Promise((x) => odoo.listen(0, '127.0.0.1', x));
  const good = `http://127.0.0.1:${odoo.address().port}`;
  const viewer = async (s) => { const x = await fetch(s.base + '/api/auth/viewer', { headers: { cookie: `session_id=${SID}` } }); return { status: x.status, j: await x.json().catch(() => null) }; };
  const old = boot('odoo-old', undefined, { LC_ODOO_URL: good });
  ok('只设旧名 LC_ODOO_URL：启动', await ready(old), old.p.out.slice(-300));
  let v = await viewer(old);
  ok('只设旧名：照常认人', v.status === 200 && v.j?.viewer?.login === 'compat', JSON.stringify(v));
  ok('只设旧名：启动告警已弃用、请改名', /LC_ODOO_URL 已弃用，请改名为 WM_ODOO_URL/.test(old.p.out), old.p.out.slice(-300));
  old.p.kill(); await old.done;
  const both = boot('odoo-both', undefined, { WM_ODOO_URL: good, LC_ODOO_URL: 'http://127.0.0.1:9' });
  ok('两个都设：启动', await ready(both), both.p.out.slice(-300));
  v = await viewer(both);
  ok('两个都设：以 WM_ODOO_URL 为准', v.status === 200 && v.j?.viewer?.login === 'compat', JSON.stringify(v));
  ok('两个都设：告警旧名可删', /以 WM_ODOO_URL 为准，LC_ODOO_URL 可删/.test(both.p.out), both.p.out.slice(-300));
  both.p.kill(); await both.done;
  await new Promise((x) => odoo.close(x));

  const { addOdooReturnPath, safeReturnPath } = await import('../server/src/login-providers/odoo/odoo-session.ts');
  // 回跳白名单收首页 /（统一待办 /tasks 已退役，不再收）；/ 收进来以后，协议相对、点段、反斜杠这些照样不收
  ok('登录回跳收首页、不收已退役的 /tasks；/ 收进来以后外站写法照样不收', safeReturnPath('/') === '/' && safeReturnPath('/?x=1') === '/?x=1' && safeReturnPath('/tasks') === null
    && ['//evil.example/', '/.//evil.example', '/%2e//evil.example', '/\\evil.example', 'http://evil.example/', '/\t/evil.example'].every((v) => safeReturnPath(v) === null));
  ok('登录回跳白名单默认不含扩展页', safeReturnPath('/demo-page') === null);
  addOdooReturnPath('/demo-page');
  ok('ctx.odoo.addReturnPath 登记后可回跳（含 query）', safeReturnPath('/demo-page?x=1') === '/demo-page?x=1');
  threw = ''; try { addOdooReturnPath('//evil.example'); } catch (e) { threw = String(e.message); }
  ok('回跳页路径非法 → 抛错', /路径非法/.test(threw), threw);
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.stack ?? e);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nextensions-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
