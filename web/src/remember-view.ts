/** 「把这次的取舍记成经验」（经验库第 2 步，#745）的纯函数：不碰 React，scripts/remember-ui-unit.mjs 直接测。
 *  三处用到：答复卡上的勾选（随 POST /api/attention/answer 的 remember 一起交）、/attention 底下「我处理过的（48 小时内）」的补记（POST /api/knowledge/remember）、
 *  经验库条目上的「拍板：名字」（decided_by_name）。只给 /api/auth/me 的 can.remember_knowledge 为真的人（管理层、属主）。
 *  统筹 11-14 定：「谁能看」缺省按服务端推的那一档，「全公司」永远不当缺省（推不出部门时落在「只给管理层」）；经验没记上不拖住答复。 */

import { answerLabel, looksLikeCode } from './attention-view.ts';

export type Visibility = 'department' | 'company' | 'restricted';
export type RememberDefaults = { default_visibility: 'department' | 'restricted'; department_name: string | null };
export type RememberStatus = 'written' | 'pending' | 'failed';

export const LESSON_MAX = 500;
export const CUE_MAX = 200;
export const LESSON_LABEL = '以后遇到类似情况怎么办';
export const CUE_LABEL = '这件事是什么情况';
export const REMEMBER_LABEL = '把这次的取舍记成经验';

/** 服务端推的缺省档：只认 department、restricted；别的（没给、形状不对、读不到）一律落在「只给管理层」，不落在「全公司」 */
export function defaultsOf(body: unknown): RememberDefaults {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof b.department_name === 'string' && b.department_name.trim() ? b.department_name.trim() : null;
  return b.default_visibility === 'department' && name ? { default_visibility: 'department', department_name: name } : { default_visibility: 'restricted', department_name: null };
}

/** 「谁能看」三个选项：本部门写上部门名，推不出部门时置灰（传了会回 400 remember_department_unknown） */
export function visibilityOptions(d: RememberDefaults): { value: Visibility; label: string; disabled: boolean }[] {
  return [
    { value: 'department', label: d.department_name ? `本部门（${d.department_name}）` : '本部门', disabled: !d.department_name },
    { value: 'company', label: '全公司', disabled: false },
    { value: 'restricted', label: '只给管理层', disabled: false },
  ];
}

/** 要交的 remember：lesson 必填；cue 空着不传（服务端用条目标题）；visibility 总是带上页面上选中的那一档。
 *  不靠服务端的缺省：页面在缺省档读不到（部门没名字、接口 500、断网）时显示的是「只给管理层」，服务端自己的缺省可能是「本部门」，
 *  不带就会记得比页面显示的宽（#766 验收退回的那一处） */
export function rememberPayload(lesson: string, cue: string, chosen: Visibility): { lesson: string; cue?: string; visibility: Visibility } {
  const l = lesson.trim(), c = cue.trim();
  return { lesson: l, ...(c ? { cue: c } : {}), visibility: chosen };
}

/** 能不能交：以后怎么办 1～500 字；情况最多 200 字。不能交时给一句为什么（答法按钮旁边显示）。
 *  where：答复卡上是勾选框（「或者取消勾选」），「我处理过的」里是「取消」按钮（「或者点「取消」」） */
export function rememberProblem(lesson: string, cue: string, where: 'card' | 'later' = 'card'): string | null {
  const l = lesson.trim();
  if (!l) return `先填「${LESSON_LABEL}」，${where === 'later' ? '或者点「取消」' : '或者取消勾选'}`;
  if (l.length > LESSON_MAX) return `「${LESSON_LABEL}」最多 ${LESSON_MAX} 字`;
  if (cue.trim().length > CUE_MAX) return `「${CUE_LABEL}」最多 ${CUE_MAX} 字`;
  return null;
}

/** 答复带着 remember 办完以后的那一句：答复本身照常算办完；经验记上、稍后重试、没记上各一句。被拒的原因用服务端给的那句，不拼请求体和代号 */
export function answeredWithRemember(remember: unknown): { type: 'success' | 'warning'; text: string } {
  const r = (remember && typeof remember === 'object' ? remember : {}) as Record<string, unknown>;
  const scope = typeof r.scope_label === 'string' && r.scope_label.trim() ? `（${r.scope_label.trim()}）` : '';
  if (r.status === 'written') return { type: 'success', text: r.duplicate === true ? `办好了；这条经验之前已经记过了${scope}` : `办好了，也记成了经验${scope}` };
  if (r.status === 'pending') return { type: 'warning', text: '办好了；经验没记上，稍后会自动重试' };
  const why = typeof r.message === 'string' && r.message.trim() && !/[a-z_]{4,}/.test(r.message) ? r.message.trim() : '稍后可以在「我处理过的」里再记一次';
  return { type: 'warning', text: `办好了；经验没记上：${why}` };
}

