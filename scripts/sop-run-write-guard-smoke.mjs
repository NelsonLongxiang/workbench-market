#!/usr/bin/env node
/**
 * SOP run 的写守卫（对抗组）：PUT /api/sop/runs/:id（保存一步）、POST /api/sop/runs/:id/finish（完成）要这个 run 的上传令牌
 * （X-Run-Upload-Token，run 还在执行）、管理员（同源）或本机命令行。都不满足 403，先于查 run；不分登录门开没开。
 * WM_SOP_RUN_WRITE=warn 照旧放行、只计数留痕。开建 POST /api/sop/runs 照旧开放。
 *
 * 只在本机起隔离实例，身份来源是合成的（identity-fake-preload），不访问任何外部系统。
 *   node scripts/sop-run-write-guard-smoke.mjs              测本仓库
 *   node scripts/sop-run-write-guard-smoke.mjs --root DIR   测另一棵目录树
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `sop-run-write-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-run-write-admin-token';
const REMOTE = { 'x-forwarded-for': '192.0.2.91' };
const TOK = { 1: 'a'.repeat(48), 2: 'b'.repeat(48), 3: 'c'.repeat(48), 4: 'd'.repeat(48) };
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

const running = [];
async function boot(name, extraEnv = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  mkdirSync(join(data, 'apps', 'rw-sop', 'v1'), { recursive: true });
  writeFileSync(join(data, 'apps', 'rw-sop', 'v1', 'sop.yaml'), 'title: 写守卫 SOP\nsteps:\n  - key: a\n    title: 第一步\n    body: <input data-field="name">\n');
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (!ready) { await stop(); return { failed: true, code: child.exitCode, log }; }
  // 种一个 SOP 台和四个 run：1、2、4 在执行，3 已结束；各有自己的上传令牌
  const db = new DatabaseSync(join(data, 'workbench-market.db'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const app = db.prepare("INSERT INTO apps (slug, title, kind, status, active_version) VALUES ('rw-sop', '写守卫 SOP', 'sop', 'published', 1)").run();
    db.prepare("INSERT INTO app_versions (app_id, version, file_count, total_bytes) VALUES (?, 1, 1, 100)").run(app.lastInsertRowid);
    for (const [id, status] of [[1, 'running'], [2, 'running'], [3, 'finished'], [4, 'running']]) {
      db.prepare("INSERT INTO sop_runs (id, sop_slug, sop_version, status, started_by, upload_token) VALUES (?, 'rw-sop', 1, ?, 'seed', ?)").run(id, status, TOK[id]);
    }
  } finally { db.close(); }
  const call = async (method, path, headers = {}, body) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const t0 = performance.now();
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ms = performance.now() - t0;
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json, ms };
  };
  const srv = { name, base, data, call, stop, log: () => log };
  running.push(srv);
  return srv;
}

const save = (srv, id, headers, value = { name: 'x' }) => srv.call('PUT', `/api/sop/runs/${id}`, headers, { stepKey: 'a', value });
const finish = (srv, id, headers) => srv.call('POST', `/api/sop/runs/${id}/finish`, headers, {});
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

try {
  {
    const bad = await boot('bad-mode', { WM_SOP_RUN_WRITE: 'off' });
    check(bad.failed === true && bad.code !== 0 && /WM_SOP_RUN_WRITE/.test(bad.log), 'WM_SOP_RUN_WRITE 不是 enforce/warn：拒绝启动（不当成关）', show({ code: bad.code }));
  }
  const srv = await boot('enforce');
  // ---------- 拒绝 ----------
  {
    const denied = [
      await save(srv, 1, REMOTE),
      await save(srv, 1, { ...REMOTE, 'x-run-upload-token': TOK[2] }),
      await save(srv, 1, { ...REMOTE, 'x-run-upload-token': 'f'.repeat(48) }),
      await save(srv, 1, { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` }),
      await save(srv, 1, { ...REMOTE, 'x-admin-token': ADMIN_TOKEN, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }),
      await save(srv, 1, { ...REMOTE, 'x-run-upload-token': 'ÿ'.repeat(48) }),
      await finish(srv, 1, REMOTE),
      await finish(srv, 1, { ...REMOTE, 'x-run-upload-token': TOK[2] }),
    ];
    check(denied.every((r) => r.status === 403 && r.json?.error === 'run_write_denied'),
      '拒绝：匿名、别的 run 的上传令牌、错的令牌、登录的非管理员、带有效口令的跨站、非 ASCII 令牌——保存和完成都 403', show(denied.map((r) => r.status)));
    const finished = [await save(srv, 3, { ...REMOTE, 'x-run-upload-token': TOK[3] }), await finish(srv, 3, { ...REMOTE, 'x-run-upload-token': TOK[3] })];
    check(finished.every((r) => r.status === 403), '令牌对、但 run 已结束：403（结束了的 run 不再凭上传令牌写）', show(finished.map((r) => r.status)));
    const data1 = (() => { const db = new DatabaseSync(join(srv.data, 'workbench-market.db')); try { return db.prepare('SELECT data FROM sop_runs WHERE id = 1').get().data; } finally { db.close(); } })();
    check(data1 === '{}', '被拒的写一条都没落进 run', data1);
  }
  // ---------- 存在与否：应答逐字节相同，耗时没有稳定差别 ----------
  {
    const exist = await save(srv, 2, REMOTE), missing = await save(srv, 987654321, REMOTE), missingFinish = await finish(srv, 987654321, REMOTE);
    check(exist.status === 403 && exist.text === missing.text && missing.text === missingFinish.text, '不存在的 run 号和存在但无权的 run 号：同样的状态码、逐字节相同的应答');
    const a = [], b = [];
    for (let i = 0; i < 40; i++) { a.push((await save(srv, 2, REMOTE)).ms); b.push((await save(srv, 987654321, REMOTE)).ms); }
    const ma = median(a), mb = median(b);
    console.log(`    耗时中位数：存在 ${ma.toFixed(2)}ms，不存在 ${mb.toFixed(2)}ms`);
    check(Math.abs(ma - mb) < 5, '耗时：存在与不存在各 40 次，中位数相差不到 5ms（同一条查询、同样的比较）', show({ ma, mb }));
  }
  // ---------- 放行 ----------
  {
    const own = await save(srv, 1, { ...REMOTE, 'x-run-upload-token': TOK[1] });
    const admin = await save(srv, 2, { ...REMOTE, 'x-admin-token': ADMIN_TOKEN });
    const odooAdmin = await save(srv, 2, { ...REMOTE, cookie: `session_id=${SESSIONS.admin}` });
    const cli = await save(srv, 4, {});
    check(own.status === 200 && admin.status === 200 && odooAdmin.status === 200 && cli.status === 200,
      '放行：这个 run 自己的上传令牌、管理口令（同源）、身份来源的管理员、本机命令行', show({ own: own.status, admin: admin.status, odooAdmin: odooAdmin.status, cli: cli.status }));
    const done = await finish(srv, 1, { ...REMOTE, 'x-run-upload-token': TOK[1] });
    check(done.status === 200, '完成：带这个 run 的上传令牌能完成', show({ status: done.status, body: done.json }));
  }
  // ---------- 开建照旧开放：开建的人拿到凭据，能写自己的 run，写不了别人的 ----------
  {
    const created = await srv.call('POST', '/api/sop/runs', REMOTE, { slug: 'rw-sop', started_by: 'someone' });
    const id = created.json?.id, tok = created.json?.upload_token;
    const mine = await save(srv, id, { ...REMOTE, 'x-run-upload-token': tok });
    const others = await save(srv, 4, { ...REMOTE, 'x-run-upload-token': tok });
    check(created.status === 201 && !!tok && mine.status === 200 && others.status === 403,
      '开建照旧开放：开建的人拿到这个 run 的上传令牌，能写自己的，写不了别人的', show({ created: created.status, mine: mine.status, others: others.status }));
  }
  // ---------- 执行页换了浏览器：只有管理员能处理 ----------
  {
    const noLocal = await save(srv, 4, { ...REMOTE, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
    const fixByAdmin = await save(srv, 4, { ...REMOTE, 'x-admin-token': ADMIN_TOKEN });
    const finishByAdmin = await finish(srv, 4, { ...REMOTE, 'x-admin-token': ADMIN_TOKEN });
    check(noLocal.status === 403 && fixByAdmin.status === 200 && finishByAdmin.status === 200,
      '执行页换了浏览器（本地没存上传令牌）：保存 403；管理员能替他保存、完成', show({ noLocal: noLocal.status, fixByAdmin: fixByAdmin.status, finishByAdmin: finishByAdmin.status }));
  }
  // ---------- 执行页带上写凭据 ----------
  {
    const src = readFileSync(join(ROOT, 'server', 'src', 'sop-runner.ts'), 'utf8');
    check(/headers: writeHeaders\(\{ 'Content-Type': 'application\/json' \}\)/.test(src) && /\/finish', \{ method: 'POST', headers: writeHeaders\(\{\}\) \}/.test(src) && /h\['X-Run-Upload-Token'\] = runUploadToken/.test(src) && /status === 403/.test(src),
      '执行页的保存和完成都带 X-Run-Upload-Token，被拒时说清楚是换了浏览器、要找管理员');
  }
  await srv.stop();
  // ---------- 告警模式 ----------
  {
    const w = await boot('warn', { WM_SOP_RUN_WRITE: 'warn' });
    const r = await save(w, 1, REMOTE);
    await save(w, 1, { ...REMOTE, cookie: `session_id=${SESSIONS.alpha}` });
    await sleep(200);
    const lines = w.log().split('\n').filter((l) => l.includes('"source":"sop-run-write"'));
    const anonLine = lines.find((l) => l.includes('"caller":"anonymous"')), staffLine = lines.find((l) => l.includes('"caller":"login-not-admin"'));
    check(r.status === 200 && !!anonLine && !!staffLine && anonLine.includes('"route":"PUT /api/sop/runs/:id"') && !lines.some((l) => /"name"|\/runs\/1|session_id|fake-internal/.test(l)),
      '告警模式：照旧放行；按路由和调用方类别留痕（匿名、登录的非管理员分开），痕里没有正文、run 号和凭据', show({ status: r.status, lines: lines.length }));
    await w.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`sop-run-write-guard-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
