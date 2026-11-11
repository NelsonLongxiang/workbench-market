#!/usr/bin/env node
/**
 * 飞书登录和市场会话的对抗组（安全面）。真实的 server/src/index.ts；Odoo 那一侧换成假的提供方（identity-fake-provider.mjs），
 * 飞书是真插件对本机起的假飞书（feishu-fake.mjs）；应用凭证预先放进一个临时凭据库，服务端用合成的主密码打开。
 * 只在 127.0.0.1 上，不访问任何真实的外部系统。请求都带反代转发头，按远程浏览器算。
 *
 * 每一例是一个谓词对：拒绝的那一头，加上合法对照，两头都对才算过。
 *
 *   node scripts/feishu-login-smoke.mjs              测本仓库
 *   node scripts/feishu-login-smoke.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { APP, PEOPLE, startFakeFeishu } from './feishu-fake.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `feishu-login-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-feishu-login-admin';
const MASTER = 'Synthetic-Vault-Master-2026!feishu-login';
const REMOTE = { 'x-forwarded-for': '192.0.2.20' };

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

/** 临时凭据库：放一条飞书应用凭证（username 是 App ID，password 是 App Secret） */
async function makeVault(file, withEntry = true) {
  const { openVault } = await import(pathToFileURL(join(ROOT, 'server/src/vault/store.ts')).href);
  const store = await openVault({ masterPassword: MASTER, path: file });
  if (withEntry) await store.add({ title: 'feishu-login', kind: 'login', username: APP.id, password: APP.secret });
  await store.lock();
}

