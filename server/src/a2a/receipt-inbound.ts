/**
 * 阶段七 R3：A2A 终态回执入站（superagent 的 A2A Source 回发的就是这种回执）。
 *
 * 窄分流：在 /a2a/direct 原有的签名校验和准入之前判一次，只有三条同时成立才走这里——
 *   1. 正文能解析成回执（`[A2A receipt] task <id> …`，上游 parseReceipt）；
 *   2. <id> 是我们发出的任务号（a2a_sent_tasks 里有）；
 *   3. 签名方就是当初投递到的那台宿主：OriginClaim 的 caller 等于发出那一刻记下的名片 team，callerUrl 的源等于投递的根地址，
 *      用那个根地址上的名片验签；只认绑定正文的 Sig3（只带 Sig2 或更老形式的不采信）；验过后同一请求里所有形式的签名都记为已用。
 * 任何一条不成立都返回 null，调用方照原路处理，应答与今天逐字节相同。前两条成立、第三条不成立的，在事件日志里记一行
 * 「收到未采信」（每次投递最多 20 行），不改状态。caller_session（对方的 CLI 句柄）不参与比对。
 *
 * 采信的回执写一行事件日志，事项服务照 8b 的路径推进（映射在 services/work-item.ts 的 factFromEventLog）：
 *   acknowledged → receipt:acknowledged；attention → receipt:attention（摘要即问题）；
 *   result + outcome ∈ completed / failed / rejected / abandoned → receipt:<outcome>；其余 → receipt:unaccepted（只记录）。
 * 同一任务号的接单回执、终局回执各认一次（idempotencyKey 去重），重复的回 409 -32003 replay；不采信的回执不占这两个槽。
 * 日志里只放摘要（≤500 字）、disposition、outcome、任务号；签名、头、令牌一概不进。
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseA2aReceipt, teamRosterDeclared } from '../a2a.ts';
import { audiencesOf, bodyDigest, originOf, SIG_SKEW_MS } from '../a2a-direct-sig.ts';
import { claimQuestion, claimReceipt, claimSignatureOnce, inReceiptTx, knownPeerRoot, progressSteps, questionRecorded, receiptRecorded, sentTask, sentTaskForFollowup, untrustedReceiptCount, type SentTask } from '../services/a2a-receipts.ts';
import { followupOf, followupsOfDelivery, followupsOfPeerSince, recordFollowup } from '../services/a2a-followups.ts';
import { deliveryTarget, queueReply } from '../services/a2a-replies.ts';
import { kickWorkbenchEvents, logDeliveryFact } from '../workbench-events.ts';
import { noteA2aError } from './errors.ts';
import { deliveredPeerZone, recordRoster, type RosterSeat } from '../services/a2a-roster.ts';
import { peerCard } from './peer-card.ts';

export const ORIGIN_CLAIM_BODY_TAG = 'a2a-origin-claim/3';
export const RESULT_OUTCOMES = ['completed', 'failed', 'rejected', 'abandoned'] as const;
const UNTRUSTED_CAP = 20;
const CALLER_SHAPE = /^[a-z0-9-]+$/i;

export type ReceiptRefusal = 'no-peer-recorded' | 'absent' | 'not-body-bound' | 'bad-shape' | 'bad-ts' | 'wrong-audience' | 'wrong-signer' | 'wrong-origin' | 'body-mismatch' | 'no-card' | 'bad-sig' | 'replay';

type Req = IncomingMessage & { body?: unknown; originalUrl?: string; rawBody?: Buffer };

function header(req: IncomingMessage, n: string): string {
  const v = req.headers[n];
  return Array.isArray(v) ? '' : String(v ?? '');
}

function verifies(publicKey: string, canonical: string, sig: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return edVerify(undefined, Buffer.from(canonical, 'utf8'), key, Buffer.from(sig, 'base64'));
  } catch { return false; }
}

/** Sig3 签的那串：标签、签名方、来源、时间、受众、方法、路径、正文摘要 */
function sig3Canonical(req: Req, raw: Buffer): string {
  let path = '';
  try { path = new URL(String(req.originalUrl ?? req.url ?? ''), 'http://x').pathname; } catch { path = ''; }
  return JSON.stringify([ORIGIN_CLAIM_BODY_TAG, header(req, 'x-a2a-caller'), header(req, 'x-a2a-caller-url'), Number(header(req, 'x-a2a-caller-ts')), header(req, 'x-a2a-caller-aud'), String(req.method ?? '').toUpperCase(), path, bodyDigest(raw)]);
}

