/**
 * 唯一 outbox 双写期的对账（阶段七第 3 步）：两条出站路的旧表与新表 a2a_outbox_items 逐行逐字段比。
 *   · 回执：a2a_outbox ↔ kind=run-receipt（ref=run_id）。
 *   · 事件投递：workbench_event_deliveries 里非 held 的行 ↔ kind=event-delivery（ref=投递 id）；held 的单独计数并列出（不在 outbox 里是预期）。
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

export const DELIVERY_FIELDS = ['target_url', 'team', 'caller', 'context_id', 'payload', 'status', 'attempts', 'next_at', 'last_error', 'created_at', 'sent_at'] as const;

export interface DeliveryReconcile extends Omit<ReceiptReconcile, 'ok'> {
  /** 等管理员放行的投递：不进 outbox，单独列出 */
  held: { count: number; refs: string[] };
  ok: boolean;
}

function compare(oldRows: Record<string, unknown>[], newRows: Record<string, unknown>[], fields: readonly string[]) {
  const oldBy = new Map(oldRows.map((r) => [String(r.ref), r]));
  const newBy = new Map(newRows.map((r) => [String(r.ref), r]));
  const missing = [...oldBy.keys()].filter((k) => !newBy.has(k)).sort((a, b) => Number(a) - Number(b));
  const extra = [...newBy.keys()].filter((k) => !oldBy.has(k)).sort((a, b) => Number(a) - Number(b));
  const mismatched: { ref: string; fields: string[] }[] = [];
  for (const [ref, o] of oldBy) {
    const n = newBy.get(ref);
    if (!n) continue;
    const diff = fields.filter((f) => String(o[f]) !== String(n[f]));
    if (diff.length) mismatched.push({ ref, fields: diff });
  }
  const count = (rows: Record<string, unknown>[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = (out[String(r.status)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort());
  };
  return { old_rows: oldRows.length, new_rows: newRows.length, by_status: { old: count(oldRows), new: count(newRows) }, missing, extra, mismatched };
}

export function reconcileDeliveryOutbox(h: Handle): DeliveryReconcile {
  const hasTable = (h.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workbench_event_deliveries'").all() as unknown[]).length > 0;
  const oldRows = hasTable ? h.prepare(`SELECT CAST(d.id AS TEXT) AS ref, d.target_url, d.target_team AS team, d.caller_session AS caller, e.context_id, d.message AS payload,
      d.status, d.attempts, d.next_at, d.last_error, d.created_at, d.sent_at
      FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE d.status <> 'held'`).all() as Record<string, unknown>[] : [];
  const held = hasTable ? (h.prepare("SELECT CAST(id AS TEXT) AS ref FROM workbench_event_deliveries WHERE status = 'held' ORDER BY id").all() as { ref: string }[]).map((r) => r.ref) : [];
  const newRows = h.prepare(`SELECT ref, ${DELIVERY_FIELDS.join(', ')} FROM a2a_outbox_items WHERE kind = 'event-delivery'`).all() as Record<string, unknown>[];
  const c = compare(oldRows, newRows, DELIVERY_FIELDS);
  return { ...c, held: { count: held.length, refs: held }, ok: c.missing.length === 0 && c.extra.length === 0 && c.mismatched.length === 0 };
}
