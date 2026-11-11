/**
 * 阶段七 R3：A2A 终态回执入站（superagent 的 A2A Source 回发的就是这种回执）。
 *
 * 窄分流：在 /a2a/direct 原有的签名校验和准入之前判一次，只有三条同时成立才走这里——
 *   1. 正文能解析成回执（`[A2A receipt] task <id> …`，上游 parseReceipt）；
 *   2. <id> 是我们发出的任务号（a2a_sent_tasks 里有）；
 *   3. 签名方就是当初投递到的那台宿主：OriginClaim 的 caller 等于发出那一刻记下的名片 team，callerUrl 的源等于投递的根地址，
 *      用那个根地址上的名片验签；带了 Sig3（body 绑定）就必须验 Sig3，不降级到 Sig2；验过的签名只认一次。
 * 任何一条不成立都返回 null，调用方照原路处理，应答与今天逐字节相同。前两条成立、第三条不成立的，在事件日志里记一行
 * 「收到未采信」（每次投递最多 20 行），不改状态。caller_session（对方的 CLI 句柄）不参与比对。
 *
 * 采信的回执写一行事件日志，事项服务照 8b 的路径推进（映射在 services/work-item.ts 的 factFromEventLog）：
 *   acknowledged → receipt:acknowledged；attention → receipt:attention（摘要即问题）；
 *   result + outcome ∈ completed / failed / rejected / abandoned → receipt:<outcome>；其余 → receipt:unaccepted（只记录）。
 * 同一任务号的接单回执、终局回执各认一次（idempotencyKey 去重），重复的回 409 -32003 replay。
 * 日志里只放摘要（≤500 字）、disposition、outcome、任务号；签名、头、令牌一概不进。
 */
import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { parseA2aReceipt } from '../a2a.ts';
import { audiencesOf, bodyDigest, originOf, SIG_SKEW_MS } from '../a2a-direct-sig.ts';
import { claimReceipt, claimSignatureOnce, inReceiptTx, sentTask, untrustedReceiptCount, type SentTask } from '../services/a2a-receipts.ts';
import { logDeliveryFact } from '../workbench-events.ts';
import { noteA2aError } from './errors.ts';
import { peerCard } from './peer-card.ts';

export const ORIGIN_CLAIM_BOUND_TAG = 'a2a-origin-claim/2';
export const ORIGIN_CLAIM_BODY_TAG = 'a2a-origin-claim/3';
export const RESULT_OUTCOMES = ['completed', 'failed', 'rejected', 'abandoned'] as const;
const UNTRUSTED_CAP = 20;
const CALLER_SHAPE = /^[a-z0-9-]+$/i;

export type ReceiptRefusal = 'no-peer-recorded' | 'absent' | 'bad-shape' | 'bad-ts' | 'wrong-audience' | 'wrong-signer' | 'wrong-origin' | 'body-mismatch' | 'no-card' | 'bad-sig' | 'replay';

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

