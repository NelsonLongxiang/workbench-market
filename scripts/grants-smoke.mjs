#!/usr/bin/env node
/**
 * 角色声明与授予的对抗组（阶段六 6b，安全面）。真实的 server/src/index.ts，身份来源是假提供方（identity-fake-provider.mjs），
 * 只在 127.0.0.1 上，不访问任何外部系统。库里的规则另用一个旁路连接直接改库来验（绕过服务也拦得住）。
 *
 *   一、五种状态之外的迁移全部被拒：库里直接改（25 对逐一试），和经接口走错步
 *   二、自授：起草给自己、放行给自己；库里的约束
 *   三、越级放行：管理员级的授予，口令管理员、不是属主的管理员登录放行都拒；属主（本机命令行、持 owner 授予的人）能放行
 *   四、没有在职责任人的非人主体不能被授予
 *   五、决定类权限不给非人主体：直接带、经 includes 一层层带进来的都拒
 *   六、范围：角色里写的范围要在授予之内；object: 只比相等；写法不对的拒
 *   七、到期自动失效、撤销要理由、每步留痕
 *   八、不是管理员、跨站：接口都拒
 *   九、只建结构不接判定：授予了 admin 角色的人照样写不了管理面
 *   十、角色声明不合格拒绝启动（同名、循环、不存在的包含和动作、类别和范围写法、不认识的键、路径和 JSON）
 *
 *   node scripts/grants-smoke.mjs              测本仓库
 *   node scripts/grants-smoke.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `grants-smoke-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-grants-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.51' };
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

const running = [];
/** 起一个隔离实例；起不来返回 { failed, log } 而不是抛（拒绝启动的那几例要用） */
async function boot(name, extraEnv = {}, { expectFail = false } = {}) {
  const port = await freePort();
  const data = join(OUT, name, 'data'), home = join(OUT, name, 'home'), ext = join(OUT, name, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, ...extraEnv });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (expectFail ? 20000 : 40000);
  let ready = false;
  while (!ready && Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const waitExit = (ms) => new Promise((r) => { if (exited()) r(); else { const t = setTimeout(r, ms); child.once('exit', () => { clearTimeout(t); r(); }); } });
  const stop = async () => {
    if (!exited()) { child.kill('SIGTERM'); await waitExit(3000); }
    if (!exited()) { child.kill('SIGKILL'); await waitExit(5000); }
  };
  if (!ready) { await stop(); if (expectFail) return { failed: true, code: child.exitCode, log }; throw new Error(`隔离实例 ${name} 没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`); }
  if (expectFail) { await stop(); return { failed: false, log }; }
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    try {
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: res.status, text, json };
    } catch (e) { return { status: 0, text: String(e?.name ?? e), json: null }; }
  };
  const srv = { name, base, host: new URL(base).host, data, stop, call, log: () => log, db: () => new DatabaseSync(join(data, 'workbench-market.db')) };
  running.push(srv);
  return srv;
}

const rolesFile = (name, doc) => { const f = join(OUT, `${name}.json`); mkdirSync(OUT, { recursive: true }); writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc)); return f; };

