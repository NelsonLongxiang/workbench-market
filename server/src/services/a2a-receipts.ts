/**
 * 阶段七 R3：A2A 回执入站要用的登记（SQL 在这里）。
 *   · a2a_sent_tasks：我们发出的任务号 → 事件、投递、对端（发出那一刻的名片 team 与根地址）
 *   · a2a_inbound_receipts：采信过的回执，按（任务号、接单 / 终局）去重
 *   · 签名只认一次：和 /a2a/direct 入站签名共用 a2a_sig_seen
 */
import { createHash } from 'node:crypto';
import { db } from '../db.ts';

export type SentTask = { task_id: string; kind: 'delivery' | 'answer'; event_id: string; delivery_id: number; peer_root: string; peer_zone: string };

/** 这个根地址是不是我们投递过的对端（来信分流按「声称的来源」预取名片用，和查不查得到投递无关） */
export function knownPeerRoot(root: string): boolean {
  return root !== '' && Boolean(db.prepare('SELECT 1 FROM a2a_sent_tasks WHERE peer_root = ? LIMIT 1').get(root));
}

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
/** 这个任务收下了几步进展（去重格里以 # 开头的） */
export function progressSteps(taskId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM a2a_inbound_questions WHERE task_id = ? AND qid LIKE '#%'").get(taskId) as { n: number }).n);
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
export function sentTaskForFollowup(contextId: string, zone: string, peerRoot: string): SentTask | undefined {
  // 按区和根地址一起找：同一个区下可以有好几台宿主，同一个 context 也可能投给过其中几台，跟进找发来的那台自己的那次投递
  const byContext = db.prepare(`SELECT s.task_id, s.kind, s.event_id, s.delivery_id, s.peer_root, s.peer_zone
    FROM a2a_sent_tasks s JOIN workbench_events e ON e.event_id = s.event_id
    WHERE e.context_id = ? AND s.peer_zone = ? AND s.peer_zone <> '' AND s.peer_root = ? AND s.peer_root <> ''
    ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`).get(contextId, zone, peerRoot) as SentTask | undefined;
  if (byContext) return byContext;
  const byTask = sentTask(contextId);
  return byTask && byTask.peer_zone === zone && byTask.peer_zone !== '' && byTask.peer_root === peerRoot ? byTask : undefined;
}

/** 一个事件上最近一步被采信的进展（事件日志里的 receipt:progress），给事项页的「正在处理」提示和子项 */
/** 一个事件上最近一条带子项（tickets）的采信回执：进展或结果都算（结果回执里是各子项的结局） */
/**
 * 这一步进展之后，同一任务有没有到过采信的结果回执：到过，这一步（连同它带的子项状态）就过时了——
 * 任务已经结束，「排队中」「在做」不再是真的；结果回执没带 tickets 时，不能拿进展里的旧状态顶上。
 */
function progressEnded(eventId: string, rowId: number, task: unknown): boolean {
  if (typeof task !== 'string' || task === '') return false;
  return db.prepare("SELECT 1 FROM workbench_event_log WHERE event_id = ? AND id > ? AND action LIKE 'receipt:%' AND action NOT IN ('receipt:untrusted','receipt:unaccepted','receipt:progress') AND json_extract(detail, '$.disposition') = 'result' AND json_extract(detail, '$.task') = ? LIMIT 1")
    .get(eventId, rowId, task) !== undefined;
}

export function latestTicketsOfEvent(eventId: string): unknown[] | null {
  const row = db.prepare("SELECT id, action, detail FROM workbench_event_log WHERE event_id = ? AND action LIKE 'receipt:%' AND action NOT IN ('receipt:untrusted','receipt:unaccepted') AND json_type(detail, '$.tickets') = 'array' ORDER BY id DESC LIMIT 1").get(eventId) as { id: number; action: string; detail: string } | undefined;
  if (!row) return null;
  try {
    const d = JSON.parse(row.detail) as { tickets?: unknown; task?: unknown };
    // 子项来自一步进展、而那个任务之后已经结束（结果回执没带子项）：旧的子项状态不再给
    if (row.action === 'receipt:progress' && progressEnded(eventId, row.id, d.task)) return null;
    return Array.isArray(d.tickets) ? d.tickets : null;
  } catch { return null; }
}

export function latestProgressOfEvent(eventId: string): { at: string; detail: Record<string, unknown> } | null {
  const row = db.prepare("SELECT id, at, detail FROM workbench_event_log WHERE event_id = ? AND action = 'receipt:progress' ORDER BY id DESC LIMIT 1").get(eventId) as { id: number; at: string; detail: string } | undefined;
  if (!row) return null;
  try {
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    // 这一步所属的任务之后已经有结果回执：任务结束了，「正在处理」不再给（比如打回后重做完、回到等验收）
    if (progressEnded(eventId, row.id, detail.task)) return null;
    return { at: row.at, detail };
  } catch { return null; }
}
