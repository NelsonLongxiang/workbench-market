/**
 * 阶段七 R2：市场回给团队的消息——在事件投递的同一个 worker 里发，复用 a2aSendOutbound（OriginClaim Sig2 + Sig3）、退避常量与终止码。
 *   answer / followup-reply：人的答复作为同一 context 的新任务发回那个团队（superagent：答复是同 context 的新任务，回执里的正文它不读）。
 *     每次尝试一个任务号 <event>.d<投递>.q<行>.a<尝试>，发出前登记进 a2a_sent_tasks（kind=answer，记下对端），对方对它的回执照 R3 回到同一事项。
 *   followup-receipt：收下跟进后结清它的回执。任务号固定为 receipt-<跟进任务号>——只用跟进的任务号，绝不用原任务号（那会被当成结清原工单）；
 *     信封 {"outcome":"completed","idempotencyKey":"<跟进任务号>","disposition":"result"}，正文一行「已转给人」。对方节点上未结清的跟进
 *     会占它的出站排队槽，所以发不出去一直重试（退避封顶 1 小时，不判 dead），并在事件日志与健康块里计数。
 */
import { a2aKeyPath, a2aSendOutbound } from '../a2a.ts';
import { noteBlocked, outboundOff } from '../outbound-gate.ts';
import { dueReplies, inReplyTx, markReply, retryReply, type ReplyRow } from '../services/a2a-replies.ts';
import { recordSentTask } from '../services/a2a-receipts.ts';
import { BACKOFF_MS, MAX_ATTEMPTS, TERMINAL_CODES, backoffScale, logDeliveryFact } from '../workbench-events.ts';
import { peerCard, peerRoot } from './peer-card.ts';

export const ANSWER_ENVELOPE_VERSION = 2;

/** 发给团队的答复信封（06：kind=answer；对方把正文当数据，按 context 归到同一线程） */
export function answerEnvelope(row: Pick<ReplyRow, 'event_id' | 'context_id' | 'qid'>, answer: { text: string; by: string }): string {
  return JSON.stringify({ type: 'workbench-event', v: ANSWER_ENVELOPE_VERSION, kind: 'answer', event_id: row.event_id, context_id: row.context_id, answer: { qid: row.qid, text: answer.text, by: answer.by } });
}

/** 结清一条跟进的回执正文：只用跟进的任务号 */
export function followupReceiptText(followupTask: string): string {
  return `[A2A receipt] task ${followupTask} 已转给人\n${JSON.stringify({ outcome: 'completed', idempotencyKey: followupTask, disposition: 'result' })}`;
}

async function sendOne(row: ReplyRow, now: () => number): Promise<void> {
  const attempt = row.attempts + 1;
  const isReceipt = row.kind === 'followup-receipt';
  const taskId = isReceipt ? row.fixed_task : `${row.event_id}.d${row.delivery_id}.q${row.id}.a${attempt}`;
  let message = '';
  if (isReceipt) message = followupReceiptText(row.qid);
  else {
    let answer: { text: string; by: string } = { text: '', by: '' };
    try { answer = JSON.parse(row.message); } catch { /* 坏行按空答复，下面判 dead */ }
    if (answer.text === '') {
      inReplyTx(() => { markReply(row.id, 'dead', attempt, 'empty answer', now()); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'reply-dead', { reply: row.id, kind: row.kind, error: 'empty answer' }); });
      return;
    }
    message = answerEnvelope(row, answer);
    const peer = await peerCard(row.target_url).catch(() => null);
    recordSentTask({ taskId, kind: 'answer', eventId: row.event_id, deliveryId: row.delivery_id, peerRoot: peerRoot(row.target_url), peerZone: peer?.team ?? '' });
  }
  let out: { ok?: boolean; code?: number; error?: string; replay?: boolean } | undefined;
  try {
    out = await a2aSendOutbound(a2aKeyPath(), { baseUrl: row.target_url, team: row.team }, message, row.context_id, row.caller_session, { taskId, async: true }) as typeof out;
  } catch (e) {
    out = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  // 固定任务号的回执重发时，对方幂等登记回 -32003 replay：说明上一次已经送到
  const delivered = out?.ok === true || (isReceipt && out?.code === -32003);
  if (delivered) {
    inReplyTx(() => { markReply(row.id, 'sent', attempt, '', now()); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'reply-sent', { reply: row.id, kind: row.kind, task: taskId }); });
    return;
  }
  const error = String(out?.error ?? 'unknown failure').slice(0, 300);
  if (!isReceipt && ((typeof out?.code === 'number' && TERMINAL_CODES.has(out.code)) || attempt >= MAX_ATTEMPTS)) {
    inReplyTx(() => { markReply(row.id, 'dead', attempt, error, now()); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'reply-dead', { reply: row.id, kind: row.kind, error }); });
    return;
  }
  const delay = (BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 3_600_000) * backoffScale();
  inReplyTx(() => { retryReply(row.id, attempt, now() + delay, error); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'reply-retry', { reply: row.id, kind: row.kind, attempts: attempt, error }); });
}

/** 发到期的（事件投递 worker 每轮调一次） */
export async function replyTick(now: () => number = Date.now): Promise<void> {
  // 对外断开（WM_OUTBOUND=off）：不发、不加 attempts、不判死（事件投递 worker 关着时本来就不调这里；这里再挡一道，免得以后别处直接调）
  if (outboundOff()) { noteBlocked('reply-outbound'); return; }
  for (const row of dueReplies(20, now())) {
    try { await sendOne(row, now); } catch (e) { console.error(`[a2a-replies] ${row.kind} ${row.id} 发送出错：${String(e).slice(0, 120)}`); }
  }
}
