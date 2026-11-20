#!/usr/bin/env node
/**
 * 旧部门接口停写（docs/domains-step1.md 第六节、用例 17；统筹 11-20 对 dept-lead 提议的裁定）。隔离实例（NODE_ENV=test，假的登录提供方）。
 * 部门、成员、提议、旧授予一律直接写库造（停写以后接口造不出来）：部门 sales、ops、legacy；领域 sales（pending-lead）、ops（撤了）；legacy 没迁。
 *
 *   S1 （#17）部门的增、改、删，成员增删：本机命令行（属主）、管理员都回 410，库里不变；远程没登录照旧被拦（鉴权在前）；读接口照旧
 *   S2 （#17）设置向导带 dept_leads：400，什么都不落；不带的照旧
 *   S3 新起草 dept: 范围的授予一律 422 dept_scope_closed（dept-lead、dept-member 都拒）；已生效的 dept: 授予过渡期照旧算
 *   S3b（Q1）已经在草稿里的 dept: 授予照常能提交、放行（dept_scope_closed 只拦新起草）
 *   S4 新的 dept-lead 提议收不进来：唯一的入口（改部门时带 lead）已经 410，库里没有新提议
 *   S5 已有的 dept-lead 提议，属主经团队页的确认接口确认：起草一条 area-lead（area:<同标识>，待核，理由「由部门负责人提议转来」），
 *      应答 200 带 drafted_grant_id；不发 dept: 授予，部门的负责人字段、dept_lead_grants 都不动
 *   S5b「等你拍板」里关系提议那条：只列、不带答复（答复地址回 400 attention_answer_not_offered、库里不变），确认走的是 S5 同一个接口
 *   S6 领域不存在（legacy）、领域撤了（ops）：确认回 409 area_not_migrated，提议仍是 pending，库里不变
 *   S7 同一条确认两次：第二次 409 state；另一条提议指向同一个人、同一个领域：不另起草，skipped: already_open，drafted_grant_id 是已有那条
 *   S7b（Q2）这个人在这个领域的负责人授予是迁移起草、后来被属主否决的：属主这次确认照样起草，带 refused_before_overridden: true，留痕写明
 *   S8 重启以后不再给「字段有、授予没有」的部门补记 dept-lead 提议
 *   S9 红线 dept-scope-closed 在红线列表里 [red-line:dept-scope-closed]；启动自检里有「部门写接口已停写」那一行
 *
 *   node scripts/dept-write-stop-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `dept-write-stop-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const REMOTE = { 'x-forwarded-for': '192.0.2.72' };
const MIGRATE_REASON = '由部门负责人迁移';
const CONVERT_REASON = '由部门负责人提议转来';

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const p = createServer(); await new Promise((r) => p.listen(0, '127.0.0.1', r)); const { port } = p.address(); await new Promise((r) => p.close(r)); return port; }

const data = join(OUT, 'data'), home = join(OUT, 'home');
const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 10000 });
const sql = (fn) => { const d = db(); try { return fn(d); } finally { d.close(); } };
const one = (q, ...a) => sql((d) => d.prepare(q).get(...a));
const all = (q, ...a) => sql((d) => d.prepare(q).all(...a));
const n = (q, ...a) => Number(Object.values(one(q, ...a))[0]);
/** 部门、成员、授予、提议四张表的样子：停写的接口前后要一模一样 */
const snapshot = () => JSON.stringify({
  d: all('SELECT * FROM departments ORDER BY id'), m: all('SELECT * FROM department_members ORDER BY department_id, principal_id'),
  g: all('SELECT id, principal_id, role, scope, status FROM grants ORDER BY id'), l: all('SELECT * FROM dept_lead_grants ORDER BY department_id'),
  p: all('SELECT id, status FROM relation_proposals ORDER BY id'), w: all('SELECT id FROM setup_wizard_runs ORDER BY id'),
});