try {
  // 外部声明文件：几个测试用的组织角色（合法的）
  const goodRoles = rolesFile('good', { roles: [
    { id: 'dept-member', name: '部门成员', permissions: [{ kinds: ['read', 'write'] }] },
    { id: 'dept-lead', name: '部门负责人', includes: ['dept-member'], permissions: [{ kinds: ['decide'] }] },
    { id: 'mid', name: '中间层', includes: ['dept-lead'], permissions: [] },
    { id: 'deep', name: '最外层', includes: ['mid'], permissions: [{ actions: ['workbench_list'] }] },
    { id: 'scoped', name: '只在甲域', permissions: [{ kinds: ['read'], scope: 'domain:a' }] },
    { id: 'obj', name: '观测层对象', permissions: [{ kinds: ['read'], scope: 'object:stage-7f' }] },
    { id: 'cfg', name: '配置员', permissions: [{ kinds: ['admin'] }] },
    // 按 HTTP 服务登记的动作写的权限：动作清单里要有，类别从清单里取
    { id: 'viewer', name: '只看台', permissions: [{ actions: ['workbench.list', 'workbench.read', 'attention.read'] }] },
    { id: 'approver', name: '审批变更', permissions: [{ actions: ['change-request.approve'] }] },
    { id: 'deactivator', name: '停用主体', permissions: [{ actions: ['principal.disable'] }] },
  ] });
  const srv = await boot('main', { WM_ROLES_FILE: goodRoles });
  const db = srv.db();
  // 让假提供方认出的人进主体表；再放几个非人的主体（有责任人的、责任人不存在的）
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  db.exec("INSERT INTO principals (id, id_key, kind, display_name, owner) VALUES ('seat:bot', 'seat:bot', 'seat', '合成席位', 'user:alpha'), ('seat:orphan', 'seat:orphan', 'seat', '没人管的席位', 'user:nobody')");
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const asRoot = { headers: { ...REMOTE, ...same }, session: SESSIONS.admin }; // 管理员登录（odoo:root-admin），不是属主
  const draft = (body, who = {}) => srv.call('POST', '/api/grants', { body: { scope: '*', reason: '合成：对抗例', ...body }, ...who });
  const step = (id, s, who = {}, body) => srv.call('POST', `/api/grants/${id}/${s}`, { ...who, ...(body ? { body } : {}) });
  /** 本机命令行（属主）走完起草→提交→放行 */
  const activate = async (body) => { const d = await draft(body); await step(d.json?.grant?.id, 'submit'); const a = await step(d.json?.grant?.id, 'approve'); return { id: d.json?.grant?.id, d, a }; };

  // ---------- 对照：一条授予正常走完 ----------
  {
    const d = await draft({ principal: 'user:alpha', role: 'member' }, { headers: token });
    const s = await step(d.json?.grant?.id, 'submit', { headers: token });
    const a = await step(d.json?.grant?.id, 'approve', { headers: token });
    const one = await srv.call('GET', `/api/grants/${d.json?.grant?.id}`, { headers: token });
    const ev = one.json?.grant?.events?.map((e) => `${e.event}:${e.from_status}->${e.to_status}:${e.actor}`);
    check(d.status === 201 && s.status === 200 && a.status === 200 && a.json?.grant?.status === 'active' && a.json.grant.approved_by === 'admin-token'
      && show(ev) === show(['draft:null->draft:admin-token', 'submit:draft->pending:admin-token', 'approve:pending->active:admin-token']),
      '对照：口令管理员给成员角色——起草 201、提交、放行，生效；每一步留一行痕', show({ d: d.status, s: s.status, a: a.status, ev }));
  }

  // ---------- 一、五种状态之外的迁移 ----------
  {
    // 经接口走错步
    const d = await draft({ principal: 'user:beta', role: 'member' });
    const id = d.json?.grant?.id;
    const r1 = await step(id, 'approve'); // 草稿直接放行
    await step(id, 'submit');
    const r2 = await step(id, 'submit'); // 待核再提交
    await step(id, 'approve');
    const r3 = await step(id, 'approve'); // 生效再放行
    const r4 = await step(id, 'submit'); // 生效再提交
    await step(id, 'revoke', {}, { reason: '合成：收回' });
    const r5 = await step(id, 'revoke', {}, { reason: '再撤一次' }); // 撤销了再撤
    const r6 = await step(id, 'submit'); // 撤销了再提交
    const r7 = await step(id, 'approve'); // 撤销了再放行
    const codes = [r1, r2, r3, r4, r5, r6, r7].map((r) => r.status);
    check(codes.every((c) => c === 409), '经接口走错步（草稿直接放行、重复提交、重复放行、撤销之后再动）：都 409', show(codes));

    // 库里直接改：25 对逐一试。每一对用一条新授予，先按合法的路走到起点
    const STATES = ['draft', 'pending', 'active', 'revoked', 'expired'];
    const allowed = new Set(['draft>pending', 'draft>revoked', 'pending>active', 'pending>revoked', 'active>revoked', 'active>expired']);
    const now = () => Date.now();
    let seq = 0;
    const fresh = (status, expires = null) => {
      const id = Number(db.prepare("INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_at, updated_at) VALUES ('user:beta', 'member', '*', ?, ?, 'cli', ?, ?)").run(expires, `直改 ${++seq}`, now(), now()).lastInsertRowid);
      const go = (to, extra = '') => db.prepare(`UPDATE grants SET status = ?${extra} WHERE id = ?`).run(to, id);
      if (status === 'pending' || status === 'active' || status === 'expired') go('pending');
      if (status === 'active' || status === 'expired') go('active', ", approved_by = 'cli'");
      if (status === 'revoked') go('revoked');
      return id;
    };
    // 「过期」的起点和「生效→过期」那一对要真的到期：期限设在 1.5 秒之后，放行之后等它过
    const dueIds = {};
    for (const from of ['expired', 'active']) dueIds[from] = fresh('active', now() + 1500);
    await sleep(1700);
    db.prepare("UPDATE grants SET status = 'expired' WHERE id = ?").run(dueIds.expired);
    const wrong = [];
    for (const from of STATES) for (const to of STATES) {
      if (from === to) continue;
      const id = from === 'active' && to === 'expired' ? dueIds.active : from === 'expired' ? fresh('active', now() + 1500) : fresh(from);
      if (from === 'expired') { await sleep(1600); db.prepare("UPDATE grants SET status = 'expired' WHERE id = ?").run(id); }
      let ok = true;
      try { db.prepare(`UPDATE grants SET status = ?${to === 'active' ? ", approved_by = 'cli'" : ''} WHERE id = ?`).run(to, id); } catch { ok = false; }
      if (ok !== allowed.has(`${from}>${to}`)) wrong.push(`${from}>${to}:${ok ? '放过了' : '拦了'}`);
    }
    check(wrong.length === 0, '库里直接改状态：20 对不同状态之间，只有 草稿→待核/撤销、待核→生效/撤销、生效→撤销/过期 这 6 对能过，其余 14 对都拦', show(wrong));

    const blocked = (sql, ...a) => { try { db.prepare(sql).run(...a); return false; } catch { return true; } };
    const someId = fresh('active');
    const notDue = fresh('active', now() + 3600_000);
    const pend = fresh('pending', now() - 1000);
    const dbRules = {
      insertActive: blocked("INSERT INTO grants (principal_id, role, scope, reason, status, created_by, approved_by, created_at, updated_at) VALUES ('user:beta', 'member', '*', 'x', 'active', 'cli', 'cli', 1, 1)"),
      deleteRow: blocked('DELETE FROM grants WHERE id = ?', someId),
      changeRole: blocked("UPDATE grants SET role = 'owner' WHERE id = ?", someId),
      changeScope: blocked("UPDATE grants SET scope = 'domain:x' WHERE id = ?", someId),
      changePrincipal: blocked("UPDATE grants SET principal_id = 'user:alpha' WHERE id = ?", someId),
      changeExpiry: blocked('UPDATE grants SET expires_at = 1 WHERE id = ?', someId),
      approverLater: blocked("UPDATE grants SET approved_by = 'someone' WHERE id = ?", someId),
      activateNoApprover: blocked("UPDATE grants SET status = 'active' WHERE id = ?", fresh('pending')),
      expireNotDue: blocked("UPDATE grants SET status = 'expired' WHERE id = ?", notDue),
      activateExpired: blocked("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?", pend),
      eventUpdate: blocked("UPDATE grant_events SET actor = 'x' WHERE seq = (SELECT MIN(seq) FROM grant_events)"),
      eventDelete: blocked('DELETE FROM grant_events WHERE seq = (SELECT MIN(seq) FROM grant_events)'),
    };
    const leaks = Object.entries(dbRules).filter(([, v]) => !v).map(([k]) => k);
    check(leaks.length === 0, '库里的其他规则：不能直接建生效的、不能删、主体角色范围期限建好不能改、放行人只在放行那一步写、生效要有放行人、没到期不能标过期、过了期限不能生效、留痕只增不改', show(leaks));
  }

  // ---------- 二、自授 ----------
  {
    const own = await draft({ principal: 'user:root-admin', role: 'member' }, asRoot);
    const d = await draft({ principal: 'user:root-admin', role: 'member' }); // 本机命令行起草给 root-admin
    await step(d.json?.grant?.id, 'submit');
    const selfApprove = await step(d.json?.grant?.id, 'approve', asRoot);
    const ctl = await step(d.json?.grant?.id, 'approve'); // 对照：别人（本机命令行）放行
    const d2 = await draft({ principal: 'user:root-admin', role: 'member' });
    const selfSubmit = await step(d2.json?.grant?.id, 'submit', asRoot);
    let dbSelf = false;
    try { db.prepare("INSERT INTO grants (principal_id, role, scope, reason, created_by, created_by_principal, created_at, updated_at) VALUES ('user:alpha', 'member', '*', 'x', 'odoo:alpha', 'user:alpha', 1, 1)").run(); } catch { dbSelf = true; }
    check(own.status === 403 && own.json?.error === 'self_grant' && selfApprove.status === 403 && selfApprove.json?.error === 'self_grant' && selfSubmit.status === 403
      && ctl.status === 200 && dbSelf,
      '自授：起草给自己、提交给自己的、放行给自己的都 403；库里的约束也拦（起草人就是被授予的主体）；对照：别人放行 200', show({ own: own.status, selfApprove: selfApprove.status, selfSubmit: selfSubmit.status, ctl: ctl.status, dbSelf }));
  }

  // ---------- 三、越级放行 ----------
  {
    const levels = {};
    for (const role of ['admin', 'owner', 'cfg']) {
      const d = await draft({ principal: 'user:beta', role }, { headers: token });
      await step(d.json?.grant?.id, 'submit', { headers: token });
      levels[role] = { id: d.json?.grant?.id, byToken: (await step(d.json?.grant?.id, 'approve', { headers: token })).status, byAdminLogin: (await step(d.json?.grant?.id, 'approve', asRoot)).status };
    }
    // 属主：本机命令行放行 admin 那一条；再给 root-admin 一个 owner 授予之后，它能放行 cfg 那一条
    const byCli = await step(levels.admin.id, 'approve');
    const owner = await activate({ principal: 'user:root-admin', role: 'owner' });
    const byOwner = await step(levels.cfg.id, 'approve', asRoot);
    check(Object.values(levels).every((l) => l.byToken === 403 && l.byAdminLogin === 403) && byCli.status === 200 && owner.a.status === 200 && byOwner.status === 200,
      '越级放行：管理员级的授予（admin、owner、带管理类权限的组织角色）口令管理员、不是属主的管理员登录放行都 403；对照：本机命令行放行 200，持 owner 授予的人放行 200',
      show({ levels, byCli: byCli.status, owner: owner.a.status, byOwner: byOwner.status }));
    // 收回 root-admin 的 owner：之后它就不是属主了，再放行管理员级的授予要被拒
    const revoked = await step(owner.id, 'revoke', {}, { reason: '合成：收回' });
    const again = await draft({ principal: 'user:beta', role: 'admin' }, { headers: token });
    await step(again.json?.grant?.id, 'submit', { headers: token });
    const afterRevoke = await step(again.json?.grant?.id, 'approve', asRoot);
    check(revoked.status === 200 && afterRevoke.status === 403 && afterRevoke.json?.error === 'owner_required',
      '属主身份跟着授予走：owner 授予撤销之后，同一个人再放行管理员级的授予 403', show({ revoked: revoked.status, afterRevoke: afterRevoke.status }));
  }

  // ---------- 四、没有在职责任人的非人主体 ----------
  {
    const orphan = await draft({ principal: 'seat:orphan', role: 'member' });
    const ok = await draft({ principal: 'seat:bot', role: 'member' });
    await srv.call('POST', '/api/principals/disable', { body: { id: 'user:alpha', reason: '合成' } });
    const afterOwnerOff = await step(ok.json?.grant?.id, 'submit');
    await srv.call('POST', '/api/principals/restore', { body: { id: 'user:alpha' } });
    const back = await step(ok.json?.grant?.id, 'submit');
    let dbNoOwner = false;
    try { db.exec("INSERT INTO principals (id, id_key, kind, owner) VALUES ('seat:none', 'seat:none', 'seat', '')"); } catch { dbNoOwner = true; }
    check(orphan.status === 422 && orphan.json?.error === 'no_responsible' && ok.status === 201 && afterOwnerOff.status === 422 && afterOwnerOff.json?.error === 'no_responsible' && back.status === 200 && dbNoOwner,
      '非人主体：责任人不存在 422；责任人停用之后提交 422，恢复之后能提交；库里不许建没有责任人的非人主体；对照：有在职责任人的能起草',
      show({ orphan: orphan.status, ok: ok.status, afterOwnerOff: afterOwnerOff.status, back: back.status, dbNoOwner }));
  }

  // ---------- 五、决定类权限不给非人主体 ----------
  {
    const direct = await draft({ principal: 'seat:bot', role: 'dept-lead' });
    const nested = await draft({ principal: 'seat:bot', role: 'deep' }); // deep → mid → dept-lead（带 decide）
    const owner = await draft({ principal: 'seat:bot', role: 'owner' });
    const member = await draft({ principal: 'seat:bot', role: 'dept-member' });
    const person = await draft({ principal: 'user:beta', role: 'deep' });
    check([direct, nested, owner].every((r) => r.status === 422 && r.json?.error === 'decide_non_person') && member.status === 201 && person.status === 201,
      '决定类权限不给非人主体：直接带的、经两层 includes 带进来的、owner 都 422；对照：不带决定类的给席位、带决定类的给人都能起草',
      show({ direct: direct.status, nested: nested.status, owner: owner.status, member: member.status, person: person.status }));
  }

  // ---------- 五之二、按动作写的权限：类别从 HTTP 服务登记的动作清单里取 ----------
  {
    const decideToSeat = await draft({ principal: 'seat:bot', role: 'approver' });
    const readToSeat = await draft({ principal: 'seat:bot', role: 'viewer' });
    const d = await draft({ principal: 'user:beta', role: 'deactivator' }, { headers: token });
    await step(d.json?.grant?.id, 'submit', { headers: token });
    const byToken = await step(d.json?.grant?.id, 'approve', { headers: token });
    const byCli = await step(d.json?.grant?.id, 'approve');
    const roles = (await srv.call('GET', '/api/roles', { headers: token })).json?.roles ?? [];
    const flags = Object.fromEntries(roles.filter((r) => ['viewer', 'approver', 'deactivator'].includes(r.id)).map((r) => [r.id, [r.admin_level, r.decides]]));
    check(decideToSeat.status === 422 && decideToSeat.json?.error === 'decide_non_person' && readToSeat.status === 201 && byToken.status === 403 && byCli.status === 200
      && show(flags) === show({ viewer: [false, false], approver: [false, true], deactivator: [true, false] }),
      '按动作写的权限：带决定类动作（change-request.approve）的不给席位，带管理类动作（principal.disable）的算管理员级、只有属主能放行；对照：只读动作的能给席位',
      show({ decideToSeat: decideToSeat.status, readToSeat: readToSeat.status, byToken: byToken.status, byCli: byCli.status, flags }));
  }

  // ---------- 六、范围 ----------
  {
    const wider = await draft({ principal: 'user:beta', role: 'scoped', scope: 'domain:b' });
    const sameScope = await draft({ principal: 'user:beta', role: 'scoped', scope: 'domain:a' });
    const all = await draft({ principal: 'user:beta', role: 'scoped', scope: '*' });
    const objOther = await draft({ principal: 'user:beta', role: 'obj', scope: 'object:stage-8a' });
    const objSame = await draft({ principal: 'user:beta', role: 'obj', scope: 'object:stage-7f' });
    const bad = [];
    for (const scope of ['', 'domain:', '域:采购', 'bench', 'all', 'domain:a b', 'object:', 'tool:\u0007']) {
      const r = await draft({ principal: 'user:beta', role: 'member', scope });
      if (r.status !== 400) bad.push([scope, r.status]);
    }
    check(wider.status === 422 && wider.json?.error === 'scope_wider' && objOther.status === 422 && sameScope.status === 201 && all.status === 201 && objSame.status === 201 && bad.length === 0,
      '范围：角色写的范围不在授予之内 422（object: 只比相等）；写法不对的 8 种 400；对照：相等、授予是 * 都能起草',
      show({ wider: wider.status, objOther: objOther.status, sameScope: sameScope.status, all: all.status, objSame: objSame.status, bad }));
  }

  // ---------- 七、到期、撤销、留痕 ----------
  {
    const d = await draft({ principal: 'user:beta', role: 'member', expires_at: Date.now() + 1500 });
    await step(d.json?.grant?.id, 'submit');
    const a = await step(d.json?.grant?.id, 'approve');
    await sleep(1700);
    const listed = await srv.call('GET', '/api/grants?principal=user:beta&status=expired', { headers: token });
    const one = await srv.call('GET', `/api/grants/${d.json?.grant?.id}`, { headers: token });
    const late = await draft({ principal: 'user:beta', role: 'member', expires_at: Date.now() + 800 });
    await step(late.json?.grant?.id, 'submit');
    await sleep(1000);
    const lateApprove = await step(late.json?.grant?.id, 'approve');
    const past = await draft({ principal: 'user:beta', role: 'member', expires_at: Date.now() - 1 });
    const noReason = await step(late.json?.grant?.id, 'revoke', {}, {});
    const noDraftReason = await srv.call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'member', scope: '*' } });
    check(a.status === 200 && one.json?.grant?.status === 'expired' && listed.json?.grants?.some((g) => g.id === d.json?.grant?.id) && one.json.grant.events.at(-1)?.event === 'expire'
      && lateApprove.status === 409 && past.status === 400 && noReason.status === 400 && noDraftReason.status === 400,
      '到期自动失效：生效的到期之后标成过期并留痕；过了期限的待核不能放行（409）；期限在过去的不能起草；起草、撤销都要写理由',
      show({ a: a.status, status: one.json?.grant?.status, lateApprove: lateApprove.status, past: past.status, noReason: noReason.status, noDraftReason: noDraftReason.status }));
  }

  // ---------- 八、不是管理员、跨站 ----------
  {
    const cross = { origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' };
    const results = {
      anonList: (await srv.call('GET', '/api/grants', { headers: REMOTE })).status,
      anonRoles: (await srv.call('GET', '/api/roles', { headers: REMOTE })).status,
      anonDraft: (await draft({ principal: 'user:beta', role: 'member' }, { headers: REMOTE })).status,
      memberDraft: (await draft({ principal: 'user:beta', role: 'member' }, { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha })).status,
      memberList: (await srv.call('GET', '/api/grants', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha })).status,
      crossToken: (await draft({ principal: 'user:beta', role: 'member' }, { headers: { ...token, ...cross } })).status,
      crossLogin: (await draft({ principal: 'user:beta', role: 'member' }, { headers: { ...REMOTE, ...cross }, session: SESSIONS.admin })).status,
      wrongToken: (await srv.call('GET', '/api/grants', { headers: { ...REMOTE, 'x-admin-token': 'nope' } })).status,
    };
    const roles = await srv.call('GET', '/api/roles', { headers: token });
    const ids = roles.json?.roles?.map((r) => r.id);
    check(Object.values(results).every((s) => s === 403) && show(ids?.slice(0, 4)) === show(['owner', 'admin', 'member', 'guest']) && roles.json?.source === 'file',
      '接口：匿名、登录的非管理员、口令错、跨站（口令或管理员登录）都 403；对照：管理员能列出角色（平台四个在前，声明来自外部文件）', show({ results, ids }));
  }

  // ---------- 九、只建结构不接判定 ----------
  {
    const g = await activate({ principal: 'user:alpha', role: 'admin' });
    const write = await srv.call('POST', '/api/types', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha, body: { key: 'zz-grant-probe', name: '探针' } });
    const list = await srv.call('GET', '/api/principals', { headers: { ...REMOTE, ...same }, session: SESSIONS.alpha });
    check(g.a.status === 200 && write.status === 403 && list.status === 403,
      '只建结构不接判定：alpha 有了生效的 admin 授予，管理写和管理读照样 403（判定在 6c 才接）', show({ grant: g.a.status, write: write.status, list: list.status }));
  }
  db.close();
  await srv.stop();

  // ---------- 十、角色声明不合格拒绝启动 ----------
  {
    const bad = {
      platformId: { roles: [{ id: 'admin', name: '我的管理员', permissions: [] }] },
      platformName: { roles: [{ id: 'my-admin', name: '管理员', permissions: [] }] },
      cycle: { roles: [{ id: 'a', name: '甲', includes: ['b'], permissions: [] }, { id: 'b', name: '乙', includes: ['a'], permissions: [] }] },
      missingInclude: { roles: [{ id: 'a', name: '甲', includes: ['nope'], permissions: [] }] },
      unknownAction: { roles: [{ id: 'a', name: '甲', permissions: [{ actions: ['nope.do'] }] }] },
      badKind: { roles: [{ id: 'a', name: '甲', permissions: [{ kinds: ['execute'] }] }] },
      badScope: { roles: [{ id: 'a', name: '甲', permissions: [{ kinds: ['read'], scope: '域:采购' }] }] },
      unknownKey: { roles: [{ id: 'a', name: '甲', permissions: [], admin: true }] },
      duplicate: { roles: [{ id: 'a', name: '甲', permissions: [] }, { id: 'a', name: '乙', permissions: [] }] },
      emptyPermission: { roles: [{ id: 'a', name: '甲', permissions: [{}] }] },
    };
    const refused = {};
    for (const [k, doc] of Object.entries(bad)) refused[k] = (await boot(`bad-${k}`, { WM_ROLES_FILE: rolesFile(`bad-${k}`, doc) }, { expectFail: true })).failed;
    refused.relativePath = (await boot('bad-relative', { WM_ROLES_FILE: 'roles.json' }, { expectFail: true })).failed;
    refused.missingFile = (await boot('bad-missing', { WM_ROLES_FILE: join(OUT, 'no-such-roles.json') }, { expectFail: true })).failed;
    refused.notJson = (await boot('bad-json', { WM_ROLES_FILE: rolesFile('bad-json', '{ roles: ') }, { expectFail: true })).failed;
    const fine = (await boot('fine-initial', {}, { expectFail: true })).failed;
    const missed = Object.entries(refused).filter(([, v]) => !v).map(([k]) => k);
    check(missed.length === 0 && fine === false,
      `角色声明不合格拒绝启动（${Object.keys(refused).length} 种：和平台角色同 id、同名，循环包含，包含不存在的角色，引用不存在的动作，类别、范围写法不对，不认识的键，id 重复，空权限，相对路径，文件不存在，不是 JSON）；对照：不设外部文件用初始集合，照常启动`,
      show({ missed, fine }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  for (const s of running) await s.stop();
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`grants-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