/**
 * 只看请求本身、不查库也不取卡的那几条：带 Sig3、签名方句柄与来源地址成形、时间戳在窗内、受众是我们、
 * 正文摘要等于实际收到的字节。来信分流先过这一关再按 context 查投递，挡掉不成形的请求、少一次查库。
 * 它不是身份防线——这些形状谁都造得出来。不让时序泄露「这个 context 投给过谁」的，是后面那条：
 * 取卡只看请求自己声称的来源、只对投递过的根地址取，而且照验签的样子取（先缓存、验不过强制重取），
 * 与查不查得到投递无关。之后的 verifyReceiptSigner 会把这些再核一遍。
 */
export function sig3Shaped(req: Req, raw: Buffer, audiences: string[], now = Date.now()): boolean {
  const sig3 = header(req, 'x-a2a-caller-sig3');
  const callerUrl = header(req, 'x-a2a-caller-url');
  const ts = Number(header(req, 'x-a2a-caller-ts'));
  if (sig3 === '' || !/^[A-Za-z0-9+/_=-]{16,256}$/.test(sig3)) return false;
  if (!CALLER_SHAPE.test(header(req, 'x-a2a-caller')) || originOf(callerUrl) === '') return false;
  if (!Number.isFinite(ts) || ts <= 0 || Math.abs(now - ts) > SIG_SKEW_MS) return false;
  if (!audiencesOf(req, audiences).has(originOf(header(req, 'x-a2a-caller-aud')))) return false;
  return header(req, 'x-a2a-body-sha256') === bodyDigest(raw);
}

/** 签名方是不是当初投递到的那台宿主 */
export async function verifyReceiptSigner(req: Req, raw: Buffer, sent: SentTask, audiences: string[], now = Date.now()): Promise<{ ok: true; publicKey: string } | { ok: false; reason: ReceiptRefusal; genuine?: boolean }> {
  if (sent.peer_zone === '' || sent.peer_root === '') return { ok: false, reason: 'no-peer-recorded' };
  const caller = header(req, 'x-a2a-caller');
  const callerUrl = header(req, 'x-a2a-caller-url');
  const ts = Number(header(req, 'x-a2a-caller-ts'));
  const audience = header(req, 'x-a2a-caller-aud');
  const sig2 = header(req, 'x-a2a-caller-sig2');
  const hasSig3 = req.headers['x-a2a-caller-sig3'] !== undefined;
  const sig3 = header(req, 'x-a2a-caller-sig3');
  // 回执会推进事项状态，只认绑定正文的签名（Sig3）：只带 Sig2 或更老形式的，换个正文就能复用，一律不采信
  if (!hasSig3) return { ok: false, reason: sig2 === '' && req.headers['x-a2a-caller-sig'] === undefined ? 'absent' : 'not-body-bound' };
  if (!CALLER_SHAPE.test(caller) || callerUrl === '' || !Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad-shape' };
  if (Math.abs(now - ts) > SIG_SKEW_MS) return { ok: false, reason: 'bad-ts' };
  if (!audiencesOf(req, audiences).has(originOf(audience))) return { ok: false, reason: 'wrong-audience' };
  if (caller !== sent.peer_zone) return { ok: false, reason: 'wrong-signer' };
  if (originOf(callerUrl) !== sent.peer_root) return { ok: false, reason: 'wrong-origin' };
  // 摘要必须等于实际收到的字节
  const digest = bodyDigest(raw);
  if (sig3 === '' || header(req, 'x-a2a-body-sha256') !== digest) return { ok: false, reason: 'body-mismatch' };
  const canonical = sig3Canonical(req, raw);
  const sig = sig3;
  let sawCard = false;
  for (const fresh of [false, true]) {
    const card = await peerCard(sent.peer_root, fresh, now);
    if (!card) continue;
    sawCard = true;
    if (card.team !== sent.peer_zone) return { ok: false, reason: 'wrong-signer' };
    if (verifies(card.publicKey, canonical, sig)) {
      // 已用记录落库（a2a_sig_seen），保留到时间窗结束之后（ts + 5 分钟 + 1 分钟余量），重启不丢
      const keepUntil = ts + SIG_SKEW_MS + 60_000;
      if (!claimSignatureOnce(sig, keepUntil, now)) return { ok: false, reason: 'replay', genuine: true };
      // 同一请求里出现的其它形式的签名（Sig2、v1 Sig）一并记为已用：防合法请求先到之后剥掉 Sig3 换正文重放
      for (const other of [sig2, header(req, 'x-a2a-caller-sig')]) if (other !== '') claimSignatureOnce(other, keepUntil, now);
      return { ok: true, publicKey: card.publicKey }; // 验过签的那把公钥：名册拿它的指纹当节点键
    }
  }
  return { ok: false, reason: sawCard ? 'bad-sig' : 'no-card' };
}

/**
 * 任务号 → 原始投递（节点侧契约 a2a-net docs/ops/superagent-market-team.md 第 3 节的字面规则）：
 *   回执头 `[A2A receipt] task <task>` 里的 <task> 是我们发出的任务号；入站 task_id 是 ack-<task>（接单回执，不结清）
 *   或 receipt-<task>（终局回执：提问或结果）；信封 idempotencyKey 等于 <task>（在调用方核）。
 *   提问 attention-<task>-<qid>（preview.13 起，qid 是 1～24 个 [A-Za-z0-9._:-]）：不结清原工单，同一任务可以有多个问题。
 *   进展 progress-<task>-<n>（n 从 1 起的整数）：不结清原工单、不推状态，只记录并更新「正在处理」的提示。
 * 不是我们发出的任务号返回 null（调用方照原路走）；入站任务号对不上字面规则的，slot 为 other（只记录，不采信）。
 */
export const QUESTION_ID = /^[A-Za-z0-9._:-]{1,24}$/;
export function receiptOrigin(headerTask: string, inboundTask: string): { sent: SentTask; slot: 'ack' | 'receipt' | 'question' | 'progress' | 'other'; qid?: string; n?: number } | null {
  const sent = sentTask(headerTask);
  if (!sent) return null;
  if (inboundTask === `ack-${headerTask}`) return { sent, slot: 'ack' };
  if (inboundTask === `receipt-${headerTask}`) return { sent, slot: 'receipt' };
  const prefix = `attention-${headerTask}-`;
  if (inboundTask.startsWith(prefix) && QUESTION_ID.test(inboundTask.slice(prefix.length))) return { sent, slot: 'question', qid: inboundTask.slice(prefix.length) };
  const step = inboundTask.startsWith(`progress-${headerTask}-`) ? inboundTask.slice(`progress-${headerTask}-`.length) : '';
  if (/^[1-9]\d{0,8}$/.test(step)) return { sent, slot: 'progress', n: Number(step) };
  return { sent, slot: 'other' };
}

/** 信封里的 question（只在 attention 上）：id 必须等于任务号里的问题 id、text 必填；按上游的上限截，坏的选项逐个丢 */
function questionOf(v: unknown, qid: string): { id: string; text: string; options?: string[]; default?: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  if (q.id !== qid || typeof q.text !== 'string') return null;
  const text = q.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 2000);
  if (text === '') return null;
  const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 6).map((o) => cleanSummary(o).slice(0, 200)) : [];
  const dflt = typeof q.default === 'string' ? cleanSummary(q.default).slice(0, 200) : '';
  return { id: qid, text, ...(options.length ? { options } : {}), ...(dflt ? { default: dflt } : {}) };
}

