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

/** 一行事项日志的一句话说明：从 detail 里挑人看得懂的几样 */
export function describe(row: Pick<LogRow, 'detail'>): string {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(row.detail || '{}'); } catch { /* 坏的 detail 当空 */ }
  const note = d.note === 'unrouted' ? '没有目标团队' : d.note === 'untrusted' ? '提交方未验证，收到但未采信' : '';
  const bits = [d.question, d.answer, d.summary, d.reason, note, d.verdict && `判断：${d.verdict}`, d.status && `状态：${d.status}`, d.outcome && `结果：${d.outcome}`, d.late ? '晚到' : ''];
  return bits.filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
}

/**
 * 这个人在「关注」里能不能直接答：答复入口和别的 /api 写一样先过写请求总门，只有管理员过得去。
 * 不是管理员的，不给答法和提交按钮，只留「在原页面处理」（免得点下去被告知「需要管理员」）。
 */
export function answerChoices(admin: boolean, answers: string[]): string[] {
  return admin ? answers : [];
}
