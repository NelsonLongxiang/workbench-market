/** 事项列表页的纯函数：不碰 React，scripts/work-items-ui-unit.mjs 直接测。
 *  数据来自 GET /api/work-items（可见范围同详情：管理员看全部，别人只看自己建立的）。 */

export type WorkItemListRow = {
  id: string; title: string; state: string; object: string | null; phase: string | null; seat: string | null;
  last_progress: { actor: string; fact: string; text: string; at: string } | null;
  updated_at: string;
  /** 未读的席位消息数；服务端还没给时缺省，当 0 */
  unread?: number;
};
export type WorkItemListPage = { items: WorkItemListRow[]; counts: Record<string, number>; total: number; next_cursor: string | null };

/** 按状态分的四组。「未派发」是只通知、没有目标团队的事件建出来的草稿，不是待办，缺省折叠。 */
export const STATE_GROUPS: { key: string; title: string; states: string[]; collapsed?: boolean; empty: string }[] = [
  { key: 'decide', title: '等你拍板', states: ['blocked', 'ready', 'held'], empty: '没有要你拍板的事项' },
  { key: 'doing', title: '在办', states: ['delivered', 'accepted', 'progress', 'waiting'], empty: '没有在办的事项' },
  { key: 'closed', title: '已结束', states: ['done', 'failed', 'dropped', 'cancelled'], empty: '没有已结束的事项' },
  { key: 'draft', title: '未派发', states: ['draft'], collapsed: true, empty: '没有未派发的事项' },
];

/** 状态归哪一组；不认识的状态归「在办」，宁可多看见也不藏起来 */
export function groupOf(state: string): string {
  return STATE_GROUPS.find((g) => g.states.includes(state))?.key ?? 'doing';
}

/** 一组的总数：取服务端给的按状态计数（覆盖整个可见范围），不靠已取回的行来数 */
export function groupCount(counts: Record<string, number>, key: string): number {
  const g = STATE_GROUPS.find((x) => x.key === key);
  return g ? g.states.reduce((n, s) => n + (Number(counts[s]) || 0), 0) : 0;
}

/** 显示名的映射：对象、阶段之后从观测层取，席位之后从席位名册取；现在没有来源，返回原值，空值返回空串（页面就不显示那一格） */
export const objectName = (id: string | null | undefined): string => id ?? '';
export const phaseName = (id: string | null | undefined): string => id ?? '';
export const seatName = (id: string | null | undefined): string => id ?? '';

/** 按状态分组：每组里保持服务端给的先后（最近变化的在前） */
export function byState(rows: WorkItemListRow[]): Record<string, WorkItemListRow[]> {
  const out: Record<string, WorkItemListRow[]> = Object.fromEntries(STATE_GROUPS.map((g) => [g.key, []]));
  for (const r of rows) out[groupOf(r.state)].push(r);
  return out;
}

export const NO_OBJECT = '';
/** 按对象分组：有对象的按对象标识排，没关联对象的放最后；组内保持服务端的先后 */
export function byObject(rows: WorkItemListRow[]): { object: string; rows: WorkItemListRow[] }[] {
  const m = new Map<string, WorkItemListRow[]>();
  for (const r of rows) {
    const k = r.object || NO_OBJECT;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === NO_OBJECT ? 1 : 0) - (b === NO_OBJECT ? 1 : 0) || a.localeCompare(b))
    .map(([object, rs]) => ({ object, rows: rs }));
}

/** 行的第二行说明：位置（对象·阶段；按对象分组时整段省掉，阶段另作标签显示）· 席位（没有就「还没派」）· 最后一条进展 */
export function rowLine(r: WorkItemListRow, mode: 'state' | 'object'): string {
  const place = mode === 'state' ? [objectName(r.object), phaseName(r.phase)].filter(Boolean).join('·') : '';
  const seat = seatName(r.seat) || '还没派';
  const lp = r.last_progress;
  const last = lp && lp.text ? `${lp.actor ? `${lp.actor}：` : ''}${lp.text}` : '';
  return [place, seat, last].filter(Boolean).join(' · ');
}

/** 追加下一页：按 id 去重（翻页期间有事项变化时，同一行可能在两页都出现），后到的覆盖先到的 */
export function appendPage(prev: WorkItemListRow[], next: WorkItemListRow[]): WorkItemListRow[] {
  const seen = new Set(next.map((r) => r.id));
  return [...prev.filter((r) => !seen.has(r.id)), ...next];
}
