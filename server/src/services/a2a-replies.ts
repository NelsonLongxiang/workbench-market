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
  const row = db.prepare("SELECT json_extract(detail, '$.task') AS task FROM workbench_event_log WHERE id = ?").get(askLogId) as { task: string | null } | undefined;
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