/** 进展的状态（上游 PROGRESS_STATES）；不认得的只记录 */
export const PROGRESS_STATES = ['queued', 'working', 'waiting', 'blocked'] as const;
/** 每个任务最多记这么多步进展（上游每分钟最多一步）；超出的照常应答、不记、计数 */
export const PROGRESS_PER_TASK = 200;
const TICKET_STATES = [...PROGRESS_STATES, 'ended'];

/** 信封里的 progress 与 tickets：n 必须等于任务号里的步号、state 认得；tickets 最多 16 个、坏的逐个丢 */
function progressOf(envelope: Record<string, unknown>, n: number): { summary: string; step: { n: number; state: string; summary: string; at: string; ahead?: number }; tickets?: { id: string; title: string; seat?: string; state: string; outcome?: string }[] } | null {
  const p = envelope.progress;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const r = p as Record<string, unknown>;
  if (r.n !== n || typeof r.state !== 'string' || !(PROGRESS_STATES as readonly string[]).includes(r.state)) return null;
  const summary = typeof r.summary === 'string' ? cleanSummary(r.summary) : '';
  const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at.slice(0, 40) : '';
  const ahead = typeof r.ahead === 'number' && Number.isSafeInteger(r.ahead) && r.ahead >= 0 ? r.ahead : undefined;
  const str = (x: unknown) => (typeof x === 'string' ? cleanSummary(x).slice(0, 200) : '');
  const tickets = Array.isArray(envelope.tickets)
    ? envelope.tickets.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t))
      .map((t) => ({ id: str(t.id), title: str(t.title), seat: str(t.seat), state: str(t.state), outcome: str(t.outcome) }))
      .filter((t) => t.id !== '' && TICKET_STATES.includes(t.state)).slice(0, 16)
      .map((t) => ({ id: t.id, title: t.title, ...(t.seat ? { seat: t.seat } : {}), state: t.state, ...(t.outcome ? { outcome: t.outcome } : {}) }))
    : undefined;
  return { summary, step: { n, state: r.state, summary, at, ...(ahead !== undefined ? { ahead } : {}) }, ...(tickets ? { tickets } : {}) };
}

