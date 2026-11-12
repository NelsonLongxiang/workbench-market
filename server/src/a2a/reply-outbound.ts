/**
 * 阶段七 R2：市场回给团队的消息——在事件投递的同一个 worker 里发，复用 a2aSendOutbound（OriginClaim Sig2 + Sig3）、退避常量与终止码。
 *   answer / followup-reply：人的答复（以及打回重做：消息里带 return）作为同一 context 的新任务发回那个团队（superagent：答复是同 context 的新任务，回执里的正文它不读）。
 *     每次尝试一个任务号 <event>.d<投递>.q<行>.a<尝试>，发出前登记进 a2a_sent_tasks（kind=answer，记下对端），对方对它的回执照 R3 回到同一事项。
 *   followup-receipt：收下跟进后结清它的回执。任务号固定为 receipt-<跟进任务号>——只用跟进的任务号，绝不用原任务号（那会被当成结清原工单）；
 *     信封 {"outcome":"completed","idempotencyKey":"<跟进任务号>","disposition":"result"}，正文一行「已转给人」。对方节点上未结清的跟进
 *     会占它的出站排队槽，所以发不出去一直重试（退避封顶 1 小时，不判 dead），并在事件日志与健康块里计数。
 */
import { a2aKeyPath, a2aSendOutbound } from '../a2a.ts';
import { noteBlocked, outboundOff } from '../outbound-gate.ts';
import { deliveryStatusOf, dueReplies, inReplyTx, markReply, noticeTaskId, retryReply, type ReplyRow } from '../services/a2a-replies.ts';
import { recordSentTask } from '../services/a2a-receipts.ts';
import { BACKOFF_MS, MAX_ATTEMPTS, TERMINAL_CODES, backoffScale, logDeliveryFact } from '../workbench-events.ts';
import { peerCard, peerRoot } from './peer-card.ts';
import { peerDeclares } from '../services/a2a-peers.ts';

export const ANSWER_ENVELOPE_VERSION = 2;

/** 发给团队的答复信封（06：kind=answer；对方把正文当数据，按 context 归到同一线程） */
export function answerEnvelope(row: Pick<ReplyRow, 'event_id' | 'context_id' | 'qid'>, answer: { text: string; by: string }): string {
  return JSON.stringify({ type: 'workbench-event', v: ANSWER_ENVELOPE_VERSION, kind: 'answer', event_id: row.event_id, context_id: row.context_id, answer: { qid: row.qid, text: answer.text, by: answer.by } });
}

/**
 * 打回重做的正文（上游 dsh-open-a2a-net#627 N1、N5）：
 *   第一行签名派工行 `[A2A dispatch] {"rework":{"of":"<原任务号>"}}`——宿主认它（Sig3 + 钉住公钥的远端成员 + 名片声明 reworkReturns）
 *     就不经总工、直接开一张新工单「打回重做：<原单标题>」，交给上次做原单的成员；范围是去掉派工行之后的正文。
 *   第二行给人和总工看的「[打回重做] 原事项《标题》（原任务 <task>）：理由」——不认派工行的宿主把整段当普通请求，总工照这一行判。
 * 理由和标题都压成一行：人写的字只能落在第二行，拼不出派工行、回执头或第三行。
 * 不再带市场自己的 JSON 信封：宿主把派工行之后的正文整段当范围，信封只会混进范围里。
 */
export function returnMessage(r: { text: string; return: { of: string; title: string } }, opts: { dispatchLine?: boolean } = {}): string {
  const line = `[打回重做] 原事项《${String(r.return.title).replace(/\s+/g, ' ').slice(0, 200)}》（原任务 ${r.return.of}）：${r.text.replace(/\s+/g, ' ')}`;
  // 对端宿主名片没声明 reworkReturns：不写派工行，只发「[打回重做]…」这一行（总工照旧按正文判，和派工行出现之前一样）
  if (opts.dispatchLine === false) return line;
  const dispatch = `[A2A dispatch] ${JSON.stringify({ rework: { of: r.return.of } })}`;
  return `${dispatch}\n${line}`;
}

/**
 * 变更通知的正文（目前只有改截止日期）：一行字，同一 context 的新任务发给接了这件事的团队。
 * 人写的字（标题）压成一行：拼不出派工行、回执头或第二行
 */
export function noticeMessage(text: string): string {
  return String(text).replace(/\s+/g, ' ').slice(0, 600);
}

/** 变更通知要等它对应的那次投递发出去了再发（对方先收到派工、再收到变更）；投递还在等过目或排队时隔这么久再看 */
export const NOTICE_WAIT_MS = 30_000;

/** 结清一条跟进的回执正文：只用跟进的任务号 */
export function followupReceiptText(followupTask: string): string {
  return `[A2A receipt] task ${followupTask} 已转给人\n${JSON.stringify({ outcome: 'completed', idempotencyKey: followupTask, disposition: 'result' })}`;
}

async function sendOne(row: ReplyRow, now: () => number): Promise<void> {
  const attempt = row.attempts + 1;
  const isReceipt = row.kind === 'followup-receipt';
  let isNotice = false;
  try { isNotice = !isReceipt && typeof (JSON.parse(row.message) as { notice?: unknown }).notice === 'string'; } catch { /* 坏行下面判 dead */ }
  // 通知（截止变更）用 .n 任务号：收回执时认得出是通知，只记录、不推状态
  const taskId = isReceipt ? row.fixed_task : isNotice ? noticeTaskId(row.event_id, row.delivery_id, row.id, attempt) : `${row.event_id}.d${row.delivery_id}.q${row.id}.a${attempt}`;
  let message = '';
  if (isReceipt) message = followupReceiptText(row.qid);
  else {
    let answer: { text: string; by: string; return?: { of: string; title: string }; notice?: string } = { text: '', by: '' };
    try { answer = JSON.parse(row.message); } catch { /* 坏行按空答复，下面判 dead */ }
    if (answer.text === '') {
      inReplyTx(() => { markReply(row.id, 'dead', attempt, 'empty answer', now()); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'reply-dead', { reply: row.id, kind: row.kind, error: 'empty answer' }); });
      return;
    }
    // 变更通知（改截止日期）：等那次投递发出去了再发；投递撤回、判死了就不发（对方没收到派工，也就不用知道变更）
    if (typeof answer.notice === 'string') {
      const st = deliveryStatusOf(row.delivery_id);
      if (st === 'held' || st === 'pending') { retryReply(row.id, row.attempts, now() + NOTICE_WAIT_MS, 'waiting_for_delivery'); return; }
      if (st !== 'sent') {
        inReplyTx(() => { markReply(row.id, 'dead', attempt, 'delivery_not_sent', now()); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'reply-dead', { reply: row.id, kind: row.kind, error: 'delivery_not_sent' }); });
        return;
      }
    }
    // 打回重做和答复走同一条路（同 context 的新任务），正文不同
    if (typeof answer.notice === 'string') message = noticeMessage(answer.text);
    else if (answer.return && typeof answer.return.of === 'string') {
      // 派工行只写给名片（登记表里钉住的那份）声明了 reworkReturns 的对端；没声明退回旧写法，第一次发时在事件日志留痕
      const declared = peerDeclares(row.target_url, 'reworkReturns');
      if (!declared && row.attempts === 0) logDeliveryFact(row.event_id, row.delivery_id, 'market', 'rework-fallback', { reply: row.id, reason: 'peer_not_declared' });
      message = returnMessage(answer as { text: string; return: { of: string; title: string } }, { dispatchLine: declared });
    } else message = answerEnvelope(row, answer);
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