let child = null, port = 0;
async function start() {
  port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_BENCH_VIEWS: 'on' });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) { try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error(`实例没起来：${log.trim().split('\n').slice(-5).join(' | ')}`);
  return base;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

rmSync(OUT, { recursive: true, force: true });
for (const d of [data, home]) mkdirSync(d, { recursive: true });
try {
  let base = await start();
  const call = async (method, path, { session, remote, body } = {}) => {
    const host = new URL(base).host;
    const h = session ? { ...REMOTE, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', cookie: `session_id=${session}` } : remote ? { ...REMOTE } : {};
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json, text };
  };
  for (const s of [SESSIONS.alpha, SESSIONS.beta, SESSIONS.strasse, SESSIONS.admin]) await call('GET', '/api/auth/viewer', { session: s });

  // ---- 造数据：直接写库 ----
  sql((d) => {
    const now = 1;
    for (const [id, name] of [['sales', '合成销售'], ['ops', '合成运营'], ['legacy', '合成旧部门']]) d.prepare('INSERT INTO departments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
    d.prepare('INSERT INTO department_members (department_id, principal_id, created_by, created_at) VALUES (?, ?, ?, ?)').run('sales', 'user:beta', 'cli', now);
    for (const [id, status] of [['sales', 'pending-lead'], ['ops', 'retired']]) d.prepare("INSERT INTO areas (id, name, status, source, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 'department', ?, 'cli', ?, 'cli')").run(id, `合成${id}`, status, now, now);
    const prop = d.prepare("INSERT INTO relation_proposals (id, kind, department_id, principal_id, proposed_by, proposed_at) VALUES (?, 'dept-lead', ?, ?, ?, ?)");
    prop.run(10, 'sales', 'user:beta', 'admin-token', now);   // S5
    prop.run(11, 'ops', 'user:alpha', 'admin-token', now);    // S6 撤了
    prop.run(12, 'legacy', 'user:alpha', 'admin-token', now); // S6 没迁
    prop.run(13, 'sales', 'user:beta', 'someone-else', now);  // S7 同一个人、同一个领域
    prop.run(14, 'sales', 'user:strasse', 'admin-token', now); // S7b
    prop.run(15, 'sales', 'user:alpha', 'admin-token', now);  // S5b
  });
  const grant = (principal, role, scope, reason, to) => sql((d) => {
    const id = Number(d.prepare('INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 1, 1)').run(principal, role, scope, reason, 'cli').lastInsertRowid);
    if (to !== 'draft') d.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(id);
    if (to === 'active') d.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(id);
    if (to === 'revoked') d.prepare("UPDATE grants SET status = 'revoked' WHERE id = ?").run(id);
    return id;
  });
  grant('user:alpha', 'dept-member', 'dept:legacy', '合成：停写前就有的', 'active');
  const draftDept = grant('user:beta', 'dept-member', 'dept:legacy', '合成：停写前起草的', 'draft');
  grant('user:strasse', 'area-lead', 'area:sales', MIGRATE_REASON, 'revoked');

  // ---- S1 ----
  {
    const before = snapshot();
    const writes = [['PUT', '/api/departments/sales', { name: '改名' }], ['PUT', '/api/departments/fresh', { name: '新部门' }], ['DELETE', '/api/departments/legacy'],
      ['PUT', '/api/departments/sales/members/user:alpha'], ['DELETE', '/api/departments/sales/members/user:beta']];
    const cli = [], admin = [], anon = [];
    for (const [m, p, b] of writes) {
      const r = await call(m, p, { body: b });
      cli.push(`${r.status}/${r.json?.error}`);
      admin.push((await call(m, p, { session: SESSIONS.admin, body: b })).status);
      anon.push((await call(m, p, { remote: true, body: b })).status);
    }
    const reads = [(await call('GET', '/api/departments')).status, (await call('GET', '/api/departments/sales')).status, (await call('GET', '/api/departments/of/user:beta')).status];
    const s = { cli, admin, anon, reads, same: snapshot() === before };
    check(cli.every((x) => x === '410/department_write_closed') && admin.every((x) => x === 410) && anon.every((x) => x === 401 || x === 403) && reads.every((x) => x === 200) && s.same,
      'S1（#17）部门增改删、成员增删：属主、管理员 410，远程没登录照旧被拦（401/403），读照旧，库里不变', s);
  }

  // ---- S2 ----
  {
    const before = snapshot();
    const r = await call('POST', '/api/setup/wizard', { body: { shape: 'standard', assignments: { dept_leads: [{ principal: 'user:beta', department: 'sales' }] } } });
    const same = snapshot() === before;
    const ok = await call('POST', '/api/setup/wizard', { body: { shape: 'standard', assignments: { management: [] } } });
    check(r.status === 400 && r.json?.error === 'dept_leads_closed' && same && ok.status === 201,
      'S2（#17）向导带 dept_leads：400 dept_leads_closed，什么都不落；不带的照旧 201', { status: r.status, error: r.json?.error, same, ok: ok.status });
  }

  // ---- S3 ----
  {
    const before = n("SELECT COUNT(*) FROM grants WHERE scope LIKE 'dept:%'");
    const lead = await call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'dept-lead', scope: 'dept:sales', reason: '合成' } });
    const member = await call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'dept-member', scope: 'dept:legacy', reason: '合成' } });
    const after = n("SELECT COUNT(*) FROM grants WHERE scope LIKE 'dept:%'");
    const legacy = (await call('GET', '/api/principals/user:alpha/access?action=bench-store.dataset-list&scope=dept:legacy')).json?.decision;
    const s = { lead: `${lead.status}/${lead.json?.error}`, member: `${member.status}/${member.json?.error}`, before, after, legacy: `${legacy?.verdict}/${legacy?.via}` };
    check(s.lead === '422/dept_scope_closed' && s.member === '422/dept_scope_closed' && before === after && s.legacy === 'allow/dept',
      'S3 新起草 dept: 范围的授予 422 dept_scope_closed（dept-lead、dept-member 都拒）；停写前就生效的 dept:legacy 照旧算', s);
  }

  // ---- S3b ----
  {
    const sub = await call('POST', `/api/grants/${draftDept}/submit`);
    const app = await call('POST', `/api/grants/${draftDept}/approve`);
    const st = one('SELECT status FROM grants WHERE id = ?', draftDept)?.status;
    check(sub.status === 200 && app.status === 200 && st === 'active', 'S3b（Q1）停写前就在草稿里的 dept: 授予照常提交、放行', { sub: sub.status, app: app.status, st });
  }

  // ---- S4 ----
  {
    const before = n("SELECT COUNT(*) FROM relation_proposals WHERE kind = 'dept-lead'");
    const r = await call('PUT', '/api/departments/sales', { session: SESSIONS.admin, body: { name: '合成销售', lead: 'user:alpha' } });
    const after = n("SELECT COUNT(*) FROM relation_proposals WHERE kind = 'dept-lead'");
    check(r.status === 410 && before === after, 'S4 新的 dept-lead 提议收不进来：改部门时带 lead 410，没有新提议', { status: r.status, before, after });
  }

  const deptGrants = () => n("SELECT COUNT(*) FROM grants WHERE scope LIKE 'dept:%'");
  const leadsOf = (p) => all("SELECT id, status, reason FROM grants WHERE principal_id = ? AND role = 'area-lead' AND scope = 'area:sales' ORDER BY id", p);
  const deptSide = () => JSON.stringify({ d: all('SELECT id, lead_principal FROM departments ORDER BY id'), l: all('SELECT * FROM dept_lead_grants') });
  let s5Grant = null;

  // ---- S5 ----
  {
    const dg = deptGrants(), side = deptSide();
    const r = await call('POST', '/api/relations/proposals/10/approve');
    const g = leadsOf('user:beta');
    s5Grant = r.json?.drafted_grant_id ?? null;
    const s = { status: r.status, id: s5Grant, proposal: r.json?.proposal?.status, g, dept: deptGrants() - dg, sideSame: deptSide() === side };
    check(r.status === 200 && Number.isSafeInteger(s5Grant) && s.proposal === 'approved' && g.length === 1 && g[0].id === s5Grant && g[0].status === 'pending' && g[0].reason === CONVERT_REASON
      && s.dept === 0 && s.sideSame && r.json?.skipped === undefined && r.json?.refused_before_overridden === undefined,
      'S5 属主确认已有 dept-lead 提议：200 带 drafted_grant_id，起草一条 area-lead（area:sales，待核，理由对）；不发 dept: 授予，负责人字段、dept_lead_grants 不动', s);
  }

  // ---- S5b ----
  {
    const list = (await call('GET', '/api/attention')).json;
    const item = (list?.items ?? []).find((x) => x.source === 'relation-proposals' && x.source_id === '15');
    const before = snapshot();
    const r = await call('POST', '/api/attention/answer', { body: { source: 'relation-proposals', source_id: '15', answer: 'approve' } });
    const same = snapshot() === before;
    check(!!item && item.link === '/team' && (item.answers ?? []).length === 0 && r.status === 400 && r.json?.error === 'attention_answer_not_offered' && same,
      'S5b「等你拍板」里的关系提议：只列（链到团队页）、不带答复；答复地址 400，库里不变——确认只走 S5 那一个接口', { item: !!item, link: item?.link, answers: item?.answers, status: r.status, error: r.json?.error, same });
  }

  // ---- S6 ----
  {
    const before = snapshot();
    const ops = await call('POST', '/api/relations/proposals/11/approve');
    const legacy = await call('POST', '/api/relations/proposals/12/approve');
    const st = all('SELECT id, status FROM relation_proposals WHERE id IN (11, 12) ORDER BY id').map((x) => x.status).join(',');
    const s = { ops: `${ops.status}/${ops.json?.error}`, legacy: `${legacy.status}/${legacy.json?.error}`, st, same: snapshot() === before, msg: legacy.json?.message };
    check(s.ops === '409/area_not_migrated' && s.legacy === '409/area_not_migrated' && st === 'pending,pending' && s.same,
      'S6 领域撤了（ops）、领域不存在（legacy）：确认 409 area_not_migrated，提议仍是 pending，库里不变', s);
  }

  // ---- S7 ----
  {
    const again = await call('POST', '/api/relations/proposals/10/approve');
    const other = await call('POST', '/api/relations/proposals/13/approve');
    const g = leadsOf('user:beta');
    const s = { again: `${again.status}/${again.json?.error}`, other: other.status, id: other.json?.drafted_grant_id, skipped: other.json?.skipped, n: g.length };
    check(s.again === '409/state' && other.status === 200 && s.id === s5Grant && s.skipped === 'already_open' && s.n === 1 && other.json?.proposal?.status === 'approved',
      'S7 同一条确认两次：第二次 409 state；另一条提议指向同一个人、同一个领域：不另起草，skipped already_open，drafted_grant_id 是已有那条', s);
  }

  // ---- S7b ----
  {
    const r = await call('POST', '/api/relations/proposals/14/approve');
    const g = leadsOf('user:strasse');
    const id = r.json?.drafted_grant_id;
    const ev = one("SELECT reason FROM grant_events WHERE grant_id = ? AND event = 'draft'", id ?? -1)?.reason ?? '';
    const s = { status: r.status, id, over: r.json?.refused_before_overridden, g: g.map((x) => x.status).join(','), ev };
    check(r.status === 200 && Number.isSafeInteger(id) && s.over === true && s.g === 'revoked,pending' && /否决/.test(ev),
      'S7b（Q2）这个人迁移起草的负责人被否决过：属主这次确认照样起草（待核），带 refused_before_overridden，留痕写明', s);
  }

  // ---- S8 ----
  {
    // 新的部门 quiet：负责人字段写着 beta，beta 没有它的授予、也没有它的提议——停写前，启动时会给它补记一条
    sql((d) => d.prepare("INSERT INTO departments (id, name, lead_principal, created_at, updated_at) VALUES ('quiet', '合成安静部门', 'user:beta', 1, 1)").run());
    const before = n("SELECT COUNT(*) FROM relation_proposals WHERE kind = 'dept-lead'");
    await stop();
    base = await start();
    await sleep(1500);
    const after = n("SELECT COUNT(*) FROM relation_proposals WHERE kind = 'dept-lead'");
    check(before === after, 'S8 重启以后不再给「字段有、授予没有」的部门补记 dept-lead 提议', { before, after });
  }

  // ---- S9 ----
  {
    const lines = (await call('GET', '/api/access/red-lines')).json?.red_lines ?? [];
    const red = lines.find((x) => x.id === 'dept-scope-closed');
    const health = (await call('GET', '/api/health')).json;
    const probe = JSON.stringify(health?.self_probe ?? health ?? '');
    check(!!red && lines[lines.length - 1]?.id === 'dept-scope-closed' && /部门写接口已停写/.test(probe),
      'S9 [red-line:dept-scope-closed] 红线在列表末尾；启动自检里有「部门写接口已停写」', { red: red?.id, last: lines[lines.length - 1]?.id, probe: probe.slice(0, 120) });
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  await stop();
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${fail ? '✗' : '✓'} 旧部门接口停写：${pass} 过、${fail} 不过`);
process.exit(fail ? 1 : 0);
