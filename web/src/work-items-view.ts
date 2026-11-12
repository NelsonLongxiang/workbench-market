/** 事项列表页的纯函数：不碰 React，scripts/work-items-ui-unit.mjs 直接测。
 *  数据来自 GET /api/work-items：按视角给（我安排的 / 我的 AI 员工手上的 / 我的团队的 / 全部），哪些能用由服务端按身份定。 */

export type WorkItemListRow = {
  id: string; title: string; state: string; object: string | null; phase: string | null; seat: string | null;
  last_progress: { actor: string; fact: string; text: string; at: string } | null;
  updated_at: string;
  /** 未读的席位消息数；服务端还没给时缺省，当 0 */
  unread?: number;
};
export type WorkItemListPage = {
  items: WorkItemListRow[]; counts: Record<string, number>; total: number; next_cursor: string | null;
  /** 这一页是哪个视角（不带 view 时服务端挑第一个有内容的）、各视角能不能用和件数；旧服务端没有这两个字段 */
  view?: ViewKey | null; views?: Record<ViewKey, { available: boolean; count: number }>;
};

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

/** 「等拍板」那几种状态（等放行、在问、等验收）里不轮到你的，另成一组「等别人处理」，中性色；
 *  每一行写清等谁。轮到不轮到你由页面传进来（「关注」里的同一个判法，见 attention-view 的 workItemTurns），这里不判 */
export const OTHERS_GROUP = { key: 'others', title: '等别人处理', empty: '没有在等别人处理的事项' };
export const isDecideState = (state: string): boolean => groupOf(state) === 'decide';
/** 不能当场办时这一行等的是谁：name 是建立人的显示名（「关注」条目带的），等验收没有名字就说「建立人」，不露标识 */
export function othersTurnLabel(state: string, name = ''): string {
  const who = name.trim();
  if (state === 'ready') return who ? `等 ${who} 验收` : '等建立人验收';
  // 在问：不知道问的是谁（「关注」里没有这一条，可能问的正是你、只是不能在这里答）就不说是谁
  if (state === 'blocked') return who ? `在等 ${who} 答复` : '在等答复';
  if (state === 'held') return '等管理员放行';
  return '';
}
/** 把「等拍板」状态的行分成轮到你的、等别人的；件数：轮到你的数已取回的行，等别人的 = 服务端这几种状态的总数减去它（总数覆盖整个视角） */
export function splitDecide(rows: WorkItemListRow[], mine: ReadonlySet<string>, decideTotal: number): { mine: WorkItemListRow[]; others: WorkItemListRow[]; mineCount: number; othersCount: number } {
  const m = rows.filter((r) => isDecideState(r.state) && mine.has(r.id));
  const o = rows.filter((r) => isDecideState(r.state) && !mine.has(r.id));
  return { mine: m, others: o, mineCount: m.length, othersCount: Math.max(0, decideTotal - m.length) };
}

/** 一组的总数：取服务端给的按状态计数（覆盖整个可见范围），不靠已取回的行来数 */
export function groupCount(counts: Record<string, number>, key: string): number {
  const g = STATE_GROUPS.find((x) => x.key === key);
  return g ? g.states.reduce((n, s) => n + (Number(counts[s]) || 0), 0) : 0;
}

/** 对象（哪条线）、阶段的显示名：从生命周期读接口取（和全景同一处）。代号不露给人：
 *  线没有名字写「未命名的线」；阶段查不到名字就不写这一格 */
// 线和阶段的名字只在 names.ts 一处；列表页一直叫 objectName / phaseName，这里转一下名字
import { NO_NAMES, UNNAMED_LINE, lifecycleNames, lineName as objectName, stageName as phaseName, type Names } from './names.ts';
export { NO_NAMES, UNNAMED_LINE, lifecycleNames, objectName, phaseName, type Names };