/** 信封里的 by（谁做的）和 artifacts（产物编号）：只记录、只显示，不授予任何东西。坏的值逐个丢 */
function attributionOf(envelope: Record<string, unknown>): { by?: { seat: string; name?: string; team?: string; role?: 'router' | 'member' | 'observer' }; artifacts?: { kind: string; id: string }[] } {
  const str = (x: unknown) => (typeof x === 'string' ? cleanSummary(x).slice(0, 200) : '');
  const out: { by?: { seat: string; name?: string; team?: string; role?: 'router' | 'member' | 'observer' }; artifacts?: { kind: string; id: string }[] } = {};
  const b = envelope.by;
  if (b && typeof b === 'object' && !Array.isArray(b) && str((b as Record<string, unknown>).seat) !== '') {
    const r = b as Record<string, unknown>;
    // role（上游只增：router 总工 / member 成员 / observer 观察者），别的值丢掉
    out.by = { seat: str(r.seat), ...(str(r.name) ? { name: str(r.name) } : {}), ...(str(r.team) ? { team: str(r.team) } : {}), ...(r.role === 'router' || r.role === 'member' || r.role === 'observer' ? { role: r.role } : {}) };
  }
  if (Array.isArray(envelope.artifacts)) {
    const list = envelope.artifacts.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a))
      .map((a) => ({ kind: str(a.kind), id: str(a.id) })).filter((a) => a.kind !== '' && a.id !== '').slice(0, 16);
    if (list.length) out.artifacts = list;
  }
  return out;
}

/**
 * 回执的 JSON 信封（第二行）。自己解析：钉住的上游 0.6.25 的 parseReceipt 不认识 disposition（0.8 才有），会把它丢掉。
 * 只看第二行、最多 4 KiB、必须是对象；其余行一概不看。
 */
