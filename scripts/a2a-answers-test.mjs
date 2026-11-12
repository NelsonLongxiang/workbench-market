#!/usr/bin/env node
/**
 * 阶段七 R2：席位回执里的提问进「关注」，人答复后作为同一 context 的新任务发回那个团队，对方对新任务的回执推进同一个事项；
 * 提问之后对方发来的自由文本跟进记进事项日志（只记录）。
 *
 * 一、提问进「关注」：receipt:attention 出现在席位提问里，问题 = 回执摘要；事件层未答提问数 = 事项未答提问总数。
 *    同一投递先 v1 decision:ask、后回执提问：只列最近的那条；答了之后两边都合上。
 * 二、答复发回：记答复与排发送一起成功；对端收到同一 context 的新任务（kind=answer，qid = 提问所答的任务号，带签名）；
 *    新任务号登记了对端；对方对新任务回 acknowledged / completed → 事项已接手 / 等验收。
 *    只通知的事件（dispatch:false）不发；同一提问答两次只发一次；对端一直失败 → 退避重试、5 次后 dead。
 * 三、跟进：同一 context、同一对端、Sig3 签名 → 记一行 followup，状态不动；同一条只记一次；
 *    没签名、别的 zone、没有采信过回执的投递、别的 context → 照原路，不记。
 */
import { spawn } from './owned-script-fixture.mjs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const port = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = resolve('tmp/a2a-answers');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// 对端：提供签名名片；收市场发来的 /a2a/direct（答复新任务），可设成一直失败
async function peer(zone, reuseKey) {
  const key = reuseKey ?? generateKeyPairSync('ed25519').privateKey;
  const p = await port();
  const peerObj = { zone, key, url: `http://127.0.0.1:${p}`, got: [], fail: false, cardHits: 0 };
  peerObj.server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
      peerObj.cardHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(signCard({ capabilities: {}, expiresAt: Date.now() + 3600_000, name: zone, session: zone, team: zone }, key)));
    }
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch {}
      peerObj.got.push({ headers: req.headers, body: j });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(peerObj.fail ? { error: 'down', code: -32000, task_status: 'TASK_STATE_FAILED' } : { routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', task_id: j.task_id, context_id: j.context_id }));
    });
  });
  await new Promise((r) => peerObj.server.listen(p, '127.0.0.1', r));
  return peerObj;
}
const lab = await peer('lab');
const evil = await peer('evil');

const PM = await port();
const BASE = `http://127.0.0.1:${PM}`;
const sign = (key, text) => edSign(undefined, Buffer.from(text, 'utf8'), key).toString('base64');
function signed(signer, raw, opts = {}) {
  const caller = opts.caller ?? signer.zone, callerUrl = signer.url, ts = Date.now(), aud = BASE;
  const digest = createHash('sha256').update(raw).digest('base64url');
  return { 'X-A2A-Caller': caller, 'X-A2A-Caller-Url': callerUrl, 'X-A2A-Caller-Ts': String(ts), 'X-A2A-Caller-Aud': aud, 'X-A2A-Body-Sha256': digest,
    'X-A2A-Caller-Sig3': sign(signer.key, JSON.stringify(['a2a-origin-claim/3', caller, callerUrl, ts, aud, 'POST', '/a2a/direct', digest])) };
}
const post = async (raw, headers) => { const r = await fetch(BASE + '/a2a/direct', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw }); return { status: r.status, text: await r.text() }; };
const receiptRaw = (task, summary, env, ctx, inbound) => JSON.stringify({ team: 'market/12345678', message: `[A2A receipt] task ${task} ${summary}\n${JSON.stringify(env)}`, caller_session: 'superagent-team/a1b2c3d4e5f60718', context_id: ctx, wait: false, task_id: inbound ?? `receipt-${task}` });
const receipt = (task, summary, env, ctx, opts = {}) => { const raw = receiptRaw(task, summary, env, ctx, opts.inbound); return post(raw, opts.unsigned ? {} : signed(opts.signer ?? lab, raw)); };

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server',
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'ans-admin', MARKET_PUBLIC_URL: BASE, WM_A2A_DIRECT_SIG: '', WM_LOGIN_GATE: '', A2A_OUTBOX_BACKOFF_SCALE: '0.0001', WM_A2A_FOLLOWUP_RATE_10MIN: '80' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }
const ADMIN = { 'x-admin-token': 'ans-admin', 'sec-fetch-site': 'same-origin' };
const api = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: { ...ADMIN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const db = () => { const d = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 }); d.exec('PRAGMA busy_timeout = 5000'); return d; };
const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
let n = 0;
function seedEvent({ dispatch = 1, zone = 'lab', root = lab.url } = {}) {
  n++;
  const ev = `wbe-${(0xa00 + n).toString(16).padStart(16, '0')}`;
  const ctx = `wb:task-center:${1000 + n}`;
  const d = db();
  try {
    d.prepare("INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, 'task-center', 'task-center', ?, ?, 'human', 'human:alice', 1, ?, ?, 'default')").run(ev, `task:${1000 + n}`, ctx, 'x'.repeat(64), dispatch);
    d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, NULL, 'market', 'recorded', '{}')").run(ev);
    const delivery = Number(d.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, sent_at) VALUES (?, 'superagent-team/a1b2c3d4e5f60718', ?, 'market/12345678', 'sent', datetime('now'))").run(ev, lab.url).lastInsertRowid);
    for (const action of ['queued', 'sent']) d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(ev, delivery, action);
    const task = `${ev}.d${delivery}.a1`;
    d.prepare('INSERT INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)').run(task, 'delivery', ev, delivery, root, zone);
    return { ev, ctx, task, delivery };
  } finally { d.close(); }
}
const state = (ev) => q('SELECT state, open_asks FROM work_items WHERE id = ?', `wi_${ev}`)[0] ?? null;
const noRecProbe = (inbound) => { const d = new DatabaseSync(join(DATA, 'workbench-market.db'), { timeout: 5000 }); try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare('SELECT COUNT(*) AS c FROM workbench_event_followups WHERE inbound_task = ?').get(inbound).c === 0; } finally { d.close(); } };
const seatAsks = async () => ((await api('GET', '/api/attention')).body?.items ?? []).filter((x) => x.source === 'seat-asks');
const answer = async (deliveryId, text) => { const r = await api('POST', '/api/attention/answer', { source: 'seat-asks', source_id: String(deliveryId), answer: 'answer', input: { text } }); return { status: r.status, body: r.body?.result ?? r.body }; };
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(150); } return false; }

