#!/usr/bin/env node
/**
 * 一人一助理第 1 期 PR 3（确认门）补充的对抗用例草稿：和登录持久化（滑动续期、登录门的 next）放在一起看。
 * 设计见 docs/assistant-phase1.md 第三节、第十一节；用例清单见统筹共享笔记 assistant-phase1-prep.md 第三节。
 * 这是**测试草稿**：先在没实现的 main 上跑，应当全红（助理令牌和确认接口都还不存在）；PR 3 实现之后全绿。
 * 用例的编号和设计第九节的 C1～C26 接着排，PR 3 开工时并进 scripts/assistant-confirm-test.mjs。
 *
 *   C27 本人的会话续期过之后（库里把续期时刻往回拨），打开确认、提交确认 → 成功，执行了一次
 *   C28 登出之后打开确认链接 → 登录门送去登录页，next 指回这一条；登录完回到这一条，能确认
 *   C29 跨站来源带着本人 cookie 读确认 → 403 cross_site，不返回内容，也不续期
 *
 * 起实例：NODE_ENV=test、WM_TEST_FIXTURES=1、WM_ASSISTANT=on、登录门 enforce（C28 要它）；只开站内账号。
 *
 *   node scripts/assistant-confirm-extra-test.mjs
 */
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `assistant-confirm-extra-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-assistant-confirm-admin';
const DAY = 86_400_000;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
let child = null, log = '', base = '';
async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', WM_TEST_FIXTURES: '1', WM_ASSISTANT: 'on', WM_LOGIN_GATE: 'enforce',
    MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** 浏览器：自己的 cookie 罐；site 是这一路请求标的 Sec-Fetch-Site（缺省同源） */
const browser = () => {
  const jar = new Map();
  const moved = new Map();
  const latest = (p) => { let q = p; for (let i = 0; i < 100 && moved.has(q); i++) q = moved.get(q); return q; };
  const go = async (method, path0, { form, json, site = 'same-origin', origin = base, accept, extra = {} } = {}) => {
    const path = method === 'POST' ? latest(path0) : path0;
    const h = { ...(site ? { 'sec-fetch-site': site } : {}), ...(origin ? { origin } : {}), ...(accept ? { accept } : {}), ...extra };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(new URL(path, base), { method, headers: h, body, redirect: 'manual' });
    const cookies = res.headers.getSetCookie?.() ?? [];
    for (const c of cookies) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1); if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') jar.delete(k); else jar.set(k, v); }
    const text = await res.text();
    const act = /<form method="post" action="([^"]+)"/.exec(text)?.[1]?.replaceAll('&amp;', '&');
    if (method === 'POST' && act && act !== path) moved.set(path, act);
    let j = null; try { j = JSON.parse(text); } catch { /* 页面 */ }
    return { status: res.status, location: res.headers.get('location') ?? '', text, json: j, cookies };
  };
  return { go, jar };
};
const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? '';
const admin = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: json === undefined ? undefined : JSON.stringify(json) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
/** 用浏览器 b 走一遍站内账号登录；next 是登录完回哪儿。返回回调的应答 */
async function login(b, username, password, newPw, next = '/') {
  const s0 = await b.go('GET', `/login/local?next=${encodeURIComponent(next)}`);
  const form = s0.location ? new URL(s0.location, base).pathname + new URL(s0.location, base).search : '';
  let r = await b.go('POST', form, { form: { username, password } });
  if (r.status === 200 && ticketOf(r.text)) r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: newPw, confirm: newPw } });
  if (r.status !== 302) return r;
  return b.go('GET', new URL(r.location, base).pathname + new URL(r.location, base).search);
}
const withDb = (fn) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 10_000 }); try { return fn(d); } finally { d.close(); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** 助理调一次测试工具，拿回「待你确认」的编号 */
async function bump(token) {
  const r = await fetch(new URL('/mcp', base), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test_counter_bump', arguments: {} } }) });
  const j = await r.json().catch(() => null);
  return j?.result?.structuredContent?.confirm_id ?? null;
}
const confirmBody = { answer: 'confirm', typed: '确认' };

rmSync(OUT, { recursive: true, force: true });
for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
try {
  await start();
  const made = await admin('POST', '/api/local-accounts', { username: 'alice', display_name: 'Synthetic alice' });
  const A = browser();
  await login(A, 'alice', made.json?.temp_password ?? '', 'Alice-pass-0001');
  const tok = await A.go('POST', '/api/assistant/token', { json: {} });
  const token = tok.json?.token ?? '';
  check(made.status === 201 && A.jar.has('wm_session') && tok.status === 200 && /^wma_/.test(token), '前提：alice 登录，取到助理令牌', { made: made.status, session: A.jar.has('wm_session'), tok: tok.status });

  console.log('C27 续期之后照样能确认');
  {
    const id = await bump(token);
    const h = sha(A.jar.get('wm_session') ?? '');
    withDb((d) => d.prepare('UPDATE market_sessions SET renewed_at = renewed_at - ?, expires_at = expires_at - ? WHERE token_sha256 = ?').run(2 * DAY, 2 * DAY, h));
    const g = await A.go('GET', `/api/assistant/confirms/${id}`);
    const renewed = g.cookies.some((c) => c.startsWith('wm_session='));
    const p = await A.go('POST', `/api/assistant/confirms/${id}`, { json: confirmBody });
    check(!!id && g.status === 200 && renewed && p.status === 200 && p.json?.status === 'done', 'C27 会话刚被续期（应答带了新的 Set-Cookie）：读得到这一条，确认执行成功', { id, get: g.status, renewed, post: [p.status, p.json?.status] });
  }

  console.log('C28 登出之后打开确认链接');
  {
    const id = await bump(token);
    await A.go('POST', '/api/auth/logout', { json: {} });
    const page = await A.go('GET', `/assistant/confirm/${id}`, { accept: 'text/html', site: 'none', origin: null });
    const loc = page.location ? new URL(page.location, base) : null;
    const nextBack = loc?.pathname === '/login' && loc.searchParams.get('next') === `/assistant/confirm/${id}`;
    const back = await login(A, 'alice', 'Alice-pass-0001', 'unused-not-asked', `/assistant/confirm/${id}`);
    const landed = back.status === 302 && new URL(back.location, base).pathname === `/assistant/confirm/${id}`;
    const p = await A.go('POST', `/api/assistant/confirms/${id}`, { json: confirmBody });
    check(!!id && nextBack && landed && p.json?.status === 'done', 'C28 登出后打开确认页：去登录页、next 指回这一条；登录完回到这一条，能确认', { id, page: [page.status, page.location], landed: [back.status, back.location], post: [p.status, p.json?.status] });
  }

  console.log('C29 跨站读确认');
  {
    const id = await bump(token);
    const h = sha(A.jar.get('wm_session') ?? '');
    withDb((d) => d.prepare('UPDATE market_sessions SET renewed_at = renewed_at - ?, expires_at = expires_at - ? WHERE token_sha256 = ?').run(2 * DAY, 2 * DAY, h));
    const before = withDb((d) => d.prepare('SELECT renewed_at FROM market_sessions WHERE token_sha256 = ?').get(h)?.renewed_at);
    const x = await A.go('GET', `/api/assistant/confirms/${id}`, { site: 'cross-site', origin: 'https://elsewhere.invalid' });
    const after = withDb((d) => d.prepare('SELECT renewed_at FROM market_sessions WHERE token_sha256 = ?').get(h)?.renewed_at);
    const leaked = JSON.stringify(x.json ?? {}).includes('description');
    check(!!id && x.status === 403 && x.json?.error === 'cross_site' && !leaked && !x.cookies.some((c) => c.startsWith('wm_session=')) && after === before,
      'C29 跨站带着本人 cookie 读确认：403 cross_site，不给描述，也不续期', { id, status: x.status, error: x.json?.error, leaked, renewed: after !== before });
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  await stop();
  await sleep(300);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`assistant-confirm-extra-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
