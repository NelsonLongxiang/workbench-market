#!/usr/bin/env node
/**
 * 自己注册的三道闸（docs/local-accounts.md 第 4 节）：缺省关着、待核准有上限、只能经核准新建主体。
 * 隔离实例（NODE_ENV=test），注册、登录都走浏览器的真实路径；合成的人：olga 持 owner（完整管理员）、sam 持 admin（系统管理员）。
 *
 *   F3 缺省关：不设 WM_LOCAL_SIGNUP，登录表单没有注册入口，?view=signup 只出登录表单，提交注册 404；账号密码登录照常（WM_LOCAL_LOGIN 缺省开）；
 *      启动日志写明 signup: off；WM_LOCAL_SIGNUP_PENDING_MAX 不合法拒绝启动
 *   F4 待核准上限（WM_LOCAL_SIGNUP_PENDING_MAX=2）：注册两个之后第三个 503，没建账号；管理员的「等你拍板」出「自己注册已暂停」；
 *      非管理员看不到；拒绝一个之后恢复；并发注册也不超过上限
 *   F2 只能经核准建新主体：bind、bind-batch 把自己注册的账号绑到已有的人 409 self-signup（等价写法、create: true 也一样）；
 *      待对接清单带 self_signup、「等你拍板」标「自己注册」、标题以用户名起头（自填的显示名不单独当标题）、不给对接的答法；
 *      经「关注」卡片的答法（POST /api/attention/answer，bind）硬要绑也被拒；绑定目标「user: 名」（两头空白）400 不是 500；核准照常
 *
 *   node scripts/local-accounts-signup-guard-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `local-accounts-signup-guard-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-signup-guard-admin';
const BUSY_MS = 10_000;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const children = [];
let log = '';
rmSync(OUT, { recursive: true, force: true });

/** 起一个隔离实例；mode 只是目录名，extra 是额外的启动环境 */
async function boot(mode, extra = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = join(OUT, mode), data = join(dir, 'data'), home = join(dir, 'home'), ext = join(dir, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base, WM_TRUSTED_PROXIES: '127.0.0.1' });
  env.ADMIN_TOKEN = ADMIN_TOKEN;
  Object.assign(env, extra);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);

  /** 浏览器：同源标记 + 自己的 cookie 罐 + 自己的来源地址；跟着页面上新的表单地址走（state 一次性） */
  const browser = (ip) => {
    const jar = new Map(), moved = new Map();
    const latest = (p) => { let q = p; for (let i = 0; i < 100 && moved.has(q); i++) q = moved.get(q); return q; };
    const go = async (method, path0, { form, json } = {}) => {
      const path = method === 'POST' ? latest(path0) : path0;
      const h = { 'sec-fetch-site': 'same-origin', origin: base, 'x-real-ip': ip };
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let body;
      if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(new URL(path, base), { method, headers: h, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1); if (/max-age=0/i.test(c) || v === '') jar.delete(k); else jar.set(k, v); }
      const text = await res.text();
      const act = /<form method="post" action="([^"]+)"/.exec(text)?.[1];
      if (method === 'POST' && act && act !== path) moved.set(path, act);
      let j = null; try { j = JSON.parse(text); } catch { /* 页面 */ }
      return { status: res.status, location: res.headers.get('location') ?? '', text, json: j };
    };
    return { go, jar };
  };
  const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? '';
  async function login(username, password, newPw, ip) {
    const b = browser(ip);
    const r0 = await b.go('GET', '/login/local?next=/');
    const form = r0.location ? new URL(r0.location).pathname + new URL(r0.location).search : '';
    let r = await b.go('POST', form, { form: { username, password } });
    if (r.status === 200 && ticketOf(r.text)) r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: newPw, confirm: newPw } });
    if (r.status === 302) await b.go('GET', new URL(r.location).pathname + new URL(r.location).search);
    return b;
  }
  /** 本机命令行（回环、不带浏览器标记）：属主 */
  const cli = (method, path, json) => fetch(new URL(path, base), { method, headers: json === undefined ? {} : { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成' }); const id = d.json?.grant?.id; await cli('POST', `/api/grants/${id}/submit`); const a = await cli('POST', `/api/grants/${id}/approve`); return { id, status: a.status }; };
  const person = async (username, pw, ip) => { const t = (await cli('POST', '/api/local-accounts', { username })).json?.temp_password ?? ''; return login(username, t, pw, ip); };
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS });
  const token = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const signupForm = async (ip) => { const b = browser(ip); const r0 = await b.go('GET', '/login/local?next=/'); return { b, form: r0.location ? new URL(r0.location).pathname + new URL(r0.location).search : '' }; };
  const signup = async (username, password, ip) => { const { b, form } = await signupForm(ip); return b.go('POST', form, { form: { mode: 'signup', username, password, confirm: password } }); };
  const attention = async (b) => ((b ? await b.go('GET', '/api/attention') : await token('GET', '/api/attention')).json?.items ?? []);
  return { base, browser, login, cli, grant, person, db, child, token, signupForm, signup, attention };
}