/** 补记（POST /api/knowledge/remember）的应答怎么说：201 / 200 记上了；403 没有拍板授予；404 找不到你答过的这一条；400 填得不对；别的稍后再试 */
export function rememberLaterResult(status: number, body: unknown): { ok: boolean; status: RememberStatus | null; text: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status === 200 || status === 201) {
    const s: RememberStatus = b.status === 'pending' || b.status === 'failed' ? b.status : 'written';
    const scope = typeof b.scope_label === 'string' && b.scope_label.trim() ? `（${b.scope_label.trim()}）` : '';
    return { ok: true, status: s, text: s === 'written' ? (b.duplicate === true ? `这条经验之前已经记过了${scope}` : `记成了经验${scope}`) : s === 'pending' ? '经验没记上，稍后会自动重试' : '经验没记上，稍后再试' };
  }
  if (status === 401) return { ok: false, status: null, text: '请先登录' };
  if (status === 403) return { ok: false, status: null, text: '你的账号现在不能把拍板记成经验' };
  if (status === 404) return { ok: false, status: null, text: '找不到你 48 小时内答过的这一条' };
  if (status === 400 && b.error === 'remember_department_unknown') return { ok: false, status: null, text: '推不出这件事所在的部门：选「只给管理层」或「全公司」' };
  if (status === 400) return { ok: false, status: null, text: '填得不对，看一下再交' };
  if (status === 0) return { ok: false, status: null, text: '连不上服务器，稍后再试' };
  return { ok: false, status: null, text: '没记上，稍后再试' };
}

/** 「我处理过的」里答的是什么：服务端给的说法；没给或者给的是代号（服务端的表里没有的答法会原样给代号，如 confirm-key），换成卡片按钮上的同一个说法 */
function answerTextOf(x: Record<string, unknown>): string {
  const t = typeof x.answer_text === 'string' ? x.answer_text.trim() : '';
  if (t && !looksLikeCode(t)) return t;
  const a = typeof x.answer === 'string' ? x.answer : t;
  return a ? answerLabel(a) : '';
}
/** 「我处理过的」一条（GET /api/knowledge/remember/recent） */
export type RecentAnswer = { source: string; source_id: string; title: string | null; answer_text: string; answered_at: string; remembered: RememberStatus | null; defaults: RememberDefaults };
export function recentOf(body: unknown): RecentAnswer[] {
  const list = body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  return list.flatMap((v): RecentAnswer[] => {
    if (!v || typeof v !== 'object') return [];
    const x = v as Record<string, unknown>;
    if (typeof x.source !== 'string' || !x.source || typeof x.source_id !== 'string' || !x.source_id) return [];
    const rem = x.remembered === 'written' || x.remembered === 'pending' || x.remembered === 'failed' ? x.remembered : null;
    return [{ source: x.source, source_id: x.source_id, title: typeof x.title === 'string' && x.title.trim() ? x.title.trim() : null,
      answer_text: answerTextOf(x), answered_at: typeof x.answered_at === 'string' ? x.answered_at : '', remembered: rem, defaults: defaultsOf(x) }];
  });
}
/** 来源名（没有标题的条目用它代替）：认不出的写「一件事」，不露代号 */
const SOURCE_NAME: Record<string, string> = { 'work-items': '事项', 'change-requests': '变更申请', 'mcp-access': 'AI 会话申请工具', 'seat-asks': 'AI 员工的提问', 'relation-proposals': '关系的提议', 'principal-pending': '外部账号对接', 'grant-requests': '授予申请', 'workbench-events': '工作台的事件', 'owner-pending': '待属主看' };
export const recentTitle = (r: Pick<RecentAnswer, 'title' | 'source'>): string => r.title ?? SOURCE_NAME[r.source] ?? '一件事';
/** 记没记过：已记成经验 / 稍后会自动重试 / 没记上；null 是还没记 */
export function rememberedLabel(s: RememberStatus | null): { text: string; tone: 'success' | 'warning' | 'error' } | null {
  if (s === 'written') return { text: '已记成经验', tone: 'success' };
  if (s === 'pending') return { text: '稍后会自动重试', tone: 'warning' };
  if (s === 'failed') return { text: '没记上', tone: 'error' };
  return null;
}
/** 经验库条目上的拍板人：有名字写「拍板：名字」，没有不写 */
export const decidedByLine = (name: unknown): string | null => (typeof name === 'string' && name.trim() ? `拍板：${name.trim()}` : null);
