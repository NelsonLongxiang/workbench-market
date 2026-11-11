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
    WHERE d.decision = 'ask' ORDER BY d.decided_at, d.id`).all() as OpenSeatAsk[];
}
