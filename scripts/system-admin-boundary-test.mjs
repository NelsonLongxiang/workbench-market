#!/usr/bin/env node
/**
 * 系统管理员的边界（docs/local-accounts.md 第 5 节）：只持 admin 授予的人管系统、看不到业务，系统面上也不能借道拿到业务。
 * 隔离实例（NODE_ENV=test），站内账号走浏览器的真实路径；合成的人：olga 持 owner（完整管理员）、sam 持 admin（系统管理员）、
 * tom 持 member（业务侧的普通员工）、nina 什么授予都没有。另装一个合成扩展（一条报了自己域的动作、一条直接挂没报动作），都用管理门。
 *
 *   甲、启动环境给口令的实例：
 *     E2 系统管理员重置业务侧的人（属主、持业务授予的）的站内密码：403；没有业务授予的人照常能重置；属主能重置
 *     E3 系统管理员把自己建的账号绑到业务侧的主体上：403（解绑没有业务授予的照常）
 *     E4 系统管理员给 MCP 会话加工具：403（能收回）；属主能加
 *     E5 系统管理员停用业务侧的主体：403；没有业务授予的照常能停用、恢复
 *     E6 系统管理员收回业务侧主体的授予：403
 *     E7 扩展报了自己域的动作（不在系统域白名单）的管理接口：系统管理员 403，属主 200
 *     E8 扩展直接挂、没报动作的管理接口：系统管理员 403，属主 200
 *     X1 系统管理员起草碰业务的授予（给自己建的账号开普通员工）：403
 *     X2 系统管理员照常管系统：角色清单、主体清单 200；业务面 403
 *     X3 迁移来的 admin 授予（source=migration）不让人成系统管理员
 *   乙、口令存库的实例（启动环境不给口令）：
 *     E1 系统管理员改管理口令：403，口令没变；属主能改
 *
 *   node scripts/system-admin-boundary-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `system-admin-boundary-${process.pid}-${Date.now().toString(36)}`);
const ADMIN_TOKEN = 'synthetic-system-admin-boundary';
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
  for (const d of [data, home, ext, join(ext, 'synthetic-ext')]) mkdirSync(d, { recursive: true });
  // 合成扩展：一条报了自己域的动作（域不在系统域白名单里），一条直接挂、没报动作；两条都用管理门
  writeFileSync(join(ext, 'synthetic-ext', 'server.mjs'), `export function register(ctx) {
  ctx.routes.add('get', '/api/synthetic-ext/declared', { action: 'synthetic-ext.read', kind: 'admin', who: 'admin' }, ctx.wrap(async (req, res) => { if (!(await ctx.adminGuard(req, res))) return; res.json({ row: 'synthetic' }); }));
  ctx.app.get('/api/synthetic-ext/raw', ctx.wrap(async (req, res) => { if (!(await ctx.adminGuard(req, res))) return; res.json({ row: 'synthetic' }); }));
}
`);
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
  // ---------------- 甲 ----------------
  console.log('甲、启动环境给口令');
  const A = await boot('env');
  const olga = await A.person('olga', 'Olga-pass-00001', '192.0.2.71'); const go = await A.grant('user:olga', 'owner');
  const sam = await A.person('sam', 'Sam-pass-000001', '192.0.2.72'); const gs = await A.grant('user:sam', 'admin');
  await A.person('tom', 'Tom-pass-000001', '192.0.2.73'); const gt = await A.grant('user:tom', 'member');
  const ninaTemp = (await A.cli('POST', '/api/local-accounts', { username: 'nina' })).json?.temp_password ?? '';
  await A.login('nina', ninaTemp, 'Nina-pass-00001', '192.0.2.74');
  const biz = async (b) => (await b.go('GET', '/api/work-items?view=all')).status;
  const ws = (await sam.go('GET', '/api/admin/whoami')).json;
  check(go.status === 200 && gs.status === 200 && gt.status === 200 && ws?.system_only === true && (await biz(olga)) === 200 && (await biz(sam)) === 403,
    '（准备）olga 属主看得到业务；sam 是系统管理员、业务 403；tom 持普通员工', { ws, o: await biz(olga), s: await biz(sam) });

  {
    const s1 = await sam.go('GET', '/api/synthetic-ext/declared'), o1 = await olga.go('GET', '/api/synthetic-ext/declared');
    check(s1.status === 403 && o1.status === 200, 'E7 扩展报了自己域的动作（不在系统域白名单）的管理接口：系统管理员 403，属主 200', { sam: s1.status, olga: o1.status });
    const s2 = await sam.go('GET', '/api/synthetic-ext/raw'), o2 = await olga.go('GET', '/api/synthetic-ext/raw');
    check(s2.status === 403 && o2.status === 200, 'E8 扩展直接挂、没报动作的管理接口：系统管理员 403，属主 200', { sam: s2.status, olga: o2.status });
  }
  {
    const owner = await sam.go('POST', '/api/local-accounts/olga/reset-password');
    const member = await sam.go('POST', '/api/local-accounts/tom/reset-password');
    const plain = await sam.go('POST', '/api/local-accounts/nina/reset-password');
    const byOwner = await olga.go('POST', '/api/local-accounts/tom/reset-password');
    check(owner.status === 403 && !owner.json?.temp_password && member.status === 403 && plain.status === 200 && byOwner.status === 200,
      'E2 系统管理员重置属主、持业务授予的人的站内密码：403（不给临时密码）；没有业务授予的照常；属主能重置', { owner: owner.status, member: member.status, plain: plain.status, byOwner: byOwner.status });
  }
  {
    const sock = await sam.go('POST', '/api/local-accounts', { json: { username: 'sock' } });
    const unbind = await sam.go('POST', '/api/principals/unbind', { json: { provider: 'local', external_id: 'sock', reason: '合成' } });
    const toOwner = await sam.go('POST', '/api/principals/bind', { json: { provider: 'local', external_id: 'sock', principal: 'user:olga', reason: '合成' } });
    const toMember = await sam.go('POST', '/api/principals/bind', { json: { provider: 'local', external_id: 'sock', principal: 'user:tom', reason: '合成' } });
    const batch = await sam.go('POST', '/api/principals/bind-batch', { json: { items: [{ provider: 'local', external_id: 'sock', principal: 'user:olga' }], reason: '合成' } });
    const unbindOwner = await sam.go('POST', '/api/principals/unbind', { json: { provider: 'local', external_id: 'olga', reason: '合成' } });
    const toPlain = await sam.go('POST', '/api/principals/bind', { json: { provider: 'local', external_id: 'sock', principal: 'user:sock', create: true, reason: '合成' } });
    check(sock.status === 201 && unbind.status === 200 && toOwner.status === 403 && toMember.status === 403 && batch.json?.results?.[0]?.status === 403 && unbindOwner.status === 403 && toPlain.status === 200,
      'E3 系统管理员把账号绑到属主、持业务授予的人身上：403（成批的那条也 403）；解绑属主名下的身份 403；没有业务授予的照常绑、解',
      { sock: sock.status, unbind: unbind.status, toOwner: toOwner.status, toMember: toMember.status, batch: batch.json?.results?.[0]?.status, unbindOwner: unbindOwner.status, toPlain: toPlain.status });
  }
  {
    const ms = await sam.go('POST', '/api/mcp/sessions', { json: { name: 'synthetic-sam-mcp' } });
    const add = ms.json?.id ? await sam.go('PUT', `/api/mcp/sessions/${ms.json.id}/grants`, { json: { grants: ['sop_run_list'] } }) : null;
    const byOwner = ms.json?.id ? await olga.go('PUT', `/api/mcp/sessions/${ms.json.id}/grants`, { json: { grants: ['sop_run_list'] } }) : null;
    const shrink = ms.json?.id ? await sam.go('PUT', `/api/mcp/sessions/${ms.json.id}/grants`, { json: { grants: [] } }) : null;
    check(ms.status === 201 && add?.status === 403 && byOwner?.status === 200 && shrink?.status === 200 && JSON.stringify(shrink.json?.grants) === '[]',
      'E4 系统管理员给 MCP 会话加工具：403；属主能加；系统管理员能收回', { create: ms.status, add: add?.status, byOwner: byOwner?.status, shrink: shrink?.status });
  }
  {
    const owner = await sam.go('POST', '/api/principals/disable', { json: { id: 'user:olga', reason: '合成' } });
    const member = await sam.go('POST', '/api/principals/disable', { json: { id: 'user:tom', reason: '合成' } });
    const plain = await sam.go('POST', '/api/principals/disable', { json: { id: 'user:nina', reason: '合成' } });
    const back = await sam.go('POST', '/api/principals/restore', { json: { id: 'user:nina', reason: '合成' } });
    check(owner.status === 403 && member.status === 403 && plain.status === 200 && back.status === 200 && (await biz(olga)) === 200,
      'E5 系统管理员停用属主、持业务授予的人：403（属主照常能用）；没有业务授予的照常停用、恢复', { owner: owner.status, member: member.status, plain: plain.status, back: back.status });
  }
  {
    const owner = await sam.go('POST', `/api/grants/${go.id}/revoke`, { json: { reason: '合成' } });
    const member = await sam.go('POST', `/api/grants/${gt.id}/revoke`, { json: { reason: '合成' } });
    check(owner.status === 403 && member.status === 403 && (await biz(olga)) === 200,
      'E6 系统管理员收回属主、持业务授予的人的授予：403（属主照常是属主）', { owner: owner.status, member: member.status });
  }
  {
    const d = await sam.go('POST', '/api/grants', { json: { principal: 'user:sock', role: 'member', scope: '*', reason: '合成' } });
    check(d.status === 403 && d.json?.error === 'system_admin_business_grant', 'X1 系统管理员起草碰业务的授予（给自己建的账号开普通员工）：403', [d.status, d.json?.error]);
    const roles = await sam.go('GET', '/api/roles'), people = await sam.go('GET', '/api/principals'), b = await biz(sam);
    check(roles.status === 200 && people.status === 200 && b === 403, 'X2 系统管理员照常管系统：角色清单、主体清单 200；业务面 403', { roles: roles.status, people: people.status, biz: b });
  }
  {
    // 迁移来的 admin 授予：判定比对开着时按「身份来源说是管理员」补的；合成：另建一个人 mia，直接在库里给她放一条生效的
    const mia = await A.person('mia', 'Mia-pass-000001', '192.0.2.75');
    const before = (await mia.go('GET', '/api/auth/me')).json?.principal;
    const d = A.db();
    try {
      const now = Date.now();
      // 和迁移一样走草稿、待核、生效（库里的触发器只许这样走）
      const id = Number(d.prepare("INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_by_principal, created_at, updated_at, source) VALUES ('user:mia', 'admin', '*', NULL, '合成：迁移', 'system:migration', NULL, ?, ?, 'migration')").run(now, now).lastInsertRowid);
      d.prepare("UPDATE grants SET status = 'pending', updated_at = ? WHERE id = ?").run(now, id);
      d.prepare("UPDATE grants SET status = 'active', approved_by = 'system:migration', updated_at = ? WHERE id = ?").run(now, id);
    } finally { d.close(); }
    const who = (await mia.go('GET', '/api/admin/whoami')).json;
    const list = await mia.go('GET', '/api/principals');
    check(before === 'user:mia' && who?.system_only !== true && list.status === 403, 'X3 迁移来的 admin 授予不让人成系统管理员（以身份来源当下说的为准）：whoami 不是系统管理员，管理面 403', { who, list: list.status });
  }

  // ---------------- 乙 ----------------
  console.log('乙、口令存库');
  const B = await boot('db');
  const set = await B.cli('PUT', '/api/admin-token', { token: ADMIN_TOKEN });
  const olgaB = await B.person('olga', 'Olga-pass-00001', '192.0.2.81'); await B.grant('user:olga', 'owner');
  const samB = await B.person('sam', 'Sam-pass-000001', '192.0.2.82'); await B.grant('user:sam', 'admin');
  {
    const put = await samB.go('PUT', '/api/admin-token', { json: { token: 'synthetic-sam-chose-this' } });
    const viaSam = await fetch(new URL('/api/work-items?view=all', B.base), { headers: { 'x-admin-token': 'synthetic-sam-chose-this' } });
    const viaOld = await fetch(new URL('/api/work-items?view=all', B.base), { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const byOwner = await olgaB.go('PUT', '/api/admin-token', { json: { token: 'synthetic-owner-new-token' } });
    check(set.status === 200 && put.status === 403 && viaSam.status !== 200 && viaOld.status === 200 && byOwner.status === 200,
      'E1 系统管理员改管理口令：403，口令没变（他设的不认，原来的照常）；属主能改', { set: set.status, put: put.status, viaSam: viaSam.status, viaOld: viaOld.status, byOwner: byOwner.status });
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await sleep(500);
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`system-admin-boundary-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
