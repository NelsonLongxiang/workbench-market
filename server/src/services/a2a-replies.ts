/**
 * 阶段七 R2：市场回给团队的消息（workbench_event_replies）的发送状态。SQL 在这里；时间由代码生成后传入（不用 SQLite 的 datetime('now')）。
 *   answer           人答复席位回执里的提问
 *   followup-reply   人回复席位来信（跟进）
 *   followup-receipt 收下跟进后结清它的回执（任务号固定 receipt-<跟进任务号>，一直重试）
 */
import { db } from '../db.ts';

export type ReplyKind = 'answer' | 'followup-reply' | 'followup-receipt';
export type ReplyRow = {
  id: number; kind: ReplyKind; event_id: string; delivery_id: number; ref: number; qid: string; fixed_task: string;
  team: string; caller_session: string; context_id: string; target_url: string; message: string; attempts: number;
};

/** SQL 里用的时刻：UTC 'YYYY-MM-DD HH:MM:SS'（和库里已有列同一种写法，字符串比较即时间比较） */
export function sqlTime(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 提问那一行事件日志：回执里的提问记着它答的那个任务号（qid 用它） */
export function askTaskOf(askLogId: number): string {
  // 提问回执（attention-<task>-<qid>）答的是那个问题：qid 用信封里的问题 id；旧式（receipt-<task> 上的 attention）用任务号
  const row = db.prepare("SELECT COALESCE(json_extract(detail, '$.qid'), json_extract(detail, '$.task')) AS task FROM workbench_event_log WHERE id = ?").get(askLogId) as { task: string | null } | undefined;
  return row?.task ?? '';
}

/** 这个事件是派发的吗（只通知的 dispatch:false 事件没有回写通道，不发答复） */
export function eventDispatched(eventId: string): boolean {
  const row = db.prepare('SELECT dispatch FROM workbench_events WHERE event_id = ?').get(eventId) as { dispatch: number } | undefined;
  return row?.dispatch === 1;
}

/** 一次投递的发送目标（团队、调用方会话、对端地址）和事件的 context */
export function deliveryTarget(deliveryId: number): { team: string; caller_session: string; target_url: string; context_id: string } | undefined {
  return db.prepare(`SELECT d.target_team AS team, d.caller_session, d.target_url, e.context_id
    FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE d.id = ?`).get(deliveryId) as never;
}

/** 排一条；同一（种类、投递、引用）只排一次。返回新行 id，已有返回 null */
/**
 * 打回重做发给谁：这个事件最近一条采信的 completed 回执所在的投递和它答的任务号（就是被验收、被打回的那次交付）；
 * 没有就取这个事件最近一次派工的投递和任务号。都没有返回 null（只通知、没派出去的事件）。
 */
export function returnTargetOfEvent(eventId: string): { delivery_id: number; task: string } | null {
  const done = db.prepare("SELECT delivery_id, json_extract(detail, '$.task') AS task FROM workbench_event_log WHERE event_id = ? AND action = 'receipt:completed' AND delivery_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(eventId) as { delivery_id: number; task: string | null } | undefined;
  if (done && typeof done.task === 'string' && done.task !== '') return { delivery_id: done.delivery_id, task: done.task };
  const sent = db.prepare("SELECT delivery_id, task_id AS task FROM a2a_sent_tasks WHERE event_id = ? AND kind = 'delivery' ORDER BY rowid DESC LIMIT 1").get(eventId) as { delivery_id: number; task: string } | undefined;
  return sent ?? null;
}

export function queueReply(r: { kind: ReplyKind; eventId: string; deliveryId: number; ref: number; qid?: string; fixedTask?: string; team: string; callerSession: string; contextId: string; targetUrl: string; message: string; now?: number }): number | null {
  const at = sqlTime(r.now);
  const info = db.prepare(`INSERT OR IGNORE INTO workbench_event_replies (kind, event_id, delivery_id, ref, qid, fixed_task, team, caller_session, context_id, target_url, message, next_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.kind, r.eventId, r.deliveryId, r.ref, r.qid ?? '', r.fixedTask ?? '', r.team, r.callerSession, r.contextId, r.targetUrl, r.message, at, at);
  return Number(info.changes) === 1 ? Number(info.lastInsertRowid) : null;
}

export function dueReplies(limit = 20, now = Date.now()): ReplyRow[] {
  return db.prepare(`SELECT id, kind, event_id, delivery_id, ref, qid, fixed_task, team, caller_session, context_id, target_url, message, attempts
    FROM workbench_event_replies WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT ?`).all(sqlTime(now), limit) as ReplyRow[];
}

export function markReply(id: number, status: 'sent' | 'dead', attempts: number, error = '', now = Date.now()): void {
  db.prepare("UPDATE workbench_event_replies SET status = ?, attempts = ?, last_error = ?, message = '', sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ? AND status = 'pending'")
    .run(status, attempts, error.slice(0, 300), status, sqlTime(now), id);
}

/** 对端此刻不能发（改钥待确认、停用）：挂起到 nextAtMs 再看，attempts 不加、不判死。返回原因是不是第一次记（调用方只在第一次留痕） */
export function holdReply(id: number, nextAtMs: number, reason: string): boolean {
  const prev = db.prepare('SELECT last_error FROM workbench_event_replies WHERE id = ?').get(id) as { last_error: string } | undefined;
  db.prepare("UPDATE workbench_event_replies SET next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").run(sqlTime(nextAtMs), reason, id);
  return prev?.last_error !== reason;
}

/** 事件投递同上：对端此刻不能发，挂起到 nextAtMs 再看，attempts 不加、不判死。返回原因是不是第一次记 */
export function holdDelivery(id: number, nextAtMs: number, reason: string): boolean {
  const prev = db.prepare('SELECT last_error FROM workbench_event_deliveries WHERE id = ?').get(id) as { last_error: string } | undefined;
  db.prepare("UPDATE workbench_event_deliveries SET next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").run(sqlTime(nextAtMs), reason, id);
  return prev?.last_error !== reason;
}

export function retryReply(id: number, attempts: number, nextAtMs: number, error: string): void {
  db.prepare("UPDATE workbench_event_replies SET attempts = ?, next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").run(attempts, sqlTime(nextAtMs), error.slice(0, 300), id);
}

/** 还没发出去的跟进回执有几条、最多试了几次（健康块与排障用） */
export function pendingFollowupReceipts(): { pending: number; max_attempts: number } {
  const row = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(attempts), 0) AS m FROM workbench_event_replies WHERE kind = 'followup-receipt' AND status = 'pending'").get() as { n: number; m: number };
  return { pending: Number(row.n), max_attempts: Number(row.m) };
}

/** 一组写放在一个保存点里 */
export function inReplyTx<T>(fn: () => T): T {
  db.exec('SAVEPOINT a2a_reply');
  try { const out = fn(); db.exec('RELEASE a2a_reply'); return out; }
  catch (e) { db.exec('ROLLBACK TO a2a_reply'); db.exec('RELEASE a2a_reply'); throw e; }
}
