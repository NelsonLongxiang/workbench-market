/** 事项详情页的纯函数：不碰 React，scripts/work-item-detail-ui-unit.mjs 直接测。 */
import type { AttentionItem } from './attention-view';

/** 看的人对这件事项能做什么：取自 /api/attention 里链接到这件事项、而且这个人确实有答法的条目（各来源的守卫决定给谁看、给什么答法），
 *  不按角色名猜。release：能放行（过目）；answer：能答席位的提问；verify：能验收 */
export type Can = { release: boolean; answer: boolean; verify: boolean };
export const CAN_NONE: Can = { release: false, answer: false, verify: false };
export function canOf(pending: AttentionItem[], choicesOf: (x: AttentionItem) => string[]): Can {
  const has = (pred: (x: AttentionItem) => boolean, ans?: string) => pending.some((x) => pred(x) && (ans ? choicesOf(x).includes(ans) : choicesOf(x).length > 0 || x.source === 'seat-asks'));
  return {
    release: has((x) => x.source === 'work-items' && x.category === 'glance', 'release'),
    // 「关注」只把提问给能答的人看（管理员，和事项的建立人本人）：看得到这条就能答
    answer: has((x) => x.source === 'seat-asks'),
    verify: has((x) => x.source === 'work-items' && x.category === 'accept', 'verify'),
  };
}

/** 状态叫法（原型的人话）。带「你」的说法只给确实该动手的人：能放行的看「等你过目」，能答的看「在问你」，能验收的看「等你验收」 */
const STATE_LABEL: Record<string, string> = {
  draft: '未派发', held: '等放行', delivered: '已转交', accepted: '已接手', progress: '在办', waiting: '在等', blocked: '在等答复',
  ready: '等验收', done: '已办结', failed: '没办成', dropped: '对方放弃了', cancelled: '已撤回',
};
export function stateLabel(state: string, can: Can = CAN_NONE): string {
  if (state === 'held' && can.release) return '等你过目';
  if (state === 'blocked' && can.answer) return '在问你';
  if (state === 'ready' && can.verify) return '等你验收';
  return STATE_LABEL[state] ?? state;
}

/** 一句话说清事项现在卡在哪、该谁动：页面顶上的提示条。终态和正常进行中不出提示。同样只在看的人该动手时说「你」 */
export function stateHint(state: string, seat: string, askAnswered = false, can: Can = CAN_NONE): { type: 'info' | 'warning' | 'success'; text: string } | null {
  switch (state) {
    case 'draft': return { type: 'info', text: '这件事项还没提交，没有派给任何团队。' };
    case 'held': return can.release
      ? { type: 'warning', text: '等你过目：你放行之后，才会派给团队。' }
      : { type: 'warning', text: '在等放行：有放行权限的人放行之后，才会派给团队。' };
    case 'delivered': return { type: 'info', text: '已经转交，在等团队接手。' };
    case 'accepted': return seat ? null : { type: 'info', text: '团队已经接手，还没说是哪个席位在做。' };
    case 'blocked':
      if (askAnswered) return { type: 'info', text: '提问已经答复，在等席位接着做。' };
      return can.answer ? { type: 'warning', text: '席位在问你：你答复之后它才能接着做。' } : { type: 'warning', text: '席位在等答复：答复之后它才能接着做。' };
    case 'ready': return can.verify
      ? { type: 'success', text: '做完了，等你验收：通过就办结，打回就接着改。' }
      : { type: 'success', text: '做完了，等建立人验收。' };
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

/** 提问区的初始选择：有缺省选项且确实在选项里就预选它 */
export function initialChoice(a: Pick<SeatAsk, 'options' | 'default'>): string {
  return a.default && a.options.includes(a.default) ? a.default : '';
}

/** 时间线里提问、答复那一行对应哪条提问（详情 asks 的 id）：提问行是自己的 fact_id，答复行是 detail.ask_id */
export function askIdOf(r: { fact: string; fact_id?: string; detail: string }): string | null {
  if (r.fact === 'ask') return r.fact_id || null;
  if (r.fact !== 'answer') return null;
  try { const a = (JSON.parse(r.detail || '{}') as { ask_id?: unknown }).ask_id; return typeof a === 'string' || typeof a === 'number' ? String(a) : null; } catch { return null; }
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
  return facts[r.fact] ?? r.fact;
}

/** 不进时间线的行：人看过席位的消息（看一眼不是事项上的事实） */
export function hiddenInTimeline(r: TimelineRow): boolean {
  if (r.fact !== 'note') return false;
  try { return (JSON.parse(r.detail || '{}') as { note?: unknown }).note === 'followup-read'; } catch { return false; }
}

/** 连续的被拒行（终态之后才到、这时候不该有）收成一组，免得一串「收到，未采信」刷屏；单独一条不收 */
export function groupRejected<T extends { rejected?: string }>(rows: T[]): ({ kind: 'row'; row: T } | { kind: 'rejected'; rows: T[] })[] {
  const out: ({ kind: 'row'; row: T } | { kind: 'rejected'; rows: T[] })[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (r.rejected && last && last.kind === 'rejected') { last.rows.push(r); continue; }
    if (r.rejected && last && last.kind === 'row' && last.row.rejected) { out[out.length - 1] = { kind: 'rejected', rows: [last.row, r] }; continue; }
    out.push({ kind: 'row', row: r });
  }
  return out;
}

/** 进展回执的步骤状态（阶段七 #551） */
export const PROGRESS_STATE: Record<string, string> = { queued: '排队中', working: '正在处理', waiting: '在等', blocked: '卡住了' };

export type Ticket = { id: string; title: string; seat?: string; state: string; outcome?: string };
export type SeatProgress = { n: number; state: string; summary: string; at: string; ahead?: number; by?: string; tickets: Ticket[]; received_at: string };

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