/** 起一个注定起不来的实例：看它是不是拒绝启动（返回退出码和日志） */
async function bootFails(extra) {
  const port = await freePort();
  const dir = join(OUT, 'bad'), data = join(dir, 'data'), home = join(dir, 'home'), ext = join(dir, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: `http://127.0.0.1:${port}` }, extra);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = ''; child.stdout.on('data', (d) => { out += String(d); }); child.stderr.on('data', (d) => { out += String(d); });
  let healthy = false;
  for (const deadline = Date.now() + 30000; child.exitCode === null && Date.now() < deadline && !healthy;) { try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200; } catch { /* 没起来 */ } if (!healthy) await sleep(200); }
  return { healthy, code: child.exitCode, out };
}

try {
  // ---------- F3 缺省关 ----------
  console.log('F3 注册缺省关着');
  {
    const D = await boot('default');
    const { b, form } = await D.signupForm('192.0.2.11');
    const page = await b.go('GET', `${form}&view=signup`);
    const post = await b.go('POST', form, { form: { mode: 'signup', username: 'quinn', password: 'Quinn-pass-0001', confirm: 'Quinn-pass-0001' } });
    const acct = ((await D.token('GET', '/api/local-accounts')).json?.accounts ?? []).find((a) => a.username === 'quinn');
    check(page.status === 200 && /账号密码登录/.test(page.text) && !/注册新账号/.test(page.text) && !/name="mode" value="signup"/.test(page.text) && post.status === 404 && !acct,
      'F3a 不设 WM_LOCAL_SIGNUP：表单页没有注册入口，?view=signup 只出登录表单，提交注册 404、没建账号', { page: page.status, signupLink: /注册新账号/.test(page.text), post: post.status, acct: !!acct });
    const lk = (await D.cli('POST', '/api/local-accounts', { username: 'lena' })).json?.temp_password ?? '';
    const lena = await D.login('lena', lk, 'Lena-pass-00001', '192.0.2.12');
    check((await lena.go('GET', '/api/auth/me')).json?.principal === 'user:lena', 'F3b 不设 WM_LOCAL_LOGIN：账号密码登录照常开着（管理员建的 lena 登得进）');
    const cfg = /"source":"local-accounts","event":"config","login":"on","signup":"off","signup_pending_max":50/.test(log);
    check(cfg, 'F3c 启动日志写明当下的开关：login on、signup off、待核准上限 50');
    const bad = await bootFails({ WM_LOCAL_SIGNUP_PENDING_MAX: '0' });
    const bad2 = await bootFails({ WM_LOCAL_SIGNUP_PENDING_MAX: '5x' });
    check(!bad.healthy && bad.code !== 0 && /WM_LOCAL_SIGNUP_PENDING_MAX/.test(bad.out) && !bad2.healthy && /WM_LOCAL_SIGNUP_PENDING_MAX/.test(bad2.out),
      'F3d WM_LOCAL_SIGNUP_PENDING_MAX 不合法（0、5x）：拒绝启动', { bad: [bad.healthy, bad.code], bad2: [bad2.healthy, bad2.code] });
  }

  // ---------- F4 待核准上限 ----------
  console.log('F4 待核准上限');
  const A = await boot('cap', { WM_LOCAL_SIGNUP: 'approval', WM_LOCAL_SIGNUP_PENDING_MAX: '2' });
  const account = async (u) => ((await A.token('GET', '/api/local-accounts')).json?.accounts ?? []).find((a) => a.username === u);
  {
    const r1 = await A.signup('amy', 'Amy-pass-000001', '192.0.2.21');
    const pausedBefore = (await A.attention()).some((i) => i.source_id === 'local:signup-paused');
    const r2 = await A.signup('ben', 'Ben-pass-000001', '192.0.2.22');
    const r3 = await A.signup('cat', 'Cat-pass-000001', '192.0.2.23');
    check([302, 200].includes(r1.status) && [302, 200].includes(r2.status) && !!(await account('amy')) && !!(await account('ben')) && r3.status === 503 && /暂停/.test(r3.text) && !(await account('cat')),
      'F4a 上限 2：注册两个之后第三个回 503「注册先暂停」，没建账号', { r1: r1.status, r2: r2.status, r3: r3.status, amy: !!(await account('amy')), ben: !!(await account('ben')), cat: !!(await account('cat')), t: r3.text.slice(-300) });
    const items = await A.attention();
    const paused = items.find((i) => i.source_id === 'local:signup-paused');
    check(!pausedBefore && !!paused && /自己注册已暂停/.test(paused.title) && /2 \/ 2/.test(paused.title) && paused.link === '/access?tab=accounts',
      'F4b 到了上限：管理员的「等你拍板」出「自己注册已暂停」（2 / 2，送去账号页）；没到上限时没有', { pausedBefore, paused });
    const plain = await A.person('pete', 'Pete-pass-00001', '192.0.2.24');
    const plainItems = await A.attention(plain);
    check(!plainItems.some((i) => i.source_id === 'local:signup-paused' || String(i.source_id).startsWith('local:')), 'F4c 不是管理员：看不到这一条，也看不到待核准的账号');
    // 同一来源暂停时不占次数：暂停期间这个来源连试几次，恢复后照样能注册
    for (let i = 0; i < 6; i++) await A.signup(`dee${i}`, 'Dee-pass-000001', '192.0.2.25');
    const rej = await A.token('POST', '/api/local-accounts/amy/reject', { reason: '合成' });
    const between = (await A.attention()).some((i) => i.source_id === 'local:signup-paused');
    const r4 = await A.signup('dan', 'Dan-pass-000001', '192.0.2.25');
    check(rej.status === 200 && !between && [302, 200].includes(r4.status) && !!(await account('dan')),
      'F4d 拒绝一个之后自动恢复（同一来源暂停期间的尝试不占次数）：空出名额时「已暂停」那一条消失，dan 注册得上', { rej: rej.status, between, r4: r4.status });
    // 现在 ben、dan 两个待核准，又满了：核准一个（ben）空出一个名额，并发两个注册只成一个
    const ap = await A.token('POST', '/api/local-accounts/ben/approve');
    const [c1, c2, c3] = await Promise.all([A.signup('eve', 'Eve-pass-000001', '192.0.2.31'), A.signup('fay', 'Fay-pass-000001', '192.0.2.32'), A.signup('gus', 'Gus-pass-000001', '192.0.2.33')]);
    const made = ['eve', 'fay', 'gus'].filter(Boolean);
    const exist = (await Promise.all(made.map(account))).filter(Boolean).length;
    const pendingNow = ((await A.token('GET', '/api/local-accounts')).json?.accounts ?? []).filter((a) => a.pending).length;
    // 没注册上的回 503（满了）或 429（同时在算哈希的名额占满，没进哈希）
    check(ap.status === 200 && exist === 1 && pendingNow === 2 && [c1, c2, c3].filter((r) => [302, 200].includes(r.status)).length === 1 && [c1, c2, c3].every((r) => [302, 200, 503, 429].includes(r.status)),
      'F4e 核准一个空出一个名额：并发三个注册只成一个，待核准的不超过上限', { ap: ap.status, exist, pendingNow, st: [c1.status, c2.status, c3.status] });
  }

  // ---------- F2 只能经核准建新主体 ----------
  console.log('F2 自己注册的账号只能经核准新建主体');
  {
    const B = await boot('bind', { WM_LOCAL_SIGNUP: 'approval' });
    const olga = await B.person('olga', 'Olga-pass-00001', '192.0.2.41'); await B.grant('user:olga', 'owner');
    await B.cli('POST', '/api/principals/bind', { provider: 'sso', external_id: 'boss', principal: 'user:boss', create: true, reason: '合成：已有的人' });
    await B.grant('user:boss', 'owner');
    { const { b, form } = await B.signupForm('192.0.2.42'); await b.go('POST', form, { form: { mode: 'signup', username: 'mallory', display_name: 'boss', password: 'Mallory-pass-001', confirm: 'Mallory-pass-001' } }); }
    await B.login('mallory', 'Mallory-pass-001', '', '192.0.2.43'); // 登一次：进待对接清单
    const one = await B.token('POST', '/api/principals/bind', { provider: 'local', external_id: 'mallory', principal: 'user:boss', reason: '合成' });
    const byOlga = await olga.go('POST', '/api/principals/bind', { json: { provider: 'local', external_id: 'mallory', principal: 'user:boss', reason: '合成' } });
    const byCli = await B.cli('POST', '/api/principals/bind', { provider: 'local', external_id: 'mallory', principal: 'user:boss', reason: '合成' });
    const asM = await B.login('mallory', 'Mallory-pass-001', '', '192.0.2.44');
    const meM = (await asM.go('GET', '/api/auth/me')).json?.principal ?? null;
    check(one.status === 409 && one.json?.reason === 'self-signup' && byOlga.status === 409 && byOlga.json?.reason === 'self-signup' && byCli.status === 409 && meM !== 'user:boss',
      'F2a bind 把自己注册的 mallory 绑到已有的 user:boss：409 self-signup（管理口令、完整管理员、本机命令行都一样），登不成 user:boss', { one: [one.status, one.json?.reason], byOlga: byOlga.status, byCli: byCli.status, meM });
    const batch = await B.token('POST', '/api/principals/bind-batch', { items: [
      { provider: 'local', external_id: 'mallory', principal: 'user:boss' },
      { provider: 'local', external_id: 'MALLORY', principal: 'user:boss' },
      { provider: 'local', external_id: 'ｍａｌｌｏｒｙ', principal: 'user:boss' },
      { provider: 'local', external_id: 'mallory', principal: 'user:mallory2', create: true },
    ], reason: '合成' });
    const rs = batch.json?.results ?? [];
    check(batch.status === 200 && batch.json?.bound === 0 && rs.length === 4 && rs.every((r) => r.ok === false && r.status === 409 && r.reason === 'self-signup'),
      'F2b bind-batch：原样、只差大小写、全角写法、连新建一个人（create: true）都 409 self-signup，一条没绑', rs.map((r) => [r.status, r.reason]));
    const eq = await B.token('POST', '/api/principals/bind', { provider: 'local', external_id: 'Mallory', principal: 'user:boss', reason: '合成' });
    const mk = await B.token('POST', '/api/principals/bind', { provider: 'local', external_id: 'mallory', principal: 'user:fresh', create: true, reason: '合成' });
    check(eq.status === 409 && eq.json?.reason === 'self-signup' && mk.status === 409 && mk.json?.reason === 'self-signup',
      'F2c 单条 bind：等价写法、create: true 新建一个人也 409（只走核准）', { eq: [eq.status, eq.json?.reason], mk: [mk.status, mk.json?.reason] });
    const pend = (await B.token('GET', '/api/principals/pending')).json?.pending ?? [];
    const pm = pend.find((p) => p.provider === 'local' && p.external_id === 'mallory');
    const olgaPend = await olga.go('GET', '/api/principals/pending');
    const items = await B.attention();
    const it = items.find((i) => i.source_id === 'local:mallory');
    check(pm?.self_signup === true && (olgaPend.json?.pending ?? []).find((p) => p.external_id === 'mallory')?.self_signup === true && !!it && /^自己注册的账号 mallory/.test(it.title) && /自填显示名「boss」/.test(it.title) && !(it.answers ?? []).includes('bind') && it.link === '/access?tab=accounts',
      'F2d 待对接清单标 self_signup: true；「等你拍板」标题以「自己注册的账号 mallory」起头（自填的显示名 boss 只作附注）、不给对接的答法、送去账号页', { pm, it });
    // 经「关注」卡片的答法硬要绑（不管卡上给没给这个答法）：管理口令、完整管理员会话都被拒，没绑上
    const viaCard = await B.token('POST', '/api/attention/answer', { source: 'principal-pending', source_id: 'local:mallory', answer: 'bind', input: { principal: 'user:boss', reason: '合成' } });
    const viaCardOlga = await olga.go('POST', '/api/attention/answer', { json: { source: 'principal-pending', source_id: 'local:mallory', answer: 'bind', input: { principal: 'user:boss', create: false, reason: '合成' } } });
    const asM3 = await B.login('mallory', 'Mallory-pass-001', '', '192.0.2.46');
    check(viaCard.status >= 400 && viaCardOlga.status >= 400 && (await asM3.go('GET', '/api/auth/me')).json?.principal !== 'user:boss',
      'F2f 经「关注」卡片的答法绑自己注册的 mallory 到 user:boss：被拒（管理口令、完整管理员都一样），没绑上', { viaCard: [viaCard.status, viaCard.json], viaCardOlga: [viaCardOlga.status, viaCardOlga.json] });
    const sp = await B.token('POST', '/api/principals/bind', { provider: 'sso', external_id: 'spacey', principal: 'user: 名', create: true, reason: '合成' });
    const spb = await B.token('POST', '/api/principals/bind-batch', { items: [{ provider: 'sso', external_id: 'spacey', principal: 'user:名 ', create: true }], reason: '合成' });
    check(sp.status === 400 && spb.status === 200 && spb.json?.results?.[0]?.status === 400,
      'F2g 绑定目标「user: 名」「user:名 」（两头空白）：单条 400、成批那一条 400，不是 500', { sp: sp.status, spb: spb.json?.results?.[0] });
    // 对照：不是自己注册的（管理员建的、别的登录方式的）照旧能绑
    const other = await B.token('POST', '/api/principals/bind', { provider: 'sso', external_id: 'boss2', principal: 'user:boss', reason: '合成：对照' });
    const ap = await B.token('POST', '/api/local-accounts/mallory/approve');
    const asM2 = await B.login('mallory', 'Mallory-pass-001', '', '192.0.2.45');
    check(other.status === 200 && ap.status === 200 && ap.json?.account?.principal === 'user:mallory' && (await asM2.go('GET', '/api/auth/me')).json?.principal === 'user:mallory',
      'F2e 对照：别的登录方式的身份照旧能绑到已有的人；核准 mallory 照常新建 user:mallory', { other: other.status, ap: [ap.status, ap.json?.account?.principal] });
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await sleep(500);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`local-accounts-signup-guard-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
