#!/usr/bin/env node
/**
 * 事项上替人做决定的动作只有一个判法（work-item-access.ts 的 itemDecisionVerdict）：can.*、真去调接口、「关注」的答法和 mine 出自它。
 * 对抗组：四种身份 × 五个动作，逐个先看 can、再真调，两边必须对得上；能做的留痕要记真实的人和 acting_for。
 *
 *   身份：只有管理口令；只有系统管理员角色（身份来源说是管理员、另有一份系统管理授予，没有管理层授予）；
 *         持有管理层授予的非建立人；建立人本人
 *   动作：answer（「关注」答席位提问）、reply（事项对话里回复）、verify、return（事项自己的决定入口和「关注」两个入口各试一次）、release
 *   期望：口令、系统管理员角色——五个都不能（看得到，答不了）；持管理层授予的——都能，留痕 acting_for（放行 team-lead、其余 creator）；
 *         建立人——除放行（这件不是自审）外都能，留痕不带 acting_for
 *   「关注」：每种身份看到的答法 = can；mine 只对建立人是 true
 *
 *   node scripts/work-item-decision-verdict-test.mjs              测本仓库
 *   node scripts/work-item-decision-verdict-test.mjs --root DIR   测另一棵目录树（变异测试用）
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
const OUT = join(HERE, '..', 'tmp', `work-item-decision-verdict-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'decision-verdict-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const at = (p) => pathToFileURL(join(ROOT, p)).href;

const WHO = ['口令', '系统管理员角色', '管理层授予', '建立人'];

/** 每种身份一套：一件 held（团队没有负责人）、一件在问（席位提问一条、发来一条消息）、四件 ready（两个入口 × 验收、退回）；都由 alpha 建 */
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
  return { event: e, item: 'wi_' + e, delivery: db.prepare('SELECT id FROM workbench_event_deliveries WHERE event_id = ?').get(e).id };
};
const ready = (n) => { const it = items.create({ title: '待验收 ' + n, created_by: 'user:alpha', creator_principal: 'user:alpha', source_kind: 'agent' });
  for (const [k, x] of [['submit', { dispatch_open: true }], ['eval', { verdict: 'accept' }], ['report', { status: 'progress' }], ['report', { status: 'ready' }]]) items.apply(it.id, { kind: k, source: 'seed', id: it.id + ':' + k + ':' + (x.status ?? x.verdict ?? ''), ...x });
  return it.id; };
