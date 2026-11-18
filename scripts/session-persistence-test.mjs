#!/usr/bin/env node
/**
 * 一次登录持续保持（server/src/session-policy.ts、services/login-session.ts 的 renewSession）：起隔离实例（NODE_ENV=test，只开站内账号），
 * 走浏览器的真实登录路径，拿到 wm_session 之后在库里把时间往回拨，模拟「过了几天」。
 *   〇、启动自检多一行 market.login-session.renewal-bounded（续期有界），造的合成数据整个回滚
 *   一、发会话：cookie 持久（Max-Age = 30 天）、HttpOnly、SameSite=Lax、Path=/、不带 Domain；https（经反代）时带 Secure；库里记下续期时刻和一年的上限
 *   二、滑动续期：不到一天不续（不发 Set-Cookie、库不动）；过了一天续一次（同一个值、Max-Age 回到 30 天），紧接着的请求又不续；页面和静态文件不续
 *   二b、Sec-Fetch-Site 是 cross-site、same-site 的请求不续；same-origin、none、没有这个头的照常续
 *   三、绝对上限：续期不超过登录时定下的上限；顶到上限之后不再续；旧会话（没有上限列）不被延长
 *   四、过期：滑动窗口里没来过，到期就掉，之后的请求续不回来
 *   五、立即失效，续期救不回来：登出、本人改密码、停用（恢复之后也要重新登录）
 *   六、收回授予：下一个请求就没有那份权限（会话还是那个人的）
 *   七、重启之后照样有效（同一个数据目录再起一个实例，旧 cookie 照认）
 *   八、口令登录的 wm_login 照旧 12 小时
 *   九、配置：缺省 30/365 天；WM_SESSION_TTL_MIN 单独设时当绝对上限、打弃用警告、自检多一行 warn「登录持久化未生效」；和新变量一起设时被忽略并警告；不合法、窗口大于上限拒绝启动
 *
 *   node scripts/session-persistence-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `session-persistence-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-session-persistence-admin';
const DAY = 86_400_000;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
let child = null, log = '', base = '';

async function start(extraEnv = {}, { expectFail = false, dir = data } = {}) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: dir, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base, ...extraEnv });
  log = '';
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (expectFail) { for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100); return child.exitCode; }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
  return 0;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 5000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** 浏览器：同源标记 + 自己的 cookie 罐；extra 是每个请求都带的头（比如经反代的 https） */
const browser = (extra = {}) => {
  const jar = new Map();
  const moved = new Map();
  const latest = (p) => { let q = p; for (let i = 0; i < 100 && moved.has(q); i++) q = moved.get(q); return q; };
  const go = async (method, path0, { form, json } = {}) => {
    const path = method === 'POST' ? latest(path0) : path0;
    const h = { 'sec-fetch-site': 'same-origin', origin: base, ...extra };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(new URL(path, base), { method, headers: h, body, redirect: 'manual' });
    const cookies = res.headers.getSetCookie?.() ?? [];
    for (const c of cookies) {
      const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    const act = /<form method="post" action="([^"]+)"/.exec(text)?.[1]?.replaceAll('&amp;', '&');
    if (method === 'POST' && act && act !== path) moved.set(path, act);
    let j = null; try { j = JSON.parse(text); } catch { /* 页面 */ }
    return { status: res.status, location: res.headers.get('location') ?? '', text, json: j, cookies };
  };
  return { go, jar };
};
const sessionSetCookie = (r) => r.cookies.find((c) => c.startsWith('wm_session='));
const maxAgeOf = (c) => Number(/max-age=(\d+)/i.exec(c ?? '')?.[1] ?? NaN);
const attrs = (c) => (c ?? '').split(';').slice(1).map((x) => x.trim().split('=')[0].toLowerCase());
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? '';
const adminCall = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

