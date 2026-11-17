/** 事项详情页的纯函数：不碰 React，scripts/work-item-detail-ui-unit.mjs 直接测。 */
import type { AttentionItem } from './attention-view';
// 「谁」的写法只在 people.ts 一处（全站共用）；这里转出去，事项详情页照旧从这里引
import { actorLabel, membersText, personLabel, seatLabel, who, UNNAMED_SEAT } from './people.ts';
export { actorLabel, seatLabel, who };

/** 看的人对这件事项能做什么、是不是轮到他：直接取事项详情应答里的 can、turn（#587，和动作接口同一处判断），
 *  页面不再比对登录名、不看是不是管理员、也不绕道「关注」去猜。
 *  can：现在能不能做；turn：是不是轮到他。can 真而 turn 假 = 能代办。 */
export type Can = { release: boolean; answer: boolean; verify: boolean };
export const CAN_NONE: Can = { release: false, answer: false, verify: false };
export type Turn = { release: boolean; answer: boolean; verify: boolean };
export const TURN_NONE: Turn = { release: false, answer: false, verify: false };
const flags = (v: unknown): Can => {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : {};
  return { release: o.release === true, answer: o.answer === true, verify: o.verify === true };
};
/** 从详情应答取：字段缺了或形状不对一律当「不能、没轮到」，页面就只给中性说法、不给按钮 */
export function viewerOf(d: { can?: unknown; turn?: unknown; creator?: unknown } | null | undefined, fallbackCreator = ''): Viewer & { turn: Turn; reply: boolean | null } {
  const can = flags(d?.can), turn = flags(d?.turn);
  const c = d?.creator && typeof d.creator === 'object' ? d.creator as Record<string, unknown> : null;
  const name = personLabel(c) || fallbackCreator;
  const rc = d?.can && typeof d.can === 'object' ? (d.can as Record<string, unknown>).reply : undefined;
  return { mine: turn.answer || turn.verify, can, turn, creator: name, reply: typeof rc === 'boolean' ? rc : null };
}

/** 「等你处理」的一条在这一页能点哪些答法：按 can 筛——验收、打回要 can.verify；放行、撤回要 can.release；答复要 can.answer；
 *  别的答法照条目给的（来源自己的守卫已经决定了给谁看） */
const NEEDS_CAN: Record<string, keyof Can> = { verify: 'verify', return: 'verify', release: 'release', withdraw: 'release', answer: 'answer' };
export function choicesFor(item: Pick<AttentionItem, 'answers'>, can: Can): string[] {
  return item.answers.filter((a) => (NEEDS_CAN[a] ? can[NEEDS_CAN[a]] : true));
}
/** 这一条走哪个入口：轮到本人的验收、打回（条目的 mine 为真）走建立人入口；其余（代办）走答复入口 */
export function routeFor(item: Pick<AttentionItem, 'source' | 'category'> & { mine?: unknown }): 'creator' | 'attention' {
  return item.mine === true && item.source === 'work-items' && item.category === 'accept' ? 'creator' : 'attention';
}

/** 状态叫法（原型的人话）。中性叫法不带「你」；时间线、列表用它 */
const STATE_LABEL: Record<string, string> = {
  draft: '未派发', held: '等放行', delivered: '已转交', accepted: '已接手', progress: '在办', waiting: '在等', blocked: '在等答复',
  ready: '等验收', done: '已办结', failed: '没办成', dropped: '对方放弃了', cancelled: '已撤回',
};

/** 看的人和这件事的关系：mine = 这件事本来该找的人（答复、验收找建立人）；can = 有权限能代办的；creator = 建立人的显示名 */
export type Viewer = { mine: boolean; can: Can; creator: string; turn?: Turn };
export const VIEWER_NONE: Viewer = { mine: false, can: CAN_NONE, creator: '' };

/** 「你」指这件事本来该找的那个人，不是所有有权限的人：
 *  答复、验收找建立人——建立人看「在问你」「等你验收」，别人看「在问 alpha」「等 alpha 验收」（有权限的可以代办）；
 *  放行找有放行权限的人——他们看「等你过目」，别人看「等放行」。没有 viewer 时给中性叫法 */
/** 轮到谁：有 turn 用 turn；没有（旧的调用、单测里的简写）退回 mine 和 can.release */
const turnOfViewer = (v: Viewer): Turn => v.turn ?? { release: v.can.release, answer: v.mine, verify: v.mine };

