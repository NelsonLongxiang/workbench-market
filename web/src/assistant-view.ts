/** 一人一助理（第 1 期，接口见 docs/assistant-phase1.md 第六节，#829）的纯函数：不碰 React，scripts/assistant-ui-unit.mjs 直接测。
 *  「我的助理」页（/settings/assistant）和「待你确认」页（/assistant/confirm/<id>）共用这里的说法。
 *  不露代号：助理的主体标识（assistant:<x>）、确认的编号、工具的代号都不写在页面的字上。 */
import { pageLink } from './page-paths.ts';

export type AssistantInfo = {
  status: 'active' | 'disabled';
  /** 部署方有没有打开 WM_ASSISTANT；没打开时不能取令牌、不会生成新的「待你确认」，以前的记录照常能看 */
  enabled: boolean;
  hasToken: boolean;
  tokenCreatedAt: string | null;
  tokenLastUsedAt: string | null;
  mcpUrl: string;
  actions30d: number;
  pendingConfirms: number;
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const time = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null);

/** GET /api/assistant 的应答整形；形状不对返回 null（页面当出错处理，不猜） */
export function assistantOf(body: unknown): AssistantInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.status !== 'active' && b.status !== 'disabled') return null;
  return {
    status: b.status,
    enabled: b.enabled_by_deployment === true,
    hasToken: b.has_token === true,
    tokenCreatedAt: time(b.token_created_at),
    tokenLastUsedAt: time(b.token_last_used_at),
    mcpUrl: str(b.mcp_url),
    actions30d: count(b.actions_30d),
    pendingConfirms: count(b.pending_confirms),
  };
}

/** 页面处在哪种状态：按应答的状态码和错误代号分，每种一句人话 */
export type PageKind = 'ok' | 'login' | 'session-only' | 'missing' | 'error';
export function pageKind(status: number, body: unknown): { kind: PageKind; text: string } {
  const err = body && typeof body === 'object' ? str((body as Record<string, unknown>).error) : '';
  if (status === 200) return assistantOf(body) ? { kind: 'ok', text: '' } : { kind: 'error', text: '读到的助理信息看不懂，稍后再试' };
  if (status === 401) return { kind: 'login', text: '请先登录' };
  if (status === 403 && err === 'session_only') return { kind: 'session-only', text: '这一页只认你自己的站内账号登录：管理员口令、令牌都不是人，打不开' };
  if (status === 403 && err === 'cross_site') return { kind: 'error', text: '这一页只能在本站打开' };
  if (status === 403) return { kind: 'error', text: '没有权限看这一页' };
  if (status === 404) return { kind: 'missing', text: '本站还没开放助理' };
  if (status === 0) return { kind: 'error', text: '连不上服务器，稍后再试' };
  return { kind: 'error', text: '读不到你的助理，稍后再试' };
}

/** 用户卡里的「我的助理」入口出不出：只在 GET /api/assistant 回 200、看得懂、并且部署方开放了（enabled_by_deployment 为真）时出。
 *  没登录（401）、不是本人的会话（403）、服务端没有助理接口（404）、没开放、出错，都不出。 */
export const showEntry = (status: number, body: unknown): boolean => status === 200 && assistantOf(body)?.enabled === true;

/** 动作（取令牌、停用、启用）没办成怎么说；404 按是哪一种动作说 */
export function actionError(status: number, body: unknown, action: 'token' | 'power' = 'token'): string {
  const err = body && typeof body === 'object' ? str((body as Record<string, unknown>).error) : '';
  if (status === 0) return '连不上服务器，没办成';
  if (status === 401) return '请先登录';
  if (status === 403 && err === 'cross_site') return '这一步只能在本站页面上点';
  if (status === 403 && err === 'session_only') return '只认你自己的站内账号登录，管理员口令和令牌办不了';
  if (status === 403) return '没有权限做这一步';
  if (status === 404) return action === 'token' ? '本站还没开放助理，现在不能取令牌' : '本站还没开放助理，现在不能停用或启用';
  return '没办成，稍后再试';
}

