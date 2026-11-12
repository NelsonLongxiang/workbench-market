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

/** 对象（哪条线）、阶段的显示名：从生命周期读接口取（和全景同一处）。代号不露给人：
 *  线没有名字写「未命名的线」；阶段查不到名字就不写这一格 */
export type Names = { objects: Record<string, string>; stages: Record<string, string> };
export const NO_NAMES: Names = { objects: {}, stages: {} };
export const UNNAMED_LINE = '未命名的线';
export const objectName = (id: string | null | undefined, names: Names = NO_NAMES): string => (id ? names.objects[id] || UNNAMED_LINE : '');
export const phaseName = (code: string | null | undefined, names: Names = NO_NAMES): string => (code ? names.stages[code] || '' : '');

/** 把生命周期的阶段码表和对象列表拍平成名字表；形状不对的项跳过，没有名字的不收 */
export function lifecycleNames(types: unknown, objects: unknown): Names {
  const out: Names = { objects: {}, stages: {} };
  for (const t of Array.isArray(types) ? types : []) {
    const st = t && typeof t === 'object' && Array.isArray((t as { stages?: unknown }).stages) ? (t as { stages: unknown[] }).stages : [];
    for (const x of st) { const o = x as { code?: unknown; name?: unknown } | null; if (o && typeof o.code === 'string' && typeof o.name === 'string' && o.name.trim()) out.stages[o.code] = o.name.trim(); }
  }
  for (const x of Array.isArray(objects) ? objects : []) { const o = x as { id?: unknown; name?: unknown } | null; if (o && typeof o.id === 'string' && typeof o.name === 'string' && o.name.trim()) out.objects[o.id] = o.name.trim(); }
  return out;
}

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

/** 视角（规范 14 第九节）：我安排的 / 我的 AI 员工手上的 / 我团队的 / 全部。哪些可用、各几件以后由服务端按身份给；
 *  现在的列表接口只有一个可见范围——管理员看全部，别人只看自己建立的——所以只给得出这一个，不放还不能用的视角。 */
export type View = { key: 'mine' | 'all'; label: string; count: number };
export function viewsFor(seesAll: boolean, total: number): View[] {
  return [seesAll ? { key: 'all', label: '全部', count: total } : { key: 'mine', label: '我安排的', count: total }];
}

/** 名册（GET /api/a2a/teams）拍平成「句柄 → 名字」；形状不对的项跳过，没有名字的不收 */
export function rosterNames(teams: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(teams)) return out;
  for (const t of teams) {
    const seats = t && typeof t === 'object' && Array.isArray((t as { seats?: unknown }).seats) ? (t as { seats: unknown[] }).seats : [];
    for (const x of seats) {
      const o = x as { seat?: unknown; name?: unknown } | null;
      if (o && typeof o.seat === 'string' && typeof o.name === 'string' && o.name.trim()) out[o.seat] = o.name.trim();
    }
  }
  return out;
}

/** 列表行里的席位只写名字（句柄在详情里才带）：事项上是「名字 · 句柄」取名字；只有句柄时查名册，查不到才显示句柄 */
export function seatNameOnly(seat: string, roster: Record<string, string> = {}): string {
  const s = (seat || '').trim();
  if (!s || s === '-') return '';
  const k = s.lastIndexOf(' · ');
  if (k > 0) return s.slice(0, k);
  return roster[s] ?? s;
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
  const word = FACT_WORD[lp.fact || ''];
  if (!word) return body;
  return body ? `${word}：${body}` : word;
}
