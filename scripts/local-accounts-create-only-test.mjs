#!/usr/bin/env node
/**
 * 站内账号的核准、管理员建账号只新建人，不接到已有的人身上（docs/local-accounts.md）。
 * 隔离实例（NODE_ENV=test），注册、登录都走浏览器的真实路径；合成的人：olga 持 owner（完整管理员）、sam 持 admin（系统管理员）。
 *
 *   一、先注册 victim（那时还没有这个人）；之后 user:victim 出现了（合成：管理员把别的登录方式的身份连新建绑上，再给他 owner）
 *       列表里这个待核准的账号标出 name_taken
 *   二、系统管理员核准：409（这个名字已经属于一个现有的人），没有接上；注册的人照旧登不进（不是 user:victim，业务面不过）
 *   三、完整管理员（管理口令）核准：同样 409，没有接上
 *   四、管理员建账号（N2）：user:nora 已经有人（持 owner），建 nora：409，不给临时密码，账号没留下
 *   四b、只差大小写的同名也算已经有人
 *   五、对照：没人用的名字照常——核准新注册的 zack 新建 user:zack；建 yara 新建 user:yara
 *   六、真是同一个人：完整管理员用「绑定到现有主体」把站内账号 victim 绑到 user:victim，照常（显式操作）
 *
 *   node scripts/local-accounts-create-only-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `local-accounts-create-only-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-create-only-admin';
const BUSY_MS = 10_000;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const children = [];
let log = '';
rmSync(OUT, { recursive: true, force: true });

/** 起一个隔离实例；mode=env 启动环境给口令，mode=db 不给（口令存库） */
async function boot(mode) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = join(OUT, mode), data = join(dir, 'data'), home = join(dir, 'home'), ext = join(dir, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', WM_EXTENSIONS_DIR: ext, MARKET_PUBLIC_URL: base, WM_TRUSTED_PROXIES: '127.0.0.1' });
  if (mode === 'env') env.ADMIN_TOKEN = ADMIN_TOKEN;
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
  return { base, browser, login, cli, grant, person, db };
}


