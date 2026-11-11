/**
 * 「关注」的提供方要用、来源里还没有现成函数的查询（阶段八 8c）。只读。
 * 口径照旧接口的写法，条数才对得上：
 *   · 席位的提问：GET /api/workbench-events 列表（最近 200 个事件，接口允许的最大窗口）里，投递的决定还是 ask 的
 * 等阶段三把工作台事件这个域搬完，查询挪回它的服务（另排）。
 */
import { db } from '../db.ts';

export type OpenSeatAsk = {
  delivery_id: number; event_id: string; target_team: string; decision_reason: string; decided_by: string; decided_at: string;
  source: string; workbench: string; item: string;
};

const tableExists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** 事件表在任务中心初始化时才建：新库上还没有，就是没有提问 */
export function openSeatAsks(): OpenSeatAsk[] {
  if (!tableExists('workbench_events')) return [];
  return db.prepare(`SELECT d.id AS delivery_id, d.event_id, d.target_team, d.decision_reason, d.decided_by, d.decided_at, e.source, e.workbench, e.item
    FROM (SELECT event_id, source, workbench, item, id FROM workbench_events ORDER BY id DESC LIMIT 200) e
    JOIN workbench_event_deliveries d ON d.event_id = e.event_id
    WHERE d.decision = 'ask'
      -- 8d：在「关注」里答过的（事项上对这个投递最近一次提问记了答复）不再等
      AND NOT EXISTS (SELECT 1 FROM work_item_log l WHERE l.item_id = 'wi_' || d.event_id AND l.fact = 'answer' AND l.rejected = ''
        AND json_extract(l.detail, '$.ask_id') = (SELECT CAST(MAX(g.id) AS TEXT) FROM workbench_event_log g WHERE g.delivery_id = d.id AND g.action = 'decision:ask'))
    ORDER BY d.decided_at, d.id`).all() as OpenSeatAsk[];
}

/** 一个投递正在等答复的那次提问：它所在的事件，和事件日志里最近一次 decision:ask 那一行的 id（事项上的提问就是按它记的） */
export function pendingAskOfDelivery(deliveryId: number): { event_id: string; ask_log_id: number } | null {
  if (!tableExists('workbench_events')) return null;
  const row = db.prepare(`SELECT d.event_id, (SELECT MAX(g.id) FROM workbench_event_log g WHERE g.delivery_id = d.id AND g.action = 'decision:ask') AS ask_log_id
    FROM workbench_event_deliveries d WHERE d.id = ? AND d.decision = 'ask'`).get(deliveryId) as { event_id: string; ask_log_id: number | null } | undefined;
  return row && row.ask_log_id !== null ? { event_id: row.event_id, ask_log_id: row.ask_log_id } : null;
}

/** 待对接清单里这条外部身份最近一次出现的时间；不在清单里返回 null（「关注」记账分轮用） */
export function pendingPrincipalSeen(provider: string, externalId: string): string | null {
  const row = db.prepare('SELECT last_seen FROM principal_pending WHERE provider = ? AND external_id = ?').get(provider, externalId) as { last_seen: string } | undefined;
  return row?.last_seen ?? null;
}