export function stateLabel(state: string, viewer: Viewer = VIEWER_NONE): string {
  const name = viewer.creator;
  const t = turnOfViewer(viewer);
  if (state === 'held') return t.release ? '等你过目' : '等放行';
  if (state === 'blocked') return t.answer ? '在问你' : name ? `在问 ${name}` : STATE_LABEL.blocked;
  if (state === 'ready') return t.verify ? '等你验收' : name ? `等 ${name} 验收` : STATE_LABEL.ready;
  return STATE_LABEL[state] ?? state;
}

/** 一句话说清事项现在卡在哪、该谁动：页面顶上的提示条。终态和正常进行中不出提示 */
export function stateHint(state: string, seat: string, askAnswered = false, viewer: Viewer = VIEWER_NONE, canAnswerHere = true): { type: 'info' | 'warning' | 'success'; text: string } | null {
  const name = viewer.creator || '建立人';
  const t = turnOfViewer(viewer);
  switch (state) {
    case 'draft': return { type: 'info', text: '这件事项还没提交，没有派给任何团队。' };
    case 'held': return t.release
      ? { type: 'warning', text: '等你过目：你放行之后，才会派给团队。' }
      : { type: 'warning', text: viewer.can.release ? '在等放行；你可以代为放行。' : '在等放行：放行之后，才会派给团队。' };
    case 'delivered': return { type: 'info', text: '已经转交，在等团队接手。' };
    case 'accepted': return seat ? null : { type: 'info', text: '团队已经接手，还没说是哪个席位在做。' };
    case 'blocked':
      if (askAnswered) return { type: 'info', text: '提问已经答复，在等席位接着做。' };
      // 建立人在这一页答不了的时候（服务端还没开建立人答复的入口），不说「你答复之后」——他没地方答
      if (t.answer) return { type: 'warning', text: canAnswerHere ? '席位在问你：你答复之后它才能接着做。' : '席位在问你。这里还不能直接答复，先请管理员代答。' };
      return { type: 'warning', text: viewer.can.answer ? `席位在问 ${name}；你可以代答。` : `席位在问 ${name}，等 ${name} 答复。` };
    case 'ready':
      if (t.verify) return { type: 'success', text: '做完了，等你验收：通过就办结，打回就接着改。' };
      return { type: 'success', text: viewer.can.verify ? `做完了，等 ${name} 验收；你可以代为验收。` : `做完了，等 ${name} 验收。` };
    default: return null;
  }
}



/** 最近一个提问答过没有：日志里最后一条「答复」在最后一条「提问」之后（日志按 seq 递增） */
export function lastAskAnswered(log: { fact: string; rejected?: string }[]): boolean {
  let ask = -1, answer = -1;
  log.forEach((r, i) => { if (r.rejected) return; if (r.fact === 'ask') ask = i; if (r.fact === 'answer') answer = i; });
  return ask >= 0 && answer > ask;
}

/** 席位提问（阶段七：详情应答的 asks，按时间先后）。open 在等答复；answered 已答；closed 没人答、被后来的提问、接单或结果合上 */
export type SeatAsk = { id: string | number; question: string; options: string[]; default?: string; status: 'open' | 'answered' | 'closed'; answer?: string; answered_by?: string; answered_at?: string; asked_by: string; at: string };

/** 答复的请求体：选了选项就只给 answer（以它为准），否则给自由文本；都没有返回 null（不该提交） */
export function askAnswerBody(choice: string, text: string): { answer: string } | { text: string } | null {
  if (choice) return { answer: choice };
  const t = text.trim();
  return t ? { text: t } : null;
}

/** 提问区的初始选择：一律不预选。席位给的缺省项只标「席位建议」，人得自己点过一个选项（或写一句）才能提交，
 *  免得一下就把没真选的值发出去（协调裁定） */
export function initialChoice(_a: Pick<SeatAsk, 'options' | 'default'>): string {
  return '';
}

/** 时间线里提问、答复那一行对应哪条提问（详情 asks 的 id）：提问行是自己的 fact_id，答复行是 detail.ask_id */
export function askIdOf(r: { fact: string; fact_id?: string; detail: string }): string | null {
  if (r.fact === 'ask') return r.fact_id || null;
  if (r.fact !== 'answer') return null;
  try { const a = (JSON.parse(r.detail || '{}') as { ask_id?: unknown }).ask_id; return typeof a === 'string' || typeof a === 'number' ? String(a) : null; } catch { return null; }
}