/** 最后一条进展怎么写成一句人话。节点给的原文像「completed：工单「…」已结束（completed）：【…结果回执】正文…」：
 *  开头的结局代号换成中文（做完了、没办成……），去掉节点自带的套话和代号，只留正文的头一句；清不出正文就只写结局。 */
const RESULT: Record<string, string> = { completed: '做完了', acknowledged: '收到了', failed: '没办成', rejected: '拒了', abandoned: '放弃了', dead: '投递失败', cancelled: '取消了', canceled: '取消了' };
const CODES = Object.keys(RESULT).join('|');
export function progressSummary(text: string, max = 40): string {
  let t = (text || '').trim();
  let result = '';
  const m = new RegExp(`^(${CODES})\\s*[：:]\\s*`).exec(t);
  if (m) { result = RESULT[m[1]]; t = t.slice(m[0].length); }
  else if (new RegExp(`^(${CODES})$`).test(t)) return RESULT[t];
  t = t.replace(/^工单「[^」]*」\s*已结束\s*/, '')
    .replace(new RegExp(`[（(]\\s*(${CODES})\\s*[）)]`, 'g'), '')
    .replace(/^[：:，,\s]+/, '')
    .replace(/^(【[^】]*】\s*)+/, '')
    .replace(/^[：:，,\s]+/, '');
  let first = t.split(/[。\n；;！!？?]/)[0].trim();
  if ([...first].length > max) first = [...first].slice(0, max).join('') + '…';
  // 清完还剩代号、括号这类东西就不要正文了
  if (new RegExp(`\\b(${CODES})\\b`).test(first) || /[【】]/.test(first)) first = '';
  return [result, first].filter(Boolean).join(' · ');
}

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

/** 「谁」怎么写由页面传进来（people.ts 的 seatLabel / actorLabel，和详情页同一套）；这里只管拼。
 *  这个文件由 Node 直接加载做单测，只能引类型，所以不直接 import people.ts */
export type Who = { seat: (s: string) => string; /** seat：这件事的承接席位，来源标记 receiver:<区> 用它顶上 */ actor: (s: string, seat: string) => string };
const PLAIN: Who = { seat: (s) => s, actor: (s) => s };

/** 没有席位时的说法：还没派出去（草稿、等放行）和派出去了还没席位接手，分开说 */
export function seatOrWaiting(r: Pick<WorkItemListRow, 'seat' | 'state'>, who: Who = PLAIN): string {
  const s = r.seat && r.seat !== '-' ? who.seat(r.seat) : '';
  if (s) return s;
  return ['draft', 'held'].includes(r.state) ? '还没派出去' : ['done', 'failed', 'dropped', 'cancelled'].includes(r.state) ? '' : '还没说是哪个席位';
}

/** 行的第二行说明：位置（对象·阶段；按对象分组时整段省掉，阶段另作标签显示）· 席位 · 最后一条进展 */
export function rowLine(r: WorkItemListRow, mode: 'state' | 'object', who: Who = PLAIN, names: Names = NO_NAMES): string {
  const place = mode === 'state' ? [objectName(r.object, names), phaseName(r.phase, names)].filter(Boolean).join(' · ') : '';
  const seat = seatOrWaiting(r, who);
  const lp = r.last_progress;
  // 说话的就是承接席位时不重复写一遍名字
  const actor = lp?.actor ? who.actor(lp.actor, r.seat ?? '') : '';
  const raw = r.seat ?? '';
  const sameAsSeat = !!actor && [seat, raw, ...raw.split(' · ')].includes(actor);
  const said = lp ? lastSaid(lp) : '';
  const last = said ? `${actor && !sameAsSeat ? `${actor}：` : ''}${said}` : '';
  return [place, seat, last].filter(Boolean).join(' · ');
}

/** 行右边的时间：最后一条进展的时间，没有（或是空串）就用事项的更新时间 */
export const rowTime = (r: Pick<WorkItemListRow, 'last_progress' | 'updated_at'>): string => r.last_progress?.at || r.updated_at;