function envelopeOf(message: string): Record<string, unknown> {
  const nl = message.indexOf('\n');
  if (nl === -1) return {};
  const line = message.slice(nl + 1).split('\n', 1)[0] ?? '';
  if (line.length > 4096) return {};
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 回执头那一行里任务号之后的话（席位的回话），最多 4000 字 */
function replyTextOf(message: string, taskId: string, fallback: string): { text: string; truncated: boolean } {
  const first = message.split('\n', 1)[0] ?? '';
  const prefix = `[A2A receipt] task ${taskId}`;
  const raw = (first.startsWith(prefix) ? first.slice(prefix.length) : fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return { text: raw.slice(0, FOLLOWUP_TEXT_MAX), truncated: raw.length > FOLLOWUP_TEXT_MAX };
}

/** 摘要：去掉控制字符，最多 500 字 */
function cleanSummary(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
}

/**
 * /a2a/direct 的回执分支。不是我们认的回执返回 null（调用方照原路走）；认了的返回应答。
 */
export async function handleInboundReceipt(req: Req, deps: { audiences: () => string[]; now?: () => number; followupRate?: number }): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : '';
  if (message === '') return null;
  // 名片没声明 teamRoster 就不收名册（照普通来信走）：不声明就不该有人推
  if (message.startsWith('[A2A roster] ') && teamRosterDeclared()) return handleRoster(req, message, deps);
  const parsed = parseA2aReceipt(message);
  if (!parsed) return handleFollowup(req, body, message, deps);
  const origin = receiptOrigin(parsed.taskId, typeof body.task_id === 'string' ? body.task_id : '');
  if (!origin) return null;
  const { sent, slot, qid = '', n: stepN = 0 } = origin;
  // 去重格：提问按问题 id，进展按「#步号」（# 不在问题 id 的字符集里，两类不会撞）
  const stepKey = slot === 'question' ? qid : slot === 'progress' ? `#${stepN}` : '';
  const now = deps.now?.() ?? Date.now();
  const verdict = await verifyReceiptSigner(req, req.rawBody ?? Buffer.alloc(0), sent, deps.audiences(), now);
  const envelope = envelopeOf(message);
  const disposition = typeof envelope.disposition === 'string' ? envelope.disposition : '';
  if (!verdict.ok && verdict.reason === 'replay' && verdict.genuine === true && (stepKey !== '' ? questionRecorded(sent.task_id, stepKey) : receiptRecorded(sent.task_id, disposition === 'acknowledged' ? 'ack' : 'final'))) {
    // 同一条合法回执原样重发：签名是真的、这条回执已经记过——幂等返回，不重复推进
    noteA2aError('receipt:replay');
    return { status: 409, body: { error: 'duplicate receipt for this task', code: -32003, task_id: typeof body.task_id === 'string' ? body.task_id.slice(0, 128) : '', replay: true } };
  }
  if (!verdict.ok) {
    // 不进公开计数：计数一涨就说明这个任务号是我们发过的
    if (untrustedReceiptCount(sent.delivery_id) < UNTRUSTED_CAP) {
      inReceiptTx(() => logDeliveryFact(sent.event_id, sent.delivery_id, 'market', 'receipt:untrusted', { reason: verdict.reason, task: sent.task_id }));
    }
    return null;
  }
  const outcome = typeof envelope.outcome === 'string' ? envelope.outcome : '';
  // idempotencyKey 缺省时以回执头里的任务号为准；带了就必须是同一个任务号（不许借别的任务号的去重槽）
  const key = typeof envelope.idempotencyKey === 'string' ? envelope.idempotencyKey : parsed.taskId;
  let action: string;
  let cls: 'ack' | 'final' | 'question' = 'final';
  const question = slot === 'question' ? questionOf(envelope.question, qid) : null;
  const progress = slot === 'progress' ? progressOf(envelope, stepN) : null;
  if (key !== parsed.taskId) action = 'receipt:unaccepted';
  // 提问骑在 attention-<task>-<qid> 上：disposition 必须是 attention、信封带同一个问题 id 的 question；不占终局的槽
  else if (slot === 'question') { if (disposition === 'attention' && question) { action = 'receipt:attention'; cls = 'question'; } else action = 'receipt:unaccepted'; }
  // 进展骑在 progress-<task>-<n> 上：disposition=progress、progress.n 等于任务号里的步号、state 认得；不认得的只记录
  else if (slot === 'progress') { if (disposition === 'progress' && progress) { action = 'receipt:progress'; cls = 'question'; } else action = 'receipt:unaccepted'; }
  // 接单回执只能骑在 ack-<task> 上，终局回执（提问、结果）只能骑在 receipt-<task> 上；对不上的只记录
  else if (disposition === 'acknowledged' && slot === 'ack') { action = 'receipt:acknowledged'; cls = 'ack'; }
  else if (disposition === 'attention' && slot === 'receipt') action = 'receipt:attention';
  else if (disposition === 'result' && slot === 'receipt' && (RESULT_OUTCOMES as readonly string[]).includes(outcome)) action = `receipt:${outcome}`;
  else action = 'receipt:unaccepted';
  const summary = question ? cleanSummary(question.text) : progress ? progress.summary : cleanSummary(parsed.summary ?? '');
  const attribution = attributionOf(envelope);
  const inboundTask = typeof body.task_id === 'string' ? body.task_id.slice(0, 128) : '';
  if (action === 'receipt:unaccepted') {
    // 不采信的回执不占接单 / 终局的槽：之后真的回执照常认。只记录（每次投递最多 20 行），不改状态
    noteA2aError('receipt:unaccepted');
    if (untrustedReceiptCount(sent.delivery_id, 'receipt:unaccepted') < UNTRUSTED_CAP) {
      inReceiptTx(() => logDeliveryFact(sent.event_id, sent.delivery_id, `receiver:${sent.peer_zone}`, action, {
        summary, disposition: disposition.slice(0, 32), ...(outcome !== '' ? { outcome: outcome.slice(0, 32) } : {}), task: sent.task_id,
      }));
    }
    return { status: 200, body: { routed: true, delivered: true, team: typeof body.team === 'string' ? body.team.slice(0, 128) : '', task_id: inboundTask, context_id: typeof body.context_id === 'string' ? body.context_id.slice(0, 256) : '', task_status: 'TASK_STATE_DELIVERED', receipt: 'not-accepted' } };
  }
  if (action === 'receipt:progress' && !questionRecorded(sent.task_id, stepKey) && progressSteps(sent.task_id) >= PROGRESS_PER_TASK) {
    noteA2aError('progress:over-cap');
    return { status: 200, body: { routed: true, delivered: true, team: typeof body.team === 'string' ? body.team.slice(0, 128) : '', task_id: inboundTask, context_id: typeof body.context_id === 'string' ? body.context_id.slice(0, 256) : '', task_status: 'TASK_STATE_DELIVERED', receipt: 'over-cap' } };
  }
  const fresh = inReceiptTx(() => {
    if (cls === 'question' ? !claimQuestion(sent.task_id, stepKey, now) : !claimReceipt(sent.task_id, cls, disposition.slice(0, 32), outcome.slice(0, 32))) return false;
    logDeliveryFact(sent.event_id, sent.delivery_id, `receiver:${sent.peer_zone}`, action, {
      summary, disposition: disposition.slice(0, 32), ...(outcome !== '' ? { outcome: outcome.slice(0, 32) } : {}), task: sent.task_id,
      ...(question ? { qid, question } : {}), ...(progress ? { progress: progress.step, ...(progress.tickets ? { tickets: progress.tickets } : {}) } : {}), ...attribution,
    });
    // 答复 / 回复类任务（人发出的消息）：席位的结果回执就是它的回话，正文落成事项对话里的一条未读席位消息。
    // 状态仍按映射表走（上面那一行事件日志）；这里只多存一份正文给人看，不回执（它本身就是回执）
    if (sent.kind === 'answer' && cls === 'final' && disposition === 'result') {
      const reply = replyTextOf(message, parsed.taskId, parsed.summary ?? '');
      recordFollowup({ eventId: sent.event_id, deliveryId: sent.delivery_id, peerZone: sent.peer_zone, inboundTask, contextId: typeof body.context_id === 'string' ? body.context_id.slice(0, 256) : '',
        sender: attribution.by?.name || attribution.by?.seat || (typeof body.caller_session === 'string' ? body.caller_session.slice(0, 200) : '') || sent.peer_zone,
        text: reply.text, truncated: reply.truncated, status: 'open', now });
    }
    return true;
  });
  if (!fresh) {
    noteA2aError('receipt:replay');
    return { status: 409, body: { error: 'duplicate receipt for this task', code: -32003, task_id: inboundTask, replay: true } };
  }
  return {
    status: 200,
    body: { routed: true, delivered: true, team: typeof body.team === 'string' ? body.team.slice(0, 128) : '', task_id: inboundTask, context_id: typeof body.context_id === 'string' ? body.context_id.slice(0, 256) : '', task_status: 'TASK_STATE_DELIVERED', receipt: 'recorded' },
  };
}

/** 跟进正文最多留这么多字（超长截断并标记）；每次投递最多这么多条算未读 */
export const FOLLOWUP_TEXT_MAX = 4000;
export const FOLLOWUP_PER_DELIVERY = 50;
/** 每个对端 10 分钟内存正文的跟进条数上限，缺省 300；可配（WM_A2A_FOLLOWUP_RATE_10MIN） */
export const FOLLOWUP_RATE_DEFAULT = 300;

/** 限频阈值；不设为 300，只收 1～100000 的整数，否则返回 null（调用方拒绝启动） */
export function followupRateLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.WM_A2A_FOLLOWUP_RATE_10MIN ?? '');
  if (raw === '') return FOLLOWUP_RATE_DEFAULT;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 100_000 ? n : null;
}

