#!/usr/bin/env node
/**
 * 角色预设 ② 的对抗组：以某人的身份看、红线清单、首次安装向导。真实的 server/src/index.ts，身份来源是假提供方，
 * 只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、以某人的身份看：管理员看任何人；登录的人只看自己（看别人 403）；远程匿名 401、跨站 403；
 *       生效的授予带展开后的权限、范围、期限、放行人、来源，范围不是 * 的标「尚未生效」；没生效的各自写明原因；
 *       带 action 给出判定结论和规则（成员能读、不能管；本机命令行起草的、口令放行的）
 *   二、红线清单：登录的人能读，和代码里的规则表一致；远程匿名 401
 *   三、向导：小团队给每个启用的人普通员工；标准形态按指定给管理层、部门负责人，其余普通员工；
 *       重复跑不重复建；给自己起草的那条记成跳过（不能给自己授予）；部门不存在的跳过；写法不对 400；员工跑不了
 *   四、向导这一批只有属主放行：口令管理员、不是属主的管理员登录 403；本机命令行放行后都生效、来源推成 wizard
 *
 *   node scripts/access-smoke.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `access-smoke-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-access-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.91' };
const token = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

let child = null;
const data = join(OUT, 'data');
async function boot() {
  const port = await freePort();
  const home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, text, json };
  };
  return { host: new URL(base).host, call, log: () => log };
}

try {
  const srv = await boot();
  const db = new DatabaseSync(join(data, 'workbench-market.db'));
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const as = (s) => ({ headers: { ...REMOTE, ...same }, session: s });
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  // 一条生效的成员授予（本机命令行起草、口令放行）、一条撤销的、一条草稿
  const mk = async (body, who = {}) => (await srv.call('POST', '/api/grants', { ...who, body: { scope: '*', reason: '合成', ...body } })).json?.grant?.id;
  const g1 = await mk({ principal: 'user:alpha', role: 'member' });
  await srv.call('POST', `/api/grants/${g1}/submit`); await srv.call('POST', `/api/grants/${g1}/approve`, { headers: token });
  const g2 = await mk({ principal: 'user:alpha', role: 'admin' });
  await srv.call('POST', `/api/grants/${g2}/revoke`, { body: { reason: '合成：不给了' } });
  const g3 = await mk({ principal: 'user:alpha', role: 'management' });

  // ---------- 一、以某人的身份看 ----------
  {
    const admin = await srv.call('GET', '/api/principals/user:alpha/access', { headers: token });
    const self = await srv.call('GET', '/api/principals/user:alpha/access', as(SESSIONS.alpha));
    const other = await srv.call('GET', '/api/principals/user:alpha/access', as(SESSIONS.beta));
    const anon = await srv.call('GET', '/api/principals/user:alpha/access', { headers: REMOTE });
    const cross = await srv.call('GET', '/api/principals/user:alpha/access', { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: SESSIONS.alpha });
    const missing = await srv.call('GET', '/api/principals/user:nobody/access', { headers: token });
    const badId = await srv.call('GET', '/api/principals/nobody/access', { headers: token });
    const a = admin.json ?? {};
    const member = a.active?.find((g) => g.id === g1);
    check(admin.status === 200 && self.status === 200 && show(self.json) === show(admin.json) && other.status === 403 && anon.status === 401 && cross.status === 403 && missing.status === 404 && badId.status === 400
      && !other.text.includes('member') && !anon.text.includes('member'),
      '以某人的身份看：口令管理员看任何人、本人看自己（两份一样）；别的员工 403、远程匿名 401、跨站 403、不存在 404、写法不对 400；被拒的应答里没有授予内容',
      show({ admin: admin.status, self: self.status, other: other.status, anon: anon.status, cross: cross.status, missing: missing.status, badId: badId.status }));
    check(member?.role === 'member' && member.role_name && Array.isArray(member.permissions) && member.permissions.length > 0 && member.scope === '*' && member.effective === true
      && member.approved_by === 'admin-token' && member.source === 'manual'
      && show(a.inactive?.map((g) => [g.id, g.status]).sort()) === show([[g2, 'revoked'], [g3, 'draft']].sort())
      && a.inactive.find((g) => g.id === g2)?.revoke_reason === '合成：不给了' && a.inactive.find((g) => g.id === g3)?.reason,
      '生效的授予带展开后的权限、范围、放行人、来源；没生效的（撤销、草稿）各自写明原因，撤销的带撤销理由', show({ member, inactive: a.inactive }));
    const dRead = await srv.call('GET', '/api/principals/user:alpha/access?action=workbench.list', { headers: token });
    const dAdmin = await srv.call('GET', '/api/principals/user:alpha/access?action=principal.list&scope=dept:x', { headers: token });
    const dUnknown = await srv.call('GET', '/api/principals/user:alpha/access?action=nope.nope', { headers: token });
    const dBad = await srv.call('GET', '/api/principals/user:alpha/access?action=BAD!', { headers: token });
    check(dRead.json?.decision?.verdict === 'allow' && dRead.json.decision.kind === 'read' && dAdmin.json?.decision?.verdict === 'deny' && dAdmin.json.decision.scope === 'dept:x' && dAdmin.json.decision.scope_note
      && dUnknown.status === 404 && dBad.status === 400,
      '带 action 给出判定：成员能读台列表（allow）、不能列主体（deny）；范围只回显并说明还不认；没登记的动作 404、写法不对 400',
      show({ read: dRead.json?.decision, admin: dAdmin.json?.decision, unknown: dUnknown.status, bad: dBad.status }));
  }

  // ---------- 二、红线清单 ----------
  {
    const { RED_LINES } = await import(pathToFileURL(join(ROOT, 'server/src/red-lines.ts')).href);
    const staff = await srv.call('GET', '/api/access/red-lines', as(SESSIONS.alpha));
    const anon = await srv.call('GET', '/api/access/red-lines', { headers: REMOTE });
    check(staff.status === 200 && show(staff.json?.red_lines?.map((r) => r.id)) === show(RED_LINES.map((r) => r.id)) && staff.json.red_lines.every((r) => r.title && r.test) && anon.status === 401,
      '红线清单：登录的人能读，和代码里的规则表一条不差；远程匿名 401', show({ staff: staff.status, n: staff.json?.red_lines?.length, anon: anon.status }));
  }

  // ---------- 三、向导 ----------
  {
    // 部门（dept-lead 的范围要部门存在）
    await srv.call('PUT', '/api/departments/sales', { headers: token, body: { name: '合成销售部' } });
    const bad = {
      shape: [await srv.call('POST', '/api/setup/wizard', { body: { shape: 'huge' } }), 400],
      smallWithAssign: [await srv.call('POST', '/api/setup/wizard', { body: { shape: 'small', assignments: { management: ['user:beta'] } } }), 400],
      badLead: [await srv.call('POST', '/api/setup/wizard', { body: { shape: 'standard', assignments: { dept_leads: [{ principal: 'user:beta', department: 'Sales' }] } } }), 400],
      staff: [await srv.call('POST', '/api/setup/wizard', { ...as(SESSIONS.alpha), body: { shape: 'small' } }), 403],
    };
    const badBad = Object.entries(bad).filter(([, [r, want]]) => r.status !== want).map(([k, [r, want]]) => [k, r.status, want]);
    const runsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM setup_wizard_runs').get().n);
    // 标准形态：口令管理员跑（不是人，不涉及自授）；root-admin 是管理层，beta 是 sales 的负责人，nobody-dept 的部门不存在
    const std = await srv.call('POST', '/api/setup/wizard', { headers: token, body: { shape: 'standard', assignments: { management: ['user:root-admin'], dept_leads: [{ principal: 'user:beta', department: 'sales' }, { principal: 'user:beta', department: 'ghost' }] } } });
    const tgt = (std.json?.created ?? []).map((c) => [c.principal, c.role, c.scope]).sort();
    const skip = (std.json?.skipped ?? []).map((c) => [c.principal, c.role, c.scope, c.reason]).sort();
    check(badBad.length === 0 && runsBefore === 0 && std.status === 201
      && show(tgt) === show([['user:beta', 'dept-lead', 'dept:sales'], ['user:root-admin', 'management', '*']].sort())
      && show(skip) === show([['user:alpha', 'member', '*', 'already'], ['user:beta', 'dept-lead', 'dept:ghost', 'department_unknown']].sort()),
      '向导（标准）：指定的管理层、部门负责人照建；其余的人给普通员工，alpha 已有生效的成员授予就跳过（already）；部门不存在的跳过并写明原因；写法不对 400、员工跑不了 403，被拒的都没建运行',
      show({ badBad, created: tgt, skipped: skip }));
    // 管理员登录的人自己跑小团队：给自己的那条记成跳过（不能给自己授予）
    const small = await srv.call('POST', '/api/setup/wizard', { ...as(SESSIONS.admin), body: { shape: 'small' } });
    const smallSkip = (small.json?.skipped ?? []).map((c) => [c.principal, c.reason]).sort();
    const smallMade = (small.json?.created ?? []).map((c) => [c.principal, c.role]).sort();
    const again = await srv.call('POST', '/api/setup/wizard', { headers: token, body: { shape: 'small' } });
    check(small.status === 201 && show(smallMade) === show([['user:beta', 'member']]) && smallSkip.some(([p, r]) => p === 'user:root-admin' && r === 'self_grant') && smallSkip.some(([p, r]) => p === 'user:alpha' && r === 'already')
      && again.status === 201 && (again.json?.created ?? []).filter((c) => c.principal === 'user:beta').length === 0,
      '向导（小团队）：每个启用的人给普通员工；给自己的那条记成跳过（不能给自己授予）；再跑一次不重复建', show({ made: smallMade, skipped: smallSkip, again: again.json?.created }));

    // ---------- 四、只有属主放行 ----------
    const run = std.json?.run;
    const byToken = await srv.call('POST', '/api/setup/wizard/approve', { headers: token, body: { run } });
    const byAdmin = await srv.call('POST', '/api/setup/wizard/approve', { ...as(SESSIONS.admin), body: { run } });
    const missing = await srv.call('POST', '/api/setup/wizard/approve', { body: { run: 9999 } });
    const byCli = await srv.call('POST', '/api/setup/wizard/approve', { body: { run } });
    const view = await srv.call('GET', '/api/principals/user:beta/access', { headers: token });
    const lead = view.json?.active?.find((g) => g.role === 'dept-lead');
    const listed = await srv.call('GET', '/api/setup/wizard', { headers: token });
    // 属主一次放行的同时，向导指定的部门负责人顺带设上（部门原来没有负责人）：属主本人的动作，就是对这个关系的确认
    const salesLead = (await srv.call('GET', '/api/departments/sales', { headers: token })).json?.department?.lead?.principal;
    const leadBeforeApprove = byToken.status === 403; // 放行前没人能设
    check(salesLead === 'user:beta' && leadBeforeApprove, '向导：属主放行时，部门负责人授予对应的部门（原来没有负责人）顺带设上负责人', show({ salesLead }));
    check(byToken.status === 403 && byAdmin.status === 403 && missing.status === 404 && byCli.status === 200 && byCli.json?.approved?.length === 2 && byCli.json.failed.length === 0
      && lead?.source === 'wizard' && lead.scope === 'dept:sales' && lead.effective === false
      && listed.json?.runs?.find((r) => r.id === run)?.grants?.every((g) => g.status === 'active'),
      '向导这一批只有属主放行：口令管理员、不是属主的管理员登录 403；运行不存在 404；本机命令行放行后两条都生效（管理层、部门负责人是第三档，属主一次放行不受影响），来源推成 wizard，部门范围的标「尚未生效」',
      show({ byToken: byToken.status, byAdmin: byAdmin.status, byCli: byCli.json, lead }));
    const lines = srv.log().split('\n').filter((l) => l.includes('"source":"setup-wizard"'));
    check(lines.some((l) => l.includes('"event":"run"')) && lines.some((l) => l.includes('"event":"approve"')), '跑向导、放行各记一行日志', `${lines.length} 行`);
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await sleep(500); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`access-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
