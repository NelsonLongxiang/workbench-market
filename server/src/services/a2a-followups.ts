/**
 * 阶段七 R2：席位来信（跟进）的登记。SQL 在这里；时间由代码生成后传入。
 */
import { db } from '../db.ts';
import { sqlTime } from './a2a-replies.ts';

export type FollowupStatus = 'open' | 'replied' | 'acknowledged' | 'over-cap' | 'rate-limited';
export type FollowupRow = {
  id: number; event_id: string; delivery_id: number; peer_zone: string; inbound_task: string; context_id: string; sender: string;
  text: string; truncated: number; status: FollowupStatus; created_at: string;
};

/** 收下一条跟进；同一投递上同一任务号只记一次（重复返回 null） */
export function recordFollowup(r: { eventId: string; deliveryId: number; peerZone: string; inboundTask: string; contextId: string; sender: string; text: string; truncated: boolean; status: 'open' | 'over-cap' | 'rate-limited'; now?: number }): number | null {
  const info = db.prepare(`INSERT OR IGNORE INTO workbench_event_followups (event_id, delivery_id, peer_zone, inbound_task, context_id, sender, text, truncated, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.eventId, r.deliveryId, r.peerZone, r.inboundTask, r.contextId, r.sender, r.text, r.truncated ? 1 : 0, r.status, sqlTime(r.now));
  return Number(info.changes) === 1 ? Number(info.lastInsertRowid) : null;
}

export function followupOf(deliveryId: number, inboundTask: string): FollowupRow | undefined {
  return db.prepare('SELECT * FROM workbench_event_followups WHERE delivery_id = ? AND inbound_task = ?').get(deliveryId, inboundTask) as FollowupRow | undefined;
}
export function followupById(id: number): FollowupRow | undefined {
  return db.prepare('SELECT * FROM workbench_event_followups WHERE id = ?').get(id) as FollowupRow | undefined;
}

/** 这次投递收下了几条（不含超限只记日志的） */
export function followupsOfDelivery(deliveryId: number): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM workbench_event_followups WHERE delivery_id = ? AND status NOT IN ('over-cap', 'rate-limited')").get(deliveryId) as { n: number }).n);
}

/** 这个对端最近一段时间发来了几条（限频用） */
export function followupsOfPeerSince(zone: string, sinceMs: number): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM workbench_event_followups WHERE peer_zone = ? AND created_at >= ?').get(zone, sqlTime(sinceMs)) as { n: number }).n);
}

/** 事项对话：一个事件上存了正文的席位消息（不含限频只计数的），按收到的先后，最多最近 200 条 */
export function followupsOfEvent(eventId: string): FollowupRow[] {
  return (db.prepare("SELECT * FROM workbench_event_followups WHERE event_id = ? AND status <> 'rate-limited' ORDER BY id DESC LIMIT 200").all(eventId) as FollowupRow[]).reverse();
}

/** 未读：status = open（还没人看过、也没人回复） */
export function unreadFollowupsOfEvent(eventId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM workbench_event_followups WHERE event_id = ? AND status = 'open'").get(eventId) as { n: number }).n);
}

/** 看过了：把这个事件上未读的都标成已读（acknowledged），返回标了几条 */
export function markFollowupsRead(eventId: string, by: string, now = Date.now()): number {
  const r = db.prepare("UPDATE workbench_event_followups SET status = 'acknowledged', handled_by = ?, handled_at = ? WHERE event_id = ? AND status = 'open'").run(by.slice(0, 200), sqlTime(now), eventId);
  return Number(r.changes);
}

/** 回复了一条：只从未读或已读改成已回复（超限只记日志的不能回复），返回是否改到了 */
export function markFollowupReplied(id: number, by: string, now = Date.now()): boolean {
  const r = db.prepare("UPDATE workbench_event_followups SET status = 'replied', handled_by = ?, handled_at = ? WHERE id = ? AND status IN ('open', 'acknowledged')").run(by.slice(0, 200), sqlTime(now), id);
  return Number(r.changes) === 1;
}
