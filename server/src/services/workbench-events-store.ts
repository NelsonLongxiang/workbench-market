/**
 * 工作台事件的存取：事件 workbench_events、投递 workbench_event_deliveries、事件日志 workbench_event_log（三张表都在 db.ts 建）。
 * 事件口径、信封、投递 worker 与 HTTP 面在 server/src/workbench-events.ts；这里只有语句，逐字照搬自那里。
 */
import type { SQLInputValue } from 'node:sqlite';
import { db } from '../db.ts';

/** 工作台事件的写事务：BEGIN IMMEDIATE，fn 成功提交，抛错回滚并原样抛出（fn 必须同步） */
export function inWorkbenchEventTx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** 写一行事件日志，返回行 id */
export function insertEventLog(eventId: string, deliveryId: number | null, actor: string, action: string, detailJson: string): number {
  const info = db.prepare('INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)').run(eventId, deliveryId, actor, action, detailJson);
  return Number(info.lastInsertRowid);
}

/** 某个台上 notify / both 方向、没撤、填了地址的绑定，按绑定 id 顺序 */
export function notifyBindingRows(type: string, slug: string) {
  return db.prepare("SELECT agent_node, notify_url FROM bindings WHERE target_type = ? AND target_slug = ? AND direction IN ('notify','both') AND revoked_at = '' AND notify_url != '' ORDER BY id").all(type, slug);
}

export function insertWorkbenchEvent(eventId: string, source: string, workbench: string, item: string, contextId: string, submitterKind: string, submitter: string, formVersion: number | null, dataSha256: string, dispatch: number, routed: string): void {
  db.prepare('INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, source, workbench, item, contextId, submitterKind, submitter, formVersion, dataSha256, dispatch, routed);
}

/** 写一行投递，返回投递 id */
export function insertDelivery(eventId: string, targetTeam: string, targetUrl: string, callerSession: string, status: string, message: string, replyTokenSha256: string): number {
  const info = db.prepare('INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, message, reply_token_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, targetTeam, targetUrl, callerSession, status, message, replyTokenSha256);
  return Number(info.lastInsertRowid);
}

/** 从 pending 落定一条投递（sent 时记送达时间），返回改了几行 */
export function settleDelivery(status: string, attempts: number, error: string, id: number): number {
  const r = db.prepare("UPDATE workbench_event_deliveries SET status = ?, message = '', attempts = ?, last_error = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END WHERE id = ? AND status = 'pending'").run(status, attempts, error, status, id);
  return Number(r.changes);
}

export function heldDeliveryIds(eventId: string) {
  return db.prepare("SELECT id FROM workbench_event_deliveries WHERE event_id = ? AND status = 'held'").all(eventId);
}

export function markDeliveryPending(id: SQLInputValue): void {
  db.prepare("UPDATE workbench_event_deliveries SET status = 'pending', next_at = datetime('now') WHERE id = ?").run(id);
}

export function eventSourceItem(eventId: string) {
  return db.prepare('SELECT source, item FROM workbench_events WHERE event_id = ?').get(eventId);
}

export function taskStatusRow(id: number) {
  return db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
}

/** 某个任务中心事件里还没发出的投递（held / pending） */
export function cancellableTaskDeliveries(item: string) {
  return db.prepare("SELECT d.id, d.event_id FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE e.source = 'task-center' AND e.item = ? AND d.status IN ('held','pending')").all(item);
}

export function cancelDelivery(id: SQLInputValue): void {
  db.prepare("UPDATE workbench_event_deliveries SET status = 'cancelled', message = '' WHERE id = ?").run(id);
}

export function scheduleDeliveryRetry(attempt: number, nextAt: string, error: string, id: number): void {
  db.prepare("UPDATE workbench_event_deliveries SET attempts = ?, next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").run(attempt, nextAt, error, id);
}

/** 到点该投的投递（库时钟），每轮最多 20 条 */
export function dueDeliveries() {
  return db.prepare("SELECT d.id, d.event_id, d.target_team, d.target_url, d.caller_session, d.message, d.attempts, e.context_id, e.source, e.item FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE d.status = 'pending' AND d.next_at <= datetime('now') ORDER BY d.id LIMIT 20").all();
}

/** 管理员读面：一个事件的全部投递（不含 reply token 与待投信封） */
export function deliveriesOfEvent(eventId: SQLInputValue) {
  return db.prepare('SELECT id, target_team, target_url, status, attempts, last_error, sent_at, decision, decision_reason, decision_ref, decided_by, decided_at, created_at FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id').all(eventId);
}

export function recentEvents(limit: number) {
  return db.prepare('SELECT * FROM workbench_events ORDER BY id DESC LIMIT ?').all(limit);
}

export function eventById(eventId: string) {
  return db.prepare('SELECT * FROM workbench_events WHERE event_id = ?').get(eventId);
}

export function eventLogRows(eventId: string) {
  return db.prepare('SELECT delivery_id, at, actor, action, detail FROM workbench_event_log WHERE event_id = ? ORDER BY id').all(eventId);
}

/** 回写决定时找投递：带 reply token 的投递，live = 送达后 ttlDays 天内（库时钟） */
export function replyCandidates(ttlDays: number, eventId: string) {
  return db.prepare("SELECT id, status, decision, target_url, reply_token_sha256, (sent_at != '' AND datetime(sent_at, '+' || ? || ' days') > datetime('now')) AS live FROM workbench_event_deliveries WHERE event_id = ? AND reply_token_sha256 != ''").all(ttlDays, eventId);
}

export function recordDeliveryDecision(decision: string, reason: string, ref: string, by: string, id: number): void {
  db.prepare("UPDATE workbench_event_deliveries SET decision = ?, decision_reason = ?, decision_ref = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(decision, reason, ref, by, id);
}
