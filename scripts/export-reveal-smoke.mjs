#!/usr/bin/env node
/**
 * 导出真值要求管理员的对抗组（安全面）：GET /api/export?reveal=1。真实的 server/src/index.ts，身份来源是假提供方
 * （identity-fake-provider.mjs，只在 127.0.0.1 上，不访问任何外部系统）。台里放合成的密钥，逐条看应答正文里有没有它。
 *
 *   拒绝例（都必须 403 或登录门的 401，正文里没有真值，也不降级成掩码的 200）：
 *     匿名（本机直连、带转发头的远程）；口令不对；口令对但浏览器从别的站点发来；管理员登录但跨站；
 *     登录的非管理员；管理员登录但主体被停用；路径换大小写；登录门开着时的远程匿名、登录的非管理员。
 *   合法对照：口令管理员（本机、远程）、管理员登录同源，能取到真值；不带 reveal 的导出照旧掩码、谁都能取。
 *
 *   node scripts/export-reveal-smoke.mjs              测本仓库
 *   node scripts/export-reveal-smoke.mjs --root DIR   测另一棵目录树
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `export-reveal-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-export-reveal-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.41' };
// 合成的密钥：查询串里的、bearer 凭据的值
const SECRET_QUERY = 'synthetic-query-secret-7f3a';
const SECRET_BEARER = 'synthetic-bearer-secret-9c1d';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const leaks = (text) => text.includes(SECRET_QUERY) || text.includes(SECRET_BEARER);

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
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, name, 'ext'), ...extraEnv });
  mkdirSync(env.WM_EXTENSIONS_DIR, { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40000;
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => {
    if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); }
    if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); }
  };
  if (!ready) { await stop(); throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`); }
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, text, json, cache: res.headers.get('cache-control') ?? '' };
    } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null, cache: '' }; }
  };
  const host = new URL(base).host;
  const srv = { name, base, host, stop, call };
  running.push(srv);
  return srv;
}

/** 布置现场：一个带密钥的台（本机 CLI 写，免口令） */
async function seed(srv) {
  const r = await srv.call('POST', '/api/workbenches', { body: { name: '合成·带密钥', url: `http://127.0.0.1:9/q?token=${SECRET_QUERY}&x=1`, type: 'web', auth: { type: 'bearer', value: SECRET_BEARER } } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`布置现场失败：${r.status} ${r.text.slice(0, 200)}`);
}

const denied = (r, want = 403) => r.status === want && !leaks(r.text) && r.json?.masked === undefined;
const revealed = (r) => r.status === 200 && r.json?.masked === 0 && leaks(r.text) && r.cache.includes('no-store');

try {
  // ---------- 一、登录门关着 ----------
  {
    const open = await boot('open');
    await seed(open);
    // 让假提供方认出的几个人先进主体表（管理员、非管理员）
    for (const s of [SESSIONS.admin, SESSIONS.alpha]) await open.call('GET', '/api/auth/viewer', { session: s });
    const same = { origin: `http://${open.host}`, 'sec-fetch-site': 'same-origin' };
    const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };

    const cases = [
      ['匿名（本机直连）', await open.call('GET', '/api/export?reveal=1')],
      ['匿名（带转发头的远程）', await open.call('GET', '/api/export?reveal=1', { headers: REMOTE })],
      ['口令不对', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': 'nope' } })],
      ['口令对，但浏览器从别的站点发来', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...cross, 'x-admin-token': ADMIN_TOKEN } })],
      ['管理员登录，但浏览器从别的站点发来', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...cross }, session: SESSIONS.admin })],
      ['登录的非管理员（同源）', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha })],
      ['路径换大小写的匿名', await open.call('GET', '/API/Export?reveal=1', { headers: REMOTE })],
      ['只带 Origin 的跨站（没有 Sec-Fetch-Site）、口令对', await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, origin: 'https://elsewhere.example', 'x-admin-token': ADMIN_TOKEN } })],
    ];
    const bad = cases.filter(([, r]) => !denied(r)).map(([label, r]) => [label, r.status, leaks(r.text)]);
    check(bad.length === 0, `登录门关着，取真值的拒绝例（${cases.length} 种）：都 403，正文里没有真值，也没降级成掩码的导出`, show(bad));

    // 管理员登录的主体被停用：用口令管理员停掉它，再拿它的会话来取
    const before = await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: SESSIONS.admin });
    const off = await open.call('POST', '/api/principals/disable', { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { id: 'user:root-admin', reason: '合成：对抗例' } });
    const after = await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: SESSIONS.admin });
    check(revealed(before) && off.status === 200 && denied(after),
      '管理员登录的主体被停用：停用之前同源能取，停用之后 403、正文里没有真值', show({ before: before.status, off: off.status, after: [after.status, leaks(after.text)] }));
    await open.call('POST', '/api/principals/restore', { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { id: 'user:root-admin' } });

    // 合法对照
    const local = await open.call('GET', '/api/export?reveal=1', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const remote = await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    const session = await open.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: SESSIONS.admin });
    check(revealed(local) && revealed(remote) && revealed(session),
      '对照：口令管理员（本机、远程）和管理员登录（同源）能取到真值，应答不进缓存', show({ local: local.status, remote: remote.status, session: session.status }));

    // 不带 reveal、reveal 不是 1：照旧掩码，谁都能取（行为不变）
    const masked = await open.call('GET', '/api/export', { headers: REMOTE });
    const other = await open.call('GET', '/api/export?reveal=true', { headers: REMOTE });
    const twice = await open.call('GET', '/api/export?reveal=1&reveal=1', { headers: REMOTE });
    check(masked.status === 200 && masked.json?.masked === 1 && !leaks(masked.text) && other.status === 200 && other.json?.masked === 1 && !leaks(other.text)
      && twice.status === 200 && twice.json?.masked === 1 && !leaks(twice.text),
      '不带 reveal、reveal=true、reveal 给了两次：照旧掩码导出（200、masked=1、没有真值），和改之前一样', show({ masked: masked.status, other: other.status, twice: twice.status }));
    await open.stop();
  }

  // ---------- 二、登录门开着 ----------
  {
    const gated = await boot('gated', { WM_LOGIN_GATE: 'enforce' });
    await seed(gated);
    await gated.call('GET', '/api/auth/viewer', { session: SESSIONS.alpha });
    const same = { origin: `http://${gated.host}`, 'sec-fetch-site': 'same-origin' };
    const anon = await gated.call('GET', '/api/export?reveal=1', { headers: REMOTE });
    const member = await gated.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha });
    const memberMasked = await gated.call('GET', '/api/export', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha });
    const token = await gated.call('GET', '/api/export?reveal=1', { headers: { ...REMOTE, 'x-admin-token': ADMIN_TOKEN } });
    check(anon.status === 401 && !leaks(anon.text) && denied(member) && memberMasked.status === 200 && memberMasked.json?.masked === 1 && !leaks(memberMasked.text) && revealed(token),
      '登录门开着：远程匿名 401；登录的非管理员取真值 403（掩码导出照旧能取）；对照：口令管理员能取', show({ anon: anon.status, member: member.status, memberMasked: memberMasked.status, token: token.status }));
    await gated.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`export-reveal-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