try {
  if (!(await ready())) throw new Error('实例未就绪：' + out.slice(-600));
  for (let i = 0; i < 40; i++) { if (q("SELECT 1 FROM sqlite_master WHERE name = 'workbench_events'").length) break; await sleep(250); }

  console.log('一、提问进「关注」');
  const a = seedEvent();
  let r = await receipt(a.task, '发哪个仓库？', { idempotencyKey: a.task, disposition: 'attention' }, a.ctx);
  ok('attention 回执 → 采信，事项在问你', r.status === 200 && state(a.ev)?.state === 'blocked', r.text);
  let asks = await seatAsks();
  const mine = asks.find((x) => x.source_id === String(a.delivery));
  ok('「关注」里出现这条席位提问，问题 = 回执摘要', mine && mine.title.includes('发哪个仓库？') && mine.answers.includes('answer'), JSON.stringify(asks));
  const openAsksTotal = () => q('SELECT open_asks FROM work_items').reduce((s, x) => s + JSON.parse(x.open_asks).length, 0);
  ok('事件层未答提问数 = 事项未答提问总数', asks.length === openAsksTotal(), `${asks.length} vs ${openAsksTotal()}`);

  // 同一投递先 v1 decision:ask，后回执提问：只列最近的那条
  const m = seedEvent();
  { const d = db(); d.prepare("UPDATE workbench_event_deliveries SET decision = 'ask', decision_reason = 'v1 的提问', decided_by = 'router', decided_at = datetime('now') WHERE id = ?").run(m.delivery); d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'receiver:router', 'decision:ask', ?)").run(m.ev, m.delivery, JSON.stringify({ reason: 'v1 的提问', ref: '' })); d.close(); }
  await receipt(m.task, '回执里的提问', { idempotencyKey: m.task, disposition: 'attention' }, m.ctx);
  asks = await seatAsks();
  const mm = asks.filter((x) => x.source_id === String(m.delivery));
  ok('v1 提问之后又来回执提问 → 只列最近那条（回执里的）', mm.length === 1 && mm[0].title.includes('回执里的提问'), JSON.stringify(mm));
  ok('……两边条数仍相等（事项上旧提问已被新提问合上）', asks.length === openAsksTotal(), `${asks.length} vs ${openAsksTotal()}`);

  console.log('二、答复发回');
  r = await answer(a.delivery, '发 apps 仓库');
  ok('答复 → 200，sent=true（已排发送）', r.status === 200 && r.body?.sent === true && r.body?.reason === 'queued', JSON.stringify(r.body));
  ok('……「关注」里这条不再等', !(await seatAsks()).some((x) => x.source_id === String(a.delivery)));
  ok('……两边条数仍相等', (await seatAsks()).length === openAsksTotal());
  await waitFor(() => lab.got.some((g) => String(g.body.task_id ?? '').startsWith(`${a.ev}.d${a.delivery}.q`)));
  const sentToPeer = lab.got.find((g) => String(g.body.task_id ?? '').startsWith(`${a.ev}.d${a.delivery}.q`));
  let env = {}; try { env = JSON.parse(sentToPeer?.body?.message ?? '{}'); } catch {}
  ok('对端收到同一 context 的新任务', sentToPeer && sentToPeer.body.context_id === a.ctx && sentToPeer.body.team === 'superagent-team/a1b2c3d4e5f60718', JSON.stringify(sentToPeer?.body ?? null).slice(0, 200));
  ok('……信封 kind=answer、qid = 提问所答的任务号、正文与答复人', env.kind === 'answer' && env.v === 2 && env.answer?.qid === a.task && env.answer?.text === '发 apps 仓库' && typeof env.answer?.by === 'string' && env.answer.by !== '', JSON.stringify(env));
  ok('……带 OriginClaim 签名', typeof sentToPeer?.headers['x-a2a-caller-sig2'] === 'string');
  const answerTask = sentToPeer?.body?.task_id ?? '';
  ok('……新任务号登记了对端（kind=answer）', q('SELECT kind, peer_zone, delivery_id FROM a2a_sent_tasks WHERE task_id = ?', answerTask)[0]?.peer_zone === 'lab', answerTask);
  r = await receipt(answerTask, '接下', { idempotencyKey: answerTask, disposition: 'acknowledged' }, a.ctx, { inbound: `ack-${answerTask}` });
  ok('对方对新任务回 acknowledged → 事项已接手', r.status === 200 && state(a.ev)?.state === 'accepted', `${r.text} ${JSON.stringify(state(a.ev))}`);
  r = await receipt(answerTask, '做完了', { outcome: 'completed', idempotencyKey: answerTask, disposition: 'result' }, a.ctx);
  ok('……再回 completed → 等验收', r.status === 200 && state(a.ev)?.state === 'ready', r.text);
  {
    const it2 = (await api('GET', `/api/work-items/wi_${a.ev}`)).body ?? {};
    const m2 = (it2.messages ?? []).find((x) => x.text === '做完了');
    ok('答复任务的结果回执 → 正文落成事项对话里的一条未读席位消息（状态仍按映射表：等验收）', m2 && m2.status === 'unread' && it2.unread >= 1 && state(a.ev)?.state === 'ready', JSON.stringify(it2.messages ?? null));
    const before = q('SELECT COUNT(*) AS c FROM workbench_event_followups WHERE event_id = ?', a.ev)[0].c;
    const rr = await receipt(answerTask, '再来一条', { outcome: 'completed', idempotencyKey: answerTask, disposition: 'result' }, a.ctx);
    ok('……同一答复任务的结果回执重放 → 409，不重复落消息', rr.status === 409 && q('SELECT COUNT(*) AS c FROM workbench_event_followups WHERE event_id = ?', a.ev)[0].c === before, rr.text);
  }
  r = await answer(a.delivery, '再答一次');
  ok('同一提问答两次 → 第二次不再发（已经不在等）', r.status !== 200 || r.body?.sent !== true, JSON.stringify(r.body));
  ok('……答复表里这次提问只有一行', q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'answer' AND delivery_id = ?", a.delivery)[0].c === 1);

  // 只通知的事件：事项不收提问（停在草稿），「关注」里也不列；答复表没有行
  const nd = seedEvent({ dispatch: 0 });
  await receipt(nd.task, '只通知的事件也问了', { idempotencyKey: nd.task, disposition: 'attention' }, nd.ctx);
  ok('只通知的事件（dispatch:false）里的回执提问 → 「关注」不列，两边条数仍相等', !(await seatAsks()).some((x) => x.source_id === String(nd.delivery)) && (await seatAsks()).length === openAsksTotal());
  r = await answer(nd.delivery, '答');
  ok('……硬答 → 不在列表里被拒，不排发送', r.status >= 400 && q('SELECT COUNT(*) AS c FROM workbench_event_replies WHERE delivery_id = ?', nd.delivery)[0].c === 0, JSON.stringify(r.body));

  // 对端一直失败 → 5 次后 dead
  const f = seedEvent();
  await receipt(f.task, '问一句', { idempotencyKey: f.task, disposition: 'attention' }, f.ctx);
  lab.fail = true;
  r = await answer(f.delivery, '答复');
  ok('对端一直失败：答复照样记下、已排发送', r.status === 200 && r.body?.sent === true);
  await waitFor(() => q("SELECT status FROM workbench_event_replies WHERE kind = 'answer' AND delivery_id = ?", f.delivery)[0]?.status === 'dead', 20000);
  const row = q("SELECT status, attempts FROM workbench_event_replies WHERE kind = 'answer' AND delivery_id = ?", f.delivery)[0];
  ok('……退避重试、5 次后 dead，事件日志有 reply-retry 与 reply-dead', row?.status === 'dead' && row.attempts === 5 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'reply-retry'", f.delivery)[0].c === 4 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'reply-dead'", f.delivery)[0].c === 1, JSON.stringify(row));
  lab.fail = false;

  console.log('二之二、提问回执 attention-<task>-<qid>（preview.13 起）');
  {
    const Q = seedEvent();
    const qenv = (qid, extra = {}) => ({ idempotencyKey: Q.task, disposition: 'attention', question: { id: qid, text: '发哪个仓库？', options: ['apps', 'market'] }, by: { seat: 'lab/a1b2c3d4', name: '成员甲' }, ...extra });
    r = await receipt(Q.task, '发哪个仓库？', qenv('q1'), Q.ctx, { inbound: `attention-${Q.task}-q1` });
    ok('attention-<task>-<qid> + question → 采信，事项在问你', r.status === 200 && r.text.includes('"receipt":"recorded"') && state(Q.ev)?.state === 'blocked', r.text);
    const qa = (await seatAsks()).find((x) => x.source_id === String(Q.delivery));
    ok('……「关注」里显示问题和选项', qa && qa.title.includes('发哪个仓库？') && qa.title.includes('可选：apps / market'), JSON.stringify(qa));
    ok('……不占终局的槽（a2a_inbound_receipts 里没有 final）', q("SELECT COUNT(*) AS c FROM a2a_inbound_receipts WHERE task_id = ? AND class = 'final'", Q.task)[0].c === 0);
    ok('……事件日志记下问题 id、question 与 by（只记录）', (() => { const d = JSON.parse(q("SELECT detail FROM workbench_event_log WHERE delivery_id = ? AND action = 'receipt:attention'", Q.delivery)[0]?.detail ?? '{}'); return d.qid === 'q1' && d.question?.options?.length === 2 && d.by?.seat === 'lab/a1b2c3d4'; })());
    r = await receipt(Q.task, '发哪个仓库？', qenv('q1'), Q.ctx, { inbound: `attention-${Q.task}-q1` });
    ok('同一个问题 id 再来 → 409 重放，不重复记', r.status === 409 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'receipt:attention'", Q.delivery)[0].c === 1, r.text);
    lab.got.length = 0;
    r = await answer(Q.delivery, '发 apps');
    await waitFor(() => lab.got.some((g) => String(g.body.task_id ?? '').startsWith(`${Q.ev}.d${Q.delivery}.q`)));
    const qs = lab.got.find((g) => String(g.body.task_id ?? '').startsWith(`${Q.ev}.d${Q.delivery}.q`));
    let qe = {}; try { qe = JSON.parse(qs?.body?.message ?? '{}'); } catch {}
    ok('答复发回：qid = 问题 id（不是任务号）', r.status === 200 && r.body?.sent === true && qe.answer?.qid === 'q1', JSON.stringify(qe));
    r = await receipt(Q.task, '发 apps 仓库了', { outcome: 'completed', idempotencyKey: Q.task, disposition: 'result' }, Q.ctx);
    ok('之后的结果仍走 receipt-<task>，采信 → 等验收（问题没占掉终局槽）', r.status === 200 && r.text.includes('"receipt":"recorded"') && state(Q.ev)?.state === 'ready', `${r.text} ${JSON.stringify(state(Q.ev))}`);
    // 办完之后晚到的接单回执、新提问：不再把旧提问再补关一遍（之前每条晚到的各留一行 rejected=terminal）
    {
      const closes = () => q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'answer' AND fact_id LIKE '%:closes-ask:%'", `wi_${Q.ev}`)[0].c;
      const v = await api('POST', '/api/attention/answer', { source: 'work-items', source_id: `wi_${Q.ev}`, answer: 'verify', input: {} });
      const before = closes();
      await receipt(Q.task, '晚到的接单', { idempotencyKey: Q.task, disposition: 'acknowledged' }, Q.ctx, { inbound: `ack-${Q.task}` });
      await receipt(Q.task, '晚到的提问', { idempotencyKey: Q.task, disposition: 'attention', question: { id: 'q3', text: '晚到的提问' } }, Q.ctx, { inbound: `attention-${Q.task}-q3` });
      ok('办完（done）之后晚到的接单回执、新提问：不再补关旧提问，事项日志不多出 rejected 的合上行', v.status === 200 && state(Q.ev)?.state === 'done' && closes() === before, `${before} → ${closes()} ${JSON.stringify(state(Q.ev))}`);
    }
    const closesOf = (ev) => q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'answer' AND fact_id LIKE '%:closes-ask:%'", `wi_${ev}`)[0].c;
    // B1：提问还开着时事项结束（另一次投递的结果把事项推到办完），之后这次投递晚到一条接单回执 → 不尝试补关（只靠「事项已结束」这一道挡）
    {
      const B = seedEvent();
      const d2 = (() => { const d = db(); try {
        const id2 = Number(d.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, sent_at) VALUES (?, 'other-team/c1c2c3c4c5c6c7c8', ?, 'market/12345678', 'sent', datetime('now'))").run(B.ev, lab.url).lastInsertRowid);
        for (const action of ['queued', 'sent']) d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(B.ev, id2, action);
        const t = `${B.ev}.d${id2}.a1`;
        d.prepare('INSERT INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)').run(t, 'delivery', B.ev, id2, lab.url, 'lab');
        return t;
      } finally { d.close(); } })();
      await receipt(B.task, '问', { idempotencyKey: B.task, disposition: 'attention', question: { id: 'b1', text: '问' } }, B.ctx, { inbound: `attention-${B.task}-b1` });
      await receipt(d2, '做完了', { outcome: 'completed', idempotencyKey: d2, disposition: 'result' }, B.ctx, { inbound: `receipt-${d2}` });
      await api('POST', '/api/attention/answer', { source: 'work-items', source_id: `wi_${B.ev}`, answer: 'verify', input: {} });
      const before = closesOf(B.ev);
      await receipt(B.task, '晚到的接单', { idempotencyKey: B.task, disposition: 'acknowledged' }, B.ctx, { inbound: `ack-${B.task}` });
      ok('B1：提问还开着时事项办完，之后同一投递晚到接单回执 → 不尝试补关（不多合上行、也不多被拒的行）', state(B.ev)?.state === 'done' && closesOf(B.ev) === before, `${before} → ${closesOf(B.ev)} ${JSON.stringify(state(B.ev))}`);
    }
    // B2：提问没被事项收下（只通知的事件，事项停在草稿），同一投递接连来两条合上类回执 → 只尝试一次（只靠「已有过答复」这一道挡）
    {
      const N = seedEvent({ dispatch: 0 });
      await receipt(N.task, '问', { idempotencyKey: N.task, disposition: 'attention', question: { id: 'b2', text: '问' } }, N.ctx, { inbound: `attention-${N.task}-b2` });
      await receipt(N.task, '接下', { idempotencyKey: N.task, disposition: 'acknowledged' }, N.ctx, { inbound: `ack-${N.task}` });
      const once = closesOf(N.ev);
      await receipt(N.task, '做完了', { outcome: 'completed', idempotencyKey: N.task, disposition: 'result' }, N.ctx);
      ok('B2：同一条提问已经被尝试合上过（被拒也算），之后再来合上类回执 → 不再尝试', once >= 1 && closesOf(N.ev) === once, `${once} → ${closesOf(N.ev)}`);
    }
    // B2·人先答了：事项未结束，人答了提问，之后同一投递来接单回执 → 不给它补合上的答复
    {
      const H = seedEvent();
      await receipt(H.task, '问', { idempotencyKey: H.task, disposition: 'attention', question: { id: 'b3', text: '问' } }, H.ctx, { inbound: `attention-${H.task}-b3` });
      await answer(H.delivery, '人答了');
      const before = closesOf(H.ev);
      await receipt(H.task, '接下', { idempotencyKey: H.task, disposition: 'acknowledged' }, H.ctx, { inbound: `ack-${H.task}` });
      ok('B2：人先答了提问，之后同一投递来接单回执 → 不再补合上的答复', closesOf(H.ev) === before && state(H.ev)?.state !== 'blocked', `${before} → ${closesOf(H.ev)} ${JSON.stringify(state(H.ev))}`);
    }
    ok('……原工单（投递任务）的结果回执不落成席位消息（只有人发出的消息的回话才是）', q('SELECT COUNT(*) AS c FROM workbench_event_followups WHERE event_id = ?', Q.ev)[0].c === 0);
    // 对抗：形状不对的一律只记录、不采信、不占槽
    const Q2 = seedEvent();
    const bad = [
      ['问题 id 和任务号里的不一致', qenv('qX', { idempotencyKey: Q2.task }), `attention-${Q2.task}-q2`],
      ['S11：任务号是 q1、question.id 是 q2', qenv('q2', { idempotencyKey: Q2.task }), `attention-${Q2.task}-q1`],
      ['没有 question', { idempotencyKey: Q2.task, disposition: 'attention' }, `attention-${Q2.task}-q3`],
      ['question.text 为空', qenv('q4', { idempotencyKey: Q2.task, question: { id: 'q4', text: '  ' } }), `attention-${Q2.task}-q4`],
      ['disposition 不是 attention', qenv('q5', { idempotencyKey: Q2.task, disposition: 'result', outcome: 'completed' }), `attention-${Q2.task}-q5`],
      ['idempotencyKey 是别的任务号', qenv('q6', { idempotencyKey: Q.task }), `attention-${Q2.task}-q6`],
      ['问题 id 带非法字符', qenv('q 7', { idempotencyKey: Q2.task }), `attention-${Q2.task}-q 7`],
      ['问题 id 超过 24 个字符', qenv('q'.repeat(25), { idempotencyKey: Q2.task }), `attention-${Q2.task}-${'q'.repeat(25)}`],
    ];
    for (const [label, env, inbound] of bad) {
      const rr = await receipt(Q2.task, '问', env, Q2.ctx, { inbound });
      ok(`提问回执·${label} → 不采信，事项不动`, !rr.text.includes('"receipt":"recorded"') && state(Q2.ev)?.state === 'delivered', rr.text.slice(0, 200));
    }
    ok('……这些都没占问题格', q('SELECT COUNT(*) AS c FROM a2a_inbound_questions WHERE task_id = ?', Q2.task)[0].c === 0);
    r = await receipt(Q2.task, '问', qenv('q8'), Q2.ctx, { inbound: `attention-${Q2.task}-q8`, signer: evil });
    ok('提问回执·别的宿主签的 → 不采信', !r.text.includes('"receipt":"recorded"') && state(Q2.ev)?.state === 'delivered', r.text.slice(0, 200));
    r = await receipt(Q2.task, '问', qenv('q9'), Q2.ctx, { inbound: `attention-${Q2.task}-q9`, unsigned: true });
    ok('提问回执·没签名 → 不采信', !r.text.includes('"receipt":"recorded"') && state(Q2.ev)?.state === 'delivered', r.text.slice(0, 200));
  }

  console.log('二之三、进展回执 progress-<task>-<n>（PR-A）');
  {
    const P = seedEvent();
    r = await receipt(P.task, '接下', { idempotencyKey: P.task, disposition: 'acknowledged', by: { seat: 'lab/00000000', name: '总工' } }, P.ctx, { inbound: `ack-${P.task}` });
    ok('确认回执的 by 没有 role（可能是总工）→ 不写承接', q('SELECT seat FROM work_items WHERE id = ?', `wi_${P.ev}`)[0]?.seat === '', JSON.stringify(q('SELECT seat FROM work_items WHERE id = ?', `wi_${P.ev}`)));
    const penv = (n, state, extra = {}) => ({ idempotencyKey: P.task, disposition: 'progress', by: { seat: 'lab/a1b2c3d4', name: '成员甲' },
      progress: { n, state, summary: `第 ${n} 步：${state}`, at: '2026-11-11T08:00:00.000Z' }, tickets: [{ id: 't1', title: '拆出来的一件', seat: 'lab/a1b2c3d4', state: 'working' }, { id: '', state: 'working' }, { id: 't2', state: 'bogus' }], ...extra });
    const before = state(P.ev)?.state;
    r = await receipt(P.task, '第 1 步', penv(1, 'working'), P.ctx, { inbound: `progress-${P.task}-1` });
    let pit = (await api('GET', `/api/work-items/wi_${P.ev}`)).body ?? {};
    ok('progress-<task>-1 → 采信，事项状态不动（不结清、不推状态）', r.status === 200 && r.text.includes('"receipt":"recorded"') && state(P.ev)?.state === before && before === 'accepted', `${r.text} ${before} ${JSON.stringify(state(P.ev))}`);
    ok('……事项读接口带「正在处理」提示：步号、状态、摘要、by', pit.progress?.n === 1 && pit.progress.state === 'working' && pit.progress.summary === '第 1 步：working' && pit.progress.by?.seat === 'lab/a1b2c3d4', JSON.stringify(pit.progress));
    ok('……进展的 by 没有 role → 不取 by；取 tickets 里没结束那一项的 seat（读接口的 item.seat 也是）', pit.item?.seat === 'lab/a1b2c3d4', JSON.stringify(pit.item?.seat));
    ok('……子项取信封 tickets，坏的逐个丢', JSON.stringify(pit.progress?.tickets) === JSON.stringify([{ id: 't1', title: '拆出来的一件', seat: 'lab/a1b2c3d4', state: 'working' }]), JSON.stringify(pit.progress?.tickets));
    ok('……事项日志记一行只记录的 note progress', q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'note' AND json_extract(detail, '$.note') = 'progress' AND rejected = ''", `wi_${P.ev}`)[0].c === 1);
    r = await receipt(P.task, '第 2 步', penv(2, 'waiting', { tickets: [] }), P.ctx, { inbound: `progress-${P.task}-2` });
    pit = (await api('GET', `/api/work-items/wi_${P.ev}`)).body ?? {};
    ok('第 2 步 → 提示换成最新一步，子项以最新一步的全量为准（空）', r.status === 200 && pit.progress?.n === 2 && pit.progress.state === 'waiting' && pit.progress.tickets.length === 0, JSON.stringify(pit.progress));
    r = await receipt(P.task, '第 2 步', penv(2, 'waiting'), P.ctx, { inbound: `progress-${P.task}-2` });
    ok('同一步号再来 → 409 重放，不重复记', r.status === 409 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'receipt:progress'", P.delivery)[0].c === 2, r.text);
    const P2 = seedEvent();
    const bad = [
      ['认不得的 state', { ...penv(1, 'working'), idempotencyKey: P2.task, progress: { n: 1, state: 'sleeping', at: '2026-11-11T08:00:00.000Z' } }, `progress-${P2.task}-1`],
      ['信封步号和任务号里的不一致', { ...penv(9, 'working'), idempotencyKey: P2.task }, `progress-${P2.task}-2`],
      ['disposition 不是 progress', { ...penv(3, 'working'), idempotencyKey: P2.task, disposition: 'acknowledged' }, `progress-${P2.task}-3`],
      ['disposition 是 result（想借进展的格结清）', { ...penv(4, 'working'), idempotencyKey: P2.task, disposition: 'result', outcome: 'completed' }, `progress-${P2.task}-4`],
      ['没有 progress', { idempotencyKey: P2.task, disposition: 'progress' }, `progress-${P2.task}-5`],
      ['idempotencyKey 是别的任务号', penv(6, 'working'), `progress-${P2.task}-6`],
      ['步号是 0', { ...penv(0, 'working'), idempotencyKey: P2.task }, `progress-${P2.task}-0`],
      ['步号带前导 0', { ...penv(7, 'working'), idempotencyKey: P2.task }, `progress-${P2.task}-07`],
    ];
    for (const [label, env, inbound] of bad) {
      const rr = await receipt(P2.task, '进展', env, P2.ctx, { inbound });
      ok(`进展回执·${label} → 不采信，事项不动`, !rr.text.includes('"receipt":"recorded"') && state(P2.ev)?.state === 'delivered', rr.text.slice(0, 160));
    }
    ok('……这些都没占格、没留提示', q('SELECT COUNT(*) AS c FROM a2a_inbound_questions WHERE task_id = ?', P2.task)[0].c === 0 && (await api('GET', `/api/work-items/wi_${P2.ev}`)).body?.progress === null);
    r = await receipt(P2.task, '进展', { ...penv(8, 'working'), idempotencyKey: P2.task }, P2.ctx, { inbound: `progress-${P2.task}-8`, signer: evil });
    ok('进展回执·别的宿主签的 → 不采信', !r.text.includes('"receipt":"recorded"'), r.text.slice(0, 160));
    r = await receipt(P2.task, '进展', { ...penv(8, 'working'), idempotencyKey: P2.task }, P2.ctx, { inbound: `progress-${P2.task}-8`, unsigned: true });
    ok('进展回执·没签名 → 不采信', !r.text.includes('"receipt":"recorded"'), r.text.slice(0, 160));
    r = await receipt(P.task, '做完了', { outcome: 'completed', idempotencyKey: P.task, disposition: 'result' }, P.ctx);
    ok('之后的结果照常走 receipt-<task> → 等验收（进展没占终局槽）', r.status === 200 && r.text.includes('"receipt":"recorded"') && state(P.ev)?.state === 'ready', r.text);
    // P7：tickets 最多 16 个；P13：摘要去控制字符、截到 500 字
    {
      const many = Array.from({ length: 20 }, (_, k) => ({ id: `t${k}`, state: 'working' }));
      const longSummary = 'a\u0001b\u0007' + '长'.repeat(600);
      r = await receipt(P.task, '第 3 步', { ...penv(3, 'working'), tickets: many, progress: { n: 3, state: 'working', summary: longSummary, at: '2026-11-11T08:00:00.000Z' } }, P.ctx, { inbound: `progress-${P.task}-3` });
      const p3 = (await api('GET', `/api/work-items/wi_${P.ev}`)).body?.progress ?? {};
      ok('P7：给 20 个 tickets，读接口只给 16 个（前 16 个）', r.status === 200 && Array.isArray(p3.tickets) && p3.tickets.length === 16 && p3.tickets[15]?.id === 't15', JSON.stringify(p3.tickets?.length));
      ok('P13：进展摘要去掉控制字符、截到 500 字', typeof p3.summary === 'string' && p3.summary.length === 500 && !/[\u0000-\u001f\u007f]/.test(p3.summary) && p3.summary.startsWith('a b '), JSON.stringify(p3.summary?.slice(0, 20)));
    }
    // P8：事项结束之后不再给进展
    r = await api('POST', '/api/attention/answer', { source: 'work-items', source_id: `wi_${P.ev}`, answer: 'verify', input: {} });
    const pDone = (await api('GET', `/api/work-items/wi_${P.ev}`)).body ?? {};
    ok('P8：事项验收办完（终态）之后，读接口的 progress 为 null（日志里的进展还在）', r.status === 200 && state(P.ev)?.state === 'done' && pDone.progress === null
      && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'receipt:progress'", P.delivery)[0].c === 3, JSON.stringify({ st: state(P.ev), p: pDone.progress, r: r.body }));
    // 每个任务最多 200 步
    const C = seedEvent();
    // P10：200 步的计数只数进展，不把同一任务的提问算进去——先来两个提问
    for (const qq of ['qa', 'qb']) await receipt(C.task, '问', { idempotencyKey: C.task, disposition: 'attention', question: { id: qq, text: '问一句' } }, C.ctx, { inbound: `attention-${C.task}-${qq}` });
    ok('P10：同一任务先收下两个提问', q('SELECT COUNT(*) AS c FROM a2a_inbound_questions WHERE task_id = ? AND qid NOT LIKE ?', C.task, '#%')[0].c === 2);
    const capBefore = (await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts?.['progress:over-cap'] ?? 0;
    for (let k = 1; k <= 200; k++) await receipt(C.task, '步', { idempotencyKey: C.task, disposition: 'progress', progress: { n: k, state: 'working', at: '2026-11-11T08:00:00.000Z' } }, C.ctx, { inbound: `progress-${C.task}-${k}` });
    r = await receipt(C.task, '步', { idempotencyKey: C.task, disposition: 'progress', progress: { n: 201, state: 'working', at: '2026-11-11T08:00:00.000Z' } }, C.ctx, { inbound: `progress-${C.task}-201` });
    ok('同一任务第 201 步 → 照常应答、不记，公开计数 progress:over-cap +1', r.status === 200 && r.text.includes('"receipt":"over-cap"') && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'receipt:progress'", C.delivery)[0].c === 200
      && ((await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts?.['progress:over-cap'] ?? 0) === capBefore + 1, r.text.slice(0, 160));
  }

  console.log('二之三之二、承接席位');
  {
    const seatOf = (ev) => q('SELECT seat FROM work_items WHERE id = ?', `wi_${ev}`)[0]?.seat;
    const S1 = seedEvent();
    await receipt(S1.task, '接下', { idempotencyKey: S1.task, disposition: 'acknowledged', by: { seat: 'lab/00000000', name: '总工', role: 'router' } }, S1.ctx, { inbound: `ack-${S1.task}` });
    ok('by.role=router（总工）→ 不写承接', seatOf(S1.ev) === '', seatOf(S1.ev));
    await receipt(S1.task, '问一句', { idempotencyKey: S1.task, disposition: 'attention', question: { id: 'qr', text: '问一句' }, by: { seat: 'lab/00000000', name: '总工', role: 'router' } }, S1.ctx, { inbound: `attention-${S1.task}-qr` });
    ok('……提问的 by 是 router 也不写', seatOf(S1.ev) === '', seatOf(S1.ev));
    const S2 = seedEvent();
    await receipt(S2.task, '接下', { idempotencyKey: S2.task, disposition: 'acknowledged', by: { seat: 'lab/c0c0c0c0', name: '成员丙', role: 'member' } }, S2.ctx, { inbound: `ack-${S2.task}` });
    ok('by.role=member → 确认回执也写承接（只存句柄）', seatOf(S2.ev) === 'lab/c0c0c0c0', seatOf(S2.ev));
    const S2o = seedEvent();
    await receipt(S2o.task, '进展', { idempotencyKey: S2o.task, disposition: 'progress', progress: { n: 1, state: 'working', at: '2026-11-11T08:00:00.000Z' }, by: { seat: 'lab/e0e0e0e0', name: '观察者戊', role: 'observer' } }, S2o.ctx, { inbound: `progress-${S2o.task}-1` });
    ok('by.role=observer → 也写承接', seatOf(S2o.ev) === 'lab/e0e0e0e0', seatOf(S2o.ev));
    const S2x = seedEvent();
    await receipt(S2x.task, '问', { idempotencyKey: S2x.task, disposition: 'attention', question: { id: 'qx', text: '问' }, by: { seat: 'lab/f0f0f0f0', name: '认不出', role: 'boss' } }, S2x.ctx, { inbound: `attention-${S2x.task}-qx` });
    ok('by.role 认不出的值 → 丢掉 role，按过渡规则（提问取 by）', seatOf(S2x.ev) === 'lab/f0f0f0f0', seatOf(S2x.ev));
    const S3 = seedEvent();
    await receipt(S3.task, '问', { idempotencyKey: S3.task, disposition: 'attention', question: { id: 'q1', text: '问' }, by: { seat: 'lab/d0d0d0d0', name: '成员丁' } }, S3.ctx, { inbound: `attention-${S3.task}-q1` });
    ok('过渡期：提问的 by（没有 role）写承接', seatOf(S3.ev) === 'lab/d0d0d0d0', seatOf(S3.ev));
    // Z4：没有 role 的进展，tickets 第一项已结束（别人的 seat）、第二项在做 → 承接取第二项
    const S4 = seedEvent();
    await receipt(S4.task, '进展', { idempotencyKey: S4.task, disposition: 'progress', progress: { n: 1, state: 'working', at: '2026-11-11T08:00:00.000Z' },
      tickets: [{ id: 't1', seat: 'lab/11111111', state: 'ended', outcome: 'completed' }, { id: 't2', seat: 'lab/22222222', state: 'working' }] }, S4.ctx, { inbound: `progress-${S4.task}-1` });
    ok('Z4：进展里 tickets 第一项已结束、第二项在做 → 承接取在做的那一项', seatOf(S4.ev) === 'lab/22222222', seatOf(S4.ev));
    // 排队的子项（queued）还没派给成员，seat 可能是总工：不取
    const S5 = seedEvent();
    await receipt(S5.task, '进展', { idempotencyKey: S5.task, disposition: 'progress', progress: { n: 1, state: 'queued', ahead: 1, at: '2026-11-11T08:00:00.000Z' },
      tickets: [{ id: 't1', seat: 'lab/00000000', state: 'queued' }] }, S5.ctx, { inbound: `progress-${S5.task}-1` });
    ok('进展里只有排队的子项（seat 是总工）→ 不写承接', seatOf(S5.ev) === '', seatOf(S5.ev));
    // 一个事件投给两个团队：A 接手（by member A），B 回 rejected（by B）——只记录，承接仍是 A
    const M2 = seedEvent();
    const { taskB } = (() => { const d = db(); try {
      const dB = Number(d.prepare("INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, sent_at) VALUES (?, 'other-team/b1b2b3b4b5b6b7b8', ?, 'market/12345678', 'sent', datetime('now'))").run(M2.ev, lab.url).lastInsertRowid);
      for (const action of ['queued', 'sent']) d.prepare("INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, 'market', ?, '{}')").run(M2.ev, dB, action);
      const t = `${M2.ev}.d${dB}.a1`;
      d.prepare('INSERT INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)').run(t, 'delivery', M2.ev, dB, lab.url, 'lab');
      return { taskB: t };
    } finally { d.close(); } })();
    await receipt(M2.task, '接下', { idempotencyKey: M2.task, disposition: 'acknowledged', by: { seat: 'lab/aaaaaaaa', name: 'A 成员', role: 'member' } }, M2.ctx, { inbound: `ack-${M2.task}` });
    r = await receipt(taskB, '不接', { outcome: 'rejected', idempotencyKey: taskB, disposition: 'result', by: { seat: 'lab/bbbbbbbb', name: 'B 成员', role: 'member' } }, M2.ctx, { inbound: `receipt-${taskB}` });
    ok('别的团队「说不干了」（rejected，只记录）→ 承接仍是接手的团队', r.status === 200 && state(M2.ev)?.state === 'accepted' && seatOf(M2.ev) === 'lab/aaaaaaaa', `${seatOf(M2.ev)} ${JSON.stringify(state(M2.ev))}`);
  }

  console.log('二之四、来信分流先验格式再查库');
  {
    const T = seedEvent();
    const raw = JSON.stringify({ team: 'market/12345678', message: '分流探测', caller_session: 'lab/canvas/ops', context_id: T.ctx, wait: false, task_id: 'a2a-probe0001' });
    const good = signed(lab, raw);
    const shapes = [
      ['只有 zone、没有签名', { 'X-A2A-Caller': 'lab' }],
      ['Sig3 不成形', { ...good, 'X-A2A-Caller-Sig3': 'x' }],
      ['时间戳过期', { ...good, 'X-A2A-Caller-Ts': String(Date.now() - 10 * 60_000) }],
      ['受众不是我们', { ...good, 'X-A2A-Caller-Aud': 'http://elsewhere.example' }],
      ['正文摘要对不上', { ...good, 'X-A2A-Body-Sha256': 'AAAA' }],
      ['来源地址不成形', { ...good, 'X-A2A-Caller-Url': 'not a url' }],
      ['成形但来源不是投递的对端根地址', { ...signed({ ...evil, zone: 'lab' }, raw) }],
    ];
    for (const [label, h] of shapes) {
      lab.cardHits = 0; evil.cardHits = 0;
      const rr = await post(raw, h);
      ok(`分流·${label} → 不收、不回执、不去取任何名片`, !rr.text.includes('"followup":"recorded"') && lab.cardHits === 0 && evil.cardHits === 0 && noRecProbe('a2a-probe0001'), `${rr.status} lab=${lab.cardHits} evil=${evil.cardHits}`);
    }
    // 知道对端根地址、声称就是它、签名是坏的：查得到投递和查不到，出网取卡的次数要一样（两个冷缓存的对端各测一种）
    {
      const pa = await peer('pa'), pb = await peer('pb');
      seedEvent({ zone: 'pa', root: pa.url });              // pa 是投递过的对端，但下面用一个它没收过的 context
      const B = seedEvent({ zone: 'pb', root: pb.url });     // pb 收过 B 的投递
      const rawA = JSON.stringify({ team: 'market/12345678', message: '探', caller_session: 'pa/canvas/ops', context_id: 'wb:task-center:888888', wait: false, task_id: 'a2a-probe-a' });
      const rawB = JSON.stringify({ team: 'market/12345678', message: '探', caller_session: 'pb/canvas/ops', context_id: B.ctx, wait: false, task_id: 'a2a-probe-b' });
      const ra = await post(rawA, signed({ ...evil, zone: 'pa', url: pa.url }, rawA));
      const rb = await post(rawB, signed({ ...evil, zone: 'pb', url: pb.url }, rawB));
      ok('知道根地址的探测：查不到投递与查到投递，取卡次数相同（时序只取决于请求自己声称的来源）', !ra.text.includes('"followup":"recorded"') && !rb.text.includes('"followup":"recorded"') && pa.cardHits === pb.cardHits && pa.cardHits >= 1, `查不到=${pa.cardHits} 查到=${pb.cardHits}`);
      const rawC = JSON.stringify({ team: 'market/12345678', message: '探', caller_session: 'x/canvas/ops', context_id: 'wb:task-center:777777', wait: false, task_id: 'a2a-probe-c' });
      const stranger = await peer('stranger');
      await post(rawC, signed({ ...evil, zone: 'stranger', url: stranger.url }, rawC));
      ok('……声称的来源不是投递过的对端 → 不去取它的名片（不做开放的取卡代理）', stranger.cardHits === 0, String(stranger.cardHits));
      // G3：声称的来源是投递过的对端、但签名不成形 → 连预取都不做
      const pe = await peer('pe');
      seedEvent({ zone: 'pe', root: pe.url });
      const rawE = JSON.stringify({ team: 'market/12345678', message: '探', caller_session: 'pe/canvas/ops', context_id: 'wb:task-center:666666', wait: false, task_id: 'a2a-probe-e' });
      await post(rawE, { ...signed({ ...evil, zone: 'pe', url: pe.url }, rawE), 'X-A2A-Caller-Sig3': 'x' });
      ok('G3：声称的来源投递过、签名不成形 → 不取卡（格式关在取卡之前）', pe.cardHits === 0, String(pe.cardHits));
      // G4：名片已在缓存、冷却已过，再比「查不到投递」与「查到投递」——两边都要照验签的样子强制重取一次
      const pc = await peer('pc'), pd = await peer('pd');
      seedEvent({ zone: 'pc', root: pc.url });
      const D = seedEvent({ zone: 'pd', root: pd.url });
      const rawC0 = JSON.stringify({ team: 'market/12345678', message: '暖', caller_session: 'pc/canvas/ops', context_id: 'wb:task-center:555555', wait: false, task_id: 'a2a-warm-c' });
      const rawD0 = JSON.stringify({ team: 'market/12345678', message: '暖', caller_session: 'pd/canvas/ops', context_id: 'wb:task-center:555556', wait: false, task_id: 'a2a-warm-d' });
      await post(rawC0, signed({ ...evil, zone: 'pc', url: pc.url }, rawC0));
      await post(rawD0, signed({ ...evil, zone: 'pd', url: pd.url }, rawD0));
      ok('G4 准备：两张名片都进了缓存', pc.cardHits === 1 && pd.cardHits === 1, `${pc.cardHits} ${pd.cardHits}`);
      await sleep(31_000); // 过取卡冷却（peer-card.ts 30 秒）
      pc.cardHits = 0; pd.cardHits = 0;
      const rawG4c = JSON.stringify({ team: 'market/12345678', message: '探', caller_session: 'pc/canvas/ops', context_id: 'wb:task-center:444444', wait: false, task_id: 'a2a-probe-g4c' });
      const rawG4d = JSON.stringify({ team: 'market/12345678', message: '探', caller_session: 'pd/canvas/ops', context_id: D.ctx, wait: false, task_id: 'a2a-probe-g4d' });
      await post(rawG4c, signed({ ...evil, zone: 'pc', url: pc.url }, rawG4c));
      await post(rawG4d, signed({ ...evil, zone: 'pd', url: pd.url }, rawG4d));
      ok('G4：名片在缓存、冷却已过，签名坏——查不到投递与查到投递都强制重取一次（取卡次数相同）', pc.cardHits === pd.cardHits && pc.cardHits === 1, `查不到=${pc.cardHits} 查到=${pd.cardHits}`);
      for (const x of [pa, pb, stranger, pe, pc, pd]) x.server.close();
    }
    // 时序（只打印、不断言）：查不到投递 vs 查到了但签名不成形 vs 查到了、成形、来源不对
    const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const time = async (rawX, h) => { const xs = []; for (let k = 0; k < 60; k++) { const t0 = performance.now(); await post(rawX, typeof h === 'function' ? h() : h); xs.push(performance.now() - t0); } return med(xs).toFixed(2); };
    const rawMiss = raw.replace(T.ctx, 'wb:task-center:999999');
    console.log(`    时序中位数（ms）：查不到投递·无签名 ${await time(rawMiss, { 'X-A2A-Caller': 'lab' })}；查到投递·无签名 ${await time(raw, { 'X-A2A-Caller': 'lab' })}；`
      + `查不到投递·成形签名 ${await time(rawMiss, () => signed({ ...evil, zone: 'lab' }, rawMiss))}；查到投递·成形签名·来源不对 ${await time(raw, () => signed({ ...evil, zone: 'lab' }, raw))}`);
  }

  console.log('二之五、团队名册（[A2A roster]）');
  {
    const rosterHealth = async () => ((await (await fetch(BASE + '/api/health')).json()).a2a?.roster ?? {});
    const cnt = (h, k) => h.outcomes?.[k]?.count ?? 0;
    const rh0 = await rosterHealth();
    const R0 = seedEvent();   // lab 是投递过的宿主（区 lab）
    // 节点键 = 节点公钥的 canvasOwnerFingerprint（sha256 前 8 位十六进制，上游 roster.ts 的 host）
    const fpOf = (key) => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 8);
    const LABFP = fpOf(lab.key);
    const rosterRaw = (fp, at, doc, task) => JSON.stringify({ team: 'market/12345678', message: `[A2A roster] ${fp} ${at}\n${JSON.stringify(doc)}`, caller_session: 'dsh-host-1a2b', context_id: '', wait: false, task_id: task });
    const at1 = '2026-11-11T09:00:00.000Z';
    const seats = [
      { seat: 'lab/a1a1a1a1', seatId: 'seat-a1', name: '成员甲', team: 'lab/canvas/team', role: 'member', online: true, active: 9, queued: 2, lastActiveAt: at1 },
      { seat: 'lab/00000000', name: '总工', team: 'lab/canvas/team', role: 'router', online: true, active: 0, queued: 0 },
      { seat: 'lab/b2b2b2b2', name: '成员乙', team: 'lab/canvas/team', role: 'boss', online: false },
      { seat: 'other/c3c3c3c3', name: '别的区的席位', team: 'lab/canvas/team', role: 'member', online: true },
      { seat: 'lab/d4d4d4d4', name: '挂在别的区团队上', team: 'other/canvas/x', role: 'member', online: true },
      { seat: 'lab/not-hex!', name: '句柄不合形状', team: 'lab/canvas/team', role: 'member', online: true },
    ];
    // 在办件数从事项现算：把一件没结束的事项的承接设成成员甲
    await receipt(R0.task, '接下', { idempotencyKey: R0.task, disposition: 'acknowledged' }, R0.ctx, { inbound: `ack-${R0.task}` });
    { const d = db(); try { d.prepare('UPDATE work_items SET seat = ? WHERE id = ?').run('lab/a1a1a1a1', `wi_${R0.ev}`); } finally { d.close(); } }
    let raw = rosterRaw(LABFP, at1, { host: LABFP, at: at1, seats }, 'roster-abcdef01-1');
    r = await post(raw, signed(lab, raw));
    ok('名册：投递过的宿主、Sig3 → 收下（roster recorded），席位只留本区、句柄合形状的', r.status === 200 && r.text.includes('"roster":"recorded"') && r.text.includes('"seats":3'), r.text);
    const t1 = await api('GET', '/api/a2a/teams');
    const team = (t1.body?.teams ?? []).find((t) => t.team === 'lab/canvas/team');
    const sa = team?.seats?.find((x) => x.seat === 'lab/a1a1a1a1');
    ok('读接口：团队、名字、在岗数；席位的名字、角色（认不出的置空）、在岗', team && team.name === 'team' && team.peer_zone === 'lab' && team.seats_online === 2 && team.seats.length === 3
      && team.seats.find((x) => x.seat === 'lab/b2b2b2b2')?.role === '' && sa?.name === '成员甲' && sa?.role === 'member', JSON.stringify(t1.body));
    ok('……在办件数从事项现算（不用宿主报的 9）；稳定的 seat_id 照收（没带的是空）', sa?.active === 1 && sa?.queued === 2 && sa?.seat_id === 'seat-a1' && team.seats.find((x) => x.seat === 'lab/00000000')?.seat_id === '', JSON.stringify(sa));
    raw = rosterRaw(LABFP, '2026-11-11T08:00:00.000Z', { host: LABFP, at: '2026-11-11T08:00:00.000Z', seats: [{ seat: 'lab/e5e5e5e5', name: '旧的', team: 'lab/canvas/team', role: 'member', online: true }] }, 'roster-abcdef01-0');
    r = await post(raw, signed(lab, raw));
    ok('更早的名册 → stale，不覆盖', r.text.includes('"roster":"stale"') && !(await api('GET', '/api/a2a/teams')).body?.teams?.some((t) => t.seats.some((x) => x.seat === 'lab/e5e5e5e5')), r.text);
    // 名册变化：第一次收到 → 团队、席位都记 added；再来一版更新的 → 成员消失、新成员、换总工、新团队、团队消失
    const changes = () => q('SELECT kind, team, seat, detail FROM a2a_roster_changes WHERE host = ? ORDER BY id', LABFP);
    ok('名册变化：第一次收到 → team-added 一条、seat-added 三条', JSON.stringify(changes().map((c) => c.kind)) === JSON.stringify(['team-added', 'seat-added', 'seat-added', 'seat-added']), JSON.stringify(changes()));
    const at2 = '2026-11-11T09:30:00.000Z';
    raw = rosterRaw(LABFP, at2, { host: LABFP, at: at2, seats: [
      { seat: 'lab/a1a1a1a1', name: '成员甲', team: 'lab/canvas/team', role: 'router', online: true },
      { seat: 'lab/00000000', name: '原总工', team: 'lab/canvas/team', role: 'member', online: true },
      { seat: 'lab/c5c5c5c5', name: '新来的', team: 'lab/canvas/team', role: 'member', online: true },
      { seat: 'lab/d6d6d6d6', name: '另一个团队的', team: 'lab/canvas/other', role: 'router', online: true },
    ] }, 'roster-abcdef01-4');
    r = await post(raw, signed(lab, raw));
    const ch2 = changes().slice(4).map((c) => [c.kind, c.team, c.seat]);
    ok('名册变化：新团队、新成员、成员消失、换总工各记一行', r.text.includes('"roster":"recorded"') && JSON.stringify(ch2) === JSON.stringify([
      ['team-added', 'lab/canvas/other', ''], ['seat-added', 'lab/canvas/team', 'lab/c5c5c5c5'], ['seat-added', 'lab/canvas/other', 'lab/d6d6d6d6'],
      ['seat-removed', 'lab/canvas/team', 'lab/b2b2b2b2'], ['router-changed', 'lab/canvas/team', 'lab/a1a1a1a1']]), JSON.stringify(ch2));
    const rc = changes().find((c) => c.kind === 'router-changed');
    ok('……换总工的记录写明从谁到谁', JSON.parse(rc?.detail ?? '{}').from === 'lab/00000000' && JSON.parse(rc?.detail ?? '{}').to === 'lab/a1a1a1a1', rc?.detail);
    const at3 = '2026-11-11T10:00:00.000Z';
    raw = rosterRaw(LABFP, at3, { host: LABFP, at: at3, seats: [{ seat: 'lab/d6d6d6d6', name: '另一个团队的', team: 'lab/canvas/other', role: 'router', online: true }] }, 'roster-abcdef01-5');
    await post(raw, signed(lab, raw));
    ok('名册变化：整个团队不在了 → 三条 seat-removed、一条 team-removed', JSON.stringify(changes().slice(9).map((c) => c.kind)) === JSON.stringify(['seat-removed', 'seat-removed', 'seat-removed', 'team-removed']), JSON.stringify(changes().slice(9)));
    ok('席位的键是「节点 + 团队 + 句柄」：表里按这三项一行', q('SELECT COUNT(*) AS c FROM a2a_roster_seats WHERE host = ?', LABFP)[0].c === 1);
    // 键只有一种写法：节点、句柄、团队的区和 canvas 段转小写再存（画布名原样）；只差大小写的两个席位算同一个
    const at4 = '2026-11-11T10:30:00.000Z';
    raw = rosterRaw(LABFP, at4, { host: LABFP.toUpperCase(), at: at4, seats: [
      { seat: 'LAB/D6D6D6D6', name: '大写的', team: 'LAB/Canvas/other', role: 'router', online: true },
      { seat: 'lab/d6d6d6d6', name: '只差大小写', team: 'lab/canvas/other', role: 'router', online: true },
      { seat: 'Lab/E7E7E7E7', name: '画布名带大写', team: 'Lab/CANVAS/MixedName', role: 'member', online: true },
    ] }, 'roster-abcdef01-6');
    r = await post(raw, signed(lab, raw));
    const lower = q('SELECT host, team, seat FROM a2a_roster_seats WHERE lower(host) = ? ORDER BY team, seat', LABFP);
    ok('名册的键统一小写：host、句柄、团队的区和 canvas 段转小写（画布名原样），只差大小写的席位并成一行', r.text.includes('"roster":"recorded"')
      && JSON.stringify(lower) === JSON.stringify([{ host: LABFP, team: 'lab/canvas/MixedName', seat: 'lab/e7e7e7e7' }, { host: LABFP, team: 'lab/canvas/other', seat: 'lab/d6d6d6d6' }])
      && q('SELECT COUNT(*) AS c FROM a2a_rosters WHERE host <> lower(host)')[0].c === 0, `${r.text.slice(0, 120)} ${JSON.stringify(lower)}`);
    raw = rosterRaw('99999999', at1, { host: LABFP, at: at1, seats }, 'roster-99999999-1');
    r = await post(raw, signed(lab, raw));
    ok('首行指纹和 JSON 的 host 对不上 → 不采信', r.text.includes('"roster":"not-accepted"'), r.text);
    const before = JSON.stringify((await api('GET', '/api/a2a/teams')).body);
    for (const [label, h] of [['没签名', {}], ['别的宿主签', signed(evil, rosterRaw(LABFP, '2026-11-11T10:00:00.000Z', { host: LABFP, at: '2026-11-11T10:00:00.000Z', seats }, 'roster-abcdef01-2'))]]) {
      const rr = rosterRaw(LABFP, '2026-11-11T10:00:00.000Z', { host: LABFP, at: '2026-11-11T10:00:00.000Z', seats: [{ seat: 'lab/f6f6f6f6', name: '冒充的', team: 'lab/canvas/team', role: 'member', online: true }] }, 'roster-abcdef01-3');
      const res = await post(rr, label === '没签名' ? {} : signed(evil, rr));
      ok(`名册·${label} → 不收（照原路走），名册不变`, !res.text.includes('"roster":') && JSON.stringify((await api('GET', '/api/a2a/teams')).body) === before, res.text.slice(0, 120));
    }
    { const stranger = await peer('stranger2');
      const rr = rosterRaw('abcdef02', at1, { host: 'abcdef0299999999', at: at1, seats: [{ seat: 'stranger2/a7a7a7a7', name: '没投递过', team: 'stranger2/canvas/t', role: 'member', online: true }] }, 'roster-abcdef02-1');
      const res = await post(rr, signed(stranger, rr));
      ok('名册·签名方是没投递过的宿主 → 不收', !res.text.includes('"roster":') && JSON.stringify((await api('GET', '/api/a2a/teams')).body) === before, res.text.slice(0, 120));
      stranger.server.close(); }
    // 对抗：节点键只认验过签的那把公钥
    {
      const labRow = () => q('SELECT peer_zone, peer_root, reported_at FROM a2a_rosters WHERE host = ?', LABFP)[0];
      const labSeats = () => JSON.stringify(q('SELECT team, seat FROM a2a_roster_seats WHERE host = ? ORDER BY team, seat', LABFP));
      const changeCount = () => q('SELECT COUNT(*) AS c FROM a2a_roster_changes WHERE host = ?', LABFP)[0].c;
      const [row0, seats0, ch0] = [JSON.stringify(labRow()), labSeats(), changeCount()];
      seedEvent({ zone: 'evil', root: evil.url });
      const far = '2099-01-01T00:00:00.000Z';
      // 别的投递过的宿主用自己的 Sig3，正文和首行都冒用 lab 的节点键，时间写在很远的将来
      let rr = rosterRaw(LABFP, far, { host: LABFP, at: far, seats: [{ seat: 'evil/e7e7e7e7', name: '顶替的', team: 'evil/canvas/t', role: 'router', online: true }] }, 'roster-evil-1');
      r = await post(rr, signed(evil, rr));
      ok('对抗：别的宿主签名、冒用这台的节点键 → 不收；这台的来源、席位、变化记录都不动', r.text.includes('"roster":"not-accepted"') && JSON.stringify(labRow()) === row0 && labSeats() === seats0 && changeCount() === ch0, `${r.text.slice(0, 120)} ${JSON.stringify(labRow())}`);
      // 这台自己报的时间也不能在将来：超过收到时间加签名时间窗的不收
      rr = rosterRaw(LABFP, far, { host: LABFP, at: far, seats: [{ seat: 'lab/f8f8f8f8', name: '将来的', team: 'lab/canvas/team', role: 'member', online: true }] }, 'roster-lab-far');
      r = await post(rr, signed(lab, rr));
      ok('对抗：报的时间远在将来（2099）→ 不收', r.text.includes('"roster":"not-accepted"') && JSON.stringify(labRow()) === row0, r.text.slice(0, 120));
      const at5 = new Date().toISOString();
      rr = rosterRaw(LABFP, at5, { host: LABFP, at: at5, seats: [{ seat: 'lab/d6d6d6d6', name: '正常再报', team: 'lab/canvas/other', role: 'router', online: true }] }, 'roster-lab-5');
      r = await post(rr, signed(lab, rr));
      ok('……之后这台正常再报一版 → recorded（没被将来的时间卡住）', r.text.includes('"roster":"recorded"') && labRow()?.reported_at === at5 && labRow()?.peer_zone === 'lab', `${r.text.slice(0, 120)} ${JSON.stringify(labRow())}`);
      // 节点键必须是签名方自己公钥的指纹：报一个表里还没有、也不是自己指纹的节点键 → 不收，不能抢先占住
      const other = 'f0e1d2c3';
      rr = rosterRaw(other, at5, { host: other, at: at5, seats: [{ seat: 'evil/e8e8e8e8', name: '抢占的', team: 'evil/canvas/t', role: 'router', online: true }] }, 'roster-evil-2');
      r = await post(rr, signed(evil, rr));
      ok('对抗：签名方报一个不是自己公钥指纹、表里还没有的节点键 → 不收，表里不多出这一行', r.text.includes('"roster":"not-accepted"') && q('SELECT COUNT(*) AS c FROM a2a_rosters WHERE host = ?', other)[0].c === 0 && other !== fpOf(evil.key), r.text.slice(0, 120));
      // 上限是收到时间加签名时间窗（5 分钟）：现在 + 10 分钟也不收
      const soon = new Date(Date.now() + 10 * 60_000).toISOString();
      rr = rosterRaw(LABFP, soon, { host: LABFP, at: soon, seats: [{ seat: 'lab/f9f9f9f9', name: '十分钟后', team: 'lab/canvas/team', role: 'member', online: true }] }, 'roster-lab-soon');
      r = await post(rr, signed(lab, rr));
      ok('对抗：报的时间是现在 + 10 分钟（超过签名时间窗）→ 不收', r.text.includes('"roster":"not-accepted"') && labRow()?.reported_at === at5, `${r.text.slice(0, 120)} ${JSON.stringify(labRow())}`);
      // 凑出指纹相同的公钥、换个根地址来报（这里直接用同一把钥匙模拟撞键）→ 这个节点键已经由别的根地址报过，不收
      const twin = await peer('twin', lab.key);
      seedEvent({ zone: 'twin', root: twin.url });
      const at6 = new Date(Date.now() + 1000).toISOString();
      rr = rosterRaw(LABFP, at6, { host: LABFP, at: at6, seats: [{ seat: 'twin/a9a9a9a9', name: '撞键的', team: 'twin/canvas/t', role: 'router', online: true }] }, 'roster-twin-1');
      r = await post(rr, signed(twin, rr));
      ok('对抗：指纹相同、根地址不同的宿主来报 → host-conflict，不覆盖', r.text.includes('"roster":"host-conflict"') && labRow()?.peer_root === lab.url && labRow()?.peer_zone === 'lab' && !labSeats().includes('twin/'), `${r.text.slice(0, 120)} ${JSON.stringify(labRow())}`);
      twin.server.close();
    }
    // health 的 a2a.roster：各种结果都计数、带最近一次的时间；匿名可读，所以不带任何对端标识
    {
      // 验签不过：投递过的宿主的地址和形状都对，Sig3 被改过
      { const at9 = new Date().toISOString(); const rr = rosterRaw(LABFP, at9, { host: LABFP, at: at9, seats: [] }, 'roster-bad-sig'); const h = signed(lab, rr); h['X-A2A-Caller-Sig3'] = h['X-A2A-Caller-Sig3'].replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
        const res = await post(rr, h); ok('（准备）Sig3 被改过的名册不认作名册', !res.text.includes('"roster":'), res.text.slice(0, 120)); }
      // 超长（团队太大）和首行格式不对：照普通来信走，但都要计数，不能悄悄丢
      { const atL = new Date().toISOString(); const big = rosterRaw(LABFP, atL, { host: LABFP, at: atL, seats: [], pad: 'x'.repeat(70 * 1024) }, 'roster-too-large');
        const r1 = await post(big, signed(lab, big)); ok('（准备）超过 64 KiB 的名册不认作名册', !r1.text.includes('"roster":'), r1.text.slice(0, 120));
        const bad = JSON.stringify({ team: 'market/12345678', message: `[A2A roster] not-a-fp ${atL}\n{}`, caller_session: 'dsh-host-1a2b', context_id: '', wait: false, task_id: 'roster-malformed' });
        const r2 = await post(bad, signed(lab, bad)); ok('（准备）首行格式不对的名册不认作名册', !r2.text.includes('"roster":'), r2.text.slice(0, 120)); }
      await new Promise((r) => setTimeout(r, 5100)); // 来源汇总缓存 5 秒
      const rawHealth = await (await fetch(BASE + '/api/health')).text();
      const rh = JSON.parse(rawHealth).a2a?.roster ?? {};
      const d = (k) => cnt(rh, k) - cnt(rh0, k);
      ok('health a2a.roster：收下、过期、不认、撞键、来源不是投递过的宿主、验签不过、超长、首行格式不对都有计数，带最近一次的时间',
        d('recorded') >= 3 && d('stale') >= 1 && d('not_accepted') >= 4 && d('host_conflict') >= 1 && d('not_delivered_peer') >= 1 && d('unverified') >= 1 && d('too_large') === 1 && d('malformed') === 1
        && ['recorded', 'stale', 'not_accepted', 'host_conflict', 'not_delivered_peer', 'unverified', 'too_large', 'malformed'].every((k) => /^\d{4}-\d\d-\d\dT/.test(rh.outcomes?.[k]?.last_at ?? '')),
        JSON.stringify({ rh0: rh0.outcomes, rh: rh.outcomes }));
      ok('health a2a.roster.sources：来源个数、最久没收下的时间、超过 15 分钟没收下的个数（没有标识）',
        rh.sources?.sources >= 1 && typeof rh.sources?.stalest_received_at === 'string' && rh.sources?.stale_15m === 0 && Object.keys(rh.sources ?? {}).sort().join() === 'sources,stale_15m,stalest_received_at', JSON.stringify(rh.sources));
      const fpLab = createHash('sha256').update(createPublicKey(lab.key).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 8);
      ok('匿名 health 里没有对端的节点键、地址、区、团队名、席位', ![fpLab, lab.url, 'lab/canvas', 'lab/', 'evil', 'twin'].some((x) => rawHealth.includes(x)), rawHealth.slice(0, 200));
    }
    const anon = await fetch(BASE + '/api/a2a/teams');
    ok('读接口：没登录 401', anon.status === 401);
    const cross = await fetch(BASE + '/api/a2a/teams', { headers: { 'x-admin-token': 'ans-admin', 'sec-fetch-site': 'cross-site' } });
    ok('读接口：跨站 403', cross.status === 403);
  }

  console.log('三、席位发来的消息（跟进）：落在事项对话里，不进「关注」');
  const fu = (ctx, text, inbound) => JSON.stringify({ team: 'market/12345678', message: text, caller_session: 'lab/canvas/ops', context_id: ctx, wait: false, task_id: inbound });
  const attentionSources = async () => ((await api('GET', '/api/attention')).body?.items ?? []).map((x) => x.source);
  const itemOf = async (ev) => (await api('GET', `/api/work-items/wi_${ev}`)).body ?? {};
  const msgReply = (ev, mid, text) => api('POST', `/api/work-items/wi_${ev}/messages/${mid}/reply`, { text });
  const msgRead = (ev) => api('POST', `/api/work-items/wi_${ev}/messages/read`, {});
  const runs = () => q('SELECT COUNT(*) AS c FROM sop_runs')[0].c;
  const L = seedEvent();
  const runsBefore = runs();
  lab.got.length = 0;
  let raw = fu(L.ctx, '成员问：发哪个仓库？', 'a2a-follow0001');
  r = await post(raw, signed(lab, raw));
  ok('同一 context、同一对端、Sig3 → 收下（200 followup recorded），事项状态不动', r.status === 200 && r.text.includes('"followup":"recorded"') && state(L.ev)?.state === 'delivered', `${r.text} ${JSON.stringify(state(L.ev))}`);
  let it = await itemOf(L.ev);
  const mineL = (it.messages ?? []).find((x) => x.text.includes('发哪个仓库'));
  ok('……落在事项对话里：一条未读席位消息（发信方、正文），事项带未读数', mineL && mineL.status === 'unread' && mineL.sender === 'lab/canvas/ops' && it.unread === 1, JSON.stringify(it.messages ?? null));
  ok('……不进「关注」（没有席位来信这个来源）', !(await attentionSources()).includes('seat-letters'));
  ok('……事项日志里是只记录的 note followup', q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'note' AND json_extract(detail, '$.note') = 'followup'", `wi_${L.ev}`)[0].c === 1);
  await waitFor(() => lab.got.some((g) => g.body.task_id === 'receipt-a2a-follow0001'));
  const rc = lab.got.find((g) => g.body.task_id === 'receipt-a2a-follow0001');
  const rcLines = String(rc?.body?.message ?? '').split('\n');
  ok('立即回一条结清它的回执：任务号 receipt-<跟进任务号>，发给来信的一方，同一 context', rc && rc.body.team === 'lab/canvas/ops' && rc.body.context_id === L.ctx, JSON.stringify(rc?.body ?? null).slice(0, 200));
  ok('……回执头与信封只用跟进的任务号（不用原任务号）', rcLines[0] === '[A2A receipt] task a2a-follow0001 已转给人' && JSON.stringify(JSON.parse(rcLines[1] ?? '{}')) === JSON.stringify({ outcome: 'completed', idempotencyKey: 'a2a-follow0001', disposition: 'result' }) && !String(rc?.body?.message).includes(L.task), JSON.stringify(rcLines));
  // #542 之后出站带 Sig2 + Sig3（body 绑定）
  ok('……带 OriginClaim 签名（Sig2 + Sig3 + 正文摘要头）', typeof rc?.headers['x-a2a-caller-sig2'] === 'string' && typeof rc?.headers['x-a2a-caller-sig3'] === 'string' && typeof rc?.headers['x-a2a-body-sha256'] === 'string', JSON.stringify(Object.keys(rc?.headers ?? {})));
  r = await post(raw, signed(lab, raw));
  ok('同一条（对方的任务号）再发 → 不重复记、不重复回执', r.status === 200 && q("SELECT COUNT(*) AS c FROM workbench_event_followups WHERE delivery_id = ?", L.delivery)[0].c === 1 && q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-receipt' AND delivery_id = ?", L.delivery)[0].c === 1);
  // 回复：同一 context 的新任务发回那个团队
  lab.got.length = 0;
  r = await msgReply(L.ev, mineL.id, '发 apps 仓库');
  it = await itemOf(L.ev);
  ok('在事项对话里回复 → 200 sent=true，这条标成已回复、不再算未读', r.status === 200 && r.body?.sent === true && it.messages.find((x) => x.id === mineL.id)?.status === 'replied' && it.unread === 0, JSON.stringify(r.body));
  r = await msgReply(L.ev, mineL.id, '再回一次');
  ok('……同一条再回复 → 409，不再发', r.status === 409 && q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-reply' AND ref = ?", mineL.id)[0].c === 1, JSON.stringify(r.body));
  await waitFor(() => lab.got.some((g) => String(g.body.task_id ?? '').startsWith(`${L.ev}.d${L.delivery}.q`)));
  const rp = lab.got.find((g) => String(g.body.task_id ?? '').startsWith(`${L.ev}.d${L.delivery}.q`));
  let renv = {}; try { renv = JSON.parse(rp?.body?.message ?? '{}'); } catch {}
  ok('……对端收到同一 context 的新任务，qid = 来信的任务号、正文是回复', rp && rp.body.context_id === L.ctx && renv.kind === 'answer' && renv.answer?.qid === 'a2a-follow0001' && renv.answer?.text === '发 apps 仓库', JSON.stringify(rp?.body ?? null).slice(0, 200));
  ok('……事项日志记一行 note followup-reply', q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'note' AND json_extract(detail, '$.note') = 'followup-reply'", `wi_${L.ev}`)[0].c === 1);
  // 看过
  raw = fu(L.ctx, '通知：已开工', 'a2a-follow0002');
  await post(raw, signed(lab, raw));
  ok('又来一条 → 事项未读数 1', (await itemOf(L.ev)).unread === 1);
  r = await msgRead(L.ev);
  it = await itemOf(L.ev);
  const notice = it.messages.find((x) => x.text.includes('已开工'));
  ok('看过 → 标成已读、未读数 0，不发任何东西；「看过」只记在事件日志里，不进事项时间线', r.status === 200 && r.body?.marked === 1 && notice?.status === 'read' && it.unread === 0
    && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE event_id = ? AND action = 'followup-read'", L.ev)[0].c === 1
    && q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-reply' AND ref = ?", notice?.id)[0].c === 0
    && q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'note' AND json_extract(detail, '$.note') = 'followup-read'", `wi_${L.ev}`)[0].c === 0, JSON.stringify(r.body));
  r = await msgRead(L.ev);
  ok('……再看一次 → 标了 0 条，不重复记', r.status === 200 && r.body?.marked === 0 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE event_id = ? AND action = 'followup-read'", L.ev)[0].c === 1, JSON.stringify(r.body));
  r = await msgReply(L.ev, notice?.id, '看过的也能回');
  ok('……看过的消息仍可回复', r.status === 200 && r.body?.sent === true, JSON.stringify(r.body));
  // 消息编号是别的事项的 → 404
  r = await msgReply(a.ev, notice?.id, '串到别的事项');
  ok('拿别的事项的消息编号来回复 → 404，不发', r.status === 404 && r.body?.error === 'seat_message_not_found', JSON.stringify(r.body));
  // S9：回复超过 4000 字 → 400，不发、不改状态
  raw = fu(L.ctx, '再问一句', 'a2a-follow0003');
  await post(raw, signed(lab, raw));
  const s9 = (await itemOf(L.ev)).messages.find((x) => x.text === '再问一句');
  r = await msgReply(L.ev, s9?.id, '长'.repeat(4001));
  ok('S9：4001 字的回复 → 400 text_too_long，这条仍未读、不发', r.status === 400 && r.body?.error === 'text_too_long' && (await itemOf(L.ev)).messages.find((x) => x.id === s9?.id)?.status === 'unread'
    && q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-reply' AND ref = ?", s9?.id)[0].c === 0, JSON.stringify(r.body));
  r = await msgReply(L.ev, s9?.id, '长'.repeat(4000));
  ok('……正好 4000 字 → 200', r.status === 200, JSON.stringify(r.body));
  // S15：跟进里夹带别处的回调地址 → 结清回执仍只投到记下的对端根地址
  {
    const elsewhere = await peer('elsewhere');
    lab.got.length = 0;
    const raw15 = JSON.stringify({ team: 'market/12345678', message: '带了别处回调的跟进', caller_session: 'lab/canvas/ops', context_id: L.ctx, wait: false, task_id: 'a2a-follow0015', callback: elsewhere.url, callback_url: elsewhere.url, reply_to: elsewhere.url, target_url: elsewhere.url });
    r = await post(raw15, signed(lab, raw15));
    await waitFor(() => lab.got.some((g) => g.body.task_id === 'receipt-a2a-follow0015'));
    const row15 = q("SELECT target_url FROM workbench_event_replies WHERE kind = 'followup-receipt' AND fixed_task = 'receipt-a2a-follow0015'")[0];
    ok('S15：跟进带别处的 callback → 结清回执只投到记下的对端根地址，别处收不到', r.text.includes('"followup":"recorded"') && row15?.target_url === lab.url && lab.got.some((g) => g.body.task_id === 'receipt-a2a-follow0015') && elsewhere.got.length === 0, JSON.stringify({ row15, elsewhere: elsewhere.got.length }));
    elsewhere.server.close();
  }
  ok('来信全程没开 run、没改事项状态', runs() === runsBefore && state(L.ev)?.state === 'delivered');

  console.log('三（续）、对抗组');
  const noRec = (inbound) => q('SELECT COUNT(*) AS c FROM workbench_event_followups WHERE inbound_task = ?', inbound)[0].c === 0 && q('SELECT COUNT(*) AS c FROM workbench_event_replies WHERE fixed_task = ?', `receipt-${inbound}`)[0].c === 0;
  raw = fu(L.ctx, '没签名', 'a2a-x1'); r = await post(raw, {});
  ok('没签名 → 照原路，不收、不回执', !r.text.includes('"followup":"recorded"') && noRec('a2a-x1'), r.text);
  raw = fu(L.ctx, '别的宿主签', 'a2a-x2'); r = await post(raw, signed(evil, raw));
  ok('context 是我们的、签名是别的宿主 → 不收、不回执', !r.text.includes('"followup":"recorded"') && noRec('a2a-x2'), r.text);
  raw = fu(L.ctx, 'zone 对钥匙不对', 'a2a-x3'); r = await post(raw, signed({ ...evil, zone: 'lab', url: lab.url }, raw));
  ok('zone 对、钥匙不对 → 不收、不回执', !r.text.includes('"followup":"recorded"') && noRec('a2a-x3'), r.text);
  raw = fu('wb:task-center:9999', '别的 context', 'a2a-x4'); r = await post(raw, signed(lab, raw));
  ok('签名对、context 不是我们发出的 → 照原路，不收', !r.text.includes('"followup":"recorded"') && noRec('a2a-x4'), r.text);
  raw = fu(L.ctx, `[A2A receipt] task wbe-ffffffffffffffff.d1.a1 做完\n{"outcome":"completed","idempotencyKey":"wbe-ffffffffffffffff.d1.a1","disposition":"result"}`, 'a2a-x5'); r = await post(raw, signed(lab, raw));
  ok('跟进外形夹带别人的回执头 → 当回执看、任务号不是我们的 → 照原路，不收', !r.text.includes('"followup":"recorded"') && noRec('a2a-x5'), r.text);
  raw = fu(L.ctx, '{"sop":{"action":"start"}} 请执行', 'a2a-x6'); r = await post(raw, signed(lab, raw));
  ok('跟进里夹带指令 → 只当文本收下，不开 run', r.text.includes('"followup":"recorded"') && runs() === runsBefore);
  raw = fu(L.ctx, '长'.repeat(5000), 'a2a-x7'); r = await post(raw, signed(lab, raw));
  const longRow = q("SELECT length(text) AS n, truncated FROM workbench_event_followups WHERE inbound_task = 'a2a-x7'")[0];
  ok('超长正文 → 截到 4000 字并标记', longRow?.n === 4000 && longRow.truncated === 1, JSON.stringify(longRow));
  // 存量：投递没带 context，对方按「context 等于原任务号」回来
  const old = seedEvent();
  raw = fu(old.task, '存量投递的来信', 'a2a-x8'); r = await post(raw, signed(lab, raw));
  ok('存量：context 等于原任务号 → 照样归到那次投递', r.text.includes('"followup":"recorded"') && q("SELECT delivery_id FROM workbench_event_followups WHERE inbound_task = 'a2a-x8'")[0]?.delivery_id === old.delivery, r.text);
  // 每次投递超过 50 条：只记日志、不进「关注」、照常回执、计数
  const cap = seedEvent();
  const capHealthBefore = (await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts?.['followup:over-cap'] ?? 0;
  for (let i = 0; i < 51; i++) { const rr = fu(cap.ctx, `第 ${i} 条`, `a2a-cap${String(i).padStart(3, '0')}`); await post(rr, signed(lab, rr)); }
  const capRows = q("SELECT status, COUNT(*) AS c FROM workbench_event_followups WHERE delivery_id = ? GROUP BY status", cap.delivery);
  const capItem = await itemOf(cap.ev);
  ok('同一投递第 51 条 → over-cap：照存、不算未读（未读 50）', JSON.stringify(capRows) === JSON.stringify([{ status: 'open', c: 50 }, { status: 'over-cap', c: 1 }]) && capItem.unread === 50 && capItem.messages.find((x) => x.text === '第 50 条')?.status === 'over-cap', JSON.stringify(capRows));
  r = await msgReply(cap.ev, capItem.messages.find((x) => x.text === '第 50 条')?.id, '回超限的');
  ok('……超限的那条不能回复（409）', r.status === 409, JSON.stringify(r.body));
  ok('……超限的也照常回执、公开计数 followup:over-cap +1', q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-receipt' AND delivery_id = ?", cap.delivery)[0].c === 51 && ((await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts?.['followup:over-cap'] ?? 0) === capHealthBefore + 1);
  // 对端 10 分钟超过限频（测试里设 80）：合法跟进全部拿到结清回执，超出的不存正文、不进「关注」、只计数
  const rate = seedEvent();
  const rateHealthBefore = (await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts?.['followup:rate-limited'] ?? 0;
  let firstLimited = -1;
  for (let i = 0; i < 90; i++) { const rr = fu(rate.ctx, `频 ${i}`, `a2a-rate${String(i).padStart(3, '0')}`); const res = await post(rr, signed(lab, rr)); if (firstLimited < 0 && res.text.includes('"rate_limited":true')) firstLimited = i; if (firstLimited >= 0 && i >= firstLimited + 4) break; }
  const rateRows = q("SELECT status, COUNT(*) AS c, MAX(LENGTH(text)) AS n FROM workbench_event_followups WHERE delivery_id = ? GROUP BY status ORDER BY status", rate.delivery);
  const limitedRow = rateRows.find((x) => x.status === 'rate-limited');
  ok('一台宿主短时间发来超过阈值的合法跟进 → 超出的记成 rate-limited、不存正文', firstLimited >= 0 && limitedRow?.c === 5 && limitedRow.n === 0, JSON.stringify({ firstLimited, rateRows }));
  ok('……全部拿到结清回执（每条一行 receipt-<跟进任务号>）', firstLimited >= 0 && q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-receipt' AND delivery_id = ?", rate.delivery)[0].c === firstLimited + 5);
  await waitFor(() => lab.got.some((g) => g.body.task_id === `receipt-a2a-rate${String(firstLimited + 4).padStart(3, '0')}`), 15000);
  ok('……超出的那几条，回执真的发到了对端', [0, 1, 2, 3, 4].every((k) => lab.got.some((g) => g.body.task_id === `receipt-a2a-rate${String(firstLimited + k).padStart(3, '0')}`)));
  {
    // S7：限频只计数的那条不能回复（404：它不在对话里）
    const limitedId = q("SELECT id FROM workbench_event_followups WHERE delivery_id = ? AND status = 'rate-limited' ORDER BY id LIMIT 1", rate.delivery)[0]?.id;
    const rr = await msgReply(rate.ev, limitedId, '回限频的');
    ok('S7：限频只计数的消息不能回复 → 404，不发', typeof limitedId === 'number' && rr.status === 404 && rr.body?.error === 'seat_message_not_found'
      && q("SELECT COUNT(*) AS c FROM workbench_event_replies WHERE kind = 'followup-reply' AND ref = ?", limitedId)[0].c === 0, JSON.stringify(rr.body));
  }
  const rateItem = await itemOf(rate.ev);
  ok('……超出的不进事项对话（对话里只有存了正文的），公开计数 followup:rate-limited +5，事件日志记 followup-rate-limited 5 行', rateItem.messages.length === firstLimited && rateItem.unread === firstLimited
    && ((await (await fetch(BASE + '/api/health')).json()).a2a?.refused?.counts?.['followup:rate-limited'] ?? 0) === rateHealthBefore + 5
    && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'followup-rate-limited'", rate.delivery)[0].c === 5);
  // 验签不过的仍然不收不回执（那不是我们欠的）——限频不改变这一条
  { const rr = fu(rate.ctx, '伪造', 'a2a-rate-forged'); await post(rr, signed(evil, rr)); ok('限频之下，验签不过的仍不收、不回执', noRec('a2a-rate-forged')); }
  ok('跟进回执的积压在健康块里有数', typeof (await (await fetch(BASE + '/api/health')).json()).a2a?.outbox?.followup_receipts?.pending === 'number');
  // 名片不声明 teamRoster（WM_A2A_TEAM_ROSTER=off）：入站名册一律不收（照普通来信走），已有的名册不动
  {
    child.kill(); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
    const off = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'ans-admin', MARKET_PUBLIC_URL: BASE, WM_A2A_DIRECT_SIG: '', WM_LOGIN_GATE: '', WM_A2A_TEAM_ROSTER: 'off' } });
    try {
      ok('（准备）WM_A2A_TEAM_ROSTER=off 的实例起来了', await ready());
      const card = await (await fetch(BASE + '/.well-known/agent-card.json')).json();
      ok('off：名片不声明 teamRoster', card?.capabilities && !('teamRoster' in card.capabilities), JSON.stringify(card?.capabilities));
      const fp = createHash('sha256').update(createPublicKey(lab.key).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 8);
      const before = JSON.stringify(q('SELECT host, reported_at FROM a2a_rosters ORDER BY host'));
      const at = new Date().toISOString();
      const raw = JSON.stringify({ team: 'market/12345678', message: `[A2A roster] ${fp} ${at}\n${JSON.stringify({ host: fp, at, seats: [{ seat: 'lab/f1f1f1f1', name: '没声明时推来的', team: 'lab/canvas/team', role: 'member', online: true }] })}`, caller_session: 'dsh-host-1a2b', context_id: '', wait: false, task_id: 'roster-off-1' });
      const rr = await post(raw, signed(lab, raw));
      ok('off：投递过的宿主、Sig3 签的名册也不收（应答里没有 roster），名册表不变', !rr.text.includes('"roster":') && JSON.stringify(q('SELECT host, reported_at FROM a2a_rosters ORDER BY host')) === before
        && q("SELECT COUNT(*) AS c FROM a2a_roster_seats WHERE seat = 'lab/f1f1f1f1'")[0].c === 0, rr.text.slice(0, 160));
      const offRoster = (await (await fetch(BASE + '/api/health')).json()).a2a?.roster ?? {};
      ok('off：health 记一次 not_declared（名片没声明，推来的名册照普通来信走）', offRoster.outcomes?.not_declared?.count === 1, JSON.stringify(offRoster.outcomes));
    } finally { off.kill(); await new Promise((r) => { if (off.exitCode !== null) r(); else off.once('exit', r); }); }
  }
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  child.kill();
  lab.server.close();
  evil.server.close();
}
// 限频阈值不合法 → 拒绝启动
for (const bad of ['0', 'abc', '100001']) {
  const bp = await port();
  const code = await new Promise((res) => { const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: 'server', env: { ...process.env, DATA_DIR: DATA, PORT: String(bp), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', WM_A2A_FOLLOWUP_RATE_10MIN: bad }, stdio: 'ignore' }); const t = setTimeout(() => { c.kill(); res('timeout'); }, 30000); c.on('exit', (x) => { clearTimeout(t); res(x); }); });
  ok(`WM_A2A_FOLLOWUP_RATE_10MIN=${bad} → 拒绝启动`, code === 1, String(code));
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