/**
 * 阶段七 R2：席位发来的跟进（同 context 的普通 A2A 任务，任务号 a2a-…；过渡期里成员的提问和通知都这样来）。
 * 在准入之前收，三条都成立才收：正文不是回执、context 是我们发出的（我们某个事件的 context；存量按 context 等于原任务号）、
 * 签名方就是那次投递的宿主（同回执：只认 Sig3、callerUrl 源等于投递根地址、验过的签名只认一次）。任何一条不成立返回 null，照原路走。
 * 收下后只做三件事：记进事项（事件日志一行 followup，事项只记录不改状态）、落成事项对话里的一条未读席位消息
 * （不进「关注」；人在事项页看、回复）、排一条结清它的回执（只用跟进的任务号）。绝不触发执行、派发或状态迁移。
 * 正文截到 4000 字并标记；每次投递超过 50 条的照存、但不算未读（over-cap）并计数；同一对端 10 分钟超过限频（缺省 300）的
 * 不存正文、只计数并记一行 rate-limited。两种都照常回执：对端是验过签名的宿主，每条跟进都欠着一条回执、出站槽只有几个，
 * 不回执会把它的出站占死，后面的回执和提问都发不出来。验签不过、context 不是我们的仍然不收不回执（那不是我们欠的）。
 * 同一条（对方的任务号）只收一次。
 */
