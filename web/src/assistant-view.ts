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
  if (status === 403) return { kind: 'session-only', text: err === 'session_only' ? '这一页只认你自己的站内账号登录：管理员口令、令牌都不是人，打不开' : '这一页只认你自己的站内账号登录' };
  if (status === 404) return { kind: 'missing', text: '本站还没有上线助理' };
  if (status === 0) return { kind: 'error', text: '连不上服务器，稍后再试' };
  return { kind: 'error', text: '读不到你的助理，稍后再试' };
}

/** 动作（取令牌、停用、启用）没办成怎么说 */
export function actionError(status: number, body: unknown): string {
  const err = body && typeof body === 'object' ? str((body as Record<string, unknown>).error) : '';
  if (status === 0) return '连不上服务器，没办成';
  if (status === 401) return '请先登录';
  if (status === 403) return err === 'cross_site' ? '这一步只能在本站页面上点' : '只认你自己的站内账号登录';
  if (status === 404) return '本站还没开放助理，现在不能取令牌';
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
      answer: isAnswer(x.answer) ? x.answer : 'pending', status: x.status, link: pageLink(x.link),
    }];
  });
  return { items, next: str(b.next_cursor) || null };
}

/** 令牌那一行怎么说：没取过 / 发出时刻和最后一次使用 */
export function tokenLine(a: Pick<AssistantInfo, 'hasToken'>): string {
  return a.hasToken ? '已经取过一枚（原文只在取的那一次显示）' : '还没取过令牌';
}
