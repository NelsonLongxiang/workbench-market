/**
 * 阶段七 R2：席位发来的消息（跟进）落在事项的对话里，不进「关注」。
 *
 * 跟进是同一 context 的普通 A2A 任务（a2a-…），没有机读标记分得出提问和通知；提问自 preview.13 起走
 * attention-<task>-<qid>，所以跟进一律当消息：照收、照回执（receipt-inbound.ts），在事项页的对话里给人看。
 *   · 未读：status = open。事项读接口带出未读条数，给事项页和以后的列表、全景做提示（不是待决）。
 *   · 看过：事项页打开时由看的人标成已读（acknowledged）。
 *   · 回复：同一 context 的新任务发回发消息的团队（只通知、没派出去的事件没有回写通道，不发），这条标成已回复。
 * 谁能看、谁能回复，和事项页同一个口径（管理员；建立人本人且事项可由建立人处理），在路由里判。
 * 这里只做事：记事件日志（事项只记录，不改状态），排发送；SQL 在 services/a2a-followups.ts、services/a2a-replies.ts。
 */
import { deliveryTarget, eventDispatched, inReplyTx, queueReply } from './services/a2a-replies.ts';
import { followupById, followupsOfEvent, markFollowupReplied, markFollowupsRead, unreadFollowupsOfEvent, type FollowupRow } from './services/a2a-followups.ts';
import { itemIdForEvent } from './services/work-item.ts';
import { latestProgressOfEvent, latestTicketsOfEvent } from './services/a2a-receipts.ts';
import { asksOfEvent } from './services/attention-sources.ts';
import { kickWorkbenchEvents, logDeliveryFact } from './workbench-events.ts';

export const SEAT_REPLY_MAX = 4000;

/** 事项 id → 事件 id（只有从工作台事件来的事项才有席位消息） */
export function eventOfItem(item: { id: string; source_ref?: string | null }): string | null {
  const ev = typeof item.source_ref === 'string' ? item.source_ref : '';
  return ev !== '' && itemIdForEvent(ev) === item.id ? ev : null;
}

export type SeatMessage = { id: number; sender: string; peer: string; text: string; truncated: boolean; at: string; status: 'unread' | 'read' | 'replied' | 'over-cap' };

const shown = (f: FollowupRow): SeatMessage => ({
  id: f.id, sender: f.sender, peer: f.peer_zone, text: f.text, truncated: f.truncated === 1, at: f.created_at,
  status: f.status === 'open' ? 'unread' : f.status === 'acknowledged' ? 'read' : f.status === 'replied' ? 'replied' : 'over-cap',
});

export function seatMessagesOf(item: { id: string; source_ref?: string | null }): { messages: SeatMessage[]; unread: number } {
  const ev = eventOfItem(item);
  if (!ev) return { messages: [], unread: 0 };
  return { messages: followupsOfEvent(ev).map(shown), unread: unreadFollowupsOfEvent(ev) };
}

/** 看过：把这件事项上未读的席位消息标成已读；标到了才记一行事件日志 */
export function markSeatMessagesRead(item: { id: string; source_ref?: string | null }, actor: string): number {
  const ev = eventOfItem(item);
  if (!ev) return 0;
  return inReplyTx(() => {
    const perDelivery = new Map<number, number>();
    for (const f of followupsOfEvent(ev)) if (f.status === 'open') perDelivery.set(f.delivery_id, (perDelivery.get(f.delivery_id) ?? 0) + 1);
    const n = markFollowupsRead(ev, actor);
    if (n > 0) for (const [delivery, count] of perDelivery) logDeliveryFact(ev, delivery, actor, 'followup-read', { count });
    return n;
  });
}

export type ReplyOutcome = { status: number; body: Record<string, unknown> };

/** 一条消息现在能不能回复（只有这一处）：没回复过（open、acknowledged）；超限只记日志的不能回复 */
const replyable = (f: FollowupRow): boolean => f.status === 'open' || f.status === 'acknowledged';
/** 事项结束了（办完、没办成、放弃、撤回）就不再回复席位消息 */
const ENDED = ['done', 'failed', 'dropped', 'cancelled'];

/** 这件事项上现在能回复的消息（事项详情的 can.reply 用，和回复接口同一个判断） */
export function replyableMessages(item: { id: string; source_ref?: string | null; state?: string }): FollowupRow[] {
  const ev = eventOfItem(item);
  if (!ev || (item.state !== undefined && ENDED.includes(item.state))) return [];
  return followupsOfEvent(ev).filter(replyable);
}

/** 回复一条席位消息：消息必须属于这件事项；超限只记日志的不能回复；已回复过的不再回复；事项结束了不能回复 */
export function replySeatMessage(item: { id: string; source_ref?: string | null; state?: string }, messageId: number, text: string, actor: string): ReplyOutcome {
  const ev = eventOfItem(item);
  const f = Number.isSafeInteger(messageId) && messageId > 0 ? followupById(messageId) : undefined;
  if (!ev || !f || f.event_id !== ev || f.status === 'rate-limited') return { status: 404, body: { error: 'seat_message_not_found' } };
  if (!replyable(f)) return { status: 409, body: { error: 'seat_message_not_open', status: f.status } };
  if (item.state !== undefined && ENDED.includes(item.state)) return { status: 409, body: { error: 'work_item_ended', state: item.state } };
  const target = deliveryTarget(f.delivery_id);
  const dispatched = eventDispatched(f.event_id);
  const queued = inReplyTx(() => {
    if (!markFollowupReplied(f.id, actor)) return null;
    const q = dispatched && !!target && queueReply({ kind: 'followup-reply', eventId: f.event_id, deliveryId: f.delivery_id, ref: f.id, qid: f.inbound_task,
      team: target.team, callerSession: target.caller_session, contextId: f.context_id, targetUrl: target.target_url, message: JSON.stringify({ text, by: actor }) }) !== null;
    logDeliveryFact(f.event_id, f.delivery_id, actor, 'followup-replied', { followup: f.id, text: text.slice(0, 500), sent: q });
    return q;
  });
  if (queued === null) return { status: 409, body: { error: 'seat_message_not_open' } };
  if (queued) kickWorkbenchEvents();
  return { status: 200, body: { ok: true, item_id: item.id, sent: queued, reason: queued ? 'queued' : dispatched ? 'not_queued' : 'event_not_dispatched' } };
}

