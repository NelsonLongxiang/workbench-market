#!/usr/bin/env node
/**
 * 离职即时失效的对抗组（安全面）：飞书通讯录事件和每日对账。真实的 server/src/index.ts；Odoo 一侧是假提供方，
 * 飞书是真插件对本机起的假飞书（feishu-fake.mjs）；事件照飞书的规则加密、签名（signedEvent）。
 * 只在 127.0.0.1 上，不访问任何真实的外部系统。
 *
 *   node scripts/feishu-offboard-smoke.mjs              测本仓库
 *   node scripts/feishu-offboard-smoke.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { APP, PEOPLE, contactEvent, signedEvent, startFakeFeishu } from './feishu-fake.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `feishu-offboard-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-feishu-offboard-admin';
const MASTER = 'Synthetic-Vault-Master-2026!feishu-offboard';
const REMOTE = { 'x-forwarded-for': '192.0.2.30' };
const admin = { 'x-admin-token': ADMIN_TOKEN };

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

async function makeVault(file, fields) {
  const { openVault } = await import(pathToFileURL(join(ROOT, 'server/src/vault/store.ts')).href);
  const store = await openVault({ masterPassword: MASTER, path: file });
  await store.add({ title: 'feishu-login', kind: 'login', username: APP.id, password: APP.secret, fields });
  await store.lock();
}

const running = [];
async function boot(name, fake, extraEnv = {}, vaultFields = { encrypt_key: APP.encryptKey, verification_token: APP.verificationToken }) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), vault = join(OUT, name, 'vault', 'default.json');
  mkdirSync(data, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(dirname(vault), { recursive: true });
  await makeVault(vault, vaultFields);
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '',
    IDENTITY_SEAM_ROOT: ROOT, MARKET_PUBLIC_URL: `http://127.0.0.1:${port}`, WM_VAULT_PATH: vault, DSH_VAULT_PASSWORD: MASTER, ...fake.env, ...extraEnv,
  });
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
  const call = async (method, path, { headers = {}, body, cookies = {}, raw } = {}) => {
    const h = { ...REMOTE, ...headers };
    const c = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (c) h.cookie = c;
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, location: res.headers.get('location') ?? '', setCookie: res.headers.getSetCookie(), text, json };
    } catch (e) { return { status: 0, location: '', setCookie: [], text: String(e?.name ?? e), json: null }; }
  };
  const srv = { name, base, data, stop, call, log: () => log };
  running.push(srv);
  return srv;
}

/** 走一遍飞书登录，返回市场会话的值 */
async function feishuSession(srv, fake, person) {
  fake.as(person);
  const start = await srv.call('GET', '/login/feishu?next=/');
  const browser = (start.setCookie.find((c) => c.startsWith('wm_login_state=')) ?? '').split(';')[0].split('=')[1];
  const auth = await fetch(start.location, { redirect: 'manual' });
  const cb = new URL(auth.headers.get('location'));
  const done = await srv.call('GET', cb.pathname + cb.search, { cookies: { wm_login_state: browser } });
  return (done.setCookie.find((c) => c.startsWith('wm_session=')) ?? '').split(';')[0].split('=')[1] ?? '';
}

