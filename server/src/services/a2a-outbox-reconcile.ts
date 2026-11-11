/**
 * 唯一 outbox 双写期的对账（阶段七第 3 步）：旧表 a2a_outbox 与新表 a2a_outbox_items（kind=run-receipt）逐行比。
 * 不 import db.ts：调用方传库句柄进来，脚本可以只读打开生产库，不触发迁移。切读前必须零差异。
 */
type Handle = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

export const RECONCILED_FIELDS = ['target_url', 'task_id', 'context_id', 'payload', 'status', 'attempts', 'next_at', 'last_error', 'created_at', 'sent_at'] as const;

export interface ReceiptReconcile {
  old_rows: number;
  new_rows: number;
  by_status: { old: Record<string, number>; new: Record<string, number> };
  /** 旧表有、新表没有的 run_id */
  missing: string[];
  /** 新表有、旧表没有的 ref */
  extra: string[];
  /** 两边都有但字段不同：ref → 不同的字段名 */
  mismatched: { ref: string; fields: string[] }[];
  ok: boolean;
}

export function reconcileReceiptOutbox(h: Handle): ReceiptReconcile {
  const cols = RECONCILED_FIELDS.join(', ');
  const oldRows = h.prepare(`SELECT CAST(run_id AS TEXT) AS ref, ${cols} FROM a2a_outbox`).all() as Record<string, unknown>[];
  const newRows = h.prepare(`SELECT ref, ${cols} FROM a2a_outbox_items WHERE kind = 'run-receipt'`).all() as Record<string, unknown>[];
  const oldBy = new Map(oldRows.map((r) => [String(r.ref), r]));
  const newBy = new Map(newRows.map((r) => [String(r.ref), r]));
  const missing = [...oldBy.keys()].filter((k) => !newBy.has(k)).sort();
  const extra = [...newBy.keys()].filter((k) => !oldBy.has(k)).sort();
  const mismatched: { ref: string; fields: string[] }[] = [];
  for (const [ref, o] of oldBy) {
    const n = newBy.get(ref);
    if (!n) continue;
    const fields = RECONCILED_FIELDS.filter((f) => String(o[f]) !== String(n[f]));
    if (fields.length) mismatched.push({ ref, fields });
  }
  const count = (rows: Record<string, unknown>[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = (out[String(r.status)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort());
  };
  return {
    old_rows: oldRows.length,
    new_rows: newRows.length,
    by_status: { old: count(oldRows), new: count(newRows) },
    missing, extra, mismatched,
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
  };
}