/**
 * by：回执信封里的 by 原样（receipt-inbound 洗过）——对象 { seat, name?, team?, role? }，不是字符串；
 *   seat 是句柄 <zone>/<id8>，name 是对端自报的显示名，role 取 router（总工）/ member（成员）/ observer（观察者），旧节点不带 role。
 * tickets：[{ id, title, seat?, state, outcome? }]，state 取 queued / working / waiting / blocked / ended。
 */
export type SeatBy = { seat: string; name?: string; team?: string; role?: 'router' | 'member' | 'observer' };
export type SeatProgress = { n: number; state: string; summary: string; at: string; ahead?: number; by?: SeatBy; tickets: { id: string; title: string; seat?: string; state: string; outcome?: string }[]; received_at: string };

/**
 * 阶段七 PR-A：席位最近一步进展（progress-<task>-<n>），给事项页做「正在处理」的轻提示和子项（tickets，以最近一步的全量为准）。
 * 只是提示：不改事项状态；事项结束之后不再给。
 */
export function seatProgressOf(item: { id: string; source_ref?: string | null; state?: string }): SeatProgress | null {
  const ev = eventOfItem(item);
  if (!ev || ['done', 'failed', 'dropped', 'cancelled'].includes(item.state ?? '')) return null;
  const p = latestProgressOfEvent(ev);
  const step = p?.detail.progress as { n?: unknown; state?: unknown; summary?: unknown; at?: unknown; ahead?: unknown } | undefined;
  if (!p || !step || typeof step.n !== 'number' || typeof step.state !== 'string') return null;
  return {
    n: step.n, state: step.state, summary: typeof step.summary === 'string' ? step.summary : '', at: typeof step.at === 'string' ? step.at : '',
    ...(typeof step.ahead === 'number' ? { ahead: step.ahead } : {}), ...(p.detail.by && typeof p.detail.by === 'object' ? { by: p.detail.by as SeatBy } : {}),
    tickets: Array.isArray(p.detail.tickets) ? p.detail.tickets as SeatProgress['tickets'] : [], received_at: p.at,
  };
}

export type ItemAsk = { id: number; question: string; options: string[]; default?: string; status: 'open' | 'answered' | 'closed'; answer?: string; answered_by?: string; answered_at?: string; asked_by: string; at: string };

/**
 * 事项详情的提问列表（v1 的 decision:ask 和席位回执的提问都在里面，同一条只出现一次，按时间先后）：
 *   · id：提问那一行事件日志的 id，答复入口 POST /api/work-items/:id/asks/:qid/answer 用它；
 *   · status：open（投递当前在等它）、answered（事项上记了答复，带 answer、answered_by、answered_at）、
 *     closed（没答，被后来的提问、接单或结果合上了）；
 *   · options、default 只在席位回执带了结构化提问时有。可见范围和事项详情一致（在路由里判）。
 */
export function seatAsksOf(item: { id: string; source_ref?: string | null }): ItemAsk[] {
  const ev = eventOfItem(item);
  if (!ev) return [];
  return asksOfEvent(ev, item.id).map((r) => {
    let d: { summary?: unknown; reason?: unknown; question?: { text?: unknown; options?: unknown; default?: unknown } } = {};
    try { d = JSON.parse(r.detail || '{}'); } catch { /* 坏的 detail 当空 */ }
    const text = typeof d.question?.text === 'string' ? d.question.text : typeof d.summary === 'string' ? d.summary : typeof d.reason === 'string' ? d.reason : '';
    const options = Array.isArray(d.question?.options) ? (d.question!.options as unknown[]).filter((o): o is string => typeof o === 'string') : [];
    const dflt = typeof d.question?.default === 'string' ? d.question.default : undefined;
    const status: ItemAsk['status'] = r.answer !== null ? 'answered' : r.pending ? 'open' : 'closed';
    return {
      id: r.id, question: text, options, ...(dflt !== undefined ? { default: dflt } : {}), status,
      ...(r.answer !== null ? { answer: String(r.answer), answered_by: r.answered_by ?? '', answered_at: r.answered_at ?? '' } : {}),
      asked_by: r.actor, at: r.at,
    };
  });
}

/**
 * 子项（拆单 dsh-open-a2a-net#618）：最近一条带 tickets 的采信回执（结果回执里是各子项的结局，否则是最近一步进展）的全量快照，按子工单列出标题、承接、状态、结局。
 * 和 progress 不同，事项结束之后照样给——整件「没办成」而正文是「部分完成」时，页面靠它列出哪些子项完成、哪些失败。没有进展时是 []。
 */
export function seatSubitemsOf(item: { id: string; source_ref?: string | null }): SeatProgress['tickets'] {
  const ev = eventOfItem(item);
  if (!ev) return [];
  // 最近一条带子项的采信回执：结果回执（各子项的结局）晚于最后一步进展，以它为准
  return (latestTicketsOfEvent(ev) ?? []) as SeatProgress['tickets'];
}
