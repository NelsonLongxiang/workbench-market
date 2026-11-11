/**
 * 「关注」的提供方要用、来源里还没有现成函数的查询（阶段八 8c）。只读。
 * 口径照旧接口的写法，条数才对得上：
 *   · 席位的提问：GET /api/workbench-events 列表（最近 200 个事件，接口允许的最大窗口）里，投递的决定还是 ask 的；
 *     阶段七 R2 起也包括席位 A2A 回执里的提问（receipt:attention），旧接口只显示前者
 * 等阶段三把工作台事件这个域搬完，查询挪回它的服务（另排）。
 */
import { db } from '../db.ts';

export type OpenSeatAsk = {
  delivery_id: number; event_id: string; target_team: string;
  /** 提问那一行事件日志：v1 的 decision:ask，或阶段七 R3 席位回执的 receipt:attention */
  ask_log_id: number; ask_kind: 'decision' | 'receipt';
  question: string; asked_by: string; asked_at: string;
  /** 提问回执带的选项（JSON 数组字符串；没有是 '[]'） */
  options: string;
  source: string; workbench: string; item: string;
};

const tableExists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * 一个投递当前的提问：它最近一条提问日志（decision:ask 或 receipt:attention），之后同一投递上没有「合上提问」的日志
 * （再问一次、作出决定、接单 / 结果回执——和事项服务合提问的规则同一套），事项上也还没有对它的答复。
 * v1 只有 decision:ask 时，这和「投递的决定还是 ask」逐条相同。
 */
const ASK_ACTIONS = "('decision:ask','receipt:attention')";
const CLOSING_ACTIONS = "('decision:ask','decision:accept','decision:decline','receipt:attention','receipt:acknowledged','receipt:completed','receipt:failed','receipt:rejected','receipt:abandoned')";
const OPEN_ASK_SQL = `
  SELECT d.id AS delivery_id, d.event_id, d.target_team, a.id AS ask_log_id,
         CASE a.action WHEN 'receipt:attention' THEN 'receipt' ELSE 'decision' END AS ask_kind,
         CASE a.action WHEN 'receipt:attention' THEN COALESCE(json_extract(a.detail, '$.summary'), '') ELSE COALESCE(json_extract(a.detail, '$.reason'), d.decision_reason) END AS question,
         CASE a.action WHEN 'receipt:attention' THEN a.actor ELSE d.decided_by END AS asked_by,
         CASE a.action WHEN 'receipt:attention' THEN a.at ELSE d.decided_at END AS asked_at,
         CASE a.action WHEN 'receipt:attention' THEN COALESCE(json_extract(a.detail, '$.question.options'), '[]') ELSE '[]' END AS options
    FROM workbench_event_deliveries d
    JOIN workbench_event_log a ON a.id = (SELECT MAX(g.id) FROM workbench_event_log g WHERE g.delivery_id = d.id AND g.action IN ${ASK_ACTIONS})
   WHERE NOT EXISTS (SELECT 1 FROM workbench_event_log c WHERE c.delivery_id = d.id AND c.id > a.id AND c.action IN ${CLOSING_ACTIONS})
     -- 回执里的提问只在事项收下了它时才列（只通知、提交方未验证的事件，事项不收提问）：两边条数才对得上
     AND (a.action <> 'receipt:attention' OR EXISTS (SELECT 1 FROM work_item_log k WHERE k.item_id = 'wi_' || d.event_id AND k.fact = 'ask'
       AND k.fact_id = CAST(a.id AS TEXT) AND k.rejected = ''))
`;
/** 8d：在「关注」里答过的（事项上对这次提问记了答复）不再等 */
const NOT_ANSWERED = `
     AND NOT EXISTS (SELECT 1 FROM work_item_log l WHERE l.item_id = 'wi_' || d.event_id AND l.fact = 'answer' AND l.rejected = ''
       AND json_extract(l.detail, '$.ask_id') = CAST(a.id AS TEXT))`;

/** 事件表在任务中心初始化时才建：新库上还没有，就是没有提问。窗口同旧接口：最近 200 个事件 */
export function openSeatAsks(): OpenSeatAsk[] {
  if (!tableExists('workbench_events')) return [];
  return db.prepare(`SELECT o.*, e.source, e.workbench, e.item
    FROM (SELECT event_id, source, workbench, item, id FROM workbench_events ORDER BY id DESC LIMIT 200) e
    JOIN (${OPEN_ASK_SQL}${NOT_ANSWERED}) o ON o.event_id = e.event_id
    ORDER BY o.asked_at, o.delivery_id`).all() as OpenSeatAsk[];
}

/** 一个投递正在等答复的那次提问：它所在的事件、提问那一行日志的 id（事项上的提问就是按它记的）、是哪一种提问 */
export function pendingAskOfDelivery(deliveryId: number): { event_id: string; ask_log_id: number; ask_kind: 'decision' | 'receipt' } | null {
  if (!tableExists('workbench_events')) return null;
  const row = db.prepare(`SELECT o.event_id, o.ask_log_id, o.ask_kind FROM (${OPEN_ASK_SQL}${NOT_ANSWERED}) o WHERE o.delivery_id = ?`).get(deliveryId) as { event_id: string; ask_log_id: number; ask_kind: 'decision' | 'receipt' } | undefined;
  return row ?? null;
}

/**
 * 一个投递当前这一轮提问（答没答过都算）：「关注」记账分轮用——答完之后键不变，重复答才认得出；再问一次是新的一轮。
 */
export function currentAskOfDelivery(deliveryId: number): { ask_log_id: number } | null {
  if (!tableExists('workbench_events')) return null;
  const row = db.prepare(`SELECT o.ask_log_id FROM (${OPEN_ASK_SQL}) o WHERE o.delivery_id = ?`).get(deliveryId) as { ask_log_id: number } | undefined;
  return row ?? null;
}

/** 待对接清单里这条外部身份这一次出现的序号（全局只增）；不在清单里返回 null（「关注」记账分轮用） */
export function pendingPrincipalAppearance(provider: string, externalId: string): number | null {
  const row = db.prepare('SELECT appearance FROM principal_pending WHERE provider = ? AND external_id = ?').get(provider, externalId) as { appearance: number } | undefined;
  return row?.appearance ?? null;
}
