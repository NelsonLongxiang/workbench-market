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
 *     X1 两人制：系统管理员能起草、提交给业务数据的授予，不能放行；放行人要确认「凭据由系统管理员设置」
 *     X1b 起草、提交的人不能自己放行给业务数据的授予（第一档也查）
 *     N3 业务授予还在草稿、待放行时这个人就算业务侧：系统管理员不能重置他的密码
 *     N1 MCP 访问申请：系统管理员不能批准；建会话的人不能批自己会话的申请
 *     X2 系统管理员照常管系统：角色清单、主体清单 200；业务面 403
 *     X3 迁移来的 admin 授予（source=migration）不让人成系统管理员，授予列表上标 ignored_for_admin
 *     E9 导出真实值（/api/export?reveal=1）：系统管理员 403；属主、管理口令照常；不带 reveal 的导出系统管理员照常
 *     X4 系统管理员经 bind 把（自己控制的）外部身份连新建绑到一个人身上，再给他起草普通员工：放行时同样标「凭据由系统管理员设置」、要确认；
 *        对照：属主绑的不标
 *     X5 业务侧真能放行：管理层看得到并放行给业务数据的普通档授予；部门负责人只看得到、放行得了本部门范围的（部门成员、普通员工），
 *        别的部门、全公司范围的看不到（单条 404）、放行不了
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
import { legacyGrantIn, deptGrantRows } from './lib/legacy-dept-seed.mjs';

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
    // 两人制：系统管理员可以起草、提交给业务数据的授予（日常开新人），不能放行；放行人还要先确认「凭据由系统管理员设置」
    const d = await sam.go('POST', '/api/grants', { json: { principal: 'user:sock', role: 'member', scope: '*', reason: '合成' } });
    const sub = d.json?.grant?.id ? await sam.go('POST', `/api/grants/${d.json.grant.id}/submit`) : null;
    const selfApprove = d.json?.grant?.id ? await sam.go('POST', `/api/grants/${d.json.grant.id}/approve`) : null;
    const listed = ((await olga.go('GET', '/api/grants?status=pending')).json?.grants ?? []).find((g) => g.id === d.json?.grant?.id);
    const noConfirm = d.json?.grant?.id ? await olga.go('POST', `/api/grants/${d.json.grant.id}/approve`) : null;
    const confirmed = d.json?.grant?.id ? await olga.go('POST', `/api/grants/${d.json.grant.id}/approve`, { json: { confirm_credentials: true } }) : null;
    check(d.status === 201 && sub?.status === 200 && selfApprove?.status === 403 && selfApprove.json?.error === 'system_admin_business_grant'
        && listed?.credentials_set_by_system_admin?.kind === 'create' && noConfirm?.status === 409 && noConfirm.json?.error === 'credentials_set_by_system_admin' && confirmed?.status === 200,
      'X1 两人制：系统管理员起草、提交给业务数据的授予照常（给他自己建的账号开普通员工），自己放行 403；列表标出「凭据由系统管理员设置」，属主不确认放行 409、确认了才放行',
      { draft: d.status, submit: sub?.status, selfApprove: [selfApprove?.status, selfApprove?.json?.error], listed: listed?.credentials_set_by_system_admin, noConfirm: [noConfirm?.status, noConfirm?.json?.error], confirmed: confirmed?.status });
    // 起草、提交的人不能自己放行：管理口令（浏览器里用的，不是本机命令行）起草提交的普通员工授予，它自己放行 403，属主放行照常（第一档也查）
    const tokenCall = (method, path, json) => fetch(new URL(path, A.base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: A.base }, body: json === undefined ? undefined : JSON.stringify(json) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    await A.cli('POST', '/api/local-accounts', { username: 'zed' });
    const t1 = await tokenCall('POST', '/api/grants', { principal: 'user:zed', role: 'member', scope: '*', reason: '合成' });
    await tokenCall('POST', `/api/grants/${t1.json?.grant?.id}/submit`);
    const tSelf = await tokenCall('POST', `/api/grants/${t1.json?.grant?.id}/approve`);
    const tOther = await olga.go('POST', `/api/grants/${t1.json?.grant?.id}/approve`);
    check(t1.status === 201 && tSelf.status === 403 && tSelf.json?.error === 'drafter_cannot_approve' && tOther.status === 200,
      'X1b 两人制：起草、提交的人不能自己放行给业务数据的授予（第一档的普通员工也查）；另一位（属主）放行照常', { draft: t1.status, self: [tSelf.status, tSelf.json?.error], other: tOther.status });
    // N3：业务授予还在待放行时，这个人已经算业务侧——系统管理员不能重置他的密码
    await A.cli('POST', '/api/local-accounts', { username: 'pia' });
    const p1 = await tokenCall('POST', '/api/grants', { principal: 'user:pia', role: 'member', scope: '*', reason: '合成' });
    const resetDraft = await sam.go('POST', '/api/local-accounts/pia/reset-password');
    await tokenCall('POST', `/api/grants/${p1.json?.grant?.id}/submit`);
    const resetPending = await sam.go('POST', '/api/local-accounts/pia/reset-password');
    check(p1.status === 201 && resetDraft.status === 403 && resetPending.status === 403 && !resetPending.json?.temp_password,
      'N3 业务授予还在草稿、待放行时，这个人已经算业务侧：系统管理员重置他的密码 403', { draft: resetDraft.status, pending: resetPending.status });
    const roles = await sam.go('GET', '/api/roles'), people = await sam.go('GET', '/api/principals'), b = await biz(sam);
    check(roles.status === 200 && people.status === 200 && b === 403, 'X2 系统管理员照常管系统：角色清单、主体清单 200；业务面 403', { roles: roles.status, people: people.status, biz: b });
  }
  {
    // N1：系统管理员不能先建会话、再用会话令牌申请业务工具、自己批准；建会话的人（完整的管理员也一样）不能批自己会话的申请
    const tokenCall = (method, path, json) => fetch(new URL(path, A.base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const ask = async (token) => {
      const r = await fetch(new URL('/mcp', A.base), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'access_request', arguments: { tools: ['sop_run_list'], reason: '合成' } } }) });
      return r.status;
    };
    const pendingOf = async (sessionName) => ((await tokenCall('GET', '/api/mcp/access-requests?status=pending')).json ?? []).find((x) => x.session_name === sessionName)?.id;
    const ms = await sam.go('POST', '/api/mcp/sessions', { json: { name: 'synthetic-sam-n1' } });
    await ask(ms.json?.token);
    const samReq = await pendingOf('synthetic-sam-n1');
    const samApprove = samReq ? await sam.go('POST', `/api/mcp/access-requests/${samReq}/approve`, { json: { note: '合成' } }) : null;
    const os = await olga.go('POST', '/api/mcp/sessions', { json: { name: 'synthetic-olga-n1' } });
    await ask(os.json?.token);
    const olgaReq = await pendingOf('synthetic-olga-n1');
    const olgaSelf = olgaReq ? await olga.go('POST', `/api/mcp/access-requests/${olgaReq}/approve`, { json: { note: '合成' } }) : null;
    const samOther = olgaReq ? await sam.go('POST', `/api/mcp/access-requests/${olgaReq}/approve`, { json: { note: '合成' } }) : null; // 不是他建的会话也不行
    const byToken = olgaReq ? await tokenCall('POST', `/api/mcp/access-requests/${olgaReq}/approve`, { note: '合成' }) : null;
    check(!!samReq && samApprove?.status === 403 && !!olgaReq && olgaSelf?.status === 403 && samOther?.status === 403 && samOther.json?.error === 'system_admin_business_tools' && byToken?.status === 200,
      'N1 MCP 访问申请：系统管理员批准 403（建会话、替它申请、自己批走不通）；建会话的人（属主）批自己会话的申请 403；另一位（管理口令）批照常',
      { samReq, samApprove: samApprove?.status, olgaReq, olgaSelf: olgaSelf?.status, samOther: samOther?.status, byToken: byToken?.status });
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
    const flagged = ((await olga.go('GET', '/api/grants?principal=user:mia')).json?.grants ?? []).find((g) => g.role === 'admin');
    check(before === 'user:mia' && who?.system_only !== true && list.status === 403 && flagged?.ignored_for_admin === true, 'X3 迁移来的 admin 授予不让人成系统管理员（以身份来源当下说的为准）：whoami 不是系统管理员，管理面 403', { who, list: list.status });
  }

  {
    // E9：导出的真实值只给完整的管理员
    const tokenCall = (method, path) => fetch(new URL(path, A.base), { method, headers: { 'x-admin-token': ADMIN_TOKEN } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const samReveal = await sam.go('GET', '/api/export?reveal=1');
    const samPlain = await sam.go('GET', '/api/export');
    const olgaReveal = await olga.go('GET', '/api/export?reveal=1');
    const tokReveal = await tokenCall('GET', '/api/export?reveal=1');
    check(samReveal.status === 403 && samReveal.json?.error === 'system_admin_reveal' && !samReveal.json?.workbenches && samPlain.status === 200 && samPlain.json?.masked === 1
        && olgaReveal.status === 200 && olgaReveal.json?.masked === 0 && tokReveal.status === 200 && tokReveal.json?.masked === 0,
      'E9 导出真实值：系统管理员 403（不给台配置），不带 reveal 的照常（掩码）；属主、管理口令照常取真值',
      { samReveal: [samReveal.status, samReveal.json?.error], samPlain: [samPlain.status, samPlain.json?.masked], olga: olgaReveal.status, token: tokReveal.status });
  }
  {
    // X4：系统管理员把一条外部身份（比如他自己控制的另一个账号）连新建绑到 user:alt 上，再给 alt 起草、提交普通员工
    const bind = await sam.go('POST', '/api/principals/bind', { json: { provider: 'synthetic', external_id: 'sam-alt', principal: 'user:alt', create: true, reason: '合成' } });
    const d = await sam.go('POST', '/api/grants', { json: { principal: 'user:alt', role: 'member', scope: '*', reason: '合成' } });
    await sam.go('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const listed = ((await olga.go('GET', '/api/grants?principal=user:alt')).json?.grants ?? []).find((g) => g.id === d.json?.grant?.id);
    const one = (await olga.go('GET', `/api/grants/${d.json?.grant?.id}`)).json?.grant;
    const noConfirm = await olga.go('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const confirmed = await olga.go('POST', `/api/grants/${d.json?.grant?.id}/approve`, { json: { confirm_credentials: true } });
    // 对照：属主绑的外部身份不标
    await olga.go('POST', '/api/principals/bind', { json: { provider: 'synthetic', external_id: 'clean-1', principal: 'user:clean', create: true, reason: '合成' } });
    const c = await sam.go('POST', '/api/grants', { json: { principal: 'user:clean', role: 'member', scope: '*', reason: '合成' } });
    await sam.go('POST', `/api/grants/${c.json?.grant?.id}/submit`);
    const cl = ((await olga.go('GET', '/api/grants?principal=user:clean')).json?.grants ?? []).find((g) => g.id === c.json?.grant?.id);
    const cOk = await olga.go('POST', `/api/grants/${c.json?.grant?.id}/approve`);
    // 成批绑的也一样
    const bb = await sam.go('POST', '/api/principals/bind-batch', { json: { items: [{ provider: 'synthetic', external_id: 'sam-alt2', principal: 'user:alt2', create: true }], reason: '合成' } });
    const d2 = await sam.go('POST', '/api/grants', { json: { principal: 'user:alt2', role: 'member', scope: '*', reason: '合成' } });
    await sam.go('POST', `/api/grants/${d2.json?.grant?.id}/submit`);
    const l2 = ((await olga.go('GET', '/api/grants?principal=user:alt2')).json?.grants ?? []).find((g) => g.id === d2.json?.grant?.id);
    check(bind.status === 200 && d.status === 201 && listed?.credentials_set_by_system_admin?.kind === 'bind' && /synthetic\/sam-alt/.test(listed.credentials_set_by_system_admin.username ?? '')
        && one?.credentials_set_by_system_admin?.kind === 'bind' && noConfirm.status === 409 && noConfirm.json?.error === 'credentials_set_by_system_admin' && /系统管理员绑上来的/.test(noConfirm.json?.message ?? '')
        && confirmed.status === 200 && cl?.credentials_set_by_system_admin === null && cOk.status === 200
        && bb.json?.bound === 1 && l2?.credentials_set_by_system_admin?.kind === 'bind',
      'X4 系统管理员经 bind、bind-batch 连新建绑上的外部身份：列表、单条标「凭据由系统管理员设置」（bind），属主不确认放行 409、确认了才放行；属主绑的不标、照常放行',
      { bind: bind.status, batch: [bb.status, l2?.credentials_set_by_system_admin], listed: listed?.credentials_set_by_system_admin, noConfirm: [noConfirm.status, noConfirm.json?.error], confirmed: confirmed.status, clean: [cl?.credentials_set_by_system_admin, cOk.status] });
  }
  {
    // X5：业务侧真能放行（管这个范围的）。部门 d1、d2；mona 持管理层（*），dina 持 d1 的部门负责人
    const d = A.db();
    try { const now = Date.now(); d.prepare("INSERT INTO departments (id, name, created_at, updated_at) VALUES ('d1', '合成一部', ?, ?), ('d2', '合成二部', ?, ?)").run(now, now, now, now); } finally { d.close(); }
    const mona = await A.person('mona', 'Mona-pass-00001', '192.0.2.76'); await A.grant('user:mona', 'management');
    const dina = await A.person('dina', 'Dina-pass-00001', '192.0.2.77');
    // 部门已停写：dina 的部门负责人授予、各部门待放行的授予都是停写前就有的，直接写库造（scripts/lib/legacy-dept-seed.mjs）
    const legacy = (principal, role, scope, to = 'active') => { const d = A.db(); try { return legacyGrantIn(d, principal, role, scope, { reason: '合成', to }); } finally { d.close(); } };
    legacy('user:dina', 'dept-lead', 'dept:d1');
    const tokenCall = (method, path, json) => fetch(new URL(path, A.base), { method, headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const pend = async (who, role, scope) => {
      await A.cli('POST', '/api/local-accounts', { username: who });
      if (scope.startsWith('dept:')) return legacy(`user:${who}`, role, scope, 'pending');
      const g = await tokenCall('POST', '/api/grants', { principal: `user:${who}`, role, scope, reason: '合成' });
      await tokenCall('POST', `/api/grants/${g.json?.grant?.id}/submit`);
      return g.json?.grant?.id;
    };
    const gAll = await pend('una', 'member', '*');           // 全公司的普通员工
    const gD1 = await pend('vic', 'member', 'dept:d1');      // 一部的普通员工
    const gD1m = await pend('wes', 'dept-member', 'dept:d1'); // 一部的部门成员（带业务写）
    const gD2 = await pend('xia', 'member', 'dept:d2');      // 二部的普通员工
    { const d = A.db(); let rows; try { rows = deptGrantRows(d); } finally { d.close(); }
      check(JSON.stringify(rows) === JSON.stringify(['user:dina dept-lead dept:d1 active', 'user:vic member dept:d1 pending', 'user:wes dept-member dept:d1 pending', 'user:xia member dept:d2 pending']), '（前置）停写前就有的 dept: 授予确实在、状态对（直接写库造；没造出来时后面「被拒 / 不认」的断言不能白白成立）', rows); }
    const ids = (r) => (r.json?.grants ?? []).map((g) => g.id);
    const monaList = ids(await mona.go('GET', '/api/grants?status=pending'));
    const dinaList = ids(await dina.go('GET', '/api/grants?status=pending'));
    const dinaOther = await dina.go('GET', `/api/grants/${gD2}`);
    const dinaAll = await dina.go('POST', `/api/grants/${gAll}/approve`);
    const dinaD2 = await dina.go('POST', `/api/grants/${gD2}/approve`);
    const dinaOk = await dina.go('POST', `/api/grants/${gD1}/approve`);
    const dinaOkM = await dina.go('POST', `/api/grants/${gD1m}/approve`);
    const monaOk = await mona.go('POST', `/api/grants/${gAll}/approve`);
    check(monaList.includes(gAll) && monaList.includes(gD1) && monaList.includes(gD2) && monaOk.status === 200,
      'X5a 管理层（*）看得到全公司和各部门待放行的普通员工授予，放行全公司的照常', { monaList, monaOk: monaOk.status });
    check(dinaList.includes(gD1) && dinaList.includes(gD1m) && !dinaList.includes(gD2) && !dinaList.includes(gAll) && dinaOther.status === 404
        && dinaAll.status === 404 && dinaD2.status === 404 && dinaOk.status === 200 && dinaOkM.status === 200,
      'X5b 部门负责人（d1）只看得到、放行得了本部门范围的普通员工、部门成员授予；二部、全公司的看不到（单条 404）、放行 404',
      { dinaList, other: dinaOther.status, all: dinaAll.status, d2: dinaD2.status, ok: dinaOk.status, okM: dinaOkM.status });
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