async function handleFollowup(req: Req, body: Record<string, unknown>, message: string, deps: { audiences: () => string[]; now?: () => number; followupRate?: number }): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const contextId = typeof body.context_id === 'string' ? body.context_id : '';
  const inboundTask = typeof body.task_id === 'string' ? body.task_id : '';
  const zone = header(req, 'x-a2a-caller');
  if (contextId === '' || contextId.length > 256 || inboundTask === '' || inboundTask.length > 128 || zone === '') return null;
  const now = deps.now?.() ?? Date.now();
  // 先验格式再查库：签名字段不齐、不成形的，不按 context 查投递，直接照原路走
  const raw = req.rawBody ?? Buffer.alloc(0);
  if (!sig3Shaped(req, raw, deps.audiences(), now)) return null;
  // 取卡挪到查库之前、按请求自己声称的来源做：声称的来源是我们投递过的对端，就照验签的样子取一次（缓存、验不过再强制重取，受冷却约束）。
  // 这样对外的网络行为只取决于请求自己声称了什么，不取决于这个 context 投没投给过它；后面真正验签时名片已在缓存、重取在冷却里，不再出网
  const claimedRoot = originOf(header(req, 'x-a2a-caller-url'));
  if (knownPeerRoot(claimedRoot)) {
    const card = await peerCard(claimedRoot, false, now);
    if (!card || !verifies(card.publicKey, sig3Canonical(req, raw), header(req, 'x-a2a-caller-sig3'))) await peerCard(claimedRoot, true, now);
  }
  const sent = sentTaskForFollowup(contextId, zone);
  if (!sent) return null;
  const verdict = await verifyReceiptSigner(req, req.rawBody ?? Buffer.alloc(0), sent, deps.audiences(), now);
  const reply = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { routed: true, delivered: true, team: typeof body.team === 'string' ? body.team.slice(0, 128) : '', task_id: inboundTask, context_id: contextId, task_status: 'TASK_STATE_DELIVERED', followup: 'recorded', ...extra } });
  if (!verdict.ok) {
    // 同一条跟进原样重发：签名是真的、已经收过——照样回已收，不重复记、不重复回执
    if (verdict.reason === 'replay' && verdict.genuine === true && followupOf(sent.delivery_id, inboundTask)) return reply();
    return null;
  }
  if (followupOf(sent.delivery_id, inboundTask)) return reply();
  const limited = followupsOfPeerSince(sent.peer_zone, now - 10 * 60_000) >= (deps.followupRate ?? FOLLOWUP_RATE_DEFAULT);
  const truncated = !limited && message.length > FOLLOWUP_TEXT_MAX;
  const text = limited ? '' : message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, FOLLOWUP_TEXT_MAX);
  const overCap = !limited && followupsOfDelivery(sent.delivery_id) >= FOLLOWUP_PER_DELIVERY;
  const status = limited ? 'rate-limited' : overCap ? 'over-cap' : 'open';
  const sender = typeof body.caller_session === 'string' && body.caller_session !== '' ? body.caller_session.slice(0, 200) : '';
  const target = deliveryTarget(sent.delivery_id);
  inReceiptTx(() => {
    const id = recordFollowup({ eventId: sent.event_id, deliveryId: sent.delivery_id, peerZone: sent.peer_zone, inboundTask, contextId, sender, text, truncated, status, now });
    if (id === null) return;
    logDeliveryFact(sent.event_id, sent.delivery_id, `receiver:${sent.peer_zone}`, limited ? 'followup-rate-limited' : 'followup', limited
      ? { inbound: inboundTask, followup: id }
      : { text: text.slice(0, 500), inbound: inboundTask, followup: id, ...(truncated ? { truncated: true } : {}), ...(overCap ? { over_cap: true } : {}) });
    // 结清这条跟进：回执发给发来跟进的那一方（它的会话），任务号只用跟进的
    queueReply({ kind: 'followup-receipt', eventId: sent.event_id, deliveryId: sent.delivery_id, ref: id, qid: inboundTask, fixedTask: `receipt-${inboundTask}`,
      team: sender || (target?.team ?? ''), callerSession: typeof body.team === 'string' && body.team !== '' ? body.team.slice(0, 128) : (target?.caller_session ?? ''),
      contextId, targetUrl: sent.peer_root, message: '', now });
  });
  if (overCap) noteA2aError('followup:over-cap');
  if (limited) noteA2aError('followup:rate-limited');
  kickWorkbenchEvents();
  return reply(overCap ? { over_cap: true } : limited ? { rate_limited: true } : {});
}

/** 名册里每台宿主最多收这么多席位、正文最多这么长 */
export const ROSTER_SEATS_MAX = 64;
const ROSTER_TEXT_MAX = 64 * 1024;

