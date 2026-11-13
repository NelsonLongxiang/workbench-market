#!/usr/bin/env node
/**
 * Odoo 用户登录后由市场维持会话（登录门 enforce）的对抗组。全部在 127.0.0.1：Odoo 替身 + 一个隔离的市场实例，人和会话号都是合成的。
 * 「浏览器」是按 Max-Age 管 cookie 的小 cookie 罐，同一主机名不分端口（和真浏览器一样）；Odoo 替身发给浏览器的 session_id 只活 4 秒。
 *
 *   一、Odoo 认出来以后发市场会话：wm_session 的属性和管理口令登录的 wm_login 一致（HttpOnly、SameSite=Lax、Path=/、https 时 Secure），
 *       期限是 WM_SESSION_TTL_MIN；库里存的 Odoo 会话号是加密的（看不出原文），密钥文件权限 600
 *   二、浏览器里的 Odoo cookie 过期以后，市场照样认得出（经市场会话，照旧回 Odoo 核）；Odoo 管理员照旧是管理员，普通员工不是
 *   三、换了账号：浏览器带来的 Odoo 会话号和存下的不是同一个——旧的市场会话注销，按新带来的认
 *   四、Odoo 那边注销以后，缓存过期后的下一次请求被拒（401），市场会话注销、存下的会话号清掉，之后一直 401
 *   五、Odoo 不可达：回 502，不注销市场会话（失败关闭，恢复后照旧）
 *   六、停用主体：立即 401，存下的会话号清掉
 *   七、库里存的密文被改过：解不开，当场注销，401
 *   八、登出：市场会话注销，存下的会话号清掉
 *   九、会话号不出现在任何应答（体和头）和日志里；启动自检多一行且通过
 *   十、Odoo 软轮换：核验应答里换了会话号（前 42 个字符不变），市场当场换掉存下的号，之后照样认得出。替身照 Odoo 19 的规矩：
 *       旧号还能用、每次都回 Set-Cookie 指向新号；新号被用过、再过宽限期（Odoo 120 秒，这里压到 2 秒）旧号才失效：
 *       发会话那次就轮换的、过了缓存期第二次核验时轮换的，都跟得上；浏览器手上还拿着旧号时也不误判成换了账号
 *   十一、诊断：每次 Odoo 核验失败、每次市场会话被注销都记一行，写原因类别（rejected、http-5xx、network、replaced、undecryptable……），不带会话号、登录名和主体
 *
 *   node scripts/odoo-market-session-test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'odoo-market-session-synthetic-admin';
const ODOO_MAX_AGE = 4;
const TTL_MIN = 720;

// ---------- Odoo 替身：服务端会话不过期（get_session_info 每次 touch、回 Set-Cookie），发给浏览器的 cookie Max-Age 很短 ----------
const GRACE_MS = 2000;
const users = { a: { admin: false }, b: { admin: false }, c: { admin: false }, d: { admin: false }, e: { admin: false }, f: { admin: false }, g: { admin: false }, r: { admin: false }, s: { admin: false }, boss: { admin: true } };
const sessions = new Map(); // sid -> login
const downSids = new Set();
const dropSids = new Set(); // 这些会话号来核验时直接断开连接（网络不通）
const allSids = [];
const rotated = new Map(); // login -> 轮换后的号
const oldOf = new Map(); // 轮换前的旧号 -> { next, newUsedAt }
const rotateAt = new Map([['r', 1], ['s', 2]]); // 这个人的第几次核验时轮换
const calls = new Map(); // login -> 核验次数
const asked = new Set(); // 市场拿来问过的会话号
const odoo = createServer((req, res) => {
  const sid = /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
  const setSid = (v) => res.setHeader('set-cookie', `session_id=${v}; Max-Age=${ODOO_MAX_AGE}; Path=/; HttpOnly`);
  const login = /^\/web\/login\/([a-z]+)$/.exec(String(req.url))?.[1];
  if (login && req.method === 'POST') {
    const fresh = 'oms' + randomBytes(24).toString('hex');
    sessions.set(fresh, login); allSids.push(fresh);
    setSid(fresh);
    return res.end('ok');
  }
  if (req.url === '/web/session/get_session_info') {
    asked.add(sid);
    if (dropSids.has(sid)) { req.socket.destroy(); return; }
    if (downSids.has(sid)) { res.statusCode = 500; return res.end('synthetic outage'); }
    res.setHeader('content-type', 'application/json');
    const who = sessions.get(sid);
    const ok = () => res.end(JSON.stringify({ jsonrpc: '2.0', id: null, result: { uid: 100 + Object.keys(users).indexOf(who), username: `oms.${who}`, name: `Synthetic ${who}`, is_internal_user: true, is_admin: users[who].admin } }));
    if (!who) return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } }));
    // 新号第一次被用：记下来，宽限期从这里算
    for (const [old, r] of oldOf) if (r.next === sid && !r.newUsedAt) r.newUsedAt = Date.now();
    const alias = oldOf.get(sid);
    if (alias) {
      // 轮换前的旧号：新号用过、宽限期过了就失效；之前照样认，应答里指向新号
      if (alias.newUsedAt && Date.now() - alias.newUsedAt > GRACE_MS) { sessions.delete(sid); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 100, message: 'Odoo Session Expired' } })); }
      setSid(alias.next); return ok();
    }
    const n = (calls.get(who) ?? 0) + 1; calls.set(who, n);
    if (rotateAt.get(who) === n) {
      const next = sid.slice(0, 42) + randomBytes(16).toString('hex'); // 软轮换：前 42 个字符不变，后半段换掉
      sessions.set(next, who); allSids.push(next); rotated.set(who, next); oldOf.set(sid, { next, newUsedAt: 0 });
      setSid(next); return ok();
    }
    setSid(sid);
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, result: { uid: 100 + Object.keys(users).indexOf(who), username: `oms.${who}`, name: `Synthetic ${who}`, is_internal_user: true, is_admin: users[who].admin } }));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => odoo.listen(0, '127.0.0.1', r));
const ODOO = `http://127.0.0.1:${odoo.address().port}`;

// ---------- 市场 ----------
mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp', 'odoo-market-session-'));
const PORT = 21000 + Math.floor(Math.random() * 11000);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: DATA, NODE_ENV: 'test', REDIS_URL: '', LAYERFS_SERVICE_URL: '',
    WM_LOGIN_GATE: 'enforce', MCP_GATEWAY: 'off', ADMIN_TOKEN: ADMIN, WM_ODOO_URL: ODOO, WM_ODOO_ORIGINS: ODOO, WM_SESSION_TTL_MIN: String(TTL_MIN) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
const B = `http://127.0.0.1:${PORT}`;
const seen = []; // 所有应答（头和体），最后查会话号有没有漏出去

function browser({ https = false } = {}) {
  const jar = new Map();
  const header = () => [...jar].filter(([, c]) => c.exp > Date.now()).map(([k, c]) => `${k}=${c.value}`).join('; ');
  const take = (res) => {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const sc of raw) {
      const [kv, ...attrs] = sc.split(';').map((x) => x.trim());
      const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
      const ma = attrs.find((x) => /^max-age=/i.test(x));
      const exp = ma ? Date.now() + Number(ma.split('=')[1]) * 1000 : Infinity;
      if (exp <= Date.now() || v === '') jar.delete(k); else jar.set(k, { value: v, exp });
    }
    return raw;
  };
  const go = async (url, init = {}) => {
    const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'x-forwarded-for': '198.51.100.30', 'sec-fetch-site': 'same-origin', ...(https ? { 'x-forwarded-proto': 'https' } : {}), ...(init.headers ?? {}), cookie: header() } });
    const setCookies = take(res);
    const text = await res.text();
    if (url.startsWith(B)) seen.push(JSON.stringify([...res.headers]) + text);
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json, text, setCookies };
  };
  return {
    go,
    login: async (who) => { await go(`${ODOO}/web/login/${who}`, { method: 'POST' }); },
    has: (k) => { const c = jar.get(k); return !!c && c.exp > Date.now(); },
    get: (k) => jar.get(k)?.value,
    api: (path = '/api/departments', init) => go(B + path, init),
  };
}
const dbq = (sql, ...args) => { const d = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 }); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
const dbx = (sql, ...args) => { const d = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 }); try { return d.prepare(sql).run(...args); } finally { d.close(); } };
const rowsOf = (principal) => dbq('SELECT revoked_at, upstream_sealed FROM market_sessions WHERE principal_id = ? ORDER BY created_at', principal);
const attrs = (sc) => sc.split(';').slice(1).map((x) => x.trim().split('=')[0].toLowerCase()).sort();

try {
  let ready = false;
  for (const end = Date.now() + 40000; !ready && Date.now() < end && child.exitCode === null;) {
    try { ready = (await fetch(B + '/api/health')).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error('市场没起来：' + log.slice(-800));

  // ---------- 一、发市场会话 ----------
  const A = browser(), Bh = browser({ https: true }), Boss = browser(), D = browser(), E = browser(), F = browser();
  const G = browser(), R = browser(), S = browser();
  for (const [br, who] of [[A, 'a'], [Bh, 'b'], [Boss, 'boss'], [D, 'd'], [E, 'e'], [F, 'f'], [G, 'g'], [R, 'r'], [S, 's']]) await br.login(who);
  const a1 = await A.api(), b1 = await Bh.api();
  for (const br of [Boss, D, E, F, G, S]) await br.api();
  const sidOf = (who) => allSids.find((x) => sessions.get(x) === who || (rotated.get(who) && x.slice(0, 42) === rotated.get(who).slice(0, 42)));
  const gSid = allSids[6], sSidOld = allSids[8];
  // 十（前半）：发会话那次就轮换——存下的是换后的号；浏览器手上还是旧号（还没过期），不能当成换了账号
  const r1 = await R.api(), r2 = await R.api(), rMe = await R.api('/api/auth/me');
  const rRows = rowsOf('user:oms.r');
  check(r1.status === 200 && r2.status === 200 && rMe.json?.via === 'session' && /oms\.r/.test(show(rMe.json)) && rRows.length === 1 && rRows[0].revoked_at === null && asked.has(rotated.get('r')),
    'Odoo 在发会话那次核验里就轮换了：下一次核验时市场跟上新号、拿它去问；浏览器手上的旧号（同一个会话）不当成换了账号', show({ r1: r1.status, r2: r2.status, rMe: rMe.json, rRows: rRows.length, askedNew: asked.has(rotated.get('r')) }));
  const aSc = a1.setCookies.find((c) => c.startsWith('wm_session=')) ?? '', bSc = b1.setCookies.find((c) => c.startsWith('wm_session=')) ?? '';
  const tokenLogin = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.31', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ token: ADMIN }) });
  const tokenLoginS = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.32', 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ token: ADMIN }) });
  const wmLogin = (tokenLogin.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('wm_login=')) ?? '', wmLoginS = (tokenLoginS.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('wm_login=')) ?? '';
  const maxAge = Number(/Max-Age=(\d+)/i.exec(aSc)?.[1]);
  check(a1.status === 200 && A.has('wm_session') && show(attrs(aSc).filter((x) => x !== 'expires')) === show(attrs(wmLogin).filter((x) => x !== 'expires')) && /HttpOnly/i.test(aSc) && /SameSite=Lax/i.test(aSc) && /Path=\//.test(aSc) && !/Secure/i.test(aSc)
      && /Secure/i.test(bSc) && show(attrs(bSc).filter((x) => x !== 'expires')) === show(attrs(wmLoginS).filter((x) => x !== 'expires')) && Math.abs(maxAge - TTL_MIN * 60) <= 5,
    'Odoo 认出来以后发 wm_session：属性和管理口令登录的 wm_login 一致（HttpOnly、SameSite=Lax、Path=/；https 时 Secure），期限是 WM_SESSION_TTL_MIN', show({ aSc, bSc, wmLogin, wmLoginS }));
  const aRows = rowsOf('user:oms.a'), aSid = allSids[0];
  const keyMode = statSync(join(DATA, '.wm-login-session.key')).mode & 0o777;
  check(aRows.length === 1 && typeof aRows[0].upstream_sealed === 'string' && aRows[0].upstream_sealed.startsWith('v1.') && !aRows[0].upstream_sealed.includes(aSid) && !aRows[0].upstream_sealed.includes(Buffer.from(aSid).toString('hex'))
      && (process.platform === 'win32' || keyMode === 0o600),
    '库里存的 Odoo 会话号是加密的（看不出原文），密钥文件权限 600；一个人一次登录只发一个会话', show({ n: aRows.length, mode: keyMode.toString(8) }));

  // ---------- 二、Odoo cookie 过期以后 ----------
  await sleep((ODOO_MAX_AGE + 1) * 1000);
  const a2 = await A.api(), me = await A.api('/api/auth/me'), bossWho = await Boss.api('/api/admin/whoami'), aWho = await A.api('/api/admin/whoami');
  const rAfter = await R.api();
  check(rAfter.status === 200, '轮换过的会话在浏览器的 Odoo cookie 过期以后照样认得出', String(rAfter.status));
  check(!A.has('session_id') && a2.status === 200 && me.json?.authenticated === true && me.json?.via === 'session' && bossWho.json?.admin === true && aWho.json?.admin === false,
    '浏览器里的 Odoo cookie 过期以后，市场照样认得出（经市场会话）；Odoo 管理员照旧是管理员，普通员工不是', show({ status: a2.status, me: me.json, bossWho: bossWho.json, aWho: aWho.json }));

  // ---------- 三、换了账号 ----------
  await Bh.login('c');
  const c1 = await Bh.api('/api/auth/me'), cGate = await Bh.api();
  const bRows = rowsOf('user:oms.b');
  check(c1.json?.authenticated === true && /oms\.c/.test(show(c1.json)) && cGate.status === 200 && bRows.length === 1 && bRows[0].revoked_at !== null && bRows[0].upstream_sealed === null && rowsOf('user:oms.c').length === 1,
    '换了账号（浏览器带来的 Odoo 会话号和存下的不同）：旧的市场会话注销、会话号清掉，按新带来的认（新发一个）', show({ me: c1.json, bRows, cRows: rowsOf('user:oms.c').length }));

  // ---------- 六、停用主体：立即 ----------
  const dis = await fetch(B + '/api/principals/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'user:oms.e', reason: '合成：停用' }) });
  const e2 = await E.api();
  const eRows = rowsOf('user:oms.e');
  check(dis.status === 200 && e2.status !== 200 && eRows[0]?.upstream_sealed === null && eRows[0]?.revoked_at !== null,
    '停用主体：立即拒（不等缓存），市场会话注销、存下的会话号清掉', show({ dis: dis.status, e2: e2.status, eRows }));

  // ---------- 七、密文被改过 ----------
  const fRow = dbq("SELECT token_sha256, upstream_sealed FROM market_sessions WHERE principal_id = 'user:oms.f'")[0];
  const tampered = fRow.upstream_sealed.slice(0, -1) + (fRow.upstream_sealed.endsWith('0') ? '1' : '0');
  dbx('UPDATE market_sessions SET upstream_sealed = ? WHERE token_sha256 = ?', tampered, fRow.token_sha256);
  const f2 = await F.api(), f3 = await F.api();
  const fAfter = rowsOf('user:oms.f');
  check(f2.status === 401 && f3.status === 401 && fAfter[0].revoked_at !== null && fAfter[0].upstream_sealed === null,
    '库里的密文被改过：解不开，当场注销，401', show({ f2: f2.status, fAfter }));

  // ---------- 四、Odoo 那边注销；五、Odoo 不可达 ----------
  sessions.delete(aSid);
  downSids.add(allSids[3]); // d
  dropSids.add(gSid); // g：连不上
  await sleep(31_000); // 登录门的认人缓存 30 秒
  const a3 = await A.api(), a4 = await A.api(), d2 = await D.api();
  const aAfter = rowsOf('user:oms.a'), dAfter = rowsOf('user:oms.d');
  check(a3.status === 401 && a3.json?.error === 'login_required' && a4.status === 401 && aAfter[0].revoked_at !== null && aAfter[0].upstream_sealed === null,
    'Odoo 那边注销以后：缓存过期后的下一次请求 401，市场会话注销、会话号清掉，之后一直 401', show({ a3: [a3.status, a3.json?.error], a4: a4.status, aAfter }));
  const g2 = await G.api(), gAfter = rowsOf('user:oms.g');
  check(d2.status === 502 && d2.json?.error === 'identity_unavailable' && dAfter[0].revoked_at === null && typeof dAfter[0].upstream_sealed === 'string'
      && g2.status === 502 && gAfter[0].revoked_at === null,
    'Odoo 不可达（回 5xx、连不上）：回 502（失败关闭），不注销市场会话、会话号还在', show({ d2: [d2.status, d2.json?.error], dAfter, g2: g2.status }));
  // 十（后半）：过了缓存期的第二次核验时轮换——市场当场换号；下一次请求拿新号去问（旧号已失效），照样认得出
  const s2 = await S.api(), s3 = await S.api();
  await sleep(GRACE_MS + 500);
  const s4 = await S.api();
  const oldDead = await (await fetch(ODOO + '/web/session/get_session_info', { method: 'POST', headers: { cookie: `session_id=${sSidOld}` } })).json();
  const sRows = dbq("SELECT revoked_at, upstream_renewals FROM market_sessions WHERE principal_id = 'user:oms.s'");
  check(s2.status === 200 && s3.status === 200 && s4.status === 200 && rotated.has('s') && asked.has(rotated.get('s')) && sRows[0]?.revoked_at === null && sRows[0]?.upstream_renewals === 1 && !!oldDead.error,
    'Odoo 轮换以后（旧号在新号用过、宽限期过后失效）：市场当场换掉存下的号、拿新号去问，旧号失效以后照样认得出', show({ s2: s2.status, s3: s3.status, s4: s4.status, askedNew: rotated.has('s') && asked.has(rotated.get('s')), sRows, oldDead: !!oldDead.error }));

  // ---------- 八、登出 ----------
  const out = await Boss.api('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', origin: B }, body: '{}' });
  const bossAfter = rowsOf('user:oms.boss'), boss2 = await Boss.api();
  check(out.status === 200 && bossAfter[0].revoked_at !== null && bossAfter[0].upstream_sealed === null && boss2.status === 401 && !Boss.has('wm_session'),
    '登出：市场会话注销、会话号清掉，浏览器的 wm_session 清掉，再来 401', show({ out: out.status, bossAfter, boss2: boss2.status }));

  // ---------- 十一、诊断日志 ----------
  const diag = log.split('\n').filter((l) => l.includes('"source":"identity"')).map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } }).filter(Boolean);
  const has = (event, cause, extra = {}) => diag.some((d) => d.event === event && d.cause === cause && Object.entries(extra).every(([k, v]) => d[k] === v));
  const diagText = JSON.stringify(diag);
  check(has('source-check-failed', 'rejected', { via: 'session' }) && has('source-check-failed', 'http-5xx', { via: 'session' }) && has('source-check-failed', 'network', { via: 'session' })
      && has('session-ended', 'rejected') && has('session-ended', 'replaced') && has('session-ended', 'undecryptable') && has('session-upstream-renewed', 'renewed')
      && !/oms\.|user:|oms[0-9a-f]{20}/.test(diagText),
    '诊断：Odoo 核验失败（说会话无效、回 5xx、连不上）、市场会话被注销（被否、换了账号、解不开）、跟着轮换换号，各记一行原因类别；不带会话号、登录名、主体', diagText.slice(0, 600));

  // ---------- 九、不外泄；启动自检 ----------
  const leakedResp = allSids.filter((sid) => seen.some((t) => t.includes(sid)));
  const leakedLog = allSids.filter((sid) => log.includes(sid));
  const health = await (await fetch(B + '/api/health', { headers: { 'x-admin-token': ADMIN } })).json();
  const row = (health.self_probe?.rows ?? []).find((r) => r.id === 'market.login-session.upstream-sealed');
  check(leakedResp.length === 0 && leakedLog.length === 0 && row?.verdict === 'pass' && health.self_probe?.passed === true,
    '会话号不出现在任何应答（体和头）和日志里；启动自检多一行「会话号加密存放」且通过', show({ leakedResp: leakedResp.length, leakedLog: leakedLog.length, row }));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child.exitCode === null) { child.kill(); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  odoo.close();
  rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`odoo-market-session-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