/** 建人并完整登录（临时密码先改成 pw）；返回浏览器和发会话那一下的 Set-Cookie */
async function signIn(username, pw, extra = {}) {
  const made = await adminCall('POST', '/api/local-accounts', { username, display_name: username });
  const temp = made.json?.temp_password ?? '';
  const b = browser(extra);
  const s0 = await b.go('GET', '/login/local?next=/');
  const form = s0.location ? new URL(s0.location).pathname + new URL(s0.location).search : '';
  let r = await b.go('POST', form, { form: { username, password: temp } });
  if (r.status === 200 && ticketOf(r.text)) r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: pw, confirm: pw } });
  let issued = null;
  if (r.status === 302) { const cb = await b.go('GET', new URL(r.location).pathname + new URL(r.location).search); issued = sessionSetCookie(cb); }
  return { b, issued, token: b.jar.get('wm_session') ?? '' };
}
const me = async (b) => (await b.go('GET', '/api/auth/me')).json;
const withDb = (fn) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 10_000 }); try { return fn(d); } finally { d.close(); } };
const shaHex = async (s) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
const row = async (token) => { const h = await shaHex(token); return withDb((d) => ({ ...d.prepare('SELECT created_at, expires_at, renewed_at, max_expires_at, revoked_at FROM market_sessions WHERE token_sha256 = ?').get(h) })); };
/** 把这个会话的时间往回拨：续期时刻、到期时刻（还有可选的上限）都减去 ms */
const rewind = async (token, ms, { cap } = {}) => { const h = await shaHex(token); withDb((d) => d.prepare(`UPDATE market_sessions SET renewed_at = renewed_at - ?, expires_at = expires_at - ?${cap === undefined ? '' : ', max_expires_at = ?'} WHERE token_sha256 = ?`).run(...[ms, ms, ...(cap === undefined ? [] : [cap]), h])); };

