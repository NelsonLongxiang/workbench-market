#!/usr/bin/env node
/**
 * 站内账号（docs/local-accounts.md P1）：起隔离实例（NODE_ENV=test，不接任何外部身份来源），走浏览器的真实路径。
 *   一、建人：管理员建 alice，回一次临时密码；对应主体 user:alice 建好、启用
 *   二、第一次登录：临时密码对了先要改密码（不发码）；两次不一致、太短都不行；改好才去回调，回调发市场会话，认出是 alice
 *   三、对抗：
 *       1 没这个人和密码不对：同一个状态码、同一句提示
 *       2 连续输错 5 次锁住：之后密码对了也进不去；管理员解锁之后能进
 *       3 一次性码：用过不能再用；换一次登录（别的 state、别的浏览器半边）不能用
 *       4 表单要有效的 state：没有、伪造的都 400；跨站的提交 403
 *       5 管理接口：普通登录的人（alice）、匿名浏览器都调不了
 *       6 应答和日志里没有密码材料：列表里没有哈希、日志里没有临时密码和新密码
 *       7 停用之后：已有的会话立即失效，再登录只给等待页、不发会话
 *       8 重置密码：旧会话注销；新的临时密码又要先改
 *       9 本人改密码：原密码不对 403；对了改好，旧会话注销
 *      10 同一来源输错太多：先歇一分钟（429）
 *   四、站内管理员（P2）：持生效中的 owner / admin 授予（范围 *）的人是管理员——owner 完整，admin 只管系统、看不到业务数据；待放行、收回、过期、管理层授予、停用都不算；
 *       whoami 说是授予、留痕记主体；不能放行别人的 admin 授予、不能放行授给自己的、不能停用自己；跨站写 403
 *
 *   node scripts/local-accounts-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `local-accounts-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-local-accounts-admin';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

let child = null, log = '';
rmSync(OUT, { recursive: true, force: true });
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base,
    // 本机当作反代：每个场景用自己的来源地址（X-Real-IP），按来源的输错限额各算各的
    WM_TRUSTED_PROXIES: '127.0.0.1' });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);

  /** 浏览器：同源标记 + 自己的 cookie 罐 + 自己的来源地址（经本机反代转进来） */
  const browser = (ip = '192.0.2.20') => {
    const jar = new Map();
    const take = (res) => {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i), v = pair.slice(i + 1);
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
      }
    };
    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    // 表单的 state 每提交一次就换一个（一次性）：像真浏览器一样，接着交到页面上新的表单地址。伪造、没见过的地址不跟
    const moved = new Map();
    const latest = (p) => { let q = p; for (let i = 0; i < 100 && moved.has(q); i++) q = moved.get(q); return q; };
    const go = async (method, path0, { form, json, headers = {} } = {}) => {
      const path = method === 'POST' ? latest(path0) : path0;
      const h = { 'sec-fetch-site': 'same-origin', origin: base, 'x-real-ip': ip, ...headers };
      if (jar.size) h.cookie = cookie();
      let body;
      if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(new URL(path, base), { method, headers: h, body, redirect: 'manual' });
      take(res);
      const text = await res.text();
      const act = /<form method="post" action="([^"]+)"/.exec(text)?.[1];
      if (method === 'POST' && act && act !== path) moved.set(path, act);
      let j = null; try { j = JSON.parse(text); } catch { /* 页面 */ }
      return { status: res.status, location: res.headers.get('location') ?? '', text, json: j, headers: res.headers };
    };
    return { go, jar };
  };
  /** 发起一次登录：拿到表单地址（带 state） */
  const begin = async (b) => { const r = await b.go('GET', '/login/local?next=/'); return { r, form: r.location ? new URL(r.location).pathname + new URL(r.location).search : '' }; };
  const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const me = async (b) => (await b.go('GET', '/api/auth/me')).json;
  const adminCall = (method, path, json) => fetch(new URL(path, base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  /** 完整登录：用户名、密码；要先改密码就改成 newPw。返回浏览器（成功时带着市场会话） */
  async function login(username, password, newPw, ip) {
    const b = browser(ip);
    const { form } = await begin(b);
    let r = await b.go('POST', form, { form: { username, password } });
    if (r.status === 200 && ticketOf(r.text)) r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: newPw, confirm: newPw } });
    if (r.status !== 302) return { b, r };
    const cb = await b.go('GET', new URL(r.location).pathname + new URL(r.location).search);
    return { b, r: cb };
  }

  console.log('一、建人');
  const made = await adminCall('POST', '/api/local-accounts', { username: 'alice', display_name: '合成用户甲' });
  const temp = made.json?.temp_password ?? '';
  check(made.status === 201 && /^[a-z2-9]{16}$/.test(temp) && made.json?.account?.principal === 'user:alice' && made.json.account.principal_status === 'active' && made.json.account.must_change === true,
    '管理员建 alice：回一次临时密码，主体 user:alice 建好、启用、要先改密码', made);
  check((await adminCall('POST', '/api/local-accounts', { username: 'alice' })).status === 409, '同名再建：409');
  check((await adminCall('POST', '/api/local-accounts', { username: 'Bad Name' })).status === 400, '用户名不合规：400');

  console.log('二、第一次登录要先改密码');
  {
    const b = browser();
    const { r: r0, form } = await begin(b);
    check(r0.status === 302 && form.startsWith('/login/local/form?state='), '发起：送到本站的表单页', r0.location);
    const page = await b.go('GET', form);
    check(page.status === 200 && page.headers.get('x-frame-options') === 'DENY' && /form-action 'self'/.test(page.headers.get('content-security-policy') ?? ''), '表单页：不许内嵌、只许提交回本站');
    let r = await b.go('POST', form, { form: { username: 'alice', password: temp } });
    const t1 = ticketOf(r.text);
    check(r.status === 200 && t1 && !r.location, '临时密码对了：先出改密码的一步，不发码');
    r = await b.go('POST', form, { form: { ticket: t1, next: 'abcdefghijk1', confirm: 'abcdefghijk2' } });
    check(r.status === 400 && /两次输的新密码不一样/.test(r.text), '两次不一致：不行');
    r = await b.go('POST', form, { form: { ticket: ticketOf(r.text), next: 'short', confirm: 'short' } });
    check(r.status === 400 && /至少 10 位/.test(r.text), '太短：不行');
    r = await b.go('POST', form, { form: { ticket: t1, next: 'Alice-pass-0001', confirm: 'Alice-pass-0001' } });
    check(r.status === 400 && /过期/.test(r.text), '用过的改密码票：不能再用');
  }
  const first = await login('alice', temp, 'Alice-pass-0001');
  check(first.r.status === 302 && first.b.jar.has('wm_session'), '改好密码：回调发市场会话', first.r.status);
  const who = await me(first.b);
  check(who?.authenticated === true && who.principal === 'user:alice' && who.via === 'session', '认出是 alice（市场会话）', who);
  check((await login('alice', temp)).r.status === 401, '临时密码改过之后就不能再用');

  console.log('三、对抗');
  {
    const b = browser('192.0.2.31'); const { form } = await begin(b);
    const nobody = await b.go('POST', form, { form: { username: 'nobody-here', password: 'whatever-pass-1' } });
    const wrong = await b.go('POST', form, { form: { username: 'alice', password: 'wrong-pass-0001' } });
    const strip = (t) => t.replace(/value="[^"]*"/g, '').replace(/action="[^"]*"/g, '');
    check(nobody.status === 401 && wrong.status === 401 && strip(nobody.text) === strip(wrong.text), '1 没这个人和密码不对：同一个状态码、同一页（除了回填的用户名）');
  }
  {
    const b = browser('192.0.2.32'); const { form } = await begin(b);
    for (let i = 0; i < 4; i++) await b.go('POST', form, { form: { username: 'alice', password: `wrong-pass-${i}xxx` } });
    const locked = await login('alice', 'Alice-pass-0001');
    check(locked.r.status === 401, '2 连续输错 5 次锁住：密码对了也进不去', locked.r.status);
    check((await adminCall('POST', '/api/local-accounts/alice/unlock')).status === 200, '2 管理员解锁');
    const again = await login('alice', 'Alice-pass-0001');
    check(again.r.status === 302 && again.b.jar.has('wm_session'), '2 解锁之后能进', again.r.status);
  }
  {
    const b1 = browser(); const { form: f1 } = await begin(b1);
    const r1 = await b1.go('POST', f1, { form: { username: 'alice', password: 'Alice-pass-0001' } });
    const cb = new URL(r1.location); const code = cb.searchParams.get('code');
    const b2 = browser(); const { form: f2 } = await begin(b2);
    const state2 = new URLSearchParams(f2.split('?')[1]).get('state');
    const cross = await b2.go('GET', `/login/local/callback?state=${encodeURIComponent(state2)}&code=${encodeURIComponent(code)}`);
    check(cross.status !== 302 && !b2.jar.has('wm_session'), '3 一次性码换到别的一次登录（别的 state、别的浏览器）用：不行', cross.status);
    const b3 = browser(); const { form: f3 } = await begin(b3);
    const r3 = await b3.go('POST', f3, { form: { username: 'alice', password: 'Alice-pass-0001' } });
    const used = new URL(r3.location).pathname + new URL(r3.location).search;
    check((await b3.go('GET', used)).status === 302, '3 正常用一次：发会话');
    const replay = browser();
    for (const [k, v] of b3.jar) replay.jar.set(k, v);
    replay.jar.delete('wm_session');
    check((await replay.go('GET', used)).status !== 302, '3 同一个码再用：不行');
  }
  {
    const b = browser();
    check((await b.go('GET', '/login/local/form')).status === 400, '4 表单没有 state：400');
    check((await b.go('GET', `/login/local/form?state=${'A'.repeat(43)}`)).status === 400, '4 伪造的 state：400');
    const { form } = await begin(b);
    check((await b.go('POST', form, { form: { username: 'alice', password: 'Alice-pass-0001' }, headers: { 'sec-fetch-site': 'cross-site' } })).status === 403, '4 跨站提交：403');
  }
  {
    const alice = (await login('alice', 'Alice-pass-0001')).b;
    const list = await alice.go('GET', '/api/local-accounts');
    const mk = await alice.go('POST', '/api/local-accounts', { json: { username: 'mallory' } });
    const anon = browser();
    const a2 = await anon.go('POST', '/api/local-accounts/alice/reset-password', { json: {} });
    check(list.status === 403 && mk.status === 403 && a2.status === 403, '5 普通登录的人、匿名浏览器：管理接口都 403', { list: list.status, mk: mk.status, anon: a2.status });
  }
  {
    const listed = await adminCall('GET', '/api/local-accounts');
    const text = JSON.stringify(listed.json);
    check(listed.status === 200 && !/password|scrypt|hash/i.test(text.replace(/"must_change"/g, '')), '6 列表里没有任何密码材料', text.slice(0, 200));
    check(!log.includes(temp) && !log.includes('Alice-pass-0001'), '6 日志里没有临时密码、没有新密码');
  }
  {
    const alice = (await login('alice', 'Alice-pass-0001')).b;
    check((await me(alice))?.principal === 'user:alice', '7（准备）alice 登录着');
    const off = await adminCall('POST', '/api/principals/disable', { id: 'user:alice', reason: '合成：停用测试' });
    check(off.status === 200, '7 管理员停用 user:alice', off);
    check((await me(alice))?.principal !== 'user:alice', '7 已有的会话立即失效');
    const again = await login('alice', 'Alice-pass-0001');
    check(again.r.status !== 302 && !again.b.jar.has('wm_session'), '7 再登录：不发会话（等待页）', again.r.status);
    check((await adminCall('POST', '/api/principals/restore', { id: 'user:alice', reason: '合成：恢复' })).status === 200, '7 恢复');
  }
  {
    const alice = (await login('alice', 'Alice-pass-0001')).b;
    const reset = await adminCall('POST', '/api/local-accounts/alice/reset-password');
    const t2 = reset.json?.temp_password ?? '';
    check(reset.status === 200 && t2 && t2 !== temp && reset.json.account.must_change === true, '8 重置：回新的临时密码，要先改');
    check((await me(alice))?.principal !== 'user:alice', '8 旧会话注销');
    check((await login('alice', 'Alice-pass-0001')).r.status === 401, '8 旧密码不能再用');
    const fresh = await login('alice', t2, 'Alice-pass-0002');
    check(fresh.r.status === 302 && fresh.b.jar.has('wm_session'), '8 新临时密码：先改再进');
  }
  {
    const alice = (await login('alice', 'Alice-pass-0002')).b;
    const bad = await alice.go('POST', '/api/local-accounts/_self/password', { json: { current: 'not-it-0000', next: 'Alice-pass-0003' } });
    check(bad.status === 403, '9 本人改密码：原密码不对 403', bad.status);
    const ok = await alice.go('POST', '/api/local-accounts/_self/password', { json: { current: 'Alice-pass-0002', next: 'Alice-pass-0003' } });
    check(ok.status === 200 && ok.json?.relogin === true, '9 原密码对：改好', ok);
    check((await me(alice))?.principal !== 'user:alice', '9 旧会话注销');
    check((await login('alice', 'Alice-pass-0003')).r.status === 302, '9 新密码能进');
  }
  {
    const b = browser('192.0.2.40'); const { form } = await begin(b);
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) last = (await b.go('POST', form, { form: { username: `nobody-${i}`, password: 'whatever-pass-1' } })).status;
    check(last === 429, '10 同一来源输错太多：先歇一分钟（429）', last);
  }

  console.log('四、站内管理员（P2：持 owner / admin 授予的人就是管理员）');
  {
    /** 本机命令行：回环直连、不带浏览器标记——授予管理面上算属主 */
    const cli = (method, path, json) => fetch(new URL(path, base), { method, headers: json === undefined ? {} : { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const grant = async (principal, role, extra = {}) => {
      const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成：站内管理员', ...extra });
      const id = d.json?.grant?.id;
      const s = await cli('POST', `/api/grants/${id}/submit`);
      return { id, draft: d, submit: s };
    };
    const approve = (id) => cli('POST', `/api/grants/${id}/approve`);
    const revoke = (id) => cli('POST', `/api/grants/${id}/revoke`, { reason: '合成：收回' });
    const person = async (username, pw) => {
      const t = (await adminCall('POST', '/api/local-accounts', { username })).json?.temp_password ?? '';
      return (await login(username, t, pw, '192.0.2.50')).b;
    };
    const whoamiOf = async (b) => (await b.go('GET', '/api/admin/whoami')).json;
    const listOf = async (b) => (await b.go('GET', '/api/local-accounts')).status;

    const bob = await person('bob', 'Bob-pass-00001');
    check((await me(bob))?.principal === 'user:bob', '11（准备）bob 用站内账号登录着');
    const w0 = await whoamiOf(bob);
    check(w0?.admin === false && (await listOf(bob)) === 403, '11 没有授予：不是管理员，管理接口 403', w0);

    const g = await grant('user:bob', 'admin');
    check(g.draft.status === 201 || g.draft.status === 200, '12（准备）本机命令行起草并提交 bob 的 admin 授予', g.draft);
    check((await listOf(bob)) === 403, '12 授予还在待放行：不算管理员');

    const ok = await approve(g.id);
    check(ok.status === 200, '13（准备）属主（本机命令行）放行', ok);
    const w1 = await whoamiOf(bob);
    check(w1?.admin === true && w1.via === 'grant' && w1.login === 'user:bob' && w1.system_only === true, '13 放行之后：同一个会话立即是（系统）管理员，whoami 说是授予、只管系统（不冒充 Odoo 管理员）', w1);
    const mk = await bob.go('POST', '/api/local-accounts', { json: { username: 'dave' } });
    check(mk.status === 201 && (await listOf(bob)) === 200, '13 站内管理员能建人、能列出账号', mk.status);
    check(/"event":"create","username":"dave","by":"user:bob"/.test(log), '13 留痕记成主体 user:bob，不写成 odoo:bob');
    const bobAll = await bob.go('GET', '/api/work-items?view=all');
    check(bobAll.status === 403, '13 只持 admin 授予的系统管理员看不到业务数据：事项「全部」403（属主 2026-11-16 定）', bobAll.status);

    const cross = await bob.go('POST', '/api/local-accounts', { json: { username: 'erin' }, headers: { origin: 'http://attacker.invalid', 'sec-fetch-site': 'cross-site' } });
    check(cross.status === 403, '14 站内管理员的浏览器被别的站借去发写请求：403', cross.status);

    const carol = await person('carol', 'Carol-pass-0001');
    const gc = await grant('user:carol', 'admin');
    const byBob = await bob.go('POST', `/api/grants/${gc.id}/approve`);
    check(byBob.status === 403 && /owner_required/.test(byBob.text), '15 站内管理员不能放行别人的 admin 授予（要属主）', byBob.text.slice(0, 160));
    check((await listOf(carol)) === 403, '15 carol 的授予没放行：还不是管理员');
    const gb2 = await grant('user:bob', 'member');
    const selfApprove = await bob.go('POST', `/api/grants/${gb2.id}/approve`);
    check(selfApprove.status !== 200, '15 站内管理员不能放行授给自己的', selfApprove.status);

    const selfOff = await bob.go('POST', '/api/principals/disable', { json: { id: 'user:bob', reason: '合成：停用自己' } });
    check(selfOff.status === 409, '16 站内管理员不能停用自己（留痕 user:bob 对回到主体）', selfOff.status);

    check((await revoke(g.id)).status === 200, '17（准备）收回 bob 的 admin 授予');
    const w2 = await whoamiOf(bob);
    check(w2?.admin === false && (await listOf(bob)) === 403, '17 收回之后：同一个会话的下一个请求就不是管理员（不等缓存）', w2);

    const gm = await grant('user:carol', 'management');
    await approve(gm.id);
    check((await listOf(carol)) === 403, '18 管理层（management）授予不算站内管理员');

    const gs = await grant('user:carol', 'admin', { expires_at: Date.now() + 4000 });
    const okS = await approve(gs.id);
    check(okS.status === 200 && (await listOf(carol)) === 200, '19（准备）带期限的 admin 授予：期限内是管理员', okS);
    await sleep(4500);
    check((await listOf(carol)) === 403, '19 过了期限：立即不是管理员（现比期限，不等周期任务）');

    const go = await grant('user:carol', 'owner');
    const okO = await approve(go.id);
    const wc = await whoamiOf(carol);
    check(okO.status === 200 && (await listOf(carol)) === 200 && wc?.via === 'grant' && wc.system_only === undefined, '20 属主（owner）授予是完整的站内管理员', { okO: okO.status, wc });
    check((await carol.go('GET', '/api/work-items?view=all')).status === 200, '20 属主授予看得到业务数据：事项「全部」200');
    const mkF = await carol.go('POST', '/api/local-accounts', { json: { username: 'frank' } });
    check(mkF.status === 201 && /"event":"create","username":"frank","by":"user:carol"/.test(log), '20 属主授予的管理员建人：留痕记主体 user:carol，不写成 odoo:carol', mkF.status);
    check((await adminCall('POST', '/api/principals/disable', { id: 'user:carol', reason: '合成：停用持授予的人' })).status === 200, '21（准备）停用 carol');
    const afterOff = await listOf(carol);
    check(afterOff === 401 || afterOff === 403, '21 主体停用：授予还在也不是管理员（会话失效）', afterOff);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await sleep(300);
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`local-accounts-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