/** 签名方是不是当初投递到的那台宿主 */
export async function verifyReceiptSigner(req: Req, raw: Buffer, sent: SentTask, audiences: string[], now = Date.now()): Promise<{ ok: true } | { ok: false; reason: ReceiptRefusal }> {
  if (sent.peer_zone === '' || sent.peer_root === '') return { ok: false, reason: 'no-peer-recorded' };
  const caller = header(req, 'x-a2a-caller');
  const callerUrl = header(req, 'x-a2a-caller-url');
  const ts = Number(header(req, 'x-a2a-caller-ts'));
  const audience = header(req, 'x-a2a-caller-aud');
  const sig2 = header(req, 'x-a2a-caller-sig2');
  const hasSig3 = req.headers['x-a2a-caller-sig3'] !== undefined;
  const sig3 = header(req, 'x-a2a-caller-sig3');
  if (sig2 === '' && !hasSig3) return { ok: false, reason: 'absent' };
  if (!CALLER_SHAPE.test(caller) || callerUrl === '' || !Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad-shape' };
  if (Math.abs(now - ts) > SIG_SKEW_MS) return { ok: false, reason: 'bad-ts' };
  if (!audiencesOf(req, audiences).has(originOf(audience))) return { ok: false, reason: 'wrong-audience' };
  if (caller !== sent.peer_zone) return { ok: false, reason: 'wrong-signer' };
  if (originOf(callerUrl) !== sent.peer_root) return { ok: false, reason: 'wrong-origin' };
  const method = String(req.method ?? '').toUpperCase();
  let path = '';
  try { path = new URL(String(req.originalUrl ?? req.url ?? ''), 'http://x').pathname; } catch { path = ''; }
  let canonical: string;
  let sig: string;
  if (hasSig3) {
    // 带了 body 绑定签名就只认它：摘要必须等于实际收到的字节
    const digest = bodyDigest(raw);
    if (sig3 === '' || header(req, 'x-a2a-body-sha256') !== digest) return { ok: false, reason: 'body-mismatch' };
    canonical = JSON.stringify([ORIGIN_CLAIM_BODY_TAG, caller, callerUrl, ts, audience, method, path, digest]);
    sig = sig3;
  } else {
    canonical = JSON.stringify([ORIGIN_CLAIM_BOUND_TAG, caller, callerUrl, ts, audience, method, path]);
    sig = sig2;
  }
  let sawCard = false;
  for (const fresh of [false, true]) {
    const card = await peerCard(sent.peer_root, fresh, now);
    if (!card) continue;
    sawCard = true;
    if (card.team !== sent.peer_zone) return { ok: false, reason: 'wrong-signer' };
    if (verifies(card.publicKey, canonical, sig)) {
      if (!claimSignatureOnce(sig, ts + SIG_SKEW_MS + 60_000, now)) return { ok: false, reason: 'replay' };
      return { ok: true };
    }
  }
  return { ok: false, reason: sawCard ? 'bad-sig' : 'no-card' };
}

/**
 * 回执的 JSON 信封（第二行）。自己解析：钉住的上游 0.6.25 的 parseReceipt 不认识 disposition（0.8 才有），会把它丢掉。
 * 只看第二行、最多 4 KiB、必须是对象；其余行一概不看。
 */
function envelopeOf(message: string): { disposition?: unknown; outcome?: unknown; idempotencyKey?: unknown } {
  const nl = message.indexOf('\n');
  if (nl === -1) return {};
  const line = message.slice(nl + 1).split('\n', 1)[0] ?? '';
  if (line.length > 4096) return {};
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 摘要：去掉控制字符，最多 500 字 */
function cleanSummary(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
}

/**
 * /a2a/direct 的回执分支。不是我们认的回执返回 null（调用方照原路走）；认了的返回应答。
 */
export async function handleInboundReceipt(req: Req, deps: { audiences: () => string[]; now?: () => number }): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : '';
  if (message === '') return null;
  const parsed = parseA2aReceipt(message);
  if (!parsed) return null;
  const sent = sentTask(parsed.taskId);
  if (!sent) return null;
  const now = deps.now?.() ?? Date.now();
  const verdict = await verifyReceiptSigner(req, req.rawBody ?? Buffer.alloc(0), sent, deps.audiences(), now);
  const envelope = envelopeOf(message);
  const disposition = typeof envelope.disposition === 'string' ? envelope.disposition : '';
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
  let cls: 'ack' | 'final' = 'final';
  if (key !== parsed.taskId) action = 'receipt:unaccepted';
  else if (disposition === 'acknowledged') { action = 'receipt:acknowledged'; cls = 'ack'; }
  else if (disposition === 'attention') action = 'receipt:attention';
  else if (disposition === 'result' && (RESULT_OUTCOMES as readonly string[]).includes(outcome)) action = `receipt:${outcome}`;
  else action = 'receipt:unaccepted';
  const summary = cleanSummary(parsed.summary ?? '');
  const fresh = inReceiptTx(() => {
    if (!claimReceipt(sent.task_id, cls, disposition.slice(0, 32), outcome.slice(0, 32))) return false;
    logDeliveryFact(sent.event_id, sent.delivery_id, `receiver:${sent.peer_zone}`, action, {
      summary, disposition: disposition.slice(0, 32), ...(outcome !== '' ? { outcome: outcome.slice(0, 32) } : {}), task: sent.task_id,
    });
    return true;
  });
  const inboundTask = typeof body.task_id === 'string' ? body.task_id.slice(0, 128) : '';
  if (!fresh) {
    noteA2aError('receipt:replay');
    return { status: 409, body: { error: 'duplicate receipt for this task', code: -32003, task_id: inboundTask, replay: true } };
  }
  if (action === 'receipt:unaccepted') noteA2aError('receipt:unaccepted');
  return {
    status: 200,
    body: { routed: true, delivered: true, team: typeof body.team === 'string' ? body.team.slice(0, 128) : '', task_id: inboundTask, context_id: typeof body.context_id === 'string' ? body.context_id.slice(0, 256) : '', task_status: 'TASK_STATE_DELIVERED', receipt: 'recorded' },
  };
}
