/** 「关注」页和事项页共用的纯函数（阶段八 8d）：不碰 React，scripts/attention-ui-unit.mjs 直接测。 */

export type Category = 'ask' | 'review' | 'accept' | 'glance' | 'grant';
export type AttentionItem = { source: string; source_id: string; category: Category; title: string; waiting_for: string; since: string; answers: string[]; object: string; phase: string; link: string;
  /** 只增的字段（#580）：变更申请带 detail（要动什么、影响多大）；统一待办带 kind（任务、SOP 执行……，它们不是审核） */
  detail?: unknown; kind?: string;
  /** #587：是不是轮到你（验收、提问对代办的人是 false）；事项和提问的条目带建立人 */
  mine?: boolean; creator?: { principal?: string; display_name?: string | null } | null;
  /** 条目自带的答复入口（见文件末尾的 answer_via 约定）；没带的照旧发 /api/attention/answer */
  answer_via?: unknown };
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
export function answerChoices(admin: boolean, item: Pick<AttentionItem, 'source' | 'category' | 'answers'> & { answer_via?: unknown; source_id?: string }): string[] {
  // 条目自带答复入口：能不能办由那个入口自己判，服务端只把它列给办得了的人——不看是不是管理员
  const via = answerViaOf(item);
  if (via) return viaChoices(via, item.answers);
  if (admin) return item.answers;
  // 阶段七 #567：席位的提问只给建立人本人列出来，建立人在事项的提问入口答（POST /api/work-items/:id/asks/:qid/answer）
  if (item.source === 'seat-asks') return item.answers.filter((a) => a === 'answer');
  if (item.source === 'work-items' && item.category === 'accept') return item.answers.filter((a) => CREATOR_ANSWERS.includes(a));
  return [];
}

/** 这一条用哪个入口答：条目自带答复入口的照它发（via）；不是管理员时，验收、打回走建立人入口，席位提问走事项的提问入口；其余（管理员）走答复入口 */
export function answerRoute(admin: boolean, item: Pick<AttentionItem, 'source' | 'category'> & { answer_via?: unknown; source_id?: string }): 'creator' | 'ask' | 'attention' | 'via' {
  if (answerViaOf(item)) return 'via';
  if (!admin && item.source === 'seat-asks') return 'ask';
  return !admin && item.source === 'work-items' && item.category === 'accept' ? 'creator' : 'attention';
}

/** 「等你拍板」的排法：能当场办的在前（在问、等验收、等过目、核准、其他），要跳到别处处理的（没有答法的，如「等你审核」）收在后面一组；
 *  组里按等得久的在前 */
/** 是不是轮到你：只看条目的 mine（#587）；没带这个字段的旧应答当作轮到你 */
export const isMine = (x: { mine?: unknown }): boolean => x.mine !== false;

/** 「等你拍板」的件数——侧栏角标、总结句、卡片区的数都用它：轮到你、而且能当场办的 */
export function decideCount(items: AttentionItem[], choicesOf: (x: AttentionItem) => string[]): number {
  return items.filter((x) => isMine(x) && choicesOf(x).length > 0).length;
}

const ORDER: Record<string, number> = { ask: 0, accept: 1, glance: 2, grant: 3, review: 4 };
export function groupCards(items: AttentionItem[], choicesOf: (x: AttentionItem) => string[]): { now: AttentionItem[]; proxy: AttentionItem[]; elsewhere: AttentionItem[] } {
  const sorted = byWaited(items).map((x, i) => ({ x, i })).sort((a, b) => (ORDER[a.x.category] ?? 9) - (ORDER[b.x.category] ?? 9) || a.i - b.i).map((e) => e.x);
  // 三组：轮到你、能当场办的（这才是「等你拍板」）；别人的事、你能代办的（条目的 mine 为假）；要到别处处理的（没有当场的答法）
  const can = sorted.filter((x) => choicesOf(x).length > 0);
  return { now: can.filter(isMine), proxy: can.filter((x) => !isMine(x)), elsewhere: sorted.filter((x) => choicesOf(x).length === 0) };
}

