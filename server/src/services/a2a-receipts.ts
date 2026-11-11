/**
 * 阶段七 R3：A2A 回执入站要用的登记（SQL 在这里）。
 *   · a2a_sent_tasks：我们发出的任务号 → 事件、投递、对端（发出那一刻的名片 team 与根地址）
 *   · a2a_inbound_receipts：采信过的回执，按（任务号、接单 / 终局）去重
 *   · 签名只认一次：和 /a2a/direct 入站签名共用 a2a_sig_seen
 */
import { createHash } from 'node:crypto';
import { db } from '../db.ts';

export type SentTask = { task_id: string; kind: 'delivery' | 'answer'; event_id: string; delivery_id: number; peer_root: string; peer_zone: string };

export function recordSentTask(r: { taskId: string; kind?: 'delivery' | 'answer'; eventId: string; deliveryId: number; peerRoot: string; peerZone: string }): void {
  db.prepare('INSERT OR IGNORE INTO a2a_sent_tasks (task_id, kind, event_id, delivery_id, peer_root, peer_zone) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.taskId, r.kind ?? 'delivery', r.eventId, r.deliveryId, r.peerRoot, r.peerZone);
}

export function sentTask(taskId: string): SentTask | undefined {
  return db.prepare('SELECT task_id, kind, event_id, delivery_id, peer_root, peer_zone FROM a2a_sent_tasks WHERE task_id = ?').get(taskId) as SentTask | undefined;
}

/** 第一次见到这条（任务号、接单 / 终局）返回 true；重复返回 false */
export function claimReceipt(taskId: string, cls: 'ack' | 'final', disposition: string, outcome: string): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO a2a_inbound_receipts (task_id, class, disposition, outcome) VALUES (?, ?, ?, ?)').run(taskId, cls, disposition, outcome);
  return Number(r.changes) === 1;
}

/** 提问回执（attention-<task>-<qid>）占（任务号、问题 id）这一格；占到了返回 true。时间由代码生成后传入 */
export function claimQuestion(taskId: string, qid: string, now = Date.now()): boolean {
  const at = new Date(now).toISOString().slice(0, 23).replace('T', ' ');
  const r = db.prepare('INSERT OR IGNORE INTO a2a_inbound_questions (task_id, qid, received_at) VALUES (?, ?, ?)').run(taskId, qid, at);
  return Number(r.changes) === 1;
}
export function questionRecorded(taskId: string, qid: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM a2a_inbound_questions WHERE task_id = ? AND qid = ?').get(taskId, qid));
}

/** 这条（任务号、接单 / 终局）回执记过了吗 */
export function receiptRecorded(taskId: string, cls: 'ack' | 'final'): boolean {
  return Boolean(db.prepare('SELECT 1 FROM a2a_inbound_receipts WHERE task_id = ? AND class = ?').get(taskId, cls));
}

/** 验过的签名只认一次（落库到有效期结束） */
export function claimSignatureOnce(sig: string, expiresAt: number, now = Date.now()): boolean {
  db.prepare('DELETE FROM a2a_sig_seen WHERE expires_at < ?').run(now);
  const r = db.prepare('INSERT OR IGNORE INTO a2a_sig_seen (sig_hash, expires_at) VALUES (?, ?)').run(createHash('sha256').update(sig, 'utf8').digest('hex'), expiresAt);
  return Number(r.changes) === 1;
}

/** 这次投递已经记了多少行「收到未采信」的回执（防刷：到上限就不再记） */
export function untrustedReceiptCount(deliveryId: number, action: 'receipt:untrusted' | 'receipt:unaccepted' = 'receipt:untrusted'): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM workbench_event_log WHERE delivery_id = ? AND action = ?').get(deliveryId, action) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** 回执入站的一组写（登记去重 + 写事件日志）放进一个保存点：嵌在调用方事务里也能用 */
export function inReceiptTx<T>(fn: () => T): T {
  db.exec('SAVEPOINT a2a_receipt_in');
  try { const out = fn(); db.exec('RELEASE a2a_receipt_in'); return out; }
  catch (e) { db.exec('ROLLBACK TO a2a_receipt_in'); db.exec('RELEASE a2a_receipt_in'); throw e; }
}

/**
 * 阶段七 R2：跟进（a2a-<hash>，和原任务号没有字面关系）只靠 context 归到投递：我们某个事件的 context、发给的对端 zone 等于签名方的
 * 最近一个任务号。存量没带 context 的投递，对方按「context 等于原任务号」回来：再按任务号找一次。找不到返回 undefined（跟进不认）。
 */
export function sentTaskForFollowup(contextId: string, zone: string): SentTask | undefined {
  const byContext = db.prepare(`SELECT s.task_id, s.kind, s.event_id, s.delivery_id, s.peer_root, s.peer_zone
    FROM a2a_sent_tasks s JOIN workbench_events e ON e.event_id = s.event_id
    WHERE e.context_id = ? AND s.peer_zone = ? AND s.peer_zone <> ''
    ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`).get(contextId, zone) as SentTask | undefined;
  if (byContext) return byContext;
  const byTask = sentTask(contextId);
  return byTask && byTask.peer_zone === zone && byTask.peer_zone !== '' ? byTask : undefined;
}