/** 提问人：服务端给的 asked_by 常是来源标记（receiver:<区>），人看不懂；是这种时换成事项的承接席位，没有承接就去掉前缀 */
export function askerLabel(askedBy: unknown, seat: string): string {
  return actorLabel(askedBy, seat);
}
/** 对端给的一段文字：字符串、数字照用，别的给空串 */
export function textOf(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** 终态：结束了，对话不再收回复 */
export const TERMINAL = ['done', 'failed', 'dropped', 'cancelled'];

const bare = (p: string) => p.replace(/^(user|human|seat):/, '');
/** 建立人：以 creator_principal（真正提需求的人）为准；和 created_by（谁把它建进系统的）不同时注明谁发布的 */
export function creatorLabel(createdBy: string, creatorPrincipal?: string | null): string {
  const by = bare(createdBy || ''), who = bare(creatorPrincipal || '');
  if (!who) return by || '—';
  return by && by !== who ? `${who} · 由 ${by} 发布` : who;
}

type TimelineRow = { fact: string; fact_id?: string; detail: string; rejected?: string };
/** 时间线这一行叫什么：系统替旧提问补的「答复」（接单节点又问了一次、发来了结果、作出了决定，旧提问就合上）叫「提问作废」，不当成有人答了 */
export function timelineLabel(r: TimelineRow, facts: Record<string, string>): string {
  if (r.fact === 'answer' && (r.fact_id ?? '').includes(':closes-ask:')) return '提问作废';
  if (isProgressNote(r)) return '进展';
  return facts[r.fact] ?? r.fact;
}

/** 席位的进展回执在日志里记成一行备注（note=progress） */
export function isProgressNote(r: { fact: string; detail: string }): boolean {
  if (r.fact !== 'note') return false;
  try { return (JSON.parse(r.detail || '{}') as { note?: unknown }).note === 'progress'; } catch { return false; }
}

/** 不进时间线的行：人看过席位的消息（看一眼不是事项上的事实） */
export function hiddenInTimeline(r: TimelineRow): boolean {
  if (r.fact !== 'note') return false;
  try { return (JSON.parse(r.detail || '{}') as { note?: unknown }).note === 'followup-read'; } catch { return false; }
}

/** 时间线收组：连续两条以上的被拒行（终态之后才到、这时候不该有）收成一组，连续两条以上的进展收成一组；单独一条不收 */
export type TimelineGroup<T> = { kind: 'row'; row: T } | { kind: 'rejected' | 'progress'; rows: T[] };
export function groupTimeline<T extends { fact: string; detail: string; rejected?: string }>(rows: T[]): TimelineGroup<T>[] {
  const keyOf = (r: T): 'rejected' | 'progress' | null => (r.rejected ? 'rejected' : isProgressNote(r) ? 'progress' : null);
  const out: TimelineGroup<T>[] = [];
  for (const r of rows) {
    const k = keyOf(r), last = out[out.length - 1];
    if (k && last && last.kind === k) { last.rows.push(r); continue; }
    if (k && last && last.kind === 'row' && keyOf(last.row) === k) { out[out.length - 1] = { kind: k, rows: [last.row, r] }; continue; }
    out.push({ kind: 'row', row: r });
  }
  return out;
}

/** 进展回执的步骤状态（阶段七 #551） */
export const PROGRESS_STATE: Record<string, string> = { queued: '排队中', working: '正在处理', waiting: '在等', blocked: '卡住了' };

export type Ticket = { id: string; title: string; seat?: unknown; state: string; outcome?: string };
/** by 由对端回执来：可能是字符串，也可能是 { seat, name, team?, role? }（#564） */
export type SeatProgress = { n: number; state: string; summary: string; at: string; ahead?: number; by?: unknown; tickets: Ticket[]; received_at: string };

/** 进展一行字：第几步 · 状态 · 前面还有几个 */
export function progressLine(p: SeatProgress): string {
  return [`第 ${p.n} 步`, PROGRESS_STATE[p.state] ?? p.state, typeof p.ahead === 'number' && p.ahead > 0 ? `前面还有 ${p.ahead} 件` : ''].filter(Boolean).join(' · ');
}

/** 产物标识（结果 / 依据）：和回执信封的 artifacts 同一个形状——只有 kind、id，只存标识，不存正文、url、标题。 */
export type Artifact = { kind: string; id: string; title?: string | null; submitted_by?: string | null; at?: string | null };
const MAX_ARTIFACTS = 16;
const okStr = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '' && x.length <= 200;

/** 从一个值里取产物标识：只认数组里 kind、id 都是非空字符串（≤200 字）的项，别的字段（url、title……）一律不认，最多 16 项 */
export function artifactsOf(v: unknown): Artifact[] {
  if (!Array.isArray(v)) return [];
  const out: Artifact[] = [];
  for (const x of v) {
    if (out.length >= MAX_ARTIFACTS) break;
    const o = x as Record<string, unknown> | null;
    if (o && typeof o === 'object' && okStr(o.kind) && okStr(o.id)) {
      // title、submitted_by、at：#555 约定的三项，可能为 null（旧数据、对端没给）；只当文字显示
      out.push({ kind: o.kind, id: o.id, title: okStr(o.title) ? o.title : null, submitted_by: okStr(o.submitted_by) ? o.submitted_by : null, at: typeof o.at === 'string' && o.at.length <= 40 ? o.at : null });
    }
  }
  return out;
}

/** item.outputs / item.evidence：服务端存的 JSON 字符串（缺省 '{}' / '[]'，都按空读）；坏的当空 */
export function parseArtifacts(raw: string | null | undefined): Artifact[] {
  try { return artifactsOf(JSON.parse(raw || '[]')); } catch { return []; }
}

/** 日志里回执行带来的产物（detail.artifacts）：被拒的行不算 */
export function artifactsFromLog(log: { fact: string; detail: string; rejected?: string }[]): Artifact[] {
  const out: Artifact[] = [];
  for (const r of log) {
    if (r.fact !== 'receipt' || r.rejected) continue;
    try { out.push(...artifactsOf((JSON.parse(r.detail || '{}') as { artifacts?: unknown }).artifacts)); } catch { /* 坏的 detail 当空 */ }
  }
  return out;
}

/** 几处来的产物合在一起，按 kind + id 去重，保持先后 */
export function mergeArtifacts(...lists: Artifact[][]): Artifact[] {
  const seen = new Set<string>(); const out: Artifact[] = [];
  for (const a of lists.flat()) { const k = a.kind + '\u0000' + a.id; if (!seen.has(k)) { seen.add(k); out.push(a); } }
  return out;
}

/** 产物的本站链接：只按 kind 拼本站路径，不跟随数据里的任何地址（标识来自对端回执）。
 *  sop-run 的 id 是 <slug>/<runId> → /sops/<slug>/runs/<runId>；table、file 还没有详情页，不认得的 kind 也只显示 */
export function artifactHref(a: Artifact): string | null {
  if (a.kind !== 'sop-run') return null;
  // slug 和服务端 SLUG_RE 一致：小写字母数字和连字符，最长 64
  const m = /^([a-z0-9][a-z0-9-]{0,63})\/([1-9]\d{0,15})$/.exec(a.id);
  return m ? `/sops/${m[1]}/runs/${m[2]}` : null;
}

/** 「关注」里属于这件事项的条目（席位提问、等验收、过目放行……）：按条目的 link 对上事项页 */
export function pendingFor(items: AttentionItem[], itemId: string): AttentionItem[] {
  const link = `/work-items/${itemId}`;
  return items.filter((x) => x.link === link || x.link === `/work-items/${encodeURIComponent(itemId)}`);
}

/** 子项（拆单）的状态说法：结束了的按结局说（做完了 / 没办成……），在做的按步骤状态说；都不认得就原样 */
const TICKET_OUTCOME: Record<string, string> = { completed: '做完了', done: '做完了', failed: '没办成', cancelled: '取消了', canceled: '取消了', dropped: '放弃了', abandoned: '放弃了', rejected: '拒了' };
export function ticketStateLabel(state: string, outcome?: string): string {
  const s = (state || '').trim(), o = (outcome || '').trim();
  if (s === 'ended' || s === 'done') return TICKET_OUTCOME[o] ?? (o ? o : '结束了');
  const head = PROGRESS_STATE[s] ?? (s || '—');
  return o ? `${head} · ${TICKET_OUTCOME[o] ?? o}` : head;
}

/** 子项列表：详情的 subitems（#575）优先，没有就用进展里的 tickets；只收形状对的项 */
export function subitemsOf(subitems: unknown, progress: SeatProgress | null | undefined): Ticket[] {
  const raw = Array.isArray(subitems) && subitems.length ? subitems : Array.isArray(progress?.tickets) ? progress.tickets : [];
  return (raw as unknown[]).filter((t): t is Ticket => !!t && typeof t === 'object' && (typeof (t as Ticket).id === 'string' || typeof (t as Ticket).title === 'string'));
}

/** 承接：有席位就显示席位；拆单后主事项承接清空（#575），这时按在做的子项数成员「2 个成员在做：A、B」；都没有返回空串 */
export function seatSummary(seat: unknown, subitems: Ticket[]): string {
  const s = seatLabel(who(seat));
  if (s && s !== '-') return s;
  // 按不同的席位数人（两个查不到名字的成员是两个人），名字只写名字、查不到写「一位 AI 员工」
  const m = membersText(subitems.filter((t) => ['working', 'waiting', 'blocked'].includes(t.state)).map((t) => who(t.seat)), (x) => seatLabel(x));
  if (m.n > 1) return m.text ? `${m.n} 个成员在做：${m.text}` : `${m.n} 个成员在做`;
  return m.n === 1 ? (m.text || UNNAMED_SEAT) : '';
}

/** 「正在处理」只在事项还在做时给：结束了、等验收（ready）时上一次进展已经过时，不显示 */
export const showProgress = (state: string): boolean => !TERMINAL.includes(state) && state !== 'ready';

/** 时间线一行的「谁」：回执带了 by 就用 by（总工、成员各记各的）；没有 by 时只去掉来源前缀，不再拿事项的当前承接去顶 */
export function rowActor(row: { actor?: string; fact_source?: string; detail?: string }): string {
  let by: unknown = null;
  try { by = (JSON.parse(row.detail || '{}') as { by?: unknown }).by ?? null; } catch { /* 坏的 detail 当没有 */ }
  if (by && typeof by === 'object') {
    const o = by as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '', seat = typeof o.seat === 'string' ? o.seat.trim() : '';
    // 只写名字，不带句柄（协调 2026-11-12）；只有句柄时按席位的说法（一位 AI 员工）
    if (name) return name;
    if (seat) return actorLabel(seat, '');
  }
  if (typeof by === 'string' && by.trim()) return actorLabel(by, '');
  const raw = row.actor || row.fact_source || '';
  // receiver:<区> 只是「对端来的」这个来源标记，区名不是人：没有 by 就写「团队那边」
  if (/^receiver:/.test(raw)) return '团队那边';
  return actorLabel(raw, '');
}

/** 「承接」这一栏怎么写。有席位写席位；拆单在做写几个成员在做。没有席位时不一律说「没人接」，照事项走到哪一步说：
 *  还没派出去 / 已转交还没接手 / 团队接了还没说是哪个席位；已经结束的写谁做过（拆单写几个成员做过），一个都不知道就留空。
 *  team：团队怎么显示由页面给（people.ts 的 teamLabel；这个文件由 Node 直接加载做单测，只能引类型） */
export function seatLine(item: { seat?: unknown; state: string; target_team?: string | null }, subitems: Ticket[], team: (t: string) => string = (t) => t): string {
  const s = seatSummary(item.seat, subitems);
  if (s) return s;
  if (TERMINAL.includes(item.state)) {
    const m = membersText(subitems.map((t) => who(t.seat)), (x) => seatLabel(x));
    if (m.n > 1) return m.text ? `${m.n} 个成员做过：${m.text}` : `${m.n} 个成员做过`;
    return m.n === 1 ? `${m.text || UNNAMED_SEAT} 做过` : '';
  }
  if (item.state === 'draft' || item.state === 'held') return '还没派出去';
  const t = item.target_team ? team(item.target_team) : '';
  if (item.state === 'delivered') return t ? `已转交给 ${t}，还没接手` : '已转交，还没接手';
  return t ? `${t} 接了，还没说是哪个席位` : '团队接了，还没说是哪个席位';
}
