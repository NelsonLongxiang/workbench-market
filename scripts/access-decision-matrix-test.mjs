#!/usr/bin/env node
/**
 * 「以某人的身份看」（GET /api/principals/:id/access?action=…&scope=area:x）的结论和实际调领域接口逐格一致（#914，统筹 11-20）。
 * 隔离实例（NODE_ENV=test），站内账号走浏览器的真实路径，合成的人：
 *   olga 属主 · mona 管理层 · sam 系统管理员 · tom 普通员工（只有 member *） · alice zeta 的领域成员 · sid zeta 的定规范 · yan eta 的定规范 ·
 *   leo zeta、eta 的负责人 · ivy 停用的人（先有 member *，再停用）
 * 动作：area.list、area.read、area.spec-list、area.spec-read、area.spec-set、area.create，都带 scope=area:zeta；
 * 每一格：access 接口（本机命令行问）答 allow / deny，和这个人自己实际调对应的领域接口（2xx 算放行；列表要列得出 zeta）比。
 * 另有复现（#914 评审）：只持 area-member（area:zeta）的人问 area.read，答 allow——原来问 judge 答 deny。
 * 改坏反证：access 接口里拿掉领域动作的分流（area.* 照旧问 judge），这张表要变红。规则抄自 routes/areas.ts，PR3b 收成一份后这张表照跑。
 *
 *   node scripts/access-decision-matrix-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `access-matrix-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-access-matrix-admin';
const BUSY_MS = 10_000;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const children = [];
let log = '';
rmSync(OUT, { recursive: true, force: true });

async function boot() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', MARKET_PUBLIC_URL: base, WM_TRUSTED_PROXIES: '127.0.0.1', ADMIN_TOKEN });
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
    const go = async (method, path0, { form, json, headers = {} } = {}) => {
      const path = method === 'POST' ? latest(path0) : path0;
      const h = { 'sec-fetch-site': 'same-origin', origin: base, 'x-real-ip': ip, ...headers };
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
  /** 远程来的请求（经受信代理报的来源地址），可带管理口令 */
  const remote = (method, path, { json, token, headers = {} } = {}) => fetch(new URL(path, base), {
    method, headers: { 'x-real-ip': '198.51.100.9', ...(token ? { 'x-admin-token': token } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const grant = async (principal, role) => { const d = await cli('POST', '/api/grants', { principal, role, scope: '*', reason: '合成' }); const id = d.json?.grant?.id; await cli('POST', `/api/grants/${id}/submit`); const a = await cli('POST', `/api/grants/${id}/approve`); return { id, status: a.status }; };
  const person = async (username, pw, ip) => { const t = (await cli('POST', '/api/local-accounts', { username })).json?.temp_password ?? ''; return login(username, t, pw, ip); };
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: BUSY_MS });
  return { base, browser, login, cli, remote, grant, person, db };
}


try {
  const A = await boot();
  const issue = async (principal, role, scope = '*') => { const d = await A.cli('POST', '/api/grants', { principal, role, scope, reason: '合成' }); const id = d.json?.grant?.id; await A.cli('POST', `/api/grants/${id}/submit`); const a = await A.cli('POST', `/api/grants/${id}/approve`); return { role, scope, draft: d.status, approve: a.status, err: a.json?.error ?? d.json?.error ?? null }; };
  const ip = (n) => `192.0.2.${100 + n}`;
  const names = ['olga', 'mona', 'sam', 'tom', 'alice', 'sid', 'yan', 'leo', 'ivy'];
  const who = {};
  for (const [i, n] of names.entries()) who[n] = await A.person(n, `${n[0].toUpperCase()}${n.slice(1)}-pass-0000${i}`, ip(i));
  const setup = [];
  setup.push(await A.cli('POST', '/api/areas', { id: 'zeta', name: '合成甲领域' }), await A.cli('POST', '/api/areas', { id: 'eta', name: '合成乙领域' }));
  const gs = [
    await issue('user:olga', 'owner'), await issue('user:mona', 'management'), await issue('user:sam', 'admin'), await issue('user:tom', 'member'), await issue('user:ivy', 'member'),
    await issue('user:leo', 'area-lead', 'area:zeta'), await issue('user:leo', 'area-lead', 'area:eta'),
    await issue('user:alice', 'area-member', 'area:zeta'), await issue('user:sid', 'area-spec', 'area:zeta'), await issue('user:yan', 'area-spec', 'area:eta'),
  ];
  setup.push(await A.cli('POST', '/api/areas/zeta/specs', { body: '合成规范第 1 版' }));
  const dis = await A.cli('POST', '/api/principals/disable', { id: 'user:ivy', reason: '合成：停用' });
  check(setup.every((r) => r.status === 201) && gs.every((g) => g.approve === 200) && dis.status === 200, '（准备）两个领域、九个人的授予都放行了，zeta 有一版规范，ivy 停用了', { setup: setup.map((r) => r.status), gs: gs.filter((g) => g.approve !== 200), dis: dis.status });

  let made = 0;
  /** 这个人实际调领域接口：2xx 算放行；列表要列得出 zeta */
  const REAL = {
    'area.list': async (b) => { const r = await b.go('GET', '/api/areas'); return r.status === 200 && (r.json?.areas ?? []).some((a) => a.id === 'zeta'); },
    'area.read': async (b) => (await b.go('GET', '/api/areas/zeta')).status === 200,
    'area.spec-list': async (b) => (await b.go('GET', '/api/areas/zeta/specs')).status === 200,
    'area.spec-read': async (b) => (await b.go('GET', '/api/areas/zeta/specs/1')).status === 200,
    'area.spec-set': async (b) => (await b.go('POST', '/api/areas/zeta/specs', { json: { body: `合成规范 ${++made}` } })).status === 201,
    'area.create': async (b) => (await b.go('POST', '/api/areas', { json: { id: `tmp-${++made}`, name: '合成临时领域' } })).status === 201,
  };
  const asked = async (n, action) => (await A.cli('GET', `/api/principals/user:${n}/access?action=${encodeURIComponent(action)}&scope=area:zeta`)).json?.decision;
  const table = [], diff = [];
  for (const n of names) {
    const row = [n];
    for (const action of Object.keys(REAL)) {
      const d = await asked(n, action);
      const real = await REAL[action](who[n]);
      const said = d?.verdict === 'allow';
      row.push(`${action.slice(5)}:${said ? '✓' : '✗'}${said === real ? '' : '≠实际' + (real ? '✓' : '✗')}`);
      if (said !== real || !d) diff.push({ who: n, action, access: d?.verdict ?? null, rule: d?.rule ?? null, via: d?.via ?? null, real });
    }
    table.push(row.join(' '));
  }
  console.log(table.map((r) => '    ' + r).join('\n'));
  check(diff.length === 0, `对照表：${names.length} 种身份 × ${Object.keys(REAL).length} 个动作（scope=area:zeta），access 的结论和实际调领域接口逐格一致`, diff);
  // 抽几格写死预期（照 routes/areas.ts 的规则），免得两边一起错了也对得上
  const v = async (n, a) => (await asked(n, a))?.verdict;
  const expect = { alice_read: await v('alice', 'area.read'), tom_read: await v('tom', 'area.read'), mona_read: await v('mona', 'area.read'), mona_set: await v('mona', 'area.spec-set'),
    sid_set: await v('sid', 'area.spec-set'), yan_set: await v('yan', 'area.spec-set'), leo_set: await v('leo', 'area.spec-set'), sam_read: await v('sam', 'area.read'), ivy_read: await v('ivy', 'area.read'), olga_create: await v('olga', 'area.create'), mona_create: await v('mona', 'area.create') };
  check(JSON.stringify(expect) === JSON.stringify({ alice_read: 'allow', tom_read: 'deny', mona_read: 'allow', mona_set: 'deny', sid_set: 'allow', yan_set: 'deny', leo_set: 'deny', sam_read: 'deny', ivy_read: 'deny', olga_create: 'allow', mona_create: 'deny' }),
    '写死的预期：领域成员能读（#914 复现）、只有 member * 的不能读、管理层能读不能定规范、定规范只认本领域的定规范授予（负责人不算）、系统管理员和停用的人不能读、建领域只有属主', expect);
  const rep = await asked('alice', 'area.read');
  check(rep?.verdict === 'allow' && rep?.via === 'area' && /按领域判/.test(rep?.scope_note ?? '') && !/还不认/.test(rep?.scope_note ?? ''),
    '#914 复现：只持 area-member（area:zeta）的人问 area.read，答 allow、按领域判，说明不再写「带范围的还不认」', rep);
  const steps = await A.cli('GET', '/api/principals/user:alice/access?action=area.trigger&scope=area:zeta');
  check(steps.json?.decision?.verdict === 'deny' && steps.json?.decision?.rule === 'area-step1-not-routed', '第 1 步只登记的领域动作（area.trigger）：答 deny，写明还没接到路由上', steps.json?.decision);
  const other = await A.cli('GET', '/api/principals/user:tom/access?action=principal.access&scope=area:zeta');
  check(other.status === 200 && other.json?.decision?.via === 'judge' && /不按领域问/.test(other.json?.decision?.scope_note ?? ''), '不是领域的动作（principal.access）带了领域范围：照旧问 judge，说明写领域范围在这个动作上不起作用', other.json?.decision ?? other.status);
} catch (e) {
  fail++; console.log(`  ✗ 跑挂了：${e?.stack ?? e}`);
} finally {
  for (const c of children) c.kill();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`access-decision-matrix-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
