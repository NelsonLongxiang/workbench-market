#!/usr/bin/env node
/**
 * 事项详情的 can、turn、creator，和「关注」条目的 mine、creator（只增字段）。起隔离实例（假的登录提供方，NODE_ENV=test），
 * 管理员（会话登录）、建立人（alpha）、无关的员工（beta）三种身份各一组，每一项都对着动作接口验：
 *
 *   can 说能 → 动作接口放行；can 说不能 → 动作接口拒
 *     release  POST /api/workbench-events/:id/release（管理员；事项 held）
 *     verify   管理员走「关注」答 verify；建立人走 POST /api/work-items/:id/decision（事项 ready）
 *     reply    POST /api/work-items/:id/messages/:mid/reply（管理员或建立人；有没回复过的消息；事项没结束）
 *     answer   管理员走「关注」答席位提问（建立人答提问的入口在阶段七，合并后另补）
 *   状态上不允许的一律 false：撤回（cancelled）之后不能回复，回复接口也拒（409 work_item_ended）
 *   turn：answer、verify 轮到建立人；release 轮到有放行权限的人。管理员看建立人的事 can 真、turn 假（代办）
 *   creator：{ principal, display_name }，详情和「关注」同一个形状
 *   mine：「关注」里和 turn 同一个函数；验收、提问对管理员是 false（代办），过目放行对管理员是 true
 *   留痕：放行记真实的管理员（不再写死 human:admin）；任务中心来的事项，显示的建立人是认出来的提需求人（不是自填的发布名）
 *
 *   node scripts/work-item-can-turn-test.mjs              测本仓库
 *   node scripts/work-item-can-turn-test.mjs --root DIR   测另一棵目录树
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
const OUT = join(HERE, '..', 'tmp', `work-item-can-turn-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'can-turn-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const at = (p) => pathToFileURL(join(ROOT, p)).href;

/** 造数据：任务中心的三个事件（都由 alpha 提需求）——held 的两件、一件派出去之后席位提问并发来两条消息；另有两件待验收（非事件） */
const SEED = `
const { db } = await import(${JSON.stringify(at('server/src/db.ts'))});
const ev = await import(${JSON.stringify(at('server/src/workbench-events.ts'))});
const fu = await import(${JSON.stringify(at('server/src/services/a2a-followups.ts'))});
const { root } = await import(${JSON.stringify(at('server/src/root-context.ts'))});
const { WorkItemService } = await import(${JSON.stringify(at('server/src/services/work-item.ts'))});
ev.initWorkbenchEvents();
await root.plugin(WorkItemService);
const items = root.get('workItems');
db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', 'dsh/canvas/team-a', 'notify', 'read', 'http://127.0.0.1:1', 'seed')").run();
const publish = (title, dispatch) => {
  const id = Number(db.prepare("INSERT INTO tasks (title, status, published_at, published_by) VALUES (?, 'published', '2026-01-01 00:00:00', 'root-admin')").run(title).lastInsertRowid);
  const fields = { title, intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
  db.exec('BEGIN IMMEDIATE');
  const e = ev.recordTaskCenterEvent({ id, data: fields, stepValue: (k) => fields[k], publishedBy: 'root-admin', requesterPrincipal: 'user:alpha', publisherPrincipal: 'user:root-admin', templateVersion: 1, materialSha256: 'h', agentDispatch: dispatch, centerOn: dispatch });
  db.exec('COMMIT');
  return { task: id, event: e, item: 'wi_' + e, delivery: db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ?').get(e).id };
};
const held = publish('等过目', false), held2 = publish('会被撤回', false), asked = publish('在问', true);
// 「在问」：投递标成已发出（不让投递工人再去发），接单节点问了一句，又发来两条消息
db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = '2026-01-01 00:00:00' WHERE id = ?").run(asked.delivery);
db.prepare("UPDATE workbench_event_deliveries SET decision = 'ask', decision_reason = '哪个店？', decided_by = 'bob', decided_at = '2026-01-01 00:00:01' WHERE id = ?").run(asked.delivery);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(asked.event, asked.delivery);
db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(asked.event, asked.delivery, JSON.stringify({ reason: '哪个店？' }));
const msg = (e, d, t) => fu.recordFollowup({ eventId: e, deliveryId: d, peerZone: 'dsh', inboundTask: 'a2a-' + t, contextId: 'ctx', sender: 'seat:x', text: '消息 ' + t, truncated: false, status: 'open', now: Date.now() });
const m1 = msg(asked.event, asked.delivery, 'm1'), m2 = msg(asked.event, asked.delivery, 'm2'), m3 = msg(held2.event, held2.delivery, 'm3');
for (const e of [held, held2, asked]) items.syncEvent(e.event);
const ready = (n) => { const it = items.create({ title: '待验收 ' + n, created_by: 'user:alpha', creator_principal: 'user:alpha', source_kind: 'agent' });
  for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? x.verdict ?? ''), ...x });
  return it.id; };
console.log('SEEDED ' + JSON.stringify({ held, held2, asked, m1, m2, m3, readyA: ready('a'), readyB: ready('b') }));
process.exit(0);
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
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
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const WHO = { 管理员: { ...SAME, cookie: `session_id=${SESSIONS.admin}` }, 建立人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }, 无关的员工: { ...SAME, cookie: `session_id=${SESSIONS.beta}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  const q = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };
  const detail = async (id, who) => { const r = await call('GET', `/api/work-items/${id}`, WHO[who]); return r.status === 200 ? r.body : { can: { release: false, answer: false, verify: false, reply: false }, turn: { release: false, answer: false, verify: false }, status: r.status }; };
  const ok2 = (r) => r.status >= 200 && r.status < 300;
  /** can 和动作接口对得上：can 说能，接口就放行；说不能，接口就拒 */
  const pair = (label, can, r) => check(can === ok2(r), `${label}：can ${can ? '能' : '不能'}，接口 ${r.status}`, show({ can, r }));

  // ---------- 起点：三种身份看三件 ----------
  const states = Object.fromEntries(q("SELECT id, state FROM work_items").map((r) => [r.id, r.state]));
  check(states[S.held.item] === 'held' && states[S.asked.item] === 'blocked' && states[S.readyA] === 'ready', '造出来的事项：一件 held、一件在问（blocked）、两件 ready', show(states));
  {
    const d = await detail(S.asked.item, '建立人');
    check(show(d.creator) === show({ principal: 'user:alpha', display_name: 'Synthetic alpha' }) && d.item?.created_by === 'user:alpha', '详情的 creator：主体和显示名；任务中心来的事项显示的建立人是认出来的提需求人（不是自填的发布名 human:root-admin）', show({ c: d.creator, by: d.item?.created_by }));
  }

  // ---------- release（不能的先验，能的最后做） ----------
  {
    const c = { 管理员: await detail(S.held.item, '管理员'), 建立人: await detail(S.held.item, '建立人'), 无关的员工: await detail(S.held.item, '无关的员工') };
    check(c.管理员.can.release && c.管理员.turn.release && !c.建立人.can.release && !c.建立人.turn.release && !c.无关的员工.can.release, 'release：管理员 can、turn 都真（轮到有放行权限的人）；建立人、无关的员工都不能', show(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [v.can.release, v.turn.release]]))));
    pair('release·建立人', c.建立人.can.release, await call('POST', `/api/workbench-events/${S.held.event}/release`, WHO.建立人, {}));
    pair('release·无关的员工', c.无关的员工.can.release, await call('POST', `/api/workbench-events/${S.held.event}/release`, WHO.无关的员工, {}));
    pair('release·管理员', c.管理员.can.release, await call('POST', `/api/workbench-events/${S.held.event}/release`, WHO.管理员, {}));
    const actor = q("SELECT actor FROM workbench_event_log WHERE event_id = ? AND action = 'released'", S.held.event)[0]?.actor;
    check(actor === 'odoo:root-admin', '放行留痕记真实的管理员（会话登录的 odoo:root-admin），不再写死 human:admin', show(actor));
    const after = await detail(S.held.item, '管理员');
    check(!after.can.release && !after.turn.release, '放行之后：不再能放行（事项不在 held）', show(after.can));
  }

  // ---------- verify ----------
  {
    const a = await detail(S.readyA, '管理员'), c = await detail(S.readyA, '建立人'), o = await detail(S.readyA, '无关的员工');
    check(a.can.verify && !a.turn.verify && c.can.verify && c.turn.verify && !o.can.verify, 'verify：管理员能、但不轮到他（代办）；建立人能、轮到他；无关的员工不能', show({ a: [a.can.verify, a.turn.verify], c: [c.can.verify, c.turn.verify], o: o.can.verify }));
    pair('verify·无关的员工', o.can.verify, await call('POST', `/api/work-items/${S.readyA}/decision`, WHO.无关的员工, { answer: 'verify' }));
    pair('verify·建立人', c.can.verify, await call('POST', `/api/work-items/${S.readyA}/decision`, WHO.建立人, { answer: 'verify' }));
    const a2 = await detail(S.readyB, '管理员');
    pair('verify·管理员（「关注」）', a2.can.verify, await call('POST', '/api/attention/answer', WHO.管理员, { source: 'work-items', source_id: S.readyB, answer: 'verify' }));
    const done = await detail(S.readyA, '建立人');
    check(!done.can.verify && !done.turn.verify, '验收之后：不能再验收（办完了）', show(done.can));
  }

  // ---------- reply、answer ----------
  {
    const a = await detail(S.asked.item, '管理员'), c = await detail(S.asked.item, '建立人'), o = await detail(S.asked.item, '无关的员工');
    check(a.can.reply && c.can.reply && !o.can.reply, 'reply：管理员、建立人能；无关的员工不能', show({ a: a.can.reply, c: c.can.reply, o: o.can.reply }));
    pair('reply·无关的员工', o.can.reply, await call('POST', `/api/work-items/${S.asked.item}/messages/${S.m1}/reply`, WHO.无关的员工, { text: '回' }));
    pair('reply·建立人', c.can.reply, await call('POST', `/api/work-items/${S.asked.item}/messages/${S.m1}/reply`, WHO.建立人, { text: '回' }));
    pair('reply·管理员', a.can.reply, await call('POST', `/api/work-items/${S.asked.item}/messages/${S.m2}/reply`, WHO.管理员, { text: '回' }));
    const none = await detail(S.asked.item, '建立人');
    check(!none.can.reply, '消息都回复过了：不能再回复', show(none.can));
    check(a.can.answer && !a.turn.answer && !c.can.answer && c.turn.answer && !o.can.answer, 'answer：管理员能、不轮到他；建立人轮到他（提问轮到建立人），但答提问的入口在阶段七、现在还不能；无关的员工不能', show({ a: [a.can.answer, a.turn.answer], c: [c.can.answer, c.turn.answer] }));
    pair('answer·建立人（「关注」）', c.can.answer, await call('POST', '/api/attention/answer', WHO.建立人, { source: 'seat-asks', source_id: String(S.asked.delivery), answer: 'answer', input: { text: '东店' } }));
    pair('answer·无关的员工（「关注」）', o.can.answer, await call('POST', '/api/attention/answer', WHO.无关的员工, { source: 'seat-asks', source_id: String(S.asked.delivery), answer: 'answer', input: { text: '东店' } }));
    // 先看「关注」里的 mine 和 creator（答了就没了）
    const att = (await call('GET', '/api/attention', WHO.管理员)).body?.items ?? [];
    const ask = att.find((x) => x.source === 'seat-asks' && x.source_id === String(S.asked.delivery));
    const glance = att.find((x) => x.source === 'work-items' && x.source_id === S.held2.item);
    const acc = (await call('GET', '/api/attention', WHO.建立人)).body?.items ?? [];
    check(ask?.mine === false && ask.creator?.principal === 'user:alpha' && glance?.mine === true && glance.creator?.display_name === 'Synthetic alpha',
      '「关注」：席位提问对管理员是代办（mine:false）、带建立人；过目放行轮到管理员（mine:true）', show({ ask: ask && [ask.mine, ask.creator], glance: glance && [glance.mine, glance.creator] }));
    check(att.filter((x) => x.source !== 'work-items' && x.source !== 'seat-asks').every((x) => x.mine === true) && acc.every((x) => typeof x.mine === 'boolean'), '「关注」：别的来源一律 mine:true；每条都有 mine');
    pair('answer·管理员（「关注」）', a.can.answer, await call('POST', '/api/attention/answer', WHO.管理员, { source: 'seat-asks', source_id: String(S.asked.delivery), answer: 'answer', input: { text: '东店' } }));
    const answered = await detail(S.asked.item, '管理员'), answeredC = await detail(S.asked.item, '建立人');
    check(!answered.can.answer && !answeredC.turn.answer, '答过之后没有在等的提问：管理员 can.answer、建立人 turn.answer 都是 false', show({ can: answered.can, turn: answeredC.turn }));
  }

  // ---------- 结束了的事项 ----------
  {
    const w = await call('POST', '/api/attention/answer', WHO.管理员, { source: 'work-items', source_id: S.held2.item, answer: 'withdraw' });
    const d = await detail(S.held2.item, '建立人');
    const r = await call('POST', `/api/work-items/${S.held2.item}/messages/${S.m3}/reply`, WHO.建立人, { text: '回' });
    check(ok2(w) && d.item?.state === 'cancelled' && !d.can.reply && r.status === 409 && r.body?.error === 'work_item_ended', '撤回之后（cancelled）：can.reply 是 false，回复接口也拒（409 work_item_ended）', show({ w: w.status, state: d.item?.state, can: d.can, r }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