/**
 * 阶段七：团队名册入站（dsh-open-a2a-net#604 P3）。普通 direct 消息，不欠回执、不占槽：
 *   首行 `[A2A roster] <宿主指纹前 8 位> <ISO 时间>`，第二行 JSON { host, at, seats:[{ seat, name, team, role, online, active, queued, lastActiveAt }] }。
 * 三条都成立才收，否则返回 null 照原路走：
 *   · 签名方是我们投递过的宿主：声称的来源是投递过的根地址，X-A2A-Caller 等于投递时记下的区；Sig3 必验（同回执，验过的签名只认一次）；
 *   · 首行的指纹和 JSON 的 host 对得上、时间合法；
 *   · 席位只认这台宿主自己区里的：seat 是 <区>/<8 hex>、team 是 <区>/canvas/<名>，区都等于签名方的区；别的逐个丢。
 * 名册只当信息（团队页、把句柄显示成名字、在岗数），不授予任何东西；同一台宿主以新替旧（按它报的时间），旧的、重复的回 stale。
 */
async function handleRoster(req: Req, message: string, deps: { audiences: () => string[]; now?: () => number }): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (message.length > ROSTER_TEXT_MAX) return null;
  const nl = message.indexOf('\n');
  const head = /^\[A2A roster\] ([0-9a-f]{8}) (\S{10,40})$/.exec(nl < 0 ? message : message.slice(0, nl));
  if (!head) return null;
  const root = originOf(header(req, 'x-a2a-caller-url'));
  const zone = deliveredPeerZone(root);
  if (!zone) return null;
  const now = deps.now?.() ?? Date.now();
  const verdict = await verifyReceiptSigner(req, req.rawBody ?? Buffer.alloc(0), { task_id: '', kind: 'delivery', event_id: '', delivery_id: 0, peer_root: root, peer_zone: zone }, deps.audiences(), now);
  if (!verdict.ok) return null;
  let doc: Record<string, unknown> = {};
  try { const o = JSON.parse(message.slice(nl + 1).split('\n', 1)[0] ?? ''); if (o && typeof o === 'object' && !Array.isArray(o)) doc = o as Record<string, unknown>; } catch { /* 坏的当空 */ }
  // 节点键取自验过签的那把公钥：上游的 host 就是节点公钥的 canvasOwnerFingerprint（sha256 前 8 位十六进制）。
  // 正文里的 host、首行的指纹都只拿来核对，对不上就不收——别的宿主用自己的签名报不了这台宿主的名册。
  const signerFp = createHash('sha256').update(Buffer.from(verdict.publicKey, 'base64')).digest('hex').slice(0, 8);
  // 名册的键全系统只有一种写法：节点、席位句柄、团队的区和 canvas 段都转小写再比、再存（画布名原样留着）
  const host = typeof doc.host === 'string' ? doc.host.slice(0, 128).toLowerCase() : '';
  const lzone = zone.toLowerCase();
  const teamKey = (t: string) => { const m = /^([a-z0-9-]+)\/canvas\/([^/]+)$/i.exec(t); return m ? `${m[1].toLowerCase()}/canvas/${m[2]}` : t; };
  const at = typeof doc.at === 'string' && !Number.isNaN(Date.parse(doc.at)) ? new Date(Date.parse(doc.at)).toISOString() : '';
  // 报的时间不能晚于收到时间加签名时间窗：写一个远在将来的时间，会让这台宿主之后正常报的名册全判成过期
  if (host !== signerFp || head[1] !== signerFp || at === '' || Date.parse(at) > now + SIG_SKEW_MS) return { status: 200, body: { routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', roster: 'not-accepted' } };
  const str = (x: unknown, n = 200) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
  const int = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);
  const seats: RosterSeat[] = (Array.isArray(doc.seats) ? doc.seats : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map((x) => ({ seat: str(x.seat, 64).toLowerCase(), seat_id: /^[A-Za-z0-9._:-]{1,64}$/.test(String(x.seatId ?? '')) ? String(x.seatId) : '', name: str(x.name), team: teamKey(str(x.team, 128)), role: (['router', 'member', 'observer'].includes(String(x.role)) ? x.role : '') as RosterSeat['role'],
      online: x.online === true, queued: int(x.queued), last_active_at: typeof x.lastActiveAt === 'string' && !Number.isNaN(Date.parse(x.lastActiveAt)) ? new Date(Date.parse(x.lastActiveAt)).toISOString() : '' }))
    .filter((x) => /^[a-z0-9-]+\/[0-9a-f]{8}$/.test(x.seat) && x.seat.split('/')[0] === lzone && (x.team === '' || (x.team.split('/')[0] === lzone && /^[a-z0-9-]+\/canvas\/[^/]+$/.test(x.team))))
    .slice(0, ROSTER_SEATS_MAX);
  const outcome = recordRoster({ host, peerRoot: root, peerZone: lzone, reportedAt: at, seats, now });
  return { status: 200, body: { routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED', roster: outcome, seats: seats.length } };
}
