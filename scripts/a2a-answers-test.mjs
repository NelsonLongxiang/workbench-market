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
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
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
async function peer(zone) {
  const key = generateKeyPairSync('ed25519').privateKey;
  const p = await port();
  const peerObj = { zone, key, url: `http://127.0.0.1:${p}`, got: [], fail: false };
  peerObj.server = createServer((req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
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
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PM), WM_CONTROL_PORT: '0', NODE_ENV: 'test', MCP_GATEWAY: 'off', ADMIN_TOKEN: 'ans-admin', MARKET_PUBLIC_URL: BASE, WM_A2A_DIRECT_SIG: '', WM_LOGIN_GATE: '', A2A_OUTBOX_BACKOFF_SCALE: '0.0001' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
async function ready() { const end = Date.now() + 30000; while (Date.now() < end) { try { if ((await fetch(BASE + '/api/health')).status === 200) return true; } catch {} await sleep(250); } return false; }
const ADMIN = { 'x-admin-token': 'ans-admin', 'sec-fetch-site': 'same-origin' };
const api = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: { ...ADMIN, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const db = () => new DatabaseSync(join(DATA, 'workbench-market.db'));
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
  r = await answer(a.delivery, '再答一次');
  ok('同一提问答两次 → 第二次不再发（已经不在等）', r.status !== 200 || r.body?.sent !== true, JSON.stringify(r.body));
  ok('……答复表里这次提问只有一行', q('SELECT COUNT(*) AS c FROM workbench_event_answers WHERE delivery_id = ?', a.delivery)[0].c === 1);

  // 只通知的事件：事项不收提问（停在草稿），「关注」里也不列；答复表没有行
  const nd = seedEvent({ dispatch: 0 });
  await receipt(nd.task, '只通知的事件也问了', { idempotencyKey: nd.task, disposition: 'attention' }, nd.ctx);
  ok('只通知的事件（dispatch:false）里的回执提问 → 「关注」不列，两边条数仍相等', !(await seatAsks()).some((x) => x.source_id === String(nd.delivery)) && (await seatAsks()).length === openAsksTotal());
  r = await answer(nd.delivery, '答');
  ok('……硬答 → 不在列表里被拒，不排发送', r.status >= 400 && q('SELECT COUNT(*) AS c FROM workbench_event_answers WHERE delivery_id = ?', nd.delivery)[0].c === 0, JSON.stringify(r.body));

  // 对端一直失败 → 5 次后 dead
  const f = seedEvent();
  await receipt(f.task, '问一句', { idempotencyKey: f.task, disposition: 'attention' }, f.ctx);
  lab.fail = true;
  r = await answer(f.delivery, '答复');
  ok('对端一直失败：答复照样记下、已排发送', r.status === 200 && r.body?.sent === true);
  await waitFor(() => q("SELECT status FROM workbench_event_answers WHERE delivery_id = ?", f.delivery)[0]?.status === 'dead', 20000);
  const row = q('SELECT status, attempts FROM workbench_event_answers WHERE delivery_id = ?', f.delivery)[0];
  ok('……退避重试、5 次后 dead，事件日志有 answer-retry 与 answer-dead', row?.status === 'dead' && row.attempts === 5 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'answer-retry'", f.delivery)[0].c === 4 && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE delivery_id = ? AND action = 'answer-dead'", f.delivery)[0].c === 1, JSON.stringify(row));
  lab.fail = false;

  console.log('三、跟进');
  const fu = (ctx, text, inbound) => JSON.stringify({ team: 'market/12345678', message: text, caller_session: 'superagent-team/a1b2c3d4e5f60718', context_id: ctx, wait: false, task_id: inbound });
  const before = state(a.ev)?.state;
  let raw = fu(a.ctx, '答复收到，继续处理', 'a2a-follow0001');
  r = await post(raw, signed(lab, raw));
  const logs = () => q("SELECT detail FROM workbench_event_log WHERE event_id = ? AND action = 'followup'", a.ev);
  ok('同一 context、同一对端、Sig3 → 记一行 followup，状态不动', r.status === 200 && logs().length === 1 && JSON.parse(logs()[0].detail).text === '答复收到，继续处理' && state(a.ev)?.state === before, `${r.text} ${JSON.stringify(logs())}`);
  ok('……事项日志里是只记录的 note followup', q("SELECT COUNT(*) AS c FROM work_item_log WHERE item_id = ? AND fact = 'note' AND json_extract(detail, '$.note') = 'followup'", `wi_${a.ev}`)[0].c === 1);
  r = await post(raw, signed(lab, raw));
  ok('同一条（对方的任务号）再发 → 不重复记', r.status === 200 && logs().length === 1);
  raw = fu(a.ctx, '没签名的跟进', 'a2a-follow0002');
  r = await post(raw, {});
  ok('没签名 → 照原路、不记', !r.text.includes('"followup":"recorded"') && logs().length === 1, r.text);
  raw = fu(a.ctx, '别的团队冒充', 'a2a-follow0003');
  r = await post(raw, signed(evil, raw));
  ok('别的 zone 签 → 照原路、不记', !r.text.includes('"followup":"recorded"') && logs().length === 1, r.text);
  raw = fu(a.ctx, '冒充 lab', 'a2a-follow0004');
  r = await post(raw, signed({ ...evil, zone: 'lab', url: lab.url }, raw));
  ok('zone 对、钥匙不对 → 照原路、不记', !r.text.includes('"followup":"recorded"') && logs().length === 1, r.text);
  const fresh = seedEvent();
  raw = fu(fresh.ctx, '还没采信过回执', 'a2a-follow0005');
  r = await post(raw, signed(lab, raw));
  ok('这次投递还没采信过任何回执 → 照原路、不记', !r.text.includes('"followup":"recorded"') && q("SELECT COUNT(*) AS c FROM workbench_event_log WHERE event_id = ? AND action = 'followup'", fresh.ev)[0].c === 0, r.text);
  raw = fu('wb:task-center:9999', '别的 context', 'a2a-follow0006');
  r = await post(raw, signed(lab, raw));
  ok('别的 context → 照原路、不记', !r.text.includes('"followup":"recorded"'), r.text);
} catch (e) {
  ok('运行', false, String(e?.stack ?? e));
} finally {
  child.kill();
  lab.server.close();
  evil.server.close();
}
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