const out = {};
for (const [k, who] of ${JSON.stringify(WHO)}.entries()) {
  const held = publish('等过目 ' + k, false), asked = publish('在问 ' + k, true);
  db.prepare("UPDATE workbench_event_deliveries SET status = 'sent', sent_at = '2026-01-01 00:00:00' WHERE id = ?").run(asked.delivery);
  db.prepare("UPDATE workbench_event_deliveries SET decision = 'ask', decision_reason = '哪个店？', decided_by = 'bob', decided_at = '2026-01-01 00:00:01' WHERE id = ?").run(asked.delivery);
  db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', 'sent', '{}')").run(asked.event, asked.delivery);
  db.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:bob', 'decision:ask', ?)").run(asked.event, asked.delivery, JSON.stringify({ reason: '哪个店？' }));
  const msg = fu.recordFollowup({ eventId: asked.event, deliveryId: asked.delivery, peerZone: 'dsh', inboundTask: 'a2a-m' + k, contextId: 'ctx', sender: 'seat:x', text: '消息 ' + k, truncated: false, status: 'open', now: Date.now() });
  for (const e of [held, asked]) items.syncEvent(e.event);
  out[who] = { held: held.item, heldEvent: held.event, asked: asked.item, delivery: asked.delivery, msg, verifyD: ready(k + 'vd'), verifyA: ready(k + 'va'), returnD: ready(k + 'rd'), returnA: ready(k + 'ra') };
}
console.log('SEEDED ' + JSON.stringify(out));
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
    if (i > 300 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const H = {
    口令: { ...SAME, 'x-admin-token': ADMIN_TOKEN },
    系统管理员角色: { ...SAME, cookie: `session_id=${SESSIONS.admin}` },
    管理层授予: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` },
    建立人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` },
  };
  const PRINCIPAL = { 口令: null, 系统管理员角色: 'user:root-admin', 管理层授予: 'user:no-flag', 建立人: 'user:alpha' };
  for (const w of WHO) await call('GET', '/api/auth/me', H[w]);
  // 授予走完起草→提交→放行（本机命令行即属主）
  const grant = async (principal, role) => {
    const g = await call('POST', '/api/grants', {}, { principal, role, scope: '*', reason: `合成：${role}` });
    await call('POST', `/api/grants/${g.body?.grant?.id}/submit`, {}, {});
    const ok = await call('POST', `/api/grants/${g.body?.grant?.id}/approve`, {}, {});
    return ok.status === 200 && ok.body?.grant?.status === 'active';
  };
  const q = (sql, ...a) => { const d = new DatabaseSync(join(data, 'workbench-market.db'), { readOnly: true }); try { return d.prepare(sql).all(...a).map((r) => ({ ...r })); } finally { d.close(); } };
  const roleGrants = (p) => q("SELECT role FROM grants WHERE principal_id = ? AND status = 'active'", p).map((r) => r.role);
  if (!roleGrants('user:root-admin').includes('admin')) await grant('user:root-admin', 'admin');
  const mgmtOk = await grant('user:no-flag', 'management');
  check(roleGrants('user:root-admin').includes('admin') && !roleGrants('user:root-admin').includes('management') && mgmtOk && show(roleGrants('user:no-flag')) === show(['management']),
    '准备：系统管理员角色的人有系统管理授予、没有管理层授予；另一个人只有管理层授予', show({ admin: roleGrants('user:root-admin'), mgmt: roleGrants('user:no-flag') }));

  const ok2 = (r) => r.status >= 200 && r.status < 300;
  const detail = async (id, w) => { const r = await call('GET', `/api/work-items/${id}`, H[w]); return r.status === 200 ? r.body : null; };
  const attention = async (w) => (await call('GET', '/api/attention', H[w])).body?.items ?? [];
  const lastFact = (id, fact) => q('SELECT actor, detail FROM work_item_log WHERE item_id = ? AND fact = ? ORDER BY seq DESC LIMIT 1', id, fact)[0] ?? null;
  const viaAttn = (w, source, id, answer, input = {}) => call('POST', '/api/attention/answer', H[w], { source, source_id: String(id), answer, input });

  const EXPECT = {
    口令: { answer: false, reply: false, verify: false, return: false, release: false },
    系统管理员角色: { answer: false, reply: false, verify: false, return: false, release: false },
    管理层授予: { answer: true, reply: true, verify: true, return: true, release: true },
    建立人: { answer: true, reply: true, verify: true, return: true, release: false },
  };
  const ACTING = { 口令: null, 系统管理员角色: null, 管理层授予: 'creator', 建立人: '' };

  for (const w of WHO) {
    const s = S[w], e = EXPECT[w];
    console.log(`— ${w}`);
    // ---------- 看得到；can 和期望一致 ----------
    const dAsked = await detail(s.asked, w), dHeld = await detail(s.held, w), dReady = await detail(s.verifyD, w);
    check(!!(dAsked && dHeld && dReady), `${w}：看得到这几件的详情`, show({ asked: !!dAsked, held: !!dHeld, ready: !!dReady }));
    const can = { answer: !!dAsked?.can?.answer, reply: !!dAsked?.can?.reply, verify: !!dReady?.can?.verify, return: !!dReady?.can?.return, release: !!dHeld?.can?.release };
    check(show(can) === show(e), `${w}：can = 期望`, show({ can, e }));
    const mine = !!dReady?.turn?.verify;
    check(mine === (w === '建立人'), `${w}：turn.verify 只对建立人是 true`, show(dReady?.turn));

    // ---------- 「关注」：答法 = can，mine 只对建立人 ----------
    const att = await attention(w);
    const ask = att.find((x) => x.source === 'seat-asks' && x.source_id === String(s.delivery));
    const acc = att.find((x) => x.source === 'work-items' && x.source_id === s.verifyA);
    check(!!ask && show(ask.answers) === show(e.answer ? ['answer'] : []) && ask.mine === (w === '建立人'), `${w}：「关注」里的席位提问，答法 = can.answer，mine 只对建立人`, show(ask && { answers: ask.answers, mine: ask.mine }));
    check(!!acc && show(acc.answers) === show(e.verify ? ['verify', 'return'] : []) && acc.mine === (w === '建立人'), `${w}：「关注」里的待验收，答法 = can.verify/return，mine 只对建立人`, show(acc && { answers: acc.answers, mine: acc.mine }));

    // ---------- 真调：can 说能就放行，说不能就拒；能做的留痕记真实的人和 acting_for ----------
    const factOk = (f, acting) => f && f.actor === PRINCIPAL[w] && (JSON.parse(f.detail || '{}').acting_for ?? '') === acting;
    const tryIt = async (label, expect, run, id, fact, acting) => {
      const n = q('SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ?', id)[0].n;
      const r = await run();
      const after = q('SELECT COUNT(*) AS n FROM work_item_log WHERE item_id = ?', id)[0].n;
      if (expect) check(ok2(r) && factOk(lastFact(id, fact), acting), `${w}·${label}：can 能 → ${r.status}，留痕记本人${acting ? `、acting_for = ${acting}` : '、不带 acting_for'}`, show({ r, fact: lastFact(id, fact) }));
      else check(!ok2(r) && after === n, `${w}·${label}：can 不能 → ${r.status} ${r.body?.error ?? r.body?.result?.error ?? ''}，事项不动`, show(r));
    };
    const acting = ACTING[w];
    await tryIt('reply', e.reply, () => call('POST', `/api/work-items/${s.asked}/messages/${s.msg}/reply`, H[w], { text: '回' }), s.asked, 'note', acting);
    await tryIt('answer（「关注」）', e.answer, () => viaAttn(w, 'seat-asks', s.delivery, 'answer', { text: '东店' }), s.asked, 'answer', acting);
    await tryIt('verify（事项入口）', e.verify, () => call('POST', `/api/work-items/${s.verifyD}/decision`, H[w], { answer: 'verify' }), s.verifyD, 'verify', acting);
    await tryIt('verify（「关注」）', e.verify, () => viaAttn(w, 'work-items', s.verifyA, 'verify'), s.verifyA, 'verify', acting);
    await tryIt('return（事项入口）', e.return, () => call('POST', `/api/work-items/${s.returnD}/decision`, H[w], { answer: 'return', reason: '差一点' }), s.returnD, 'return', acting);
    await tryIt('return（「关注」）', e.return, () => viaAttn(w, 'work-items', s.returnA, 'return', { reason: '差一点' }), s.returnA, 'return', acting);
    await tryIt('release', e.release, () => call('POST', `/api/work-items/${s.held}/release`, H[w], {}), s.held, 'release', acting === null ? null : 'team-lead');
    if (e.release) {
      const row = q("SELECT actor, detail FROM workbench_event_log WHERE event_id = ? AND action = 'released'", s.heldEvent)[0];
      check(row?.actor === PRINCIPAL[w] && JSON.parse(row.detail).acting_for === 'team-lead', `${w}·release：事件日志也记本人、acting_for = team-lead`, show(row));
    }
    // 回复留痕在投递的事件日志里（acting_for 跟着）
    if (e.reply) {
      const row = q("SELECT actor, detail FROM workbench_event_log WHERE delivery_id = ? AND action = 'followup-replied' ORDER BY id DESC LIMIT 1", s.delivery)[0];
      check(row?.actor === PRINCIPAL[w] && (JSON.parse(row.detail).acting_for ?? '') === acting, `${w}·reply：事件日志记本人${acting ? `、acting_for = ${acting}` : '、不带 acting_for'}`, show(row));
    }
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
