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

/** 回复一条席位消息：消息必须属于这件事项；超限只记日志的不能回复；已回复过的不再回复 */
export function replySeatMessage(item: { id: string; source_ref?: string | null }, messageId: number, text: string, actor: string): ReplyOutcome {
  const ev = eventOfItem(item);
  const f = Number.isSafeInteger(messageId) && messageId > 0 ? followupById(messageId) : undefined;
  if (!ev || !f || f.event_id !== ev || f.status === 'rate-limited') return { status: 404, body: { error: 'seat_message_not_found' } };
  if (f.status !== 'open' && f.status !== 'acknowledged') return { status: 409, body: { error: 'seat_message_not_open', status: f.status } };
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
