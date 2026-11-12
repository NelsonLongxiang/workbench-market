#!/usr/bin/env node
/**
 * 扩展的路由报动作（对抗组）：扩展经 ctx.routes.add 注册，报上动作（<扩展名>.<动词>）、类别和「谁能调」；
 * 直接用 ctx.app 挂的照旧能跑，但逐条点名「没报动作」、计数；WM_EXTENSION_ROUTES=enforce 时拒绝启动。
 * surface-snapshot.mjs --extensions 单独导出扩展那一节，不写 surfaces/。
 *
 * 只在本机起隔离实例，扩展是合成的（写在临时目录里），不访问任何外部系统。
 *   node scripts/extension-routes-smoke.mjs              测本仓库
 *   node scripts/extension-routes-smoke.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `extension-routes-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-extension-routes-admin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/** 在临时目录里写一组扩展：{ 扩展名: register 函数体 } */
function writeExtensions(tag, exts) {
  const dir = join(OUT, tag, 'ext');
  for (const [name, body] of Object.entries(exts)) {
    mkdirSync(join(dir, name), { recursive: true });
    // 扩展里要 express（做子路由器）时，从实例的工作目录（server/）解析，拿到的是宿主那一份
    writeFileSync(join(dir, name, 'server.mjs'), `import { createRequire } from 'node:module';\nconst express = createRequire(process.cwd() + '/src/index.ts')('express');\nexport function register(ctx) {\n${body}\n}\n`);
  }
  return dir;
}

const running = [];
async function boot(tag, extDir, extraEnv = {}) {
  const port = await freePort();
  const data = join(OUT, tag, 'data'), home = join(OUT, tag, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: extDir, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  if (!ready) { for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100); await stop(); return { failed: true, code: child.exitCode, log }; }
  const call = async (method, path, headers = {}) => { const r = await fetch(base + path, { method, headers }); return { status: r.status, text: await r.text() }; };
  const srv = { base, call, stop, log: () => log };
  running.push(srv);
  return srv;
}

const GOOD = `
  ctx.routes.add('get', '/api/acme/items', { action: 'acme.items-read', kind: 'read', who: 'member' }, (_req, res) => res.json({ items: [1] }));
  ctx.routes.add('post', '/api/acme/items', { action: 'acme.items-create', kind: 'admin', who: 'admin' }, (_req, res) => res.status(201).json({ ok: true }));
  ctx.routes.add('post', '/api/acme/approve', { action: 'acme.approve', kind: 'decide', who: 'member', statusNotVerdict: '恒定 503：只读阶段' }, (_req, res) => res.status(503).json({ error: 'read-only' }));`;
const LEGACY = `
  ctx.app.get('/api/acme/legacy', (_req, res) => res.json({ legacy: true }));
  ctx.app.route('/api/acme/legacy2').post((_req, res) => res.json({ legacy2: true }));
  ctx.app.use('/api/acme/mw', (_req, _res, next) => next());`;