/** 「等你拍板」条目自带的答复入口（answer_via 约定）：条目说清用什么方法、发到哪个地址、每个答法的请求体和要填的东西，
 *  卡片照着发，不按来源逐个写死地址。单测在 scripts/answer-via-unit.mjs。
 *
 *    answer_via: { method: 'POST' | 'PUT', path: '/api/…',
 *      answers: { <答法>: { body: {…}, input?: { <填写项>: { to: '<请求体的键>', required?: true, max?: N } } } } }
 *
 *  · 请求体 = { ...body, [to]: 填的值 }；没填的选填项不带。
 *  · 没带 answer_via 的条目照旧发 /api/attention/answer。
 *  · 应答是那个地址自己的：2xx 算办成；4xx 是 { error, message? }，有 message 原样给人看。
 *  · 地址只认同源、以 /api/ 开头的相对路径；别的一律当没带，并在控制台留一条告警。
 *  · 卡片上只有一个输入框：一个答法最多认一个填写项；多出来的选填项不填，必填项超过一个的答法不在卡片上给。 */

export type ViaInput = { name: string; to: string; required: boolean; max: number };
export type ViaAnswer = { body: Record<string, unknown>; input: ViaInput | null };
export type AnswerVia = { method: 'POST' | 'PUT'; path: string; answers: Record<string, ViaAnswer> };

const DEFAULT_MAX = 4000;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** 地址能不能用：同源、以 /api/ 开头的相对路径（「//主机」、带协议的、绕出 /api/ 的、带反斜杠或控制字符的都不认） */
export function safeApiPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    const u = new URL(path, 'http://same.invalid');
    return u.origin === 'http://same.invalid' && u.pathname.startsWith('/api/');
  } catch { return false; }
}

function inputsOf(v: unknown): ViaInput[] {
  const o = obj(v);
  if (!o) return [];
  return Object.entries(o).flatMap(([name, raw]) => {
    const i = obj(raw);
    if (!i || typeof i.to !== 'string' || !i.to) return [];
    const max = typeof i.max === 'number' && Number.isFinite(i.max) && i.max > 0 ? Math.floor(i.max) : DEFAULT_MAX;
    return [{ name, to: i.to, required: i.required === true, max }];
  });
}

/** 读条目上的 answer_via；没带、形状不对或地址不能用都返回 null（后两种留一条告警） */
const warned = new Set<string>();
const warnOnce = (m: string): void => { if (!warned.has(m)) { warned.add(m); console.warn(m); } };
export function answerViaOf(item: { answer_via?: unknown; source?: string; source_id?: string }, warn: (msg: string) => void = warnOnce): AnswerVia | null {
  if (item.answer_via === undefined || item.answer_via === null) return null;
  const tag = `${item.source ?? ''}/${item.source_id ?? ''}`;
  const v = obj(item.answer_via);
  const answers = v ? obj(v.answers) : null;
  if (!v || !answers || (v.method !== 'POST' && v.method !== 'PUT')) { warn(`[answer_via] ${tag}：形状不对，当没带处理`); return null; }
  if (!safeApiPath(v.path)) { warn(`[answer_via] ${tag}：地址不是同源的 /api/ 路径，当没带处理`); return null; }
  const out: Record<string, ViaAnswer> = {};
  for (const [name, raw] of Object.entries(answers)) {
    const a = obj(raw);
    if (!a) continue;
    const inputs = inputsOf(a.input);
    const required = inputs.filter((i) => i.required);
    if (required.length > 1) { warn(`[answer_via] ${tag}：答法 ${name} 有多个必填项，卡片上办不了`); continue; }
    out[name] = { body: obj(a.body) ?? {}, input: required[0] ?? inputs[0] ?? null };
  }
  return { method: v.method, path: v.path, answers: out };
}

/** 卡片上给哪些答法：条目列的、answer_via 里也说了怎么发的，按条目的顺序 */
export function viaChoices(via: AnswerVia, answers: string[]): string[] {
  return answers.filter((a) => Object.prototype.hasOwnProperty.call(via.answers, a));
}

/** 这个答法要不要先填一句；不用填返回 null */
export function viaInput(via: AnswerVia, answer: string): ViaInput | null {
  return via.answers[answer]?.input ?? null;
}

/** 请求体：答法自带的 body，加上填的那一项（选填又没填的不带） */
export function viaBody(via: AnswerVia, answer: string, value = ''): Record<string, unknown> {
  const a = via.answers[answer];
  if (!a) return {};
  const text = value.trim();
  return a.input && text ? { ...a.body, [a.input.to]: text.slice(0, a.input.max) } : { ...a.body };
}

/** 没办成时给人看的话：有 message 原样给，没有就按状态说 */
export function viaError(status: number, body: unknown): string {
  const b = obj(body);
  if (b && typeof b.message === 'string' && b.message.trim()) return b.message;
  if (status === 401) return '请先登录';
  if (status === 403) return '你没有权限办这一条';
  if (status === 409) return '这一条已经有人办过了，刷新看看';
  return '没办成';
}