/** 「待你确认」的状态（服务端九种）各一句人话，和标签颜色 */
export type ConfirmStatus = 'pending' | 'confirming' | 'done' | 'failed' | 'declined' | 'expired' | 'stale' | 'denied' | 'cancelled';
export const STATUS_TEXT: Record<ConfirmStatus, string> = {
  pending: '等你确认', confirming: '正在办', done: '已办', failed: '没办成', declined: '你没办',
  expired: '已过期，没办', stale: '数据变了，没办', denied: '你的权限变了，没办', cancelled: '已作废，没办',
};
export const STATUS_TONE: Record<ConfirmStatus, 'success' | 'warning' | 'error' | 'processing' | 'default'> = {
  pending: 'warning', confirming: 'processing', done: 'success', failed: 'error', declined: 'default',
  expired: 'default', stale: 'warning', denied: 'error', cancelled: 'default',
};
const isStatus = (v: unknown): v is ConfirmStatus => typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_TEXT, v);

/** 「你的回答」（服务端由状态推出来）各一句 */
export type Answer = 'confirm' | 'decline' | 'timeout' | 'pending' | 'cancelled';
export const ANSWER_TEXT: Record<Answer, string> = { confirm: '你确认了', decline: '你没办', timeout: '超时没确认', pending: '还没回答', cancelled: '作废了' };
const isAnswer = (v: unknown): v is Answer => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ANSWER_TEXT, v);

/** 「它替你办过的事」一行。id 只用来做 key 和确认页的链接，不写在页面的字上 */
export type ActionRow = { id: string; at: string; toolLabel: string; description: string; answer: Answer; status: ConfirmStatus; link: string | null };
export function actionsOf(body: unknown): { items: ActionRow[]; next: string | null } {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const list = Array.isArray(b.items) ? b.items : [];
  const items = list.flatMap((v): ActionRow[] => {
    if (!v || typeof v !== 'object') return [];
    const x = v as Record<string, unknown>;
    const id = str(x.id), description = str(x.description);
    if (!id || !description || !isStatus(x.status)) return [];
    return [{
      id, at: time(x.at) ?? '', toolLabel: str(x.tool_label) || '一件事', description,
      answer: isAnswer(x.answer) ? x.answer : 'pending', status: x.status,
      // 还在等确认的链到确认页；别的给站内的结果链接
      link: x.status === 'pending' ? confirmPath(id) : pageLink(x.link),
    }];
  });
  return { items, next: str(b.next_cursor) || null };
}

/** 令牌那一行怎么说：没取过 / 发出时刻和最后一次使用 */
export function tokenLine(a: Pick<AssistantInfo, 'hasToken'>): string {
  return a.hasToken ? '已经取过一枚（原文只在取的那一次显示）' : '还没取过令牌';
}

/* ---------------- 「待你确认」页（/assistant/confirm/<id>，#829 第三节第 3、5 条） ---------------- */

/** 确认页的地址：助理回复里给的就是它；「我的助理」页里还在等确认的那几条也链到这里 */
export const confirmPath = (id: string): string => `/assistant/confirm/${encodeURIComponent(id)}`;

/** 本人要打的字：服务端只认恰好这两个字，前端不替人修剪空格、不做任何规范化（原样提交） */
export const CONFIRM_WORD = '确认';

export type ConfirmInfo = { id: string; description: string; assistantLabel: string; createdAt: string | null; expiresAt: number | null; status: ConfirmStatus; link: string | null };
/** GET /api/assistant/confirms/<id> 的应答整形；形状不对返回 null */
export function confirmOf(body: unknown): ConfirmInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const id = str(b.id), description = str(b.description);
  if (!id || !description || !isStatus(b.status)) return null;
  const exp = time(b.expires_at);
  return { id, description, assistantLabel: str(b.assistant_label) || '你的助理', createdAt: time(b.created_at), expiresAt: exp ? Date.parse(exp) : null, status: b.status, link: pageLink(b.link) };
}