try {
  // ---------- 一、报了动作的照常；直接挂的点名计数（warn） ----------
  {
    const dir = writeExtensions('warn', { acme: GOOD + LEGACY });
    const srv = await boot('warn', dir);
    if (srv.failed) throw new Error(`带扩展的实例没起来：${srv.log.trim().split('\n').filter((l) => /拒绝|Error/.test(l)).slice(0, 1).join(' ').slice(0, 200)}`);
    const items = await srv.call('GET', '/api/acme/items'), legacy = await srv.call('GET', '/api/acme/legacy');
    const lines = srv.log().split('\n').filter((l) => l.includes('"source":"extensions"'));
    const named = (m, p) => lines.some((l) => l.includes('"event":"route-undeclared"') && l.includes('"extension":"acme"') && l.includes(`"method":"${m}"`) && l.includes(`"path":"${p}"`));
    check(items.status === 200 && legacy.status === 200, 'warn：报了动作的扩展路由照常；直接用 ctx.app 挂的照旧能跑', show({ items: items.status, legacy: legacy.status }));
    check(named('GET', '/api/acme/legacy') && named('POST', '/api/acme/legacy2') && lines.some((l) => l.includes('"event":"middleware-added"'))
      && /扩展没报的层：路由 2 条、中间件或子路由器 1 个（acme）/.test(srv.log()) && !lines.some((l) => l.includes('/api/acme/items')),
      '直接挂的（app.get、app.route().post）逐条点名「没报动作」，中间件另记一类，合计一行；经 routes.add 的不点名', show(lines.length));
    await srv.stop();
  }
  // ---------- 二、enforce：有没报动作的就拒绝启动；全报了的照常 ----------
  {
    const bad = await boot('enforce-bad', writeExtensions('enforce-bad', { acme: GOOD + LEGACY }), { WM_EXTENSION_ROUTES: 'enforce' });
    check(bad.failed === true && bad.code !== 0 && /WM_EXTENSION_ROUTES=enforce：扩展有 3 处没报（路由 2 条、中间件或子路由器 1 个/.test(bad.log) && bad.log.includes('acme GET /api/acme/legacy'),
      'enforce：有没报动作的扩展路由、没报用途的中间件，拒绝启动并点名', show({ code: bad.code }));
    // 旁路挂载：子路由器（里面的路由看不见）、按路径直接应答的裸中间件——enforce 一律拒绝启动
    const subRouter = await boot('enforce-subrouter', writeExtensions('enforce-subrouter', { acme: GOOD + `\n  const r = express.Router(); r.get('/peek', (_q, s) => s.json({ peek: true })); ctx.app.use('/api/acme/sub', r);` }), { WM_EXTENSION_ROUTES: 'enforce' });
    const rawMw = await boot('enforce-raw-mw', writeExtensions('enforce-raw-mw', { acme: GOOD + `\n  ctx.app.use('/api/acme/raw', (_q, s) => s.json({ raw: true }));` }), { WM_EXTENSION_ROUTES: 'enforce' });
    check(subRouter.failed === true && /子路由器 1 个/.test(subRouter.log) && rawMw.failed === true && /子路由器 1 个/.test(rawMw.log),
      'enforce：旁路挂载——ctx.app.use 挂子路由器、按路径直接应答的裸中间件——都拒绝启动', show({ sub: subRouter.code, raw: rawMw.code }));
    // 报了用途的中间件照常（enforce 下也能启动）
    const declaredMw = await boot('enforce-declared-mw', writeExtensions('enforce-declared-mw', { acme: GOOD + `\n  ctx.routes.use('/api/acme', { purpose: '给本扩展的接口加缓存头' }, (_q, s, n) => { s.set('X-Acme', '1'); n(); });` }), { WM_EXTENSION_ROUTES: 'enforce' });
    const viaMw = declaredMw.failed ? null : await declaredMw.call('GET', '/api/acme/items');
    check(!declaredMw.failed && viaMw?.status === 200, 'enforce：经 ctx.routes.use 写明用途的中间件照常启动、照常生效', show({ failed: declaredMw.failed }));
    if (!declaredMw.failed) await declaredMw.stop();
    const good = await boot('enforce-good', writeExtensions('enforce-good', { acme: GOOD }), { WM_EXTENSION_ROUTES: 'enforce' });
    check(!good.failed && (await good.call('GET', '/api/acme/items')).status === 200, 'enforce：全部报了动作的扩展照常启动');
    if (!good.failed) await good.stop();
    const badMode = await boot('bad-mode', writeExtensions('bad-mode', { acme: GOOD }), { WM_EXTENSION_ROUTES: 'off' });
    check(badMode.failed === true && /WM_EXTENSION_ROUTES/.test(badMode.log), 'WM_EXTENSION_ROUTES 不是 warn/enforce：拒绝启动');
  }
  // ---------- 三、注册时就拒的 ----------
  {
    const cases = [
      ['声明核心的动作 app.list', `ctx.routes.add('get', '/api/acme/x', { action: 'app.list', kind: 'read', who: 'member' }, (_q, s) => s.end());`, /动作名要以「acme\.」开头/],
      ['动作不带自己的前缀', `ctx.routes.add('get', '/api/acme/x', { action: 'other.read', kind: 'read', who: 'member' }, (_q, s) => s.end());`, /动作名要以「acme\.」开头/],
      ['路径挂到宿主的命名空间', `ctx.routes.add('get', '/api/apps/x', { action: 'acme.x', kind: 'read', who: 'member' }, (_q, s) => s.end());`, /路径只能在 \/api\/acme\//],
      ['会写的方法报成 read', `ctx.routes.add('post', '/api/acme/x', { action: 'acme.x', kind: 'read', who: 'member' }, (_q, s) => s.end());`, /不能报成 read/],
      ['管理类给 member', `ctx.routes.add('post', '/api/acme/x', { action: 'acme.x', kind: 'admin', who: 'member' }, (_q, s) => s.end());`, /管理类只能给 admin 或 owner/],
      ['决定类给匿名', `ctx.routes.add('post', '/api/acme/x', { action: 'acme.x', kind: 'decide', who: 'anonymous' }, (_q, s) => s.end());`, /who=anonymous 只能配 read 或 write/],
      ['自造的 who', `ctx.routes.add('get', '/api/acme/x', { action: 'acme.x', kind: 'read', who: 'everyone' }, (_q, s) => s.end());`, /who 只能是 anonymous \/ member \/ admin \/ owner/],
      ['同一个动作两条路由说法不一', `ctx.routes.add('get', '/api/acme/x', { action: 'acme.x', kind: 'read', who: 'member' }, (_q, s) => s.end()); ctx.routes.add('get', '/api/acme/y', { action: 'acme.x', kind: 'read', who: 'admin' }, (_q, s) => s.end());`, /同一个动作要一致/],
      ['路径用正则', `ctx.routes.add('get', /^\\/api\\/acme\\/x$/, { action: 'acme.x', kind: 'read', who: 'member' }, (_q, s) => s.end());`, /路径要是字符串/],
    ];
    const results = [];
    for (const [i, [what, body, re]] of cases.entries()) {
      const r = await boot(`reject-${i}`, writeExtensions(`reject-${i}`, { acme: body }));
      results.push({ what, ok: r.failed === true && r.code !== 0 && re.test(r.log) && r.log.includes('扩展 acme') });
      if (!r.failed) await r.stop();
    }
    check(results.every((r) => r.ok), '注册时就拒绝启动并点名扩展：' + cases.map((c) => c[0]).join('、'), show(results.filter((r) => !r.ok).map((r) => r.what)));
    // 扩展名（动作前缀）和核心动作的域重名：核心路由全部注册完之后核出来
    const clash = await boot('clash', writeExtensions('clash', { grant: `ctx.routes.add('get', '/api/grant/x', { action: 'grant.x', kind: 'read', who: 'member' }, (_q, s) => s.end());` }));
    check(clash.failed === true && /扩展名 grant 和核心动作的域重名/.test(clash.log), '扩展名和核心动作的域重名（扩展叫 grant）：拒绝启动');
    // 扩展名和核心路径的首段重名：api、核心的路径（design、go）、前端页面（tasks）、只在核心路由栈里的首段（a2a：直接挂在 Express 上、没报动作，自动收集）
    const pathClash = [];
    for (const n of ['api', 'design', 'go', 'tasks', 'overview', 'a2a']) {
      const r = await boot(`path-clash-${n}`, writeExtensions(`path-clash-${n}`, { [n]: `ctx.routes.add('get', '/${n}/x', { action: '${n}.x', kind: 'read', who: 'member' }, (_q, s) => s.json({ ext: true }));` }));
      pathClash.push({ n, ok: r.failed === true && new RegExp(`扩展名 ${n} 和核心的路径首段重名`).test(r.log) });
      if (!r.failed) await r.stop();
    }
    check(pathClash.every((x) => x.ok), '扩展名和核心路径的首段重名（api、design、go、前端页面 tasks、退役的页面 overview、只在核心路由栈里的 a2a，自动收集）：拒绝启动，不让扩展抢走核心的路由', show(pathClash.filter((x) => !x.ok)));
    // 前端页面的首段清单和 web/src/App.tsx 对得上
    const app = readFileSync(join(ROOT, 'web', 'src', 'App.tsx'), 'utf8');
    const pages = [...new Set([...app.matchAll(/<Route path="\/([a-z0-9-]+)/g)].map((m) => m[1]))].sort();
    const extSrc = readFileSync(join(ROOT, 'server', 'src', 'extensions.ts'), 'utf8');
    const listOf = (name) => JSON.parse(new RegExp(`${name}: readonly string\\[\\] = (\\[[^\\]]*\\])`).exec(extSrc)?.[1].replace(/\/\/[^\n]*/g, '').replace(/,\s*\]/, ']').replace(/'/g, '"') ?? '[]').sort();
    const listed = listOf('SPA_PAGE_SEGMENTS');
    const retired = listOf('RETIRED_PAGE_SEGMENTS');
    check(JSON.stringify(pages) === JSON.stringify(listed), '扩展名的保留名单里的前端页面首段和 web/src/App.tsx 一致（页面加了、名单没跟上就红）', show({ pages, listed }));
    check(retired.every((s) => !pages.includes(s)) && !retired.some((s) => listed.includes(s)), '退役的页面首段（页面删了、路径照样保留）不在现有页面里、也不和现有页面那份重复：保留 = 页面 ∪ 退役', show({ pages, retired }));
  }
  // ---------- 四、快照 --extensions：单独一节，不写 surfaces/ ----------
  {
    const dir = writeExtensions('snap', { acme: GOOD + LEGACY });
    const before = readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8');
    const out = join(OUT, 'ext-surface.json');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'surface-snapshot.mjs'), '--extensions', dir, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const sec = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
    const acme = sec?.extensions?.find((e) => e.name === 'acme');
    const intoSurfaces = spawnSync(process.execPath, [join(ROOT, 'scripts', 'surface-snapshot.mjs'), '--extensions', dir, '--out', join(ROOT, 'surfaces', 'ext.json')], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    check(r.status === 0 && acme?.routes?.length === 3 && acme.routes.some((x) => x.action === 'acme.items-read' && x.kind === 'read' && x.who === 'member')
      && acme.routes.some((x) => x.action === 'acme.approve' && x.statusNotVerdict) && acme.undeclared.filter((u) => u.type === 'route').length === 2
      && readFileSync(join(ROOT, 'surfaces', 'actions.json'), 'utf8') === before && !before.includes('acme') && intoSurfaces.status !== 0 && !existsSync(join(ROOT, 'surfaces', 'ext.json')),
      '快照 --extensions：扩展报的路由（动作、类别、谁能调、状态码不代表授权）和没报动作的单独一节；核心快照不变；不许写进 surfaces/', show({ status: r.status, routes: acme?.routes?.length, undeclared: acme?.undeclared?.length, err: r.stderr.slice(0, 200) }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`extension-routes-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
