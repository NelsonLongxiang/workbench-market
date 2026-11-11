/**
 * A2A 出站积压的聚合读数（阶段七第 5 步，给 /api/health 的 a2a 块用）：只出计数和时长，不出目标、团队、内容。
 * 两张出站表现在各管一条路：a2a_outbox（SOP 完成回执）、workbench_event_deliveries（事件投递）；唯一 outbox 落地后改读一张。
 */
import { db } from '../db.ts';

export type OutboxCounts = Record<string, number>;

function byStatus(table: 'a2a_outbox' | 'workbench_event_deliveries'): OutboxCounts | null {
  try {
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`).all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  } catch { return null; } // 表还没建（模块没装）
}

export function receiptOutboxStats(now = Date.now()): { counts: OutboxCounts | null; oldest_pending_s: number | null; recent_delay_s: { samples: number; median: number | null; max: number | null } } {
  const counts = byStatus('a2a_outbox');
  let oldest: number | null = null;
  let delays: number[] = [];
  try {
    const row = db.prepare("SELECT MIN(created_at) AS at FROM a2a_outbox WHERE status = 'pending'").get() as { at: string | null } | undefined;
    if (row?.at) oldest = Math.max(0, Math.round((now - Date.parse(row.at.replace(' ', 'T') + 'Z')) / 1000));
    delays = (db.prepare("SELECT (julianday(sent_at) - julianday(created_at)) * 86400.0 AS d FROM a2a_outbox WHERE status = 'sent' AND sent_at <> '' ORDER BY id DESC LIMIT 50").all() as { d: number | null }[])
      .map((r) => Number(r.d)).filter((d) => Number.isFinite(d)).map((d) => Math.max(0, Math.round(d)));
  } catch { /* 表还没建 */ }
  const sorted = [...delays].sort((a, b) => a - b);
  const median = sorted.length === 0 ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  return { counts, oldest_pending_s: oldest, recent_delay_s: { samples: sorted.length, median, max: sorted.length ? sorted[sorted.length - 1] : null } };
}

export function eventDeliveryStats(): { counts: OutboxCounts | null } {
  return { counts: byStatus('workbench_event_deliveries') };
}
