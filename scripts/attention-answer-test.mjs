#!/usr/bin/env node
/**
 * 「关注」的答（阶段八 8d）。规格见产品化文档 02 附录 8d。起一个隔离实例（假的登录提供方，NODE_ENV=test）。
 *
 *   一、每个转给原路由的来源：同样的两条待决，一条从新入口答、一条从旧入口答，状态、留痕、应答逐字段相同
 *       （变更申请的拒绝和批准失败、MCP 权限申请的批准、待属主看板的答复、待对接的绑定、事项的放行和撤回）
 *   二、无权的人从新入口答，被拒的方式和旧入口一样；看得到但不在列表里的 404
 *   三、重复答返回第一次的结果、不再生效；并发答一个生效、另一个被告知
 *   四、转发的硬约束：路径只来自写死的表（id 核形状、编码；转不到表外、转不回入口自己）；身份原样（留痕里的人和旧入口一样）；
 *       请求体只由答法换算（多带的字段不透传）；原路由的状态码和正文原样交回
 *   五、新写的两类：席位提问的答复（记在事项上、合上提问、对 v1 不发）、事项的验收和退回
 *
 *   node scripts/attention-answer-test.mjs              测本仓库
 *   node scripts/attention-answer-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `attention-answer-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'attention-answer-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const SEED = `
const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
const { db } = await import(at('server/src/db.ts'));
const { root } = await import(at('server/src/root-context.ts'));
const events = await import(at('server/src/workbench-events.ts'));
const { WorkItemService } = await import(at('server/src/services/work-item.ts'));
events.initWorkbenchEvents();
await root.plugin(WorkItemService);
const items = root.get('workItems');
const out = {};
const cr = (slug) => Number(db.prepare("INSERT INTO change_requests (kind, slug, op, target_version, reason, requested_by) VALUES ('app', ?, 'rollback', 1, '合成', 'mcp:synthetic')").run(slug).lastInsertRowid);
out.cr = Object.fromEntries(['rejectNew', 'rejectOld', 'approveNew', 'approveOld', 'dup', 'race', 'extra'].map((k) => [k, cr('no-such-app-' + k)]));
out.mcp = {};
for (const k of ['new', 'old']) {
  const s = Number(db.prepare("INSERT INTO mcp_sessions (name, token_sha256) VALUES (?, ?)").run('session-' + k, (k === 'new' ? 'a' : 'b').repeat(64)).lastInsertRowid);
  out.mcp[k] = Number(db.prepare("INSERT INTO mcp_access_requests (session_id, tools, reason) VALUES (?, '[\\"app_sync\\"]', '合成')").run(s).lastInsertRowid);
}
const wb = db.prepare("INSERT INTO workbenches (name, url, type) VALUES ('看板', '/owner-pending', 'web')").run().lastInsertRowid;
out.board = Number(wb);
const putVar = (key, value, owner) => db.prepare("INSERT INTO workbench_vars (workbench_id, key, kind, value, owner, updated_by) VALUES (?, ?, 'const', ?, ?, ?)").run(wb, key, JSON.stringify(value), owner, owner);
putVar('config.owner', { owner_login: 'root-admin', writers: ['mcp:writer'] }, 'odoo:root-admin');
putVar('item.1', { question: '问题一', source: '登记方' }, 'mcp:writer');
putVar('item.2', { question: '问题二', source: '登记方' }, 'mcp:writer');
for (const id of ['ext-new', 'ext-old', 'ext-extra']) db.prepare("INSERT INTO principal_pending (provider, external_id, display_name) VALUES ('synthetic', ?, ?)").run(id, 'Name ' + id);
db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, notify_url) VALUES ('sop', 'task-center', 'team-a', 'notify', 'http://team-a.synthetic.invalid/a2a')").run();
const publish = (id, open) => { db.exec('BEGIN IMMEDIATE'); const e = events.recordTaskCenterEvent({ id, data: {}, stepValue: () => '', publishedBy: 'alpha', templateVersion: 1, materialSha256: 'c'.repeat(64), agentDispatch: open, centerOn: open }); db.exec('COMMIT'); return e; };
out.release = { new: publish(801, false), old: publish(802, false) };
for (const id of [803, 804]) db.prepare("INSERT INTO tasks (id, title, status, published_at, published_by) VALUES (?, ?, 'published', datetime('now'), 'alpha')").run(id, '任务 ' + id);
out.withdraw = { new: publish(803, false), old: publish(804, false) };
out.withdrawTask = { new: 803, old: 804 };
const asked = publish(901, true);
const d = db.prepare("SELECT id FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id LIMIT 1").get(asked).id;
db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', decision = 'ask', decision_reason = '哪个店？', decided_by = 'bob', decided_at = datetime('now') WHERE id = ?").run(d);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(asked, d);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(asked, d, JSON.stringify({ reason: '哪个店？' }));
items.syncEvent(asked);
out.ask = { event: asked, delivery: d };
const ready = (n) => { const it = items.create({ title: '待验收 ' + n, created_by: 'user:alpha', source_kind: 'agent' }); for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? ''), ...x }); return it.id; };
out.ready = { verify: ready(1), ret: ready(2) };
console.log('SEEDED ' + JSON.stringify(out));
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  // ---------- 四·一：转发只收表里的路径（进程内） ----------
  {
    const { forwardable } = await import(at('server/src/attention-forward.ts'));
    const no = [['POST', '/api/attention/answer'], ['POST', '/API/Attention/answer'], ['GET', '/api/change-requests'], ['POST', '/api/x/../attention/answer'], ['POST', '/api/change-requests/1/approve?x=1'], ['DELETE', '/api/bindings/1'], ['POST', '/login'], ['POST', '/api/a b']];
    const leaked = no.filter(([m, p]) => forwardable(m, p));
    check(leaked.length === 0 && forwardable('POST', '/api/change-requests/1/reject'), '转发只收 /api/ 下的 POST、PUT：转不回「关注」入口自己、不收 GET/DELETE、不收带查询串和 .. 的路径', show(leaked));
  }
  {
    // 换算表本身：id 先核形状再编码；请求体只有这一种答法要的字段（入口另有「在不在列表里」一道，这里单独钉住表）
    const { forwardRoute } = await import(at('server/src/attention-answers.ts'));
    const badIds = ['1/../../attention/answer', '1?x=1', '0x1', '1 ', '%2e%2e', '-1', ''];
    const through = badIds.filter((id) => { const r = forwardRoute('change-requests', 'approve', id, {}); return !r || !('error' in r); });
    const ok = forwardRoute('change-requests', 'reject', '12', { reviewed_by: ' alice ', status: 'approved', path: '/x' });
    const bind = forwardRoute('principal-pending', 'bind', 'synthetic:a/b?c', { principal: 'user:x', create: true, reason: 'r', display_name: 'd', provider: 'evil' });
    check(through.length === 0 && ok.path === '/api/change-requests/12/reject' && ok.method === 'POST' && show(ok.body) === show({ reviewed_by: 'alice' })
      && bind.path === '/api/principals/bind' && show(Object.keys(bind.body).sort()) === show(['create', 'external_id', 'principal', 'provider', 'reason']) && bind.body.provider === 'synthetic' && bind.body.external_id === 'a/b?c'
      && forwardRoute('change-requests', 'delete', '1', {}) === null && forwardRoute('mcp-access', 'approve', '../1', {}).error,
      '换算表：坏 id 一律拒；路径固定、id 编码；请求体只取这一种答法的字段（夹带的 status、path、display_name、provider 都不进去）；表外的答法没有', show({ through, ok, bind }));
  }

  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', A2A_OUTBOX_BACKOFF_SCALE: '100000' };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', SEED], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seeded.stdout);
  if (!m) throw new Error(`造数据失败：${seeded.stderr.slice(-800)}`);
  const S = JSON.parse(m[1]);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ADMIN = { ...SAME, cookie: `session_id=${SESSIONS.admin}` }; // 会话登录的管理员（odoo:root-admin）：留痕里看得出是谁
  const call = async (method, path, headers, body) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body: json };
  };
  const answer = (source, source_id, ans, input = {}, headers = ADMIN, extra = {}) => call('POST', '/api/attention/answer', headers, { source, source_id: String(source_id), answer: ans, input, ...extra });
  const db = () => new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true });
  const q = (sql, ...a) => { const c = db(); try { return c.prepare(sql).all(...a); } finally { c.close(); } };
  /** 比较时去掉每一行里必然不同的：自增 id、时间、指向各自那一条的外键 */
  const strip = (rows, drop = []) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'at', 'created_at', 'updated_at', 'decided_at', 'reviewed_at', 'published_at', 'last_seen', ...drop].includes(k))));
  const same = (a, b) => show(a) === show(b);

  // ---------- 一、新入口和旧入口逐字段相同 ----------
  {
    const n = await answer('change-requests', S.cr.rejectNew, 'reject', { reviewed_by: 'alice' });
    const o = await call('POST', `/api/change-requests/${S.cr.rejectOld}/reject`, ADMIN, { reviewed_by: 'alice' });
    const rows = (id) => strip(q('SELECT * FROM change_requests WHERE id = ?', id), ['slug']);
    check(n.status === o.status && same({ ...n.body.result, id: 0 }, { ...o.body, id: 0 }) && same(rows(S.cr.rejectNew), rows(S.cr.rejectOld)) && rows(S.cr.rejectNew)[0].status === 'rejected',
      '变更申请·拒绝：状态码、应答、申请那一行（状态、审核人）逐字段相同', show({ n, o, rows: [rows(S.cr.rejectNew), rows(S.cr.rejectOld)] }));
    const na = await answer('change-requests', S.cr.approveNew, 'approve', { reviewed_by: 'alice' });
    const oa = await call('POST', `/api/change-requests/${S.cr.approveOld}/approve`, ADMIN, { reviewed_by: 'alice' });
    const norm = (b) => JSON.parse(JSON.stringify(b).replaceAll(String(S.cr.approveNew), 'X').replaceAll(String(S.cr.approveOld), 'X').replaceAll('approveNew', 'Y').replaceAll('approveOld', 'Y'));
    check(na.status === oa.status && na.status >= 400 && same(norm(na.body.result), norm(oa.body)) && same(rows(S.cr.approveNew), rows(S.cr.approveOld)),
      `变更申请·批准失败（台不存在）：原路由的失败（${oa.status}）原样交回，不吞；申请那一行两边一样没变`, show({ na, oa }));
    check(q('SELECT 1 FROM attention_answers WHERE source = ? AND source_id = ?', 'change-requests', String(S.cr.approveNew)).length === 0, '失败的那次不记账：还可以再答');
  }
  {
    const n = await answer('mcp-access', S.mcp.new, 'approve', { note: '同意' });
    const o = await call('POST', `/api/mcp/access-requests/${S.mcp.old}/approve`, ADMIN, { note: '同意' });
    const req = (id) => strip(q('SELECT * FROM mcp_access_requests WHERE id = ?', id), ['session_id']);
    const grants = (name) => q('SELECT grants FROM mcp_sessions WHERE name = ?', name)[0].grants;
    const norm = (b) => JSON.parse(JSON.stringify(b).replace(/"(id|session_id)":\d+/g, '"$1":0').replace(/session-(new|old)/g, 'session-X'));
    check(n.status === o.status && n.status === 200 && same(norm(n.body.result), norm(o.body)) && same(req(S.mcp.new), req(S.mcp.old)) && grants('session-new') === grants('session-old') && req(S.mcp.new)[0].decided_by.length > 0,
      'MCP 权限申请·批准：应答、申请那一行（状态、批准人、备注）、会话的授权逐字段相同', show({ n, o, rows: [req(S.mcp.new), req(S.mcp.old)] }));
  }
  {
    const n = await answer('owner-pending', '1', 'answer', { summary: '可以' });
    const { answerBody } = await import(at('server/src/owner-pending.ts'));
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const o = await call('PUT', `/api/workbenches/${S.board}/vars/answer.2`, ADMIN, answerBody('可以', today, null));
    const v = (k) => strip(q('SELECT * FROM workbench_vars WHERE workbench_id = ? AND key = ?', S.board, k), ['key']);
    const audit = (k) => strip(q('SELECT * FROM workbench_var_audit WHERE workbench_id = ? AND key = ?', S.board, k), ['key']);
    check(n.status === o.status && same({ ...n.body.result, key: '' }, { ...o.body, key: '' }) && same(v('answer.1'), v('answer.2')) && same(audit('answer.1'), audit('answer.2')) && v('answer.1')[0]?.owner === 'odoo:root-admin',
      '待属主看板·答复：常量那一行（作者是属主本人）、审计那一行、应答逐字段相同', show({ n, o, v: [v('answer.1'), v('answer.2')], a: [audit('answer.1'), audit('answer.2')] }));
  }
  {
    const n = await answer('principal-pending', 'synthetic:ext-new', 'bind', { principal: 'user:bound-x', create: true, reason: '对接' });
    const o = await call('POST', '/api/principals/bind', ADMIN, { provider: 'synthetic', external_id: 'ext-old', principal: 'user:bound-y', create: true, reason: '对接' });
    const ident = (e) => strip(q('SELECT * FROM principal_identities WHERE provider = ? AND external_id = ?', 'synthetic', e), ['external_id', 'external_key', 'principal_id']);
    const princ = (p) => strip(q('SELECT * FROM principals WHERE id = ?', p), ['id_key']).map((r) => ({ ...r, id: undefined }));
    const norm = (b) => JSON.parse(JSON.stringify(b).replace(/bound-[xy]/g, 'bound-Z').replace(/ext-(new|old)/g, 'ext-Z'));
    check(n.status === o.status && n.status === 200 && same(norm(n.body.result), norm(o.body)) && same(ident('ext-new'), ident('ext-old')) && ident('ext-new').length === 1 && same(princ('user:bound-x'), princ('user:bound-y')),
      '待对接·绑定：外部身份那一行、新建的主体、应答逐字段相同', show({ n: norm(n.body.result), o: norm(o.body), i: [ident('ext-new'), ident('ext-old')], p: [princ('user:bound-x'), princ('user:bound-y')] }));
  }
  {
    const itemOf = (ev) => `wi_${ev}`;
    const n = await answer('work-items', itemOf(S.release.new), 'release');
    const o = await call('POST', `/api/workbench-events/${S.release.old}/release`, ADMIN, {});
    // 放行之后投递 worker 会马上去试发（发不出去会记 retry、改 attempts），那是 worker 的事、先后不定：只比两个入口造成的那几种动作
    const dl = (ev) => strip(q('SELECT target_team, status FROM workbench_event_deliveries WHERE event_id = ?', ev)).map((d) => ({ ...d, status: d.status === 'held' ? 'held' : d.status === 'cancelled' ? 'cancelled' : 'released' }));
    const lg = (ev) => strip(q("SELECT actor, action, detail FROM workbench_event_log WHERE event_id = ? AND action IN ('recorded', 'held', 'queued', 'released', 'cancelled') ORDER BY id", ev));
    const st = (ev) => q('SELECT state FROM work_items WHERE id = ?', itemOf(ev))[0]?.state;
    const norm = (b) => JSON.parse(JSON.stringify(b).replace(/wbe-[0-9a-f]{16}/g, 'wbe-X').replace(/"(id|delivery_id)":\d+/g, '"$1":0'));
    check(n.status === o.status && n.status === 200 && same(norm(n.body.result), norm(o.body)) && same(dl(S.release.new), dl(S.release.old)) && same(lg(S.release.new), lg(S.release.old)) && st(S.release.new) === 'delivered' && st(S.release.old) === 'delivered',
      '事项·放行（转给工作台事件的放行）：投递、事件日志（谁放行的）、事项状态、应答逐字段相同', show({ n, o, logs: [lg(S.release.new), lg(S.release.old)] }));
    const nw = await answer('work-items', itemOf(S.withdraw.new), 'withdraw');
    const ow = await call('POST', `/api/task-center/tasks/${S.withdrawTask.old}/withdraw`, ADMIN, {});
    const task = (id) => strip(q('SELECT status FROM tasks WHERE id = ?', id));
    const tev = (id) => strip(q('SELECT type, actor, actor_kind, payload_json FROM task_events WHERE task_id = ? ORDER BY id', id));
    const normW = (b) => JSON.parse(JSON.stringify(b).replace(/"id":\d+/g, '"id":0'));
    check(nw.status === ow.status && nw.status === 200 && same(normW(nw.body.result), normW(ow.body)) && same(task(S.withdrawTask.new), task(S.withdrawTask.old)) && same(tev(S.withdrawTask.new), tev(S.withdrawTask.old)) && same(dl(S.withdraw.new), dl(S.withdraw.old)) && st(S.withdraw.new) === 'cancelled' && st(S.withdraw.old) === 'cancelled',
      '事项·撤回（转给任务中心的撤回）：任务状态、任务事件（谁撤回的）、投递、事项状态、应答逐字段相同', show({ nw, ow, tev: [tev(S.withdrawTask.new), tev(S.withdrawTask.old)] }));
  }

  // ---------- 二、无权的人 ----------
  for (const [who, h] of [['会话登录的非管理员', { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }], ['远程匿名', { ...SAME, 'x-forwarded-for': '198.51.100.7' }], ['口令不对', { ...SAME, 'x-admin-token': 'nope' }]]) {
    const n = await answer('change-requests', S.cr.dup, 'reject', { reviewed_by: 'mallory' }, h);
    const o = await call('POST', `/api/change-requests/${S.cr.dup}/reject`, h, { reviewed_by: 'mallory' });
    check(n.status === o.status && n.status === 403 && same(n.body, o.body) && q('SELECT status FROM change_requests WHERE id = ?', S.cr.dup)[0].status === 'pending', `${who}从新入口答：被拒的方式（状态码、正文）和旧入口一样，申请没动`, show({ n, o }));
  }
  {
    // 过得了写请求总门、但这个来源看不到：本机命令行（回环直连、不带浏览器标记）不过写门，但变更申请的管理门不认它。
    // 入口自己回旧入口无权时那个拒绝（同一个守卫写出来的）
    const oldList = await call('GET', '/api/change-requests', {});
    const n = await answer('change-requests', S.cr.dup, 'reject', { reviewed_by: 'cli' }, {});
    check(oldList.status === 403 && n.status === 403 && same(n.body, oldList.body) && q('SELECT status FROM change_requests WHERE id = ?', S.cr.dup)[0].status === 'pending',
      '看不到这个来源的人（本机命令行之于变更申请）从新入口答：状态码、正文和旧入口无权时一样，没转、没动', show({ n, oldList }));
  }
  {
    const r = await answer('change-requests', 999999, 'reject', { reviewed_by: 'alice' });
    check(r.status === 404 && r.body?.error === 'attention_item_not_found', '看得到这个来源、但列表里没有这一条（也没答过）：404，不转给原路由', show(r));
    const u = await answer('no-such-source', '1', 'approve');
    const t = await answer('tasks', 'market:run-1', 'approve');
    const x = await answer('change-requests', S.cr.dup, 'delete', { reviewed_by: 'alice' });
    check(u.status === 404 && t.status === 400 && x.status === 400 && x.body.error === 'attention_answer_not_offered', '不认识的来源 404；统一待办没有答法、表里没有的答法 400', show({ u, t, x }));
  }

  // ---------- 三、重复答、并发答 ----------
  {
    const a = await answer('change-requests', S.cr.dup, 'reject', { reviewed_by: 'alice' });
    const b = await answer('change-requests', S.cr.dup, 'reject', { reviewed_by: 'bob' });
    const row = q('SELECT status, reviewed_by FROM change_requests WHERE id = ?', S.cr.dup)[0];
    check(a.status === 200 && !a.body.duplicate && b.status === 200 && b.body.duplicate === true && same(b.body.result, a.body.result) && row.reviewed_by === 'alice',
      '同一条答两次：第二次返回第一次的结果（duplicate），不再生效（审核人还是第一次的）', show({ a, b, row }));
    const [r1, r2] = await Promise.all([answer('change-requests', S.cr.race, 'reject', { reviewed_by: 'p1' }), answer('change-requests', S.cr.race, 'reject', { reviewed_by: 'p2' })]);
    const done = [r1, r2].filter((r) => r.status === 200 && !r.body.duplicate), told = [r1, r2].filter((r) => r.status === 409 || r.body?.duplicate === true);
    const who = q('SELECT reviewed_by FROM change_requests WHERE id = ?', S.cr.race)[0].reviewed_by;
    check(done.length === 1 && told.length === 1 && who === done[0].body.result.reviewed_by, '两个人同时答：一个生效，另一个被告知已处理（正在处理或已答过）', show({ r1, r2, who }));
  }

  // ---------- 四、转发的硬约束 ----------
  {
    const bad = ['1/../../attention/answer', '1?x=1', '../principals/bind', '0x1', '1 ', '%2e%2e'];
    const rs = [];
    for (const id of bad) rs.push(await answer('change-requests', id, 'reject', { reviewed_by: 'alice' }));
    check(rs.every((r) => r.status === 404 || r.status === 400), '路径只来自写死的表：id 不是数字（含 ..、查询串、编码过的路径）就到不了任何路由', show(rs.map((r) => r.status)));
    const e = await answer('change-requests', S.cr.extra, 'reject', { reviewed_by: 'alice', status: 'approved', reviewed_at: 'x' }, ADMIN, { path: '/api/principals/bind', method: 'PUT' });
    const row = q('SELECT status, reviewed_by FROM change_requests WHERE id = ?', S.cr.extra)[0];
    check(e.status === 200 && row.status === 'rejected' && row.reviewed_by === 'alice', '请求体只由答法换算：input 里多带的字段、外层多带的 path 和 method 都不起作用', show({ e, row }));
    const b2 = await answer('principal-pending', 'synthetic:ext-extra', 'bind', { principal: 'user:bound-e', create: true, reason: '对接', display_name: '夹带的名字' });
    const p = q('SELECT display_name FROM principals WHERE id = ?', 'user:bound-e')[0];
    check(b2.status === 200 && p && p.display_name !== '夹带的名字', '绑定时夹带 display_name：不透传给原路由', show({ b2, p }));
    // 身份原样：留痕里记「谁」的那几处（看板常量的作者、MCP 申请的批准人），是会话登录的那个管理员，不是本机命令行、不是口令
    const owner = q('SELECT owner FROM workbench_vars WHERE workbench_id = ? AND key = ?', S.board, 'answer.1')[0]?.owner;
    const decided = q('SELECT decided_by FROM mcp_access_requests WHERE id = ?', S.mcp.new)[0]?.decided_by;
    check(owner === 'odoo:root-admin' && decided === q('SELECT decided_by FROM mcp_access_requests WHERE id = ?', S.mcp.old)[0]?.decided_by && !/^(cli|admin-token)$/.test(decided), '身份原样带过去：看板答复的作者、MCP 申请的批准人都是会话登录的那个管理员（和旧入口一样），不是本机命令行或口令', show({ owner, decided }));
  }

  // ---------- 五、新写的两类 ----------
  {
    // 席位的提问：旧接口（工作台事件列表）只认口令管理员，这里用口令
    const TOKEN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
    const before = await call('GET', '/api/attention', TOKEN);
    check(before.body.items.some((x) => x.source === 'seat-asks' && x.source_id === String(S.ask.delivery)), '席位的提问在「关注」里');
    const a = await answer('seat-asks', S.ask.delivery, 'answer', { text: '店铺 A' }, TOKEN);
    const it = q('SELECT state, open_asks FROM work_items WHERE id = ?', `wi_${S.ask.event}`)[0];
    const after = await call('GET', '/api/attention', TOKEN);
    check(a.status === 200 && a.body.result.sent === false && a.body.result.reason === 'receiver_is_v1' && JSON.parse(it.open_asks).length === 0 && !after.body.items.some((x) => x.source === 'seat-asks'),
      '答席位的提问：记在事项上、合上提问，「关注」里不再有它；对方是 v1，按 06 不发回答事件（sent:false 写明原因）', show({ a, it }));
    const again = await answer('seat-asks', S.ask.delivery, 'answer', { text: '店铺 B' }, TOKEN);
    check(again.status === 200 && again.body.duplicate === true && again.body.result.item_id === a.body.result.item_id, '再答一次：返回第一次的结果');
    const v = await answer('work-items', S.ready.verify, 'verify');
    const r0 = await answer('work-items', S.ready.ret, 'return', {});
    const r = await answer('work-items', S.ready.ret, 'return', { reason: '差异没标' });
    const st = (id) => q('SELECT state FROM work_items WHERE id = ?', id)[0].state;
    const last = q("SELECT fact, actor, detail FROM work_item_log WHERE item_id = ? ORDER BY seq DESC LIMIT 1", S.ready.ret)[0];
    check(v.status === 200 && st(S.ready.verify) === 'done' && r0.status === 400 && r.status === 200 && st(S.ready.ret) === 'progress' && last.fact === 'return' && last.actor === 'odoo:root-admin' && JSON.parse(last.detail).reason === '差异没标',
      '事项的验收（ready → done）和退回（要理由，ready → progress；日志记谁、为什么）', show({ v, r0, r, last }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split("\n").filter((l) => !l.includes("self-probe")).slice(-40).join("\n"));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