/** 读的时候已经过了时限的「等你确认」一律当过期（服务端也这么判；页面开着时钟走到了，也照这个说） */
export const shownStatus = (c: Pick<ConfirmInfo, 'status' | 'expiresAt'>, now: number): ConfirmStatus =>
  c.status === 'pending' && c.expiresAt !== null && c.expiresAt <= now ? 'expired' : c.status;

/** 还剩多久：「还剩 4 分 12 秒」；到了返回空串 */
export function remainingText(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return '';
  const s = Math.floor((expiresAt - now) / 1000);
  if (s <= 0) return '';
  return s >= 60 ? `还剩 ${Math.floor(s / 60)} 分 ${s % 60} 秒` : `还剩 ${s} 秒`;
}

/** 确认页处在哪种状态：读不到的各一句。不是本人的和不存在的，服务端回同一个 403（不透露这一条存不存在） */
export function confirmPageKind(status: number, body: unknown): { kind: PageKind | 'not-yours'; text: string } {
  const err = body && typeof body === 'object' ? str((body as Record<string, unknown>).error) : '';
  if (status === 200) return confirmOf(body) ? { kind: 'ok', text: '' } : { kind: 'error', text: '读到的这一条看不懂，稍后再试' };
  if (status === 401) return { kind: 'login', text: '请先登录' };
  if (status === 403 && err === 'session_only') return { kind: 'session-only', text: '这一页只认你自己的站内账号登录：管理员口令、令牌都不是人，确认不了' };
  if (status === 403) return { kind: 'not-yours', text: '这一条不是给你的，或者已经没有了' };
  if (status === 404) return { kind: 'missing', text: '本站还没开放助理' };
  if (status === 0) return { kind: 'error', text: '连不上服务器，稍后再试' };
  return { kind: 'error', text: '读不到这一条，稍后再试' };
}

/** 每种结局一句话：页面到了终态只显示这一句和结果链接，不再给提交框 */
export const OUTCOME_TEXT: Record<ConfirmStatus, string> = {
  pending: '还在等你确认。',
  confirming: '正在办，稍等一下再刷新看结果。',
  done: '按你确认那一刻的权限和数据重新判过，办好了。',
  failed: '办的时候出了错，没办成。可以到对应的页面核对一下。',
  declined: '你选了不办，这一条已作废，什么也没改。',
  expired: '5 分钟内没确认，这一条已作废，什么也没改。要办就让助理重新发起。',
  stale: '从助理发起到你确认之间，相关的数据变了，这一条作废、没有执行。要办就让助理按现在的数据重新发起。',
  denied: '你确认的时候，你已经没有办这件事的权限了，没有执行。',
  cancelled: '助理被停用或令牌被重置了，这一条已作废，什么也没改。',
};

/** 提交以后（POST /api/assistant/confirms/<id>）怎么说：
 *  200 带最终状态；409 已经不是待确认了（带当前状态）；422 打的字不对，这一条仍可再交；其余是没交上 */
export function answerResult(status: number, body: unknown): { final: ConfirmStatus | null; link: string | null; text: string } {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const err = str(b.error);
  if ((status === 200 || status === 409) && isStatus(b.status)) {
    return { final: b.status, link: pageLink(b.link), text: status === 409 ? `这一条已经处理过了：${STATUS_TEXT[b.status]}` : STATUS_TEXT[b.status] };
  }
  if (status === 422) return { final: null, link: null, text: `要恰好打「${CONFIRM_WORD}」两个字（不带空格），再交一次` };
  if (status === 401) return { final: null, link: null, text: '登录过期了，请重新登录后再打开这个链接' };
  if (status === 403 && err === 'cross_site') return { final: null, link: null, text: '只能在本站的这个页面上提交' };
  if (status === 403 && err === 'session_only') return { final: null, link: null, text: '只认你自己的站内账号登录，口令和令牌提交不了' };
  if (status === 403) return { final: null, link: null, text: '这一条不是给你的，或者已经没有了' };
  if (status === 0) return { final: null, link: null, text: '连不上服务器，没交上；时限内可以再交' };
  return { final: null, link: null, text: '没交上，稍后再试' };
}