try {
  const A = await boot('env');
  const token = (method, path, json) => fetch(new URL(path, A.base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: json === undefined ? undefined : JSON.stringify(json) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const olga = await A.person('olga', 'Olga-pass-00001', '192.0.2.71'); await A.grant('user:olga', 'owner');
  const sam = await A.person('sam', 'Sam-pass-000001', '192.0.2.72'); await A.grant('user:sam', 'admin');
  const signup = async (username, password, ip) => {
    const b = A.browser(ip);
    const r0 = await b.go('GET', '/login/local?next=/');
    const form = r0.location ? new URL(r0.location).pathname + new URL(r0.location).search : '';
    return b.go('POST', form, { form: { mode: 'signup', username, password, confirm: password } });
  };
  const biz = async (b) => (await b.go('GET', '/api/work-items?view=all')).status;
  const account = async (u) => ((await token('GET', '/api/local-accounts')).json?.accounts ?? []).find((a) => a.username === u);

  // ---------- 一 ----------
  const reg = await signup('victim', 'Victim-pass-0001', '192.0.2.81');
  const before = await account('victim');
  const made = await A.cli('POST', '/api/principals/bind', { provider: 'odoo', external_id: 'victim', principal: 'user:victim', create: true, reason: '合成：他第一次从别的登录方式进来' });
  const gv = await A.grant('user:victim', 'owner');
  const after = await account('victim');
  check([302, 200].includes(reg.status) && before?.pending === true && before.name_taken === false && made.status === 200 && gv.status === 200 && after?.pending === true && after.name_taken === true,
    '一、先注册 victim，之后 user:victim 出现了（持 owner）：列表里这个待核准的账号标出 name_taken', { reg: reg.status, before, made: made.status, after });

  // ---------- 二 ----------
  const bySam = await sam.go('POST', '/api/local-accounts/victim/approve');
  const asVictim = await A.login('victim', 'Victim-pass-0001', '', '192.0.2.82');
  const meV = (await asVictim.go('GET', '/api/auth/me')).json?.principal ?? null;
  check(bySam.status === 409 && bySam.json?.reason === 'exists' && /已经属于一个现有的人/.test(bySam.json?.error ?? '') && (await account('victim'))?.principal === null && meV !== 'user:victim' && (await biz(asVictim)) !== 200,
    '二、系统管理员核准：409（这个名字已经属于一个现有的人），没有接上；注册的人登不成 user:victim，业务面不过', { bySam: [bySam.status, bySam.json], meV, biz: await biz(asVictim) });

  // ---------- 三 ----------
  const byToken = await token('POST', '/api/local-accounts/victim/approve');
  const asVictim2 = await A.login('victim', 'Victim-pass-0001', '', '192.0.2.83');
  const meV2 = (await asVictim2.go('GET', '/api/auth/me')).json?.principal ?? null;
  check(byToken.status === 409 && byToken.json?.reason === 'exists' && (await account('victim'))?.principal === null && meV2 !== 'user:victim',
    '三、完整管理员（管理口令）核准：同样 409，没有接上', { byToken: [byToken.status, byToken.json?.reason], meV2 });

  // ---------- 四 ----------
  await A.cli('POST', '/api/principals/bind', { provider: 'odoo', external_id: 'nora', principal: 'user:nora', create: true, reason: '合成' });
  await A.grant('user:nora', 'owner');
  const n2 = await token('POST', '/api/local-accounts', { username: 'nora' });
  const n2sam = await sam.go('POST', '/api/local-accounts', { json: { username: 'nora' } });
  check(n2.status === 409 && n2.json?.reason === 'exists' && !n2.json?.temp_password && n2sam.status === 409 && !n2sam.json?.temp_password && !(await account('nora')),
    '四、管理员建账号（N2）：user:nora 已经有人（持 owner），建 nora 409（管理口令、系统管理员都一样），不给临时密码，账号没留下', { n2: [n2.status, n2.json?.reason], n2sam: n2sam.status });

  // ---------- 四b ----------
  // 先注册 wendy，之后只差大小写的同名出现了（别的登录方式进来的是 Wendy）：同样算已经有人，回同一句话
  await signup('wendy', 'Wendy-pass-0001', '192.0.2.86');
  await A.cli('POST', '/api/principals/bind', { provider: 'odoo', external_id: 'Wendy', principal: 'user:Wendy', create: true, reason: '合成' });
  const wl = await account('wendy');
  const wa = await token('POST', '/api/local-accounts/wendy/approve');
  check(wl?.name_taken === true && wa.status === 409 && wa.json?.reason === 'exists' && /已经属于一个现有的人/.test(wa.json?.error ?? ''),
    '四b、只差大小写的同名（user:Wendy 已经有人）：列表标出 name_taken，核准 409「这个名字已经属于一个现有的人」', { wl: wl?.name_taken, wa: [wa.status, wa.json?.reason] });

  // ---------- 五 ----------
  await signup('zack', 'Zack-pass-00001', '192.0.2.84');
  const z = await sam.go('POST', '/api/local-accounts/zack/approve');
  const y = await token('POST', '/api/local-accounts', { username: 'yara' });
  check(z.status === 200 && z.json?.account?.principal === 'user:zack' && y.status === 201 && y.json?.account?.principal === 'user:yara' && !!y.json?.temp_password,
    '五、对照：没人用的名字照常——核准 zack 新建 user:zack；建 yara 新建 user:yara、给临时密码', { z: [z.status, z.json?.account?.principal], y: [y.status, y.json?.account?.principal] });

  // ---------- 六 ----------
  const explicit = await token('POST', '/api/principals/bind', { provider: 'local', external_id: 'victim', principal: 'user:victim', reason: '合成：确认是同一个人' });
  const asVictim3 = await A.login('victim', 'Victim-pass-0001', '', '192.0.2.85');
  check(explicit.status === 200 && (await asVictim3.go('GET', '/api/auth/me')).json?.principal === 'user:victim',
    '六、真是同一个人：完整管理员用「绑定到现有主体」显式把站内账号 victim 绑到 user:victim，照常', { explicit: explicit.status });
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await sleep(500);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`local-accounts-create-only-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
