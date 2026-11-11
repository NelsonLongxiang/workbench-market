/**
 * 阶段七 R2：答复席位提问的发送状态（workbench_event_answers）。SQL 在这里。
 */
import { db } from '../db.ts';

export type AnswerRow = {
  id: number; event_id: string; delivery_id: number; ask_log_id: number; qid: string; message: string; attempts: number;
  target_team: string; target_url: string; caller_session: string; context_id: string;
};

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

/** 排一条答复；同一次提问只排一次。返回新行 id，已有返回 null */
export function queueAnswer(r: { eventId: string; deliveryId: number; askLogId: number; qid: string; message: string }): number | null {
  const info = db.prepare('INSERT OR IGNORE INTO workbench_event_answers (event_id, delivery_id, ask_log_id, qid, message) VALUES (?, ?, ?, ?, ?)')
    .run(r.eventId, r.deliveryId, r.askLogId, r.qid, r.message);
  return Number(info.changes) === 1 ? Number(info.lastInsertRowid) : null;
}

export function dueAnswers(limit = 20): AnswerRow[] {
  return db.prepare(`SELECT a.id, a.event_id, a.delivery_id, a.ask_log_id, a.qid, a.message, a.attempts, d.target_team, d.target_url, d.caller_session, e.context_id
    FROM workbench_event_answers a JOIN workbench_event_deliveries d ON d.id = a.delivery_id JOIN workbench_events e ON e.event_id = a.event_id
    WHERE a.status = 'pending' AND a.next_at <= datetime('now') ORDER BY a.id LIMIT ?`).all(limit) as AnswerRow[];
}

export function markAnswer(id: number, status: 'sent' | 'dead', attempts: number, error = ''): void {
  db.prepare("UPDATE workbench_event_answers SET status = ?, attempts = ?, last_error = ?, message = '', sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END WHERE id = ? AND status = 'pending'")
    .run(status, attempts, error.slice(0, 300), status, id);
}

export function retryAnswer(id: number, attempts: number, nextAt: string, error: string): void {
  db.prepare("UPDATE workbench_event_answers SET attempts = ?, next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").run(attempts, nextAt, error.slice(0, 300), id);
}

/** 记答复与排发送放在一个保存点里：答复记下了就一定排上 */
export function inAnswerTx<T>(fn: () => T): T {
  db.exec('SAVEPOINT a2a_answer');
  try { const out = fn(); db.exec('RELEASE a2a_answer'); return out; }
  catch (e) { db.exec('ROLLBACK TO a2a_answer'); db.exec('RELEASE a2a_answer'); throw e; }
}