/** 追加下一页：按 id 去重（翻页期间有事项变化时，同一行可能在两页都出现），后到的覆盖先到的 */
export function appendPage(prev: WorkItemListRow[], next: WorkItemListRow[]): WorkItemListRow[] {
  const seen = new Set(next.map((r) => r.id));
  return [...prev.filter((r) => !seen.has(r.id)), ...next];
}

/** 视角（规范 14 第九节）：我安排的 / 我的 AI 员工手上的 / 我的团队的 / 全部。哪些能用、各几件由列表接口按身份给（views，#626）；
 *  页面只出 available 为真的，按这个先后排；接口没给 views（旧服务端）就一个都不出，不自己猜。 */
export type ViewKey = 'mine' | 'seats' | 'team' | 'all';
export const VIEW_LABEL: Record<ViewKey, string> = { mine: '我安排的', seats: '我的 AI 员工手上的', team: '我的团队的', all: '全部' };
export type View = { key: ViewKey; label: string; count: number };
export function viewsFor(views: unknown): View[] {
  if (!views || typeof views !== 'object') return [];
  const v = views as Record<string, { available?: unknown; count?: unknown } | undefined>;
  return (Object.keys(VIEW_LABEL) as ViewKey[])
    .filter((k) => v[k]?.available === true)
    .map((k) => ({ key: k, label: VIEW_LABEL[k], count: Math.max(0, Number(v[k]?.count) || 0) }));
}

/** 一个视角里一件都没有时怎么说：各说各的；按某个 AI 员工筛着时说这个员工手上 */
export function emptyText(view: ViewKey | null | undefined, seat?: string): string {
  if (seat) return '这个 AI 员工手上现在没有事项';
  switch (view) {
    case 'mine': return '你还没有安排过事项';
    case 'seats': return '你的 AI 员工手上现在没有事项';
    case 'team': return '你的团队现在没有事项';
    case 'all': return '还没有事项';
    default: return '你现在没有能看的事项';
  }
}

/** 行首圆标里的那个字：名字的第一个字 */
export function avatarChar(name: string): string {
  const s = (name || '').trim();
  // 只有句柄（<区>/<编号>）时没有有意义的字：返回空串，页面放一个中性的席位图标
  if (!s || s.includes('/')) return '';
  return [...s][0].toUpperCase();
}

/** 最后一条进展是哪一种事（验收、打回、撤回……）也要说出来：这些事常常没有正文。
 *  正文只是一个内部代号（followup-read 这类）时不显示正文 */
const FACT_WORD: Record<string, string> = { withdraw: '撤回了', verify: '验收通过', return: '打回重做', release: '放行了', ask: '在问', answer: '答复了' };
export function lastSaid(lp: { fact?: string; text?: string }): string {
  const raw = (lp.text || '').trim();
  const body = /^[a-z][a-z0-9_-]*$/.test(raw) && !RESULT[raw] ? '' : progressSummary(raw);
  const word = Object.hasOwn(FACT_WORD, lp.fact || '') ? FACT_WORD[lp.fact || ''] : undefined;
  if (!word) return body;
  // 正文就是这件事的名字（「验收通过」）时不重复
  return body && body !== word ? `${word}：${body}` : word;
}

/** 地址里带的视角和席位（驾驶舱「AI 员工」点卡跳过来是 ?view=seats&seat=…）：只认四个视角名、席位不超过 200 字；认不出的当没带。
 *  返回给列表接口的参数（GET /api/work-items?view=&seat=，#626） */
export const VIEW_NAMES = ['mine', 'seats', 'team', 'all'] as const;
export function urlFilter(search: string): { view?: string; seat?: string } {
  const q = new URLSearchParams(search);
  const view = q.get('view') ?? '';
  const seat = (q.get('seat') ?? '').trim();
  return { ...((VIEW_NAMES as readonly string[]).includes(view) ? { view } : {}), ...(seat && seat.length <= 200 && !/[\u0000-\u001f]/.test(seat) ? { seat } : {}) };
}