const running = [];
async function boot(name, fake, extraEnv = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), vault = join(OUT, name, 'vault', 'default.json');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(dirname(vault), { recursive: true });
  if (extraEnv.NO_VAULT_ENTRY !== '1') await makeVault(vault); else await makeVault(vault, false);
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '',
    IDENTITY_SEAM_ROOT: ROOT, MARKET_PUBLIC_URL: `http://127.0.0.1:${port}`, WM_VAULT_PATH: vault, DSH_VAULT_PASSWORD: MASTER, ...fake.env, ...extraEnv,
  });
  delete env.NO_VAULT_ENTRY;
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
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
  const stop = async () => { child.kill('SIGTERM'); await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } }); };
  if (!ready) { await stop(); throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`); }
  const srv = { name, base, data, stop, log: () => log };
  running.push(srv);
  return srv;
}

/** 一个浏览器：自己的 cookie 罐。请求不跟随跳转 */
function browser(srv) {
  const jar = new Map();
  const cookieHeader = (extra = {}) => [...[...jar].map(([k, v]) => `${k}=${v}`), ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)].join('; ');
  async function req(method, path, { headers = {}, body, cookies = {} } = {}) {
    const h = { ...REMOTE, ...headers };
    const c = cookieHeader(cookies);
    if (c) h.cookie = c;
    if (body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(path.startsWith('http') ? path : srv.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(20000) });
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';');
        const i = pair.indexOf('='); const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        const gone = attrs.some((a) => /^\s*max-age=0/i.test(a) || /^\s*expires=thu, 01 jan 1970/i.test(a)) || v === '';
        if (gone) jar.delete(k); else jar.set(k, v);
      }
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, location: res.headers.get('location') ?? '', text, json };
    } catch (e) { return { status: 0, location: '', text: String(e?.name ?? e), json: null }; }
  }
  return { jar, req };
}

/** 走一遍飞书登录：发起 → 假飞书授权页 → 回调。返回三步的应答和回调地址 */
async function feishuLogin(b, fake, person, next = '/tasks') {
  fake.as(person);
  const start = await b.req('GET', `/login/feishu?next=${encodeURIComponent(next)}`);
  if (start.status !== 302 || !start.location.startsWith(fake.url)) return { start };
  const auth = await fetch(start.location, { redirect: 'manual' });
  const callback = auth.headers.get('location') ?? '';
  const cb = await b.req('GET', callback);
  return { start, callback, cb };
}

const admin = { 'x-admin-token': ADMIN_TOKEN };
const whoami = async (b, cookies) => { const r = await b.req('GET', '/api/auth/viewer', { cookies }); return { status: r.status, sub: r.json?.viewer?.sub ?? null, login: r.json?.viewer?.login ?? null }; };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const fake = await startFakeFeishu();
try {
  const open = await boot('open', fake);
  const gated = await boot('gated', fake, { WM_LOGIN_GATE: 'enforce' });
  const ops = browser(open);

  // ---------- 一、两种登录都能进，同一个人是同一个主体 ----------
  const odooAlpha = await whoami(browser(open), { session_id: SESSIONS.alpha });
  check(odooAlpha.status === 200 && odooAlpha.sub === 'user:alpha', '对照·Odoo 登录（假提供方）：alpha 认得出，主体 user:alpha', show(odooAlpha));
  {
    const b = browser(open);
    const r = await feishuLogin(b, fake, 'bob');
    const pending = await ops.req('GET', '/api/principals/pending', { headers: admin });
    const listed = (pending.json?.pending ?? []).find((p) => p.provider === 'feishu' && p.external_id === PEOPLE.bob.union_id);
    const principalsNow = (await ops.req('GET', '/api/principals', { headers: admin })).json?.principals ?? [];
    check(r.cb?.status === 403 && !b.jar.has('wm_session') && listed?.display_name === PEOPLE.bob.name && listed.email === PEOPLE.bob.enterprise_email && !principalsNow.some((p) => p.identities.some((i) => i.provider === 'feishu')),
      '飞书登录·还没对到主体的人（bob）：停在「等管理员开通」（403），不发会话、不建主体，列进待对接清单', show({ cb: r.cb?.status, listed }));
  }
  {
    const bound = await ops.req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:alpha', reason: '合成：同一个人' } });
    const b = browser(open);
    const r = await feishuLogin(b, fake, 'alice', '/tasks');
    const viaFeishu = await whoami(b);
    const tasks = await b.req('GET', '/api/tasks');
    check(bound.status === 200 && r.cb?.status === 302 && r.cb.location === '/tasks' && b.jar.has('wm_session') && viaFeishu.status === 200 && viaFeishu.sub === 'user:alpha' && tasks.status === 200 && odooAlpha.sub === viaFeishu.sub,
      '飞书登录·管理员把 alice 的飞书身份对到 user:alpha 之后：登录成功、回到 /tasks、发了市场会话；只带市场会话 whoami 是 user:alpha（和 Odoo 登录的是同一个主体），待办 200', show({ bound: bound.status, cb: r.cb?.status, loc: r.cb?.location, viaFeishu, tasks: tasks.status }));
    const g = browser(gated);
    const pre = await g.req('GET', '/api/apps');
    const odooFirst = await browser(gated).req('GET', '/api/apps', { cookies: { session_id: SESSIONS.alpha } }); // Odoo 那边先来过一次，建出 user:alpha
    const okBind = await browser(gated).req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:alpha' } });
    const r2 = await feishuLogin(g, fake, 'alice', '/');
    const inside = await g.req('GET', '/api/apps'), me = await g.req('GET', '/api/auth/me');
    const odooInside = await browser(gated).req('GET', '/api/apps', { cookies: { session_id: SESSIONS.alpha } });
    check(pre.status === 401 && odooFirst.status === 200 && okBind.status === 200 && r2.cb?.status === 302 && inside.status === 200 && me.json?.authenticated === true && me.json?.via === 'session' && me.json?.login === 'alpha' && odooInside.status === 200,
      '登录门开着：没登录 401；飞书登录之后进得来（/api/auth/me 说 via=session、login=alpha）；对照：Odoo 登录照样进得来', show({ pre: pre.status, bind: okBind.status, cb: r2.cb?.status, inside: inside.status, me: me.json, odoo: odooInside.status }));
  }

  // ---------- 二、会话：注销、停用、过期都立即失效 ----------
  {
    const b = browser(open);
    await feishuLogin(b, fake, 'alice');
    const token = b.jar.get('wm_session');
    const before = await whoami(b);
    const out = await b.req('POST', '/api/auth/logout', { headers: { origin: open.base, 'sec-fetch-site': 'same-origin' }, body: {} });
    const after = await whoami(browser(open), { wm_session: token });
    check(before.status === 200 && out.status === 200 && !b.jar.has('wm_session') && after.status !== 200 && after.sub === null, '注销：浏览器的会话 cookie 清掉，拿着原来的会话值再来也不认', show({ before, out: out.status, after }));
  }
  {
    const b = browser(open);
    await feishuLogin(b, fake, 'alice');
    const token = b.jar.get('wm_session');
    const before = await whoami(b);
    const off = await ops.req('POST', '/api/principals/disable', { headers: admin, body: { id: 'user:alpha', reason: '合成' } });
    const during = await whoami(b);
    const relogin = await feishuLogin(browser(open), fake, 'alice');
    const on = await ops.req('POST', '/api/principals/restore', { headers: admin, body: { id: 'user:alpha' } });
    const afterRestore = await whoami(browser(open), { wm_session: token });
    const fresh = browser(open); await feishuLogin(fresh, fake, 'alice');
    const again = await whoami(fresh);
    const unboundPage = (await feishuLogin(browser(open), fake, 'bob')).cb;
    check(before.status === 200 && off.status === 200 && during.status !== 200 && relogin.cb?.status === 403 && relogin.cb.text === unboundPage?.text && unboundPage?.status === 403 && on.status === 200 && afterRestore.status !== 200 && again.status === 200,
      '停用：会话立即失效、再用飞书登录也进不来（403）；等待页和「还没对到主体」的一字不差（不透露有没有这个人、是不是停用了）；恢复之后旧会话也不复活，重新登录才行', show({ before: before.status, during, relogin: relogin.cb?.status, afterRestore, again: again.status }));
  }
  {
    // 不经停用接口、直接在库里停用（离职事件之类的别的代码路径）：会话照样立即失效——认人时连着主体状态查
    const b = browser(open);
    await feishuLogin(b, fake, 'alice');
    const before = await whoami(b);
    const sql = (q, ...a) => { const db = new DatabaseSync(join(open.data, 'workbench-market.db')); try { db.exec('PRAGMA busy_timeout=5000'); return db.prepare(q).run(...a); } finally { db.close(); } };
    sql("UPDATE principals SET status = 'disabled' WHERE id = 'user:alpha'");
    const during = await whoami(b);
    sql("UPDATE principals SET status = 'active' WHERE id = 'user:alpha'");
    const after = await whoami(b);
    check(before.status === 200 && during.status !== 200 && after.status === 200, '库里直接把主体改成停用（不经停用接口、会话没被注销）：会话立即不认；改回启用就认——管住它的是认人时现查主体状态', show({ before: before.status, during, after: after.status }));
  }
  {
    const b = browser(open);
    await feishuLogin(b, fake, 'alice');
    const before = await whoami(b);
    const db = new DatabaseSync(join(open.data, 'workbench-market.db'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('UPDATE market_sessions SET expires_at = ? WHERE revoked_at IS NULL').run(Date.now() - 1); } finally { db.close(); }
    const after = await whoami(b);
    const fresh = browser(open); await feishuLogin(fresh, fake, 'alice');
    check(before.status === 200 && after.status !== 200 && (await whoami(fresh)).status === 200, '过期：到了绝对期限立即不认（把库里的到期时刻改到过去来模拟）；对照：重新登录照常', show({ before: before.status, after }));
  }
  {
    const b = browser(open);
    const forged = await whoami(b, { wm_session: randomBytes(32).toString('base64url') });
    const junk = await whoami(b, { wm_session: '../../etc' });
    check(forged.status !== 200 && junk.status !== 200, '伪造的会话值、形状不对的会话值：不认', show({ forged, junk }));
  }

  {
    // 解绑：凭这条身份发出的会话立即不认；重新绑回去，旧会话也不复活。另一条路径（直接从库里删掉绑定、不经解绑接口）也一样立即不认
    const b = browser(open);
    await feishuLogin(b, fake, 'alice');
    const token = b.jar.get('wm_session');
    const before = await whoami(b);
    const off = await ops.req('POST', '/api/principals/unbind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id } });
    const during = await whoami(browser(open), { wm_session: token });
    const tasks = await browser(open).req('GET', '/api/tasks', { cookies: { wm_session: token } });
    const back = await ops.req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:alpha' } });
    const revived = await whoami(browser(open), { wm_session: token });
    const c = browser(open); await feishuLogin(c, fake, 'alice');
    const fresh = await whoami(c);
    const sql = (q, ...a) => { const db = new DatabaseSync(join(open.data, 'workbench-market.db')); try { db.exec('PRAGMA busy_timeout=5000'); return db.prepare(q).run(...a); } finally { db.close(); } };
    sql("DELETE FROM principal_identities WHERE provider = 'feishu' AND external_id = ?", PEOPLE.alice.union_id);
    const dropped = await whoami(c);
    sql("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('feishu', ?, ?, 'user:alpha')", PEOPLE.alice.union_id, PEOPLE.alice.union_id);
    const restored = await whoami(c);
    // 改绑到别的主体：旧会话不能变成新主体
    const c2 = browser(open); await feishuLogin(c2, fake, 'alice');
    const oldToken = c2.jar.get('wm_session');
    await ops.req('POST', '/api/principals/unbind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id } });
    const toBeta = await ops.req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:beta-feishu', create: true } });
    const moved = await whoami(browser(open), { wm_session: oldToken });
    await ops.req('POST', '/api/principals/unbind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id } });
    await ops.req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:alpha' } });
    check(toBeta.status === 200 && moved.status !== 200 && moved.sub === null, '改绑到别的主体：旧会话不能变成新主体（不认）', show({ toBeta: toBeta.status, moved }));
    check(before.status === 200 && off.status === 200 && during.status !== 200 && tasks.status !== 200 && back.status === 200 && revived.status !== 200 && fresh.status === 200 && dropped.status !== 200 && restored.status === 200,
      '解绑：凭这条身份发出的会话立即不认（whoami、待办都不给）；重新绑回去，旧会话也不复活，重新登录才行；直接从库里删掉绑定（不经解绑接口）也立即不认', show({ before: before.status, during, tasks: tasks.status, revived, fresh: fresh.status, dropped, restored: restored.status }));
  }
  {
    // 登录门开着：解绑之后旧会话立刻进不来（接口 401、/api/auth/me 说没登录、管理员认定不成立）
    const g = browser(gated); await feishuLogin(g, fake, 'alice');
    const token = g.jar.get('wm_session');
    const inside = await g.req('GET', '/api/apps');
    await browser(gated).req('POST', '/api/principals/unbind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id } });
    const old = (path) => browser(gated).req('GET', path, { cookies: { wm_session: token } });
    const [apps, me, adm, viewer] = await Promise.all([old('/api/apps'), old('/api/auth/me'), old('/api/admin/whoami'), old('/api/auth/viewer')]);
    await browser(gated).req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:alpha' } });
    check(inside.status === 200 && apps.status === 401 && me.json?.authenticated === false && adm.status === 401 && viewer.status === 401,
      '登录门开着：解绑之后旧会话立刻进不来（接口 401、/api/auth/me 说没登录、管理员认定、whoami 都拿不到）', show({ inside: inside.status, apps: apps.status, me: me.json?.authenticated, adm: adm.status, viewer: viewer.status }));
  }
  {
    // 回调地址按 MARKET_PUBLIC_URL 拼，不信请求自带的转发主机
    fake.as('alice');
    const r = await browser(open).req('GET', '/login/feishu?next=/', { headers: { 'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'https' } });
    const redirect = r.location ? new URL(r.location).searchParams.get('redirect_uri') : null;
    check(redirect === `${open.base}/login/feishu/callback`, '回调地址按部署配置的对外地址拼，请求里带别的转发主机也不变', show({ redirect }));
  }
  {
    // 库里只存会话令牌的摘要
    const b = browser(open); await feishuLogin(b, fake, 'alice');
    const token = b.jar.get('wm_session');
    const db = new DatabaseSync(join(open.data, 'workbench-market.db'), { readOnly: true });
    let raw; try { raw = db.prepare('SELECT COUNT(*) AS n FROM market_sessions WHERE token_sha256 = ? OR principal_id = ? OR external_id = ?').get(token, token, token).n; } finally { db.close(); }
    check(typeof token === 'string' && token.length === 43 && raw === 0 && (await whoami(b)).status === 200, '会话令牌在库里只存摘要：哪一列里都找不到原值', show({ raw }));
  }
  {
    // 停用的人来登录：不进待对接清单（等待页一样，但清单里不该出现已有主体的人）
    await ops.req('POST', '/api/principals/disable', { headers: admin, body: { id: 'user:alpha' } });
    await feishuLogin(browser(open), fake, 'alice');
    const listed = ((await ops.req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.alice.union_id);
    await ops.req('POST', '/api/principals/restore', { headers: admin, body: { id: 'user:alpha' } });
    check(!listed, '停用的人来登录：看到的是同一页，但不会被列进待对接清单', show({ listed }));
  }

  // ---------- 三、state、回调、next ----------
  {
    const calls = fake.calls.length;
    const b = browser(open);
    const forged = await b.req('GET', `/login/feishu/callback?state=${randomBytes(32).toString('base64url')}&code=synthetic`, { cookies: { wm_login_state: randomBytes(32).toString('base64url') } });
    const noState = await b.req('GET', '/login/feishu/callback?code=synthetic');
    check(forged.status === 400 && noState.status === 400 && !b.jar.has('wm_session') && fake.calls.slice(calls).every((c) => c.path !== '/open-apis/authen/v2/oauth/token'),
      '伪造回调（state 是编的、没有 state）：400，不发会话，也不去飞书换令牌', show({ forged: forged.status, noState: noState.status }));
  }
  {
    const b = browser(open);
    const r = await feishuLogin(b, fake, 'alice');
    const stateCookie = new URL(r.callback).searchParams.get('state');
    const browserHalf = r.start ? null : null;
    const replay = await browser(open).req('GET', r.callback, { cookies: {} });
    // 带着原来那个浏览器半边再来一次（服务端已清掉它的 cookie，这里从发起那一步的应答里拿不到，只能再发起一次拿新的半边去配旧 state）
    const b2 = browser(open);
    await b2.req('GET', '/login/feishu?next=/');
    const replayWithCookie = await b2.req('GET', r.callback);
    check(r.cb?.status === 302 && replay.status === 400 && replayWithCookie.status === 400 && !b2.jar.has('wm_session') && stateCookie && browserHalf === null,
      '重放 state：用过一次的回调链接再用，换个浏览器、带着别的浏览器半边，都 400、不发会话', show({ first: r.cb?.status, replay: replay.status, replayWithCookie: replayWithCookie.status }));
  }
  {
    // 在 A 浏览器发起，把回调链接拿到 B 浏览器里用：B 没有 A 的浏览器半边，不认；A 自己的回调照常
    fake.as('alice');
    const a = browser(open), b = browser(open);
    const start = await a.req('GET', '/login/feishu?next=/tasks');
    const auth = await fetch(start.location, { redirect: 'manual' });
    const callback = auth.headers.get('location');
    await b.req('GET', '/login/feishu?next=/'); // B 自己也发起过一次：手里有一个形状合格、但不是 A 的浏览器半边
    const stolen = await b.req('GET', callback);
    const own = await a.req('GET', callback);
    check(stolen.status === 400 && !b.jar.has('wm_session') && own.status === 302 && a.jar.has('wm_session'),
      'state 绑在发起它的浏览器上：回调链接被拿到别的浏览器里用，400；对照：原浏览器照常登录（被拒的那一次没有把它作废）', show({ stolen: stolen.status, own: own.status }));
  }
  {
    const outs = [];
    for (const next of ['//evil.invalid/x', 'https://evil.invalid/', '/\\evil.invalid', 'javascript:alert(1)', '/api/admin-token', '/login', '/tasks?x=1']) {
      const b = browser(open);
      const r = await feishuLogin(b, fake, 'alice', next);
      outs.push([next, r.cb?.location]);
    }
    const want = ['/', '/', '/', '/', '/', '/', '/tasks?x=1'];
    check(outs.every(([, loc], i) => loc === want[i]), 'next 只收站内路径：外站、协议相对、反斜杠、javascript:、/api/、/login 都回到 /；对照：/tasks?x=1 原样回去', show(outs));
  }
  {
    const b = browser(open);
    let n = 0, last = 0;
    for (let i = 0; i < 22; i++) { const r = await b.req('GET', '/login/feishu?next=/', { headers: { 'x-forwarded-for': '192.0.2.99' } }); if (r.status === 302) n++; last = r.status; }
    check(n === 20 && last === 429, '同一个来源连着发起登录：第 21 次起 429（state 按来源限额）', show({ issued: n, last }));
  }

  // ---------- 四、飞书那边出问题 ----------
  for (const [mode, label, wantStatus] of [
    ['tokenFail', '换令牌失败', 502], ['tokenNotJson', '换令牌回的不是 JSON', 502], ['userinfoFail', '取用户信息失败', 502],
    ['unionMissing', '用户信息里没有 union_id', 502], ['unionTampered', 'union_id 形状不对（被篡改）', 502], ['unionInjected', 'union_id 里塞了别的东西', 502], ['deny', '用户在飞书那边没同意', 401],
  ]) {
    fake.mode(mode);
    const b = browser(open);
    const before = ((await ops.req('GET', '/api/principals', { headers: admin })).json?.principals ?? []).length;
    const r = await feishuLogin(b, fake, 'carol');
    fake.mode('normal');
    const after = ((await ops.req('GET', '/api/principals', { headers: admin })).json?.principals ?? []).length;
    const pendingCarol = ((await ops.req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id.includes(PEOPLE.carol.union_id.slice(3, 20)));
    check(r.cb?.status === wantStatus && !b.jar.has('wm_session') && before === after && !pendingCarol && !r.cb.text.includes(APP.secret),
      `飞书那边：${label} → ${wantStatus}，不发会话、不建主体、不进待对接清单`, show({ status: r.cb?.status }));
  }
  {
    fake.mode('tokenHang');
    const b = browser(open);
    const t0 = Date.now();
    const r = await feishuLogin(b, fake, 'carol');
    const ms = Date.now() - t0;
    fake.mode('normal');
    check(r.cb?.status === 502 && ms < 15000 && !b.jar.has('wm_session'), '换令牌永远不回答：有期限，按不可用处理（502），不一直挂着', `${ms} 毫秒，${r.cb?.status}`);
  }
  {
    const leaked = fake.calls.filter((c) => c.path !== '/open-apis/authen/v2/oauth/token' && JSON.stringify(c).includes(APP.secret));
    const tokenCalls = fake.calls.filter((c) => c.path === '/open-apis/authen/v2/oauth/token');
    check(leaked.length === 0 && tokenCalls.length > 0 && !open.log().includes(APP.secret), '应用密钥只发给换令牌那一步：授权页、取用户信息的请求里都没有它，日志里也没有', `${leaked.length} 处泄漏`);
  }

  // ---------- 五、部署配置 ----------
  {
    const locked = await boot('locked', fake, { DSH_VAULT_PASSWORD: null });
    const noEntry = await boot('no-entry', fake, { NO_VAULT_ENTRY: '1' });
    const a = await browser(locked).req('GET', '/login/feishu?next=/'), b = await browser(noEntry).req('GET', '/login/feishu?next=/');
    check(a.status === 503 && b.status === 503 && !a.location && !b.location, '凭据库锁着（没配服务端主密码）、库里没有这一条：发起登录 503，不跳去飞书', show({ locked: a.status, noEntry: b.status }));
    await locked.stop(); await noEntry.stop();
  }
  {
    const off = await boot('off', fake, { WM_FEISHU_LOGIN: null });
    const r = await browser(off).req('GET', '/login/feishu?next=/'), cb = await browser(off).req('GET', `/login/feishu/callback?state=${randomBytes(32).toString('base64url')}`);
    const page = await browser(off).req('GET', '/login', { headers: { accept: 'text/html' } });
    check(r.status === 404 && cb.status === 400 && !page.text.includes('/login/feishu'), '没打开飞书登录：发起 404，登录页上没有飞书的按钮', show({ start: r.status, cb: cb.status }));
    await off.stop();
  }
  {
    const tenant = await boot('tenant', fake, { WM_FEISHU_TENANT_KEY: 'tenant_synthetic' });
    await browser(tenant).req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:alice', create: true } });
    fake.mode('otherTenant');
    const b = browser(tenant); const r = await feishuLogin(b, fake, 'alice'); // alice 的身份绑过 user:alice，换成别的租户来
    fake.mode('normal');
    const pendingOther = ((await browser(tenant).req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.alice.union_id);
    const outsiderLine = tenant.log().split('\n').filter((l) => l.includes('"event":"outsider"'));
    const unboundPage = (await feishuLogin(browser(tenant), fake, 'bob')).cb;
    const b2 = browser(tenant); const ok = await feishuLogin(b2, fake, 'alice');
    check(r.cb?.status === 403 && !b.jar.has('wm_session') && r.cb.text === unboundPage?.text && pendingOther && outsiderLine.length === 1 && ok.cb?.status === 302 && b2.jar.has('wm_session'),
      '配了租户：别的租户的人哪怕身份被绑过也拿不到会话，只进待对接清单并留一行痕，看到的是同一张等待页；对照：本租户的人照常', show({ other: r.cb?.status, pendingOther, lines: outsiderLine.length, own: ok.cb?.status }));
    // 配了租户、但没打开按邮箱自动对上：本租户的人邮箱对得上也不自动绑（开关缺省关）
    await browser(tenant).req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'fake', external_id: 'dave@synthetic.invalid', principal: 'user:dave-t', create: true } });
    const d = browser(tenant); const dl = await feishuLogin(d, fake, 'dave');
    check(dl.cb?.status === 403 && !d.jar.has('wm_session'), '配了租户、没打开自动对上：本租户的人企业邮箱对得上也不自动绑（开关缺省关）', show({ dave: dl.cb?.status }));
    await tenant.stop();
  }
  {
    // 按邮箱自动对上：缺省关；打开之后，企业邮箱和 Odoo 登录名（规范化之后）恰好对上一个启用的人才绑
    const auto = await boot('auto', fake, { WM_FEISHU_AUTO_BIND_EMAIL: 'on', WM_FEISHU_TENANT_KEY: 'tenant_synthetic' });
    const mk = (srv) => browser(srv).req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'fake', external_id: 'DAVE@synthetic.invalid', principal: 'user:dave', create: true } }); // 身份来源的外部身份（这里身份来源是假提供方，名叫 fake）
    await mk(auto); await mk(open);
    const a = browser(auto); const ra = await feishuLogin(a, fake, 'dave');
    const viaAuto = await whoami(a);
    const o = browser(open); const ro = await feishuLogin(o, fake, 'dave');
    const autoLine = auto.log().split('\n').filter((l) => l.includes('"by":"auto:email"'));
    check(ra.cb?.status === 302 && viaAuto.sub === 'user:dave' && ro.cb?.status === 403 && !o.jar.has('wm_session') && autoLine.length === 1 && autoLine[0].includes('"id":"user:dave"'),
      '按邮箱自动对上：缺省关（等管理员处理，403）；打开之后企业邮箱和身份来源的登录名（大小写不同）对上，就是 user:dave，并留一行痕', show({ auto: ra.cb?.status, sub: viaAuto.sub, off: ro.cb?.status, lines: autoLine.length }));
    // 不绑的情形：那个主体已经有别的飞书身份；那个主体停用了
    const mkAuto = (body) => browser(auto).req('POST', '/api/principals/bind', { headers: admin, body });
    await mkAuto({ provider: 'fake', external_id: 'alice@synthetic.invalid', principal: 'user:alice-odoo', create: true });
    await mkAuto({ provider: 'feishu', external_id: 'on_00000000000000000000000000000001', principal: 'user:alice-odoo' });
    const a2 = browser(auto); const already = await feishuLogin(a2, fake, 'alice');
    await mkAuto({ provider: 'fake', external_id: 'bob@synthetic.invalid', principal: 'user:bob-odoo', create: true });
    await browser(auto).req('POST', '/api/principals/disable', { headers: admin, body: { id: 'user:bob-odoo' } });
    const b2 = browser(auto); const disabled = await feishuLogin(b2, fake, 'bob');
    check(already.cb?.status === 403 && !a2.jar.has('wm_session') && disabled.cb?.status === 403 && !b2.jar.has('wm_session') && already.cb.text === disabled.cb.text,
      '自动对上也有不绑的时候：那个主体已经绑了另一个飞书身份、那个主体停用了——都不绑，照「等管理员处理」走（同一页）', show({ already: already.cb?.status, disabled: disabled.cb?.status }));
    // 别的租户的人、企业邮箱和本地某人的登录名相同：插件按租户拒（403），不绑、不进清单
    await mkAuto({ provider: 'fake', external_id: 'carol-mail@synthetic.invalid', principal: 'user:carol-odoo', create: true });
    fake.mode('otherTenant');
    const x = browser(auto); const cross = await feishuLogin(x, fake, 'frank');
    fake.mode('normal');
    const pendingCross = ((await browser(auto).req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.frank.union_id);
    const crossBound = ((await browser(auto).req('GET', '/api/principals', { headers: admin })).json?.principals ?? []).some((p) => p.identities.some((i) => i.external_id === PEOPLE.frank.union_id));
    check(cross.cb?.status === 403 && !x.jar.has('wm_session') && pendingCross && !crossBound, '打开了自动对上：别的租户的人（企业邮箱和本地登录名相同）403，不自动绑、不发会话，只进待对接清单', show({ cross: cross.cb?.status, pendingCross, crossBound }));
    // 核心那一道：登录方式交回的邮箱没说来自本组织（emailTrusted=false），哪怕这个登录方式打开了自动对上、邮箱对得上，也不绑
    const u = await boot('untrusted-flow', fake, { IDENTITY_FAKE_UNTRUSTED_FLOW: '1' });
    await browser(u).req('POST', '/api/principals/bind', { headers: admin, body: { provider: 'fake', external_id: 'erin@synthetic.invalid', principal: 'user:erin', create: true } });
    const ub = browser(u);
    const st = await ub.req('GET', '/login/untrusted?next=/');
    const state = st.location ? new URL(st.location).searchParams.get('state') : '';
    const cb = await ub.req('GET', `/login/untrusted/callback?state=${encodeURIComponent(state)}&who=outsider-0001&email=${encodeURIComponent('ERIN@synthetic.invalid')}`);
    const boundUntrusted = ((await browser(u).req('GET', '/api/principals', { headers: admin })).json?.principals ?? []).find((p) => p.id === 'user:erin')?.identities.some((i) => i.provider === 'untrusted');
    check(st.status === 302 && cb.status === 403 && !ub.jar.has('wm_session') && !boundUntrusted, '核心这一道：登录方式交回的邮箱没确认来自本组织，哪怕打开了自动对上、邮箱对得上，也不绑、不发会话', show({ start: st.status, cb: cb.status, boundUntrusted }));
    await u.stop();
    // 打开自动对上却没配租户：拒绝启动
    const noTenant = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, HOME: join(OUT, 'nt-home'), NODE_ENV: 'test', IDENTITY_SEAM_ROOT: ROOT, DATA_DIR: join(OUT, 'nt-data'), PORT: '0', WM_CONTROL_PORT: '0', MCP_GATEWAY: 'on', WM_FEISHU_LOGIN: 'on', WM_FEISHU_AUTO_BIND_EMAIL: 'on' }, encoding: 'utf8', timeout: 30000 });
    check(noTenant.status !== 0 && /WM_FEISHU_TENANT_KEY/.test(noTenant.stderr), '打开按邮箱自动对上、却没配租户：拒绝启动并说明', `status=${noTenant.status} ${String(noTenant.stderr).trim().split('\n').filter((l) => l.includes('feishu')).slice(0, 1)}`);
    await auto.stop();
  }
  {
    // 两种登录同时带着：市场会话优先
    const b = browser(open);
    await feishuLogin(b, fake, 'alice');
    const both = await b.req('GET', '/api/admin/whoami', { cookies: { session_id: SESSIONS.admin } });
    const odooOnly = await browser(open).req('GET', '/api/admin/whoami', { cookies: { session_id: SESSIONS.admin } });
    await new Promise((done) => setTimeout(done, 500)); // 留痕在后台做
    const lines = open.log().split('\n').filter((l) => l.includes('"event":"session-mismatch"'));
    const same = browser(open); await feishuLogin(same, fake, 'alice');
    await same.req('GET', '/api/admin/whoami', { cookies: { session_id: SESSIONS.alpha } }); await new Promise((done) => setTimeout(done, 300));
    const linesAfter = open.log().split('\n').filter((l) => l.includes('"event":"session-mismatch"'));
    check(both.json?.admin === false && odooOnly.json?.admin === true && lines.length === 1 && lines[0].includes('"session":"user:alpha"') && lines[0].includes('"other":"user:root-admin"') && linesAfter.length === 1,
      '同时带着市场会话（alpha）和 Odoo 管理员会话：按市场会话算，不是管理员，并留一行痕（两边各认成谁）；对照：只带 Odoo 会话是管理员；两边是同一个人时不留痕', show({ both: both.json, odooOnly: odooOnly.json, lines: lines.length, linesAfter: linesAfter.length }));
  }
  {
    // 成批对接：逐条给结果，一条不成不影响别的
    const items = [
      { provider: 'feishu', external_id: PEOPLE.bob.union_id, principal: 'user:bob', create: true, display_name: 'Bob' },
      { provider: 'feishu', external_id: PEOPLE.alice.union_id, principal: 'user:bob' },
      { provider: 'Bad!', external_id: 'x', principal: 'user:bob' },
      { provider: 'feishu', external_id: PEOPLE.carol.union_id, principal: 'user:nobody-here' },
    ];
    const r = await ops.req('POST', '/api/principals/bind-batch', { headers: admin, body: { items, reason: '合成：第一批' } });
    const staff = await browser(open).req('POST', '/api/principals/bind-batch', { cookies: { session_id: SESSIONS.beta }, body: { items } });
    const tooMany = await ops.req('POST', '/api/principals/bind-batch', { headers: admin, body: { items: Array.from({ length: 501 }, () => items[0]) } });
    const res = r.json?.results ?? [];
    const b = browser(open); const login = await feishuLogin(b, fake, 'bob');
    const pendingBob = ((await ops.req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.bob.union_id);
    check(r.status === 200 && r.json?.bound === 1 && res[0]?.ok === true && res[1]?.reason === 'conflict' && res[2]?.status === 400 && res[3]?.reason === 'missing' && staff.status === 403 && tooMany.status === 400
      && login.cb?.status === 302 && (await whoami(b)).sub === 'user:bob' && !pendingBob,
      '成批对接：逐条给结果（绑上、已绑在别人身上、形状不对、目标不存在各一条）；不是管理员 403、超过 500 条 400；绑上的 bob 能登录了，也从待对接清单里消失', show({ status: r.status, bound: r.json?.bound, res: res.map((x) => x.ok || x.reason || x.status) }));
  }
  {
    // 待对接清单：只放最少的信息，保留 30 天
    await feishuLogin(browser(open), fake, 'carol');
    const listed = ((await ops.req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).find((p) => p.external_id === PEOPLE.carol.union_id);
    const db = new DatabaseSync(join(open.data, 'workbench-market.db'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare("UPDATE principal_pending SET last_seen = datetime('now', '-31 days') WHERE external_id = ?").run(PEOPLE.carol.union_id); } finally { db.close(); }
    const gone = !((await ops.req('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.carol.union_id);
    const db2 = new DatabaseSync(join(open.data, 'workbench-market.db'), { readOnly: true });
    let rows; try { rows = db2.prepare('SELECT COUNT(*) AS n FROM principal_pending WHERE external_id = ?').get(PEOPLE.carol.union_id).n; } finally { db2.close(); }
    check(listed && show(Object.keys(listed).sort()) === show(['display_name', 'email', 'external_id', 'last_seen', 'provider']) && gone && rows === 0,
      '待对接清单只有认人需要的最少信息（提供方、用户标识、显示名、企业邮箱、最近一次来的时间）；超过 30 天没再来的清掉（表里也没有了）', show({ listed, gone, rows }));
  }
  {
    // 会话期限的配置：不是数字、超出范围都拒绝启动，不悄悄回落
    const tries = ['abc', '10', '10081', '12.5', ' '].map((v) => {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, HOME: join(OUT, 'ttl-home'), NODE_ENV: 'test', IDENTITY_SEAM_ROOT: ROOT, DATA_DIR: join(OUT, 'ttl-data'), PORT: '0', WM_CONTROL_PORT: '0', MCP_GATEWAY: 'on', WM_SESSION_TTL_MIN: v }, encoding: 'utf8', timeout: 30000 });
      return [v, r.status, /WM_SESSION_TTL_MIN/.test(r.stderr)];
    });
    check(tries.slice(0, 4).every(([, status, said]) => status === 1 && said), '会话期限 WM_SESSION_TTL_MIN 不是整数、少于 15 分钟、多于 7 天：拒绝启动并说明', show(tries));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  for (const srv of running) await srv.stop();
  await fake.close();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`feishu-login-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
