/**
 * 阶段七 R2：把人在「关注」里的答复，作为同一 context 的新任务发回提问的那个团队（superagent：答复「comes back as a new task
 * in the same context」）。每次尝试一个任务号 <event>.d<投递>.q<答复>.a<尝试>，发出前登记进 a2a_sent_tasks（kind=answer，记下对端），
 * 对方对这个新任务的回执（接单 / 再问 / 结果）照 R3 的路回到同一个事项。
 * 发送复用事件投递的 a2aSendOutbound（OriginClaim 签名）、退避常量与终止码；在事件投递的同一个 worker 里跑。
 */
import { a2aKeyPath, a2aSendOutbound } from '../a2a.ts';
import { dueAnswers, inAnswerTx, markAnswer, retryAnswer, type AnswerRow } from '../services/a2a-answers.ts';
import { recordSentTask } from '../services/a2a-receipts.ts';
import { BACKOFF_MS, MAX_ATTEMPTS, TERMINAL_CODES, backoffScale, logDeliveryFact, sqliteUtcIn } from '../workbench-events.ts';
import { peerCard, peerRoot } from './peer-card.ts';

export const ANSWER_ENVELOPE_VERSION = 2;

/** 发给团队的答复信封（06：kind=answer；对方把正文当数据，按 context 归到同一线程） */
export function answerEnvelope(row: Pick<AnswerRow, 'event_id' | 'context_id' | 'qid'>, answer: { text: string; by: string }): string {
  return JSON.stringify({ type: 'workbench-event', v: ANSWER_ENVELOPE_VERSION, kind: 'answer', event_id: row.event_id, context_id: row.context_id, answer: { qid: row.qid, text: answer.text, by: answer.by } });
}

async function sendOne(row: AnswerRow): Promise<void> {
  const attempt = row.attempts + 1;
  const taskId = `${row.event_id}.d${row.delivery_id}.q${row.id}.a${attempt}`;
  let answer: { text: string; by: string } = { text: '', by: '' };
  try { answer = JSON.parse(row.message); } catch { /* 坏行按空答复发不出去，下面判 dead */ }
  if (answer.text === '') {
    inAnswerTx(() => { markAnswer(row.id, 'dead', attempt, 'empty answer'); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'answer-dead', { answer: row.id, error: 'empty answer' }); });
    return;
  }
  const peer = await peerCard(row.target_url).catch(() => null);
  recordSentTask({ taskId, kind: 'answer', eventId: row.event_id, deliveryId: row.delivery_id, peerRoot: peerRoot(row.target_url), peerZone: peer?.team ?? '' });
  let out: { ok?: boolean; code?: number; error?: string } | undefined;
  try {
    out = await a2aSendOutbound(a2aKeyPath(), { baseUrl: row.target_url, team: row.target_team }, answerEnvelope(row, answer), row.context_id, row.caller_session, { taskId, async: true }) as typeof out;
  } catch (e) {
    out = { ok: false, error: String((e as Error)?.message ?? e) };
  }
  if (out?.ok === true) {
    inAnswerTx(() => { markAnswer(row.id, 'sent', attempt); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'answer-sent', { answer: row.id, task: taskId }); });
    return;
  }
  const error = String(out?.error ?? 'unknown failure').slice(0, 300);
  if ((typeof out?.code === 'number' && TERMINAL_CODES.has(out.code)) || attempt >= MAX_ATTEMPTS) {
    inAnswerTx(() => { markAnswer(row.id, 'dead', attempt, error); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'answer-dead', { answer: row.id, error }); });
    return;
  }
  const delay = (BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 3_600_000) * backoffScale();
  inAnswerTx(() => { retryAnswer(row.id, attempt, sqliteUtcIn(delay), error); logDeliveryFact(row.event_id, row.delivery_id, 'market', 'answer-retry', { answer: row.id, attempts: attempt, error }); });
}

/** 发到期的答复（事件投递 worker 每轮调一次） */
export async function answerTick(): Promise<void> {
  for (const row of dueAnswers(20)) {
    try { await sendOne(row); } catch (e) { console.error(`[a2a-answers] 答复 ${row.id} 发送出错：${String(e).slice(0, 120)}`); }
  }
}