const post = (srv, ev) => srv.call('POST', '/login/feishu/events', { raw: ev.body, headers: ev.headers });
const bind = (srv, external, principal, create = false) => srv.call('POST', '/api/principals/bind', { headers: admin, body: { provider: 'feishu', external_id: PEOPLE[external].union_id, principal, create } });
const statusOf = async (srv, id) => ((await srv.call('GET', '/api/principals', { headers: admin })).json?.principals ?? []).find((p) => p.id === id)?.status ?? null;
const restore = (srv, id) => srv.call('POST', '/api/principals/restore', { headers: admin, body: { id } });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const fake = await startFakeFeishu();
try {
  const open = await boot('open', fake);
  const gated = await boot('gated', fake, { WM_LOGIN_GATE: 'enforce' });

  // 准备：alpha 用 Odoo 登录过（建出 user:alpha），他的飞书身份（alice）也绑在 user:alpha 上；bob、carol 各自一个人
  for (const srv of [open, gated]) {
    await srv.call('GET', '/api/auth/viewer', { cookies: { session_id: SESSIONS.alpha } });
    await bind(srv, 'alice', 'user:alpha');
    await bind(srv, 'bob', 'user:bob', true);
    await bind(srv, 'carol', 'user:carol', true);
  }

  // ---------- 一、离职事件：主体停用，所有入口立即拒绝 ----------
  {
    const s = await feishuSession(open, fake, 'alice');
    const before = (await open.call('GET', '/api/auth/viewer', { cookies: { wm_session: s } })).status;
    const odooBefore = (await open.call('GET', '/api/auth/viewer', { cookies: { session_id: SESSIONS.alpha } })).status;
    const r = await post(open, signedEvent(contactEvent('contact.user.deleted_v3', 'alice')));
    const entries = await Promise.all([
      open.call('GET', '/api/auth/viewer', { cookies: { wm_session: s } }), open.call('GET', '/api/tasks', { cookies: { wm_session: s } }),
      open.call('GET', '/api/auth/viewer', { cookies: { session_id: SESSIONS.alpha } }), open.call('GET', '/api/tasks', { cookies: { session_id: SESSIONS.alpha } }),
    ]);
    const relogin = await feishuSession(open, fake, 'alice');
    const status = await statusOf(open, 'user:alpha');
    const line = open.log().split('\n').filter((l) => l.includes('"event":"offboard"') && l.includes('"id":"user:alpha"'));
    check(before === 200 && odooBefore === 200 && r.status === 200 && entries.every((e) => e.status !== 200) && !relogin && status === 'disabled' && line.length === 1 && line[0].includes('"by":"event:feishu"'),
      '员工离职事件（飞书）：主体立即停用——飞书会话、同一个人的 Odoo 登录、待办都拒绝，再用飞书登录也拿不到会话；留一行痕', show({ before, odooBefore, event: r.status, entries: entries.map((e) => e.status), relogin: !!relogin, status, lines: line.length }));
    await restore(open, 'user:alpha');
    const revived = (await open.call('GET', '/api/auth/viewer', { cookies: { wm_session: s } })).status;
    check(revived !== 200, '离职事件之后恢复主体：离职时那个会话已经注销，不复活', show({ revived }));
    // 登录门开着的实例
    const g = await feishuSession(gated, fake, 'bob');
    const inside = (await gated.call('GET', '/api/apps', { cookies: { wm_session: g } })).status;
    await post(gated, signedEvent(contactEvent('contact.user.deleted_v3', 'bob')));
    const [apps, me, page] = await Promise.all([
      gated.call('GET', '/api/apps', { cookies: { wm_session: g } }), gated.call('GET', '/api/auth/me', { cookies: { wm_session: g } }),
      gated.call('GET', '/', { cookies: { wm_session: g }, headers: { accept: 'text/html' } })]);
    check(inside === 200 && apps.status === 401 && me.json?.authenticated === false && page.status === 302, '登录门开着：离职事件之后，接口 401、/api/auth/me 说没登录、页面跳去登录', show({ inside, apps: apps.status, me: me.json?.authenticated, page: page.status }));
    await restore(gated, 'user:bob');
  }
  {
    // 员工信息被修改：离职、冻结、退出才停用；别的修改不停用
    const resigned = await post(open, signedEvent(contactEvent('contact.user.updated_v3', 'bob', { status: { is_resigned: true } })));
    const afterResigned = await statusOf(open, 'user:bob');
    await restore(open, 'user:bob');
    const frozen = await post(open, signedEvent(contactEvent('contact.user.updated_v3', 'bob', { status: { is_frozen: true } })));
    const afterFrozen = await statusOf(open, 'user:bob');
    await restore(open, 'user:bob');
    const renamed = await post(open, signedEvent(contactEvent('contact.user.updated_v3', 'bob')));
    const afterRename = await statusOf(open, 'user:bob');
    check(resigned.status === 200 && afterResigned === 'disabled' && frozen.status === 200 && afterFrozen === 'disabled' && renamed.status === 200 && afterRename === 'active',
      '员工信息被修改：改成离职、冻结 → 停用；对照：别的修改（状态都正常）不停用', show({ afterResigned, afterFrozen, afterRename }));
  }

  // ---------- 二、伪造的事件不生效 ----------
  {
    const ev = () => contactEvent('contact.user.deleted_v3', 'carol');
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      ['没有签名头', (() => { const e = signedEvent(ev()); return { body: e.body, headers: { 'content-type': 'application/json' } }; })()],
      ['签名不对', (() => { const e = signedEvent(ev()); return { ...e, headers: { ...e.headers, 'x-lark-signature': 'f'.repeat(64) } }; })()],
      ['签名之后改了请求体', signedEvent(ev(), { tamper: (b) => b.replace(/"encrypt":"./, (m) => m.slice(0, -1) + (m.endsWith('A') ? 'B' : 'A')) })],
      ['时间戳是 10 分钟前的（重放旧请求）', signedEvent(ev(), { timestamp: now - 600 })],
      ['时间戳在 10 分钟后', signedEvent(ev(), { timestamp: now + 600 })],
      ['用别的 Encrypt Key 签名、加密', signedEvent(ev(), { encryptKey: 'attacker-encrypt-key' })],
      ['Verification Token 不对', signedEvent(contactEvent('contact.user.deleted_v3', 'carol', { token: 'attacker-token' }))],
      ['App ID 不对', signedEvent(contactEvent('contact.user.deleted_v3', 'carol', { appId: 'cli_attacker' }))],
      ['不是 JSON 的请求体', (() => { const e = signedEvent(ev()); return { ...e, body: 'not json' }; })()],
    ];
    const results = [];
    for (const [label, e] of cases) results.push([label, (await post(open, e)).status]);
    const still = await statusOf(open, 'user:carol');
    // 不是 JSON 的请求体在全局 JSON 解析器那里就被拒了（400），到不了路由；其余都是插件验签不过（401）
    const ok = results.every(([label, s]) => (label.startsWith('不是 JSON') ? s === 400 : s === 401)) && still === 'active';
    check(ok, `伪造的事件（${cases.length} 种）：都被拒（验签不过 401，请求体不是 JSON 400），carol 照常启用`, show({ results, still }));
    const real = await post(open, signedEvent(ev()));
    check(real.status === 200 && (await statusOf(open, 'user:carol')) === 'disabled' && ok, '对照：签名、来源都对的同一个事件 → 停用', show({ real: real.status }));
    await restore(open, 'user:carol');
  }
  {
    // 重放：同一个事件号只处理一次（中间恢复了，再收到同一个事件不会再停用）
    const e = signedEvent(contactEvent('contact.user.deleted_v3', 'carol', { eventId: 'evt-replay-0001' }));
    const first = await post(open, e);
    await restore(open, 'user:carol');
    const again = await post(open, signedEvent(contactEvent('contact.user.deleted_v3', 'carol', { eventId: 'evt-replay-0001' })));
    const after = await statusOf(open, 'user:carol');
    check(first.status === 200 && again.status === 200 && after === 'active', '同一个事件号重放（哪怕重新签名）：回 200 但不再处理——恢复之后不会被同一个事件再停用一次', show({ first: first.status, again: again.status, after }));
  }
  {
    // URL 校验：回 challenge；Token 不对不回
    const ok = await post(open, signedEvent({ challenge: 'synthetic-challenge-1', token: APP.verificationToken, type: 'url_verification' }));
    const bad = await post(open, signedEvent({ challenge: 'synthetic-challenge-2', token: 'attacker-token', type: 'url_verification' }));
    check(ok.status === 200 && ok.json?.challenge === 'synthetic-challenge-1' && bad.status === 401 && !bad.text.includes('synthetic-challenge-2'), '事件订阅的 URL 校验：Token 对才回 challenge', show({ ok: ok.json, bad: bad.status }));
  }
  {
    // 还没对到主体的人离职：不停用任何人，从待对接清单里删掉
    fake.as('dave'); await feishuSession(open, fake, 'dave');
    const listed = ((await open.call('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.dave.union_id);
    const r = await post(open, signedEvent(contactEvent('contact.user.deleted_v3', 'dave')));
    const gone = !((await open.call('GET', '/api/principals/pending', { headers: admin })).json?.pending ?? []).some((p) => p.external_id === PEOPLE.dave.union_id);
    const actives = ((await open.call('GET', '/api/principals', { headers: admin })).json?.principals ?? []).filter((p) => p.status !== 'active').length;
    check(listed && r.status === 200 && gone && actives === 0, '还没对到主体的人离职：不停用任何人，从待对接清单里删掉', show({ listed, gone, actives }));
  }

  // ---------- 三、配置和别的租户 ----------
  {
    // 没打开时事件路由要是不拒，启动自检那一行先拦住、实例起不来：也算这一例没过（具名失败，不当成没跑完）
    let off = null, offBoot = null;
    try { off = await boot('off', fake, { WM_FEISHU_LOGIN: null }); } catch (e) { offBoot = String(e?.message ?? e).slice(0, 300); }
    const a = off ? await post(off, signedEvent(contactEvent('contact.user.deleted_v3', 'alice'))) : { status: null };
    const noKey = await boot('no-key', fake, {}, {});
    const b = await post(noKey, signedEvent(contactEvent('contact.user.deleted_v3', 'alice')));
    check(a.status === 401 && b.status === 503, '没打开飞书登录：事件 401（和验签不过同一个应答）；凭据里没有 Encrypt Key、Verification Token：503，不处理', show({ off: a.status, offBoot, noKey: b.status }));
    await off?.stop(); await noKey.stop();
    const tenant = await boot('tenant', fake, { WM_FEISHU_TENANT_KEY: APP.tenant });
    await bind(tenant, 'alice', 'user:alice-t', true);
    const other = await post(tenant, signedEvent(contactEvent('contact.user.deleted_v3', 'alice', { tenant: 'tenant_other' })));
    const afterOther = await statusOf(tenant, 'user:alice-t');
    const own = await post(tenant, signedEvent(contactEvent('contact.user.deleted_v3', 'alice')));
    check(other.status === 200 && afterOther === 'active' && own.status === 200 && (await statusOf(tenant, 'user:alice-t')) === 'disabled', '配了租户：别的租户的事件回 200 但不处理；对照：本租户的同一个事件停用', show({ other: other.status, afterOther }));
    await tenant.stop();
  }

  // ---------- 四、对账补上漏掉的事件 ----------
  {
    // bob 在飞书那边离职了，但事件没到；dave 查不到（出错）；alice（user:alpha）照常在职
    const recon = await boot('recon', fake);
    await recon.call('GET', '/api/auth/viewer', { cookies: { session_id: SESSIONS.alpha } });
    await bind(recon, 'alice', 'user:alpha'); await bind(recon, 'bob', 'user:bob', true); await bind(recon, 'carol', 'user:carol', true); await bind(recon, 'dave', 'user:dave', true);
    const s = await feishuSession(recon, fake, 'bob');
    fake.setStatus('bob', { is_resigned: true });
    fake.breakLookup('dave');
    const staff = await recon.call('POST', '/api/principals/reconcile', { cookies: { session_id: SESSIONS.alpha }, body: { flow: 'feishu' } });
    const r = await recon.call('POST', '/api/principals/reconcile', { headers: admin, body: { flow: 'feishu' } });
    const states = { bob: await statusOf(recon, 'user:bob'), dave: await statusOf(recon, 'user:dave'), alpha: await statusOf(recon, 'user:alpha'), carol: await statusOf(recon, 'user:carol') };
    const bobSession = (await recon.call('GET', '/api/auth/viewer', { cookies: { wm_session: s } })).status;
    const line = recon.log().split('\n').filter((l) => l.includes('"event":"reconcile"'));
    check(staff.status === 403 && r.status === 200 && r.json?.checked === 4 && show(r.json?.disabled) === show(['user:bob']) && r.json?.unknown === 1
      && states.bob === 'disabled' && states.dave === 'active' && states.alpha === 'active' && states.carol === 'active' && bobSession !== 200 && line.length === 1,
      '对账：事件没到的离职（bob）被补上、会话立即失效；查不到的（dave）不停用、计入 unknown；在职的不动；不是管理员不能手动触发；留一行痕', show({ staff: staff.status, r: r.json, states, bobSession }));
    // 取不到 tenant_access_token：一个也不停用
    await restore(recon, 'user:bob');
    fake.mode('tenantTokenFail');
    const r2 = await recon.call('POST', '/api/principals/reconcile', { headers: admin, body: { flow: 'feishu' } });
    fake.mode('normal');
    check(r2.status === 200 && r2.json?.disabled?.length === 0 && r2.json?.unknown === 4 && (await statusOf(recon, 'user:bob')) === 'active', '对账时飞书那边出错（取不到令牌）：一个也不停用，全部计入 unknown', show(r2.json));
    const bad = await recon.call('POST', '/api/principals/reconcile', { headers: admin, body: { flow: 'odoo' } });
    check(bad.status === 404, '不能对账的登录方式：404', show({ status: bad.status }));
    fake.setStatus('bob', {});
    await recon.stop();
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  for (const srv of running) await srv.stop();
  await fake.close();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`feishu-offboard-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
