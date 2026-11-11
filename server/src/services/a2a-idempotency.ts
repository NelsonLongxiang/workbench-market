/**
 * A2A 入站幂等登记（阶段七第 2 步）：task_id → 指纹，落 SQLite，取代 a2a.ts 里的进程内 Map。
 * 重启后同一个 task_id 仍判 replay / conflict。（多进程同时写同一个库还不行：库没设 busy_timeout，并发登记会抛 database is locked——全库存量，留给 outbox 那一步统一处理。）
 *
 * 语义照旧（上游 idempotencyStore 同语义）：
 *   · 窗口 30 分钟：登记时刻起，now - created_at 超过窗口的行在下次登记时清掉，同一 task_id 重新算 fresh。
 *   · 同 id 同指纹 → replay（-32003），同 id 异指纹 → conflict（-32002），都不改原登记。
 *   · 只在准入之后调用：没有绑定的来源走不到这里，不能占用 task_id，也探不出 id 是否被用过。
 * 库里只存指纹的 sha256，不存消息原文。按 UTF-16 码元（utf16le）算摘要：utf8 编码会把孤代理码元都换成 U+FFFD，
 * 只差一个孤代理的两条消息会撞成同一个摘要（旧的 Map 比原串，判 conflict）。
 * 上游 dsh-open-a2a-net 没有导出幂等存储；导出后改为引用（07 第三节第 1 条）。
 */
import { createHash } from 'node:crypto';
import { db } from '../db.ts';

export const A2A_IDEM_TTL_MS = 30 * 60 * 1000;

export type A2aIdemVerdict = 'fresh' | 'replay' | 'conflict';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf16le').digest('hex');

export function claimA2aTask(taskId: string, fingerprint: string, now = Date.now(), ttlMs = A2A_IDEM_TTL_MS): A2aIdemVerdict {
  const fp = sha256(fingerprint);
  db.prepare('DELETE FROM a2a_idempotency WHERE created_at < ?').run(now - ttlMs);
  const ins = db.prepare('INSERT INTO a2a_idempotency (task_id, fp_sha256, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING').run(taskId, fp, now);
  if (Number(ins.changes) === 1) return 'fresh';
  const prev = db.prepare('SELECT fp_sha256 FROM a2a_idempotency WHERE task_id = ?').get(taskId) as { fp_sha256: string } | undefined;
  // 两句之间这一行被清掉了（过期清理）：按新登记处理
  if (!prev) {
    db.prepare('INSERT INTO a2a_idempotency (task_id, fp_sha256, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING').run(taskId, fp, now);
    return 'fresh';
  }
  return prev.fp_sha256 === fp ? 'replay' : 'conflict';
}
