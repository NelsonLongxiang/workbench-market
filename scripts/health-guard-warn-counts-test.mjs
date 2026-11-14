#!/usr/bin/env node
/**
 * 两个守卫告警档的计数接进 /api/health（对抗组）：WM_APP_DATA_READ=warn、WM_SOP_RUN_WRITE=warn 时「本会拒」的次数，
 * 管理口令读 /api/health 在 guard_would_deny.app_data_read、guard_would_deny.sop_run_write 里给，按路由模板 × 调用方类别，进程启动以来累计。
 *
 *   守的：
 *   - 匿名读一次台数据、匿名写一次 run：管理读看到对应那一行各加一；登录的非管理员读一次，记在自己的类别下，不混进匿名
 *   - 非管理读（匿名、远程匿名、登录的非管理员、口令不对）看不到这个字段
 *   - 字段里只有路由模板、调用方类别、次数：没有台名、run 号、会话
 *   - enforce 档：守卫直接拒、不计数，管理读给的是空的
 *   变异：不判管理口令、两组计数接反、不接出来都必须红
 *
 * 只在本机起隔离实例，身份来源是合成的（identity-fake-preload），不访问任何外部系统。
 *   node scripts/health-guard-warn-counts-test.mjs              测本仓库
 *   node scripts/health-guard-warn-counts-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `health-guard-warn-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-health-warn-admin-token';
const REMOTE = { 'x-forwarded-for': '192.0.2.93' };
const SLUG = 'warn-count-bench', RUN = 7, TOK = 'e'.repeat(48);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const running = [];
async function boot(name, extraEnv) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  mkdirSync(join(data, 'apps', SLUG, 'v1'), { recursive: true });
  writeFileSync(join(data, 'apps', SLUG, 'v1', 'sop.yaml'), 'title: 计数 SOP\nsteps:\n  - key: a\n    title: 第一步\n    body: <input data-field="name">\n');
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  running.push({ stop });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`实例没起来：${log.slice(-800)}`);
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 15000 });
  try {
    const app = db.prepare("INSERT INTO apps (slug, title, kind, status, active_version) VALUES (?, '计数 SOP', 'sop', 'published', 1)").run(SLUG);
    db.prepare('INSERT INTO app_versions (app_id, version, file_count, total_bytes) VALUES (?, 1, 1, 100)').run(app.lastInsertRowid);
    db.prepare("INSERT INTO sop_runs (id, sop_slug, sop_version, status, started_by, upload_token) VALUES (?, ?, 1, 'running', 'seed', ?)").run(RUN, SLUG, TOK);
  } finally { db.close(); }
  const call = async (method, path, headers = {}, body) => {
    const h = { ...headers }; if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  return { call, stop };
}

const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const READ = 'GET /api/apps/:slug/data', WRITE = 'PUT /api/sop/runs/:id';
const countOf = (rows, route, caller) => (Array.isArray(rows) ? rows.find((r) => r.route === route && r.caller === caller)?.count : undefined) ?? 0;

try {
  {
    const w = await boot('warn', { WM_APP_DATA_READ: 'warn', WM_SOP_RUN_WRITE: 'warn' });
    const before = (await w.call('GET', '/api/health', ADMIN)).json?.guard_would_deny;
    check(before && Array.isArray(before.app_data_read) && Array.isArray(before.sop_run_write), '管理口令读 /api/health 带 guard_would_deny（app_data_read、sop_run_write 两组）', show(before));
    const r1 = await w.call('GET', `/api/apps/${SLUG}/data`, REMOTE);
    const r2 = await w.call('PUT', `/api/sop/runs/${RUN}`, REMOTE, { stepKey: 'a', value: { name: 'x' } });
    const after = (await w.call('GET', '/api/health', ADMIN)).json?.guard_would_deny;
    check(r1.status === 200 && countOf(after?.app_data_read, READ, 'anonymous') === countOf(before?.app_data_read, READ, 'anonymous') + 1,
      `warn 档匿名读一次台数据（照旧放行 ${r1.status}）：app_data_read 里「${READ}」× anonymous 加一`, show({ status: r1.status, before: before?.app_data_read, after: after?.app_data_read }));
    check(r2.status === 200 && countOf(after?.sop_run_write, WRITE, 'anonymous') === countOf(before?.sop_run_write, WRITE, 'anonymous') + 1,
      `warn 档匿名写一次 run（照旧放行 ${r2.status}）：sop_run_write 里「${WRITE}」× anonymous 加一`, show({ status: r2.status, before: before?.sop_run_write, after: after?.sop_run_write }));
    check(countOf(after?.app_data_read, WRITE, 'anonymous') === 0 && countOf(after?.sop_run_write, READ, 'anonymous') === 0, '两组各记各的：读不进写那组，写不进读那组', show(after));
    await w.call('GET', `/api/apps/${SLUG}/data`, { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` });
    const third = (await w.call('GET', '/api/health', ADMIN)).json?.guard_would_deny;
    check(countOf(third?.app_data_read, READ, 'login-not-admin') === 1 && countOf(third?.app_data_read, READ, 'anonymous') === countOf(after?.app_data_read, READ, 'anonymous'),
      '登录的非管理员读一次：记在 login-not-admin 下，匿名那行不变', show(third?.app_data_read));
    const rows = [...(third?.app_data_read ?? []), ...(third?.sop_run_write ?? [])];
    const text = show(third);
    check(rows.length > 0 && rows.every((r) => Object.keys(r).sort().join() === 'caller,count,route' && /^[A-Z]+ \/api\/[a-z/:]+$/.test(r.route)) && !text.includes(SLUG) && !text.includes(`/runs/${RUN}`) && !text.includes(SESSIONS.alpha) && !text.includes('alpha'),
      '每行只有路由模板、调用方类别、次数：没有台名、run 号、会话、主体', text);
    for (const [who, h] of [['本机匿名', {}], ['远程匿名', REMOTE], ['登录的非管理员', { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` }], ['口令不对', { ...REMOTE, 'x-admin-token': 'wrong-' + ADMIN_TOKEN }]]) {
      const r = await w.call('GET', '/api/health', h);
      check(r.status === 200 && r.json && !('guard_would_deny' in r.json), `非管理读（${who}）的 /api/health 没有 guard_would_deny`, show({ status: r.status, keys: Object.keys(r.json ?? {}) }));
    }
    await w.stop();
  }
  {
    const e = await boot('enforce', {});
    const r = await e.call('GET', `/api/apps/${SLUG}/data`, REMOTE);
    const g = (await e.call('GET', '/api/health', ADMIN)).json?.guard_would_deny;
    check(r.status === 403 && show(g) === show({ app_data_read: [], sop_run_write: [] }), 'enforce 档：守卫直接拒（403）、不计数，管理读给的两组都是空的', show({ status: r.status, g }));
    await e.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