rmSync(OUT, { recursive: true, force: true });
for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
try {
  await start();

  console.log('〇、启动自检');
  {
    const h = await (await fetch(`${base}/api/health`)).json().catch(() => null);
    const rows = h?.self_probe?.rows ?? h?.startup_security?.rows ?? [];
    const row = rows.find((x) => x.id === 'market.login-session.renewal-bounded');
    const left = withDb((d) => d.prepare("SELECT COUNT(*) AS n FROM principals WHERE id LIKE 'user:~self-probe-%'").get().n + d.prepare("SELECT COUNT(*) AS n FROM market_sessions WHERE provider = 'self-probe'").get().n);
    check(row?.verdict === 'pass' && left === 0, '自检一行 market.login-session.renewal-bounded 通过；造的合成人和会话整个回滚，库里没留', { row, left, keys: Object.keys(h ?? {}) });
  }

  console.log('一、发会话');
  const A = await signIn('alice', 'Alice-pass-0001');
  const ra = await row(A.token);
  check(!!A.issued && near(maxAgeOf(A.issued), 30 * 86400, 120) && /HttpOnly/i.test(A.issued) && /SameSite=Lax/i.test(A.issued) && /Path=\//i.test(A.issued) && !attrs(A.issued).includes('domain') && !attrs(A.issued).includes('secure'),
    '登录发的 wm_session 是持久 cookie：Max-Age 30 天、HttpOnly、SameSite=Lax、Path=/、不带 Domain（http 下不带 Secure）', A.issued);
  check(ra.renewed_at === ra.created_at && near(ra.expires_at - ra.created_at, 30 * DAY, 1000) && near(ra.max_expires_at - ra.created_at, 365 * DAY, 1000),
    '库里：续期时刻 = 登录时刻，到期 = 登录 + 30 天，上限 = 登录 + 365 天（毫秒整数列）', ra);
  check((await me(A.b))?.principal === 'user:alice', '认出是 alice');
  const H = await signIn('hana', 'Hana-pass-0001', { 'x-forwarded-proto': 'https' });
  check(!!H.issued && attrs(H.issued).includes('secure'), '经反代的 https：cookie 带 Secure', H.issued);

  console.log('二、滑动续期');
  let r = await A.b.go('GET', '/api/auth/me');
  const before = await row(A.token);
  check(!sessionSetCookie(r) && before.expires_at === ra.expires_at && before.renewed_at === ra.renewed_at, '不到一天：不续（不发 Set-Cookie、库不动）', { set: sessionSetCookie(r), before });
  await rewind(A.token, 2 * DAY);
  const t0 = Date.now();
  r = await A.b.go('GET', '/api/auth/me');
  const after = await row(A.token);
  const sc = sessionSetCookie(r);
  check(!!sc && sc.startsWith(`wm_session=${A.token};`) && near(maxAgeOf(sc), 30 * 86400, 120) && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//i.test(sc),
    '过了一天：续一次——同一个值，Max-Age 回到 30 天，属性不变', sc);
  check(near(after.expires_at, t0 + 30 * DAY, 5000) && near(after.renewed_at, t0, 5000) && after.max_expires_at === ra.max_expires_at, '库里：到期顺延到现在 + 30 天，续期时刻是现在，上限不动', after);
  r = await A.b.go('GET', '/api/auth/me');
  check(!sessionSetCookie(r) && (await row(A.token)).renewed_at === after.renewed_at, '刚续过：紧接着的请求不再续');
  await rewind(A.token, 2 * DAY);
  const page = await A.b.go('GET', '/');
  check(!sessionSetCookie(page) && (await row(A.token)).renewed_at === after.renewed_at - 2 * DAY, '页面（非 /api/）的应答不续、不带 Set-Cookie', { set: sessionSetCookie(page) });

  console.log('二b、别的站点发来的请求不续');
  {
    const I = await signIn('iris', 'Iris-pass-00001');
    const hit = async (site) => {
      await rewind(I.token, 2 * DAY);
      const before = (await row(I.token)).renewed_at;
      const h = { cookie: `wm_session=${I.token}` };
      if (site !== undefined) h['sec-fetch-site'] = site;
      const res = await fetch(new URL('/api/auth/me', base), { headers: h });
      await res.text();
      const set = (res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('wm_session='));
      return { set, renewed: (await row(I.token)).renewed_at !== before };
    };
    const out = {};
    for (const site of ['cross-site', 'same-site', 'same-origin', 'none', undefined]) out[String(site)] = await hit(site);
    check(!out['cross-site'].set && !out['cross-site'].renewed && !out['same-site'].set && !out['same-site'].renewed,
      'Sec-Fetch-Site 是 cross-site、same-site：不续、不发 Set-Cookie（别的站点不能替人续命）', out);
    check(out['same-origin'].set && out['same-origin'].renewed && out.none.set && out.none.renewed && out.undefined.set && out.undefined.renewed,
      'same-origin、none、没有这个头（命令行、老浏览器）：照常续', out);
  }

  console.log('三、绝对上限');
  {
    const cap = Date.now() + 5 * DAY;
    { const h = await shaHex(A.token); withDb((d) => d.prepare('UPDATE market_sessions SET expires_at = ?, renewed_at = ?, max_expires_at = ? WHERE token_sha256 = ?').run(Date.now() + DAY, Date.now() - 2 * DAY, cap, h)); }
    r = await A.b.go('GET', '/api/auth/me');
    const c = await row(A.token);
    check(c.expires_at === cap && near(maxAgeOf(sessionSetCookie(r)), 5 * 86400, 120), '续期不超过上限：到期 = 上限，Max-Age 约 5 天', { c, set: sessionSetCookie(r) });
    await rewind(A.token, 2 * DAY, { cap: c.expires_at - 2 * DAY }); // 到期正好在上限上
    r = await A.b.go('GET', '/api/auth/me');
    check(!sessionSetCookie(r), '已经顶到上限：不再续', sessionSetCookie(r));
    // 旧会话（升级前发的，没有上限列）：不被延长
    const h = await shaHex(A.token);
    const oldExp = Date.now() + 3 * DAY;
    withDb((d) => d.prepare('UPDATE market_sessions SET max_expires_at = NULL, renewed_at = NULL, created_at = ?, expires_at = ? WHERE token_sha256 = ?').run(Date.now() - 9 * DAY, oldExp, h));
    r = await A.b.go('GET', '/api/auth/me');
    check(!sessionSetCookie(r) && (await row(A.token)).expires_at === oldExp && (await me(A.b))?.principal === 'user:alice', '旧会话（没有上限、续期列）：照认，但不被延长', await row(A.token));
  }

  console.log('四、过期');
  {
    const B = await signIn('bob', 'Bob-pass-00001');
    const h = await shaHex(B.token);
    withDb((d) => d.prepare('UPDATE market_sessions SET expires_at = ?, renewed_at = ? WHERE token_sha256 = ?').run(Date.now() - 1000, Date.now() - 31 * DAY, h));
    r = await B.b.go('GET', '/api/auth/me');
    const b = await row(B.token);
    check(r.json?.authenticated !== true && !sessionSetCookie(r) && b.expires_at < Date.now(), '30 天没来过：到期就掉，续不回来（不发 Set-Cookie、库里到期不动）', { me: r.json, b });
  }

  console.log('五、立即失效，续期救不回来');
  {
    const C = await signIn('carol', 'Carol-pass-0001');
    const out = await C.b.go('POST', '/api/auth/logout', { json: {} });
    const again = browser(); again.jar.set('wm_session', C.token);
    await rewind(C.token, 2 * DAY);
    r = await again.go('GET', '/api/auth/me');
    const c = await row(C.token);
    check(out.status === 200 && r.json?.authenticated !== true && !sessionSetCookie(r) && c.revoked_at !== null && c.renewed_at < Date.now() - DAY,
      '登出：同一个 cookie 再来认不出；过了一天也续不回来（库里续期时刻不动）', { me: r.json, c });

    const D = await signIn('dave', 'Dave-pass-00001');
    const chg = await D.b.go('POST', '/api/local-accounts/_self/password', { json: { current: 'Dave-pass-00001', next: 'Dave-pass-00002' } });
    const old = browser(); old.jar.set('wm_session', D.token);
    await rewind(D.token, 2 * DAY);
    r = await old.go('GET', '/api/auth/me');
    check(chg.status === 200 && r.json?.authenticated !== true && !sessionSetCookie(r) && (await row(D.token)).revoked_at !== null, '本人改密码：改之前的会话立即失效，续不回来', { chg: chg.status, me: r.json });

    const E = await signIn('erin', 'Erin-pass-00001');
    const dis = await adminCall('POST', '/api/principals/disable', { id: 'user:erin', reason: '合成' });
    await rewind(E.token, 2 * DAY);
    r = await E.b.go('GET', '/api/auth/me');
    const res = await adminCall('POST', '/api/principals/restore', { id: 'user:erin', reason: '合成' });
    const r2 = await E.b.go('GET', '/api/auth/me');
    check(dis.status === 200 && r.json?.authenticated !== true && !sessionSetCookie(r) && res.status === 200 && r2.json?.authenticated !== true && !sessionSetCookie(r2),
      '停用：会话立即失效、续不回来；恢复之后旧会话也不活过来（要重新登录）', { dis: dis.status, me: r.json, res: res.status, me2: r2.json });
  }

  console.log('六、收回授予');
  {
    const F = await signIn('fay', 'Fay-pass-000001');
    const g = await adminCall('POST', '/api/grants', { principal: 'user:fay', role: 'admin', scope: '*', reason: '合成' });
    const gid = g.json?.id ?? g.json?.grant?.id;
    await adminCall('POST', `/api/grants/${gid}/submit`, { reason: '合成' });
    const ap = await adminCall('POST', `/api/grants/${gid}/approve`, { reason: '合成' });
    const w1 = await F.b.go('GET', '/api/admin/whoami');
    const rv = await adminCall('POST', `/api/grants/${gid}/revoke`, { reason: '合成' });
    await rewind(F.token, 2 * DAY);
    const w2 = await F.b.go('GET', '/api/admin/whoami');
    const m2 = await me(F.b);
    check(ap.status === 200 && w1.json?.admin === true && rv.status === 200 && w2.json?.admin === false && m2?.principal === 'user:fay',
      '收回授予：下一个请求就不是管理员（续期也给不回来）；会话还是 fay 的', { g: [g.status, gid], ap: ap.status, w1: w1.json, rv: rv.status, w2: w2.json, me: m2?.principal });
  }

  console.log('七、重启之后照样有效');
  {
    const G = await signIn('gus', 'Gus-pass-000001');
    await stop();
    await start();
    const kept = browser(); kept.jar.set('wm_session', G.token);
    const m = await me(kept);
    check(m?.principal === 'user:gus' && m.via === 'session', '同一个数据目录重启之后，旧 cookie 照认', m);
  }

  console.log('八、口令登录的 wm_login 照旧 12 小时');
  {
    const b = browser();
    const lg = await b.go('POST', '/api/auth/login', { json: { token: ADMIN_TOKEN } });
    const c = lg.cookies.find((x) => x.startsWith('wm_login='));
    check(lg.status === 200 && near(maxAgeOf(c), 12 * 3600, 60), 'wm_login 的 Max-Age 是 12 小时', { status: lg.status, c });
  }
  await stop();

  console.log('九、配置');
  {
    const d2 = join(OUT, 'data-ttl'); mkdirSync(d2, { recursive: true });
    await start({ WM_SESSION_TTL_MIN: '60' }, { dir: d2 });
    check(/WM_SESSION_TTL_MIN 已弃用/.test(log), '只设 WM_SESSION_TTL_MIN：启动打弃用警告', log.slice(-300));
    {
      const h = await (await fetch(`${base}/api/health`)).json().catch(() => null);
      const p = (h?.self_probe?.rows ?? h?.startup_security?.rows ?? []).find((x) => x.id === 'market.login-session.persistence');
      check(p?.verdict === 'warn' && p.reason === 'persistence-off-legacy-ttl-min' && /登录持久化未生效/.test(log) && h?.self_probe?.passed !== false,
        '只设 WM_SESSION_TTL_MIN：启动自检多一行 warn「登录持久化未生效」（不拒绝启动）', { p, passed: h?.self_probe?.passed });
    }
    const T = await signIn('tina', 'Tina-pass-00001');
    check(near(maxAgeOf(T.issued), 3600, 60), '只设 WM_SESSION_TTL_MIN=60：当绝对上限，cookie 一小时', T.issued);
    await stop();
    const d3 = join(OUT, 'data-both'); mkdirSync(d3, { recursive: true });
    await start({ WM_SESSION_TTL_MIN: '60', WM_SESSION_IDLE_DAYS: '7', WM_SESSION_MAX_DAYS: '90' }, { dir: d3 });
    check(/WM_SESSION_TTL_MIN 已弃用.*忽略/.test(log), '新旧一起设：旧的被忽略并警告', log.slice(-300));
    {
      const h = await (await fetch(`${base}/api/health`)).json().catch(() => null);
      check(!(h?.self_probe?.rows ?? []).some((x) => x.id === 'market.login-session.persistence'), '新变量设着（持久化生效）：没有那一行 warn', h?.self_probe?.rows?.map((x) => x.id));
    }
    const U = await signIn('ugo', 'Ugo-pass-000001');
    check(near(maxAgeOf(U.issued), 7 * 86400, 120), '新变量生效：WM_SESSION_IDLE_DAYS=7 → cookie 7 天', U.issued);
    await stop();
    const bad = [];
    for (const env of [{ WM_SESSION_IDLE_DAYS: '400' }, { WM_SESSION_IDLE_DAYS: 'x' }, { WM_SESSION_MAX_DAYS: '0' }, { WM_SESSION_IDLE_DAYS: '10', WM_SESSION_MAX_DAYS: '5' }, { WM_SESSION_TTL_MIN: '5' }]) {
      const dd = join(OUT, `data-bad-${bad.length}`); mkdirSync(dd, { recursive: true });
      const code = await start(env, { expectFail: true, dir: dd });
      bad.push([JSON.stringify(env), code, /拒绝启动/.test(log)]);
      await stop();
    }
    check(bad.every(([, code, said]) => code !== null && code !== 0 && said), '不合法（越界、不是整数、窗口大于上限、旧变量越界）：拒绝启动并说明', bad);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  await stop();
  await sleep(300);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`session-persistence-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
