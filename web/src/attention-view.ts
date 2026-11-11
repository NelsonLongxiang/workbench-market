/** 「关注」页和事项页共用的纯函数（阶段八 8d）：不碰 React，scripts/attention-ui-unit.mjs 直接测。 */

export type Category = 'ask' | 'review' | 'accept' | 'glance' | 'grant';
export type AttentionItem = { source: string; source_id: string; category: Category; title: string; waiting_for: string; since: string; answers: string[]; object: string; phase: string; link: string };
export type LogRow = { seq: number; fact: string; fact_source: string; fact_id: string; from_state: string; to_state: string; actor: string; detail: string; at: string; rejected: '' | 'not_allowed' | 'terminal' };

/** since 是 SQLite UTC「YYYY-MM-DD HH:MM:SS」或 ISO；认不出返回 NaN */
export function sinceMs(since: string): number {
  if (!since) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since) ? since.replace(' ', 'T') + 'Z' : since);
}

/** 「等了多久」：空的显示「—」，认不出的原样 */
export function waited(since: string, now = Date.now()): string {
  if (!since) return '—';
  const t = sinceMs(since);
  if (isNaN(t)) return since;
  const m = Math.max(0, Math.floor((now - t) / 60000));
  if (m < 60) return `${m} 分钟`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时`;
  return `${Math.floor(m / 60 / 24)} 天`;
}

/** 等得最久的排前面；不知道从什么时候开始等的排最后（服务端给的先后保持不变） */
export function byWaited(items: AttentionItem[]): AttentionItem[] {
  return items.map((x, i) => ({ x, i, t: sinceMs(x.since) }))
    .sort((a, b) => (isNaN(a.t) ? 1 : 0) - (isNaN(b.t) ? 1 : 0) || (isNaN(a.t) ? 0 : a.t - b.t) || a.i - b.i)
    .map((e) => e.x);
}

/** 日志里的取值换成人话（接单判断、上报的状态、回执的结果）；不认得的原样 */
export const VERDICT: Record<string, string> = { accept: '接了', stop: '不做了', ignore: '不接', unavailable: '接不了' };
export const REPORT_STATUS: Record<string, string> = { progress: '在办', waiting: '在等', blocked: '在等答复', ready: '做完了', failed: '没办成', dropped: '对方放弃了' };
export const OUTCOME: Record<string, string> = { completed: '做完了', acknowledged: '收到了', failed: '没办成', rejected: '拒了', abandoned: '放弃了', dead: '投递失败' };

/** 一行事项日志的一句话说明：从 detail 里挑人看得懂的几样 */
export function describe(row: Pick<LogRow, 'detail'>): string {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(row.detail || '{}'); } catch { /* 坏的 detail 当空 */ }
  const note = d.note === 'unrouted' ? '没有目标团队' : d.note === 'untrusted' ? '提交方未验证，收到但未采信' : d.note === 'undispatched' ? '只通知、不派发，未派发' : d.note === 'followup' ? '席位发来的消息' : d.note === 'followup-reply' ? '人回复了席位的消息' : d.note === 'followup-read' ? '人看过席位的消息' : d.note === 'progress' ? '席位的进展' : '';
  const bits = [d.question, d.answer, d.summary, d.reason, (d.note === 'followup' || d.note === 'followup-reply' || d.note === 'progress') ? d.text : '', note, typeof d.verdict === 'string' && `判断：${VERDICT[d.verdict] ?? d.verdict}`, typeof d.status === 'string' && `状态：${REPORT_STATUS[d.status] ?? d.status}`, typeof d.outcome === 'string' && `结果：${OUTCOME[d.outcome] ?? d.outcome}`, d.late ? '晚到' : ''];
  return bits.filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
}

/** 建立人本人能答的（8e）：「等验收」的事项，验收、退回两种，走 POST /api/work-items/:id/decision */
export const CREATOR_ANSWERS = ['verify', 'return'];

/**
 * 这个人在「关注」里能直接答哪些：
 *   · 管理员：条目给的全部答法，走答复入口 /api/attention/answer（它在写请求总门后面，只有管理员过得去）；
 *   · 不是管理员：只有「等验收」的事项可以答验收、退回（列表里给不是管理员的事项都是他自己建的），走建立人入口；
 *     别的不给答法和提交按钮，只留「在原页面处理」（免得点下去被告知「需要管理员」）。
 */
export function answerChoices(admin: boolean, item: Pick<AttentionItem, 'source' | 'category' | 'answers'>): string[] {
  if (admin) return item.answers;
  if (item.source === 'work-items' && item.category === 'accept') return item.answers.filter((a) => CREATOR_ANSWERS.includes(a));
  return [];
}

/** 这一条用哪个入口答：不是管理员时建立人验收、退回走建立人入口，其余走答复入口 */
export function answerRoute(admin: boolean, item: Pick<AttentionItem, 'source' | 'category'>): 'creator' | 'attention' {
  return !admin && item.source === 'work-items' && item.category === 'accept' ? 'creator' : 'attention';
}
