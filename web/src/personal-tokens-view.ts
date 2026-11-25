/** 设置页「个人令牌」（#1063）的纯函数：清单怎么读、状态和期限怎么说、签发表单怎么核、出错怎么说。不碰 React、不碰网络。
 *  规则对齐后端 server/src/services/owner-personal-tokens.ts（#1065）：名字、作用域五项、台、有效期 1～90 天、令牌格式。 */
import type { SourceResult } from './personal-tokens-api';

export interface TokenRow { id: string; name: string; scopes: string[]; benches: string[]; createdAt: number; expiresAt: number; lastUsedAt: number | null; revokedAt: number | null }
export interface ScopeDef { key: string; label: string; description: string; perBench: boolean }
export interface TokenDraft { name: string; scopes: string[]; benches: string[]; days: number }

const DAY = 86400000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const NAME_MAX = 48;
/** 和服务端同一条：字母或数字开头，其后字母、数字、空格、点、短横线、下划线，共 1～48 个，前后不留空格 */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}$/u;
export const NAME_HINT = '1～48 个字母、数字、空格、点、短横线或下划线，以字母或数字开头';
export const SCOPES: ScopeDef[] = [
  { key: 'bench:read', label: '读台数据', description: '查询数据、读报告', perBench: true },
  { key: 'bench:write', label: '写台数据', description: '定义数据集、写入行', perBench: true },
  { key: 'view', label: '改视图', description: '保存台的视图描述', perBench: true },
  { key: 'grants', label: '批授权', description: '看台上的 MCP 授予、批准或驳回申请', perBench: true },
  { key: 'report-dimensions', label: '报告维度', description: '维度模板发版、复核、激活；绑定到台时也要选那个台', perBench: false },
];
export const ONE_TIME_NOTE = '令牌原文只显示这一次：现在复制，存进只有你能读的文件（wm user login --token-file，权限 0600）。离开或刷新这个页面就再也看不到；丢了就撤销，重新签一枚。';
export const SCOPE_NOTE = '令牌只换认证方式，不改授权：用它做的事和你在浏览器里做的一样过同样的规则；审计里记为「属主（令牌 名字）」。';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(v as string[])] : null);

/** 一行令牌：形状不对的不要；原文、哈希即使给了也不留（只挑认得的字段） */
export function tokenRowOf(v: unknown): TokenRow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const scopes = strs(o.scopes); const benches = strs(o.benches); const created = num(o.created_at); const expires = num(o.expires_at);
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !scopes || !benches || created === null || expires === null) return null;
  return { id: o.id, name: o.name, scopes, benches, createdAt: created, expiresAt: expires, lastUsedAt: num(o.last_used_at), revokedAt: num(o.revoked_at) };
}

export type TokenState = 'active' | 'expired' | 'revoked';
export function tokenState(t: TokenRow, now: number): TokenState {
  if (t.revokedAt !== null) return 'revoked';
  return t.expiresAt <= now ? 'expired' : 'active';
}
export function stateTag(t: TokenRow, now: number): { text: string; tone: 'success' | 'warning' | 'default' } {
  const s = tokenState(t, now);
  return s === 'active' ? { text: '可用', tone: 'success' } : s === 'expired' ? { text: '已过期', tone: 'warning' } : { text: '已撤销', tone: 'default' };
}
/** 清单：可用的在前（新签的在上），再是过期的，最后是撤销的（服务端撤销后照样列出） */
export function tokensOf(body: unknown, now: number): TokenRow[] {
  const raw = body && typeof body === 'object' ? (body as { personal_tokens?: unknown }).personal_tokens : null;
  const rows = (Array.isArray(raw) ? raw : []).map(tokenRowOf).filter((x): x is TokenRow => !!x);
  const rank: Record<TokenState, number> = { active: 0, expired: 1, revoked: 2 };
  return rows.sort((a, b) => rank[tokenState(a, now)] - rank[tokenState(b, now)] || b.createdAt - a.createdAt);
}

const pad = (n: number) => String(n).padStart(2, '0');
export function ymdhm(ms: number): string { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
export function lastUsedLabel(t: TokenRow): string { return t.lastUsedAt === null ? '还没用过' : ymdhm(t.lastUsedAt); }
export function expiryLabel(t: TokenRow, now: number): string {
  const s = tokenState(t, now);
  if (s === 'revoked') return ymdhm(t.revokedAt as number) + ' 撤销';
  if (s === 'expired') return ymdhm(t.expiresAt) + ' 已过期';
  return ymdhm(t.expiresAt) + ' 到期（还剩 ' + Math.ceil((t.expiresAt - now) / DAY) + ' 天）';
}
/** 作用域的说法：认得的写中文，认不得的只说有几项，不露代号 */
export function scopesLabel(t: TokenRow): string {
  const byKey = new Map(SCOPES.map((d) => [d.key, d.label]));
  const known = t.scopes.filter((k) => byKey.has(k)).map((k) => byKey.get(k) as string);
  const unknown = t.scopes.length - known.length;
  return [...known, ...(unknown ? ['另有 ' + unknown + ' 项'] : [])].join('、') || '—';
}
export function benchesLabel(t: TokenRow, titles: Map<string, string>): string {
  return t.benches.map((s) => titles.get(s) ?? s).join('、') || '不限台（只有报告维度）';
}

export function newDraft(): TokenDraft { return { name: '', scopes: [], benches: [], days: DEFAULT_DAYS }; }
/** 选的作用域里有没有按台的（这时必须选台） */
export function needsBench(scopes: string[]): boolean { return scopes.some((k) => SCOPES.find((s) => s.key === k)?.perBench !== false); }
/** 签发前核一遍（与服务端同规则）：哪一项没填好就说哪一项；都好返回 null */
export function draftProblem(d: TokenDraft): string | null {
  if (!NAME.test(d.name) || d.name !== d.name.trim()) return '名字：' + NAME_HINT;
  if (!d.scopes.length) return '至少选一项它能做的事';
  if (needsBench(d.scopes) && !d.benches.length) return '选了按台的作用域，至少选一个台';
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > MAX_DAYS) return '有效期在 1 到 ' + MAX_DAYS + ' 天之间';
  return null;
}
export function issueBody(d: TokenDraft): { name: string; scopes: string[]; benches: string[]; expires_in_days: number } {
  const order = SCOPES.map((s) => s.key);
  return { name: d.name, scopes: [...new Set(d.scopes)].sort((a, b) => order.indexOf(a) - order.indexOf(b)), benches: [...new Set(d.benches)].sort(), expires_in_days: d.days };
}
/** 签发应答：原文只取这一次（wmu_ 加 43 位）；没有原文当没签成 */
export function issuedOf(body: unknown): { token: string; row: TokenRow | null } | null {
  const o = body && typeof body === 'object' ? (body as { token?: unknown; personal_token?: unknown }) : null;
  if (!o || typeof o.token !== 'string' || !/^wmu_[A-Za-z0-9_-]{43}$/.test(o.token)) return null;
  return { token: o.token, row: tokenRowOf(o.personal_token) };
}

const codeOf = (r: SourceResult): string => (r.body && typeof r.body === 'object' && typeof (r.body as { error?: unknown }).error === 'string' ? (r.body as { error: string }).error : '');
/** 服务端只给代号、不给句子的几种拒绝，各自说清楚（代号本身不露） */
function refusalText(r: SourceResult): string | null {
  const c = codeOf(r);
  if (c === 'personal_token_surface_denied') return '个人令牌只能在市场的 HTTPS 地址上签发和管理。';
  if (c === 'personal_token_owner_session_required') return '请在市场页面上、用属主本人的登录来操作个人令牌。';
  if (c === 'personal_token_owner_required') return '个人令牌只有属主本人能签发和管理。';
  return null;
}
export function listProblem(r: SourceResult | null): { type: 'warning' | 'info'; text: string } | null {
  if (!r || (r.status >= 200 && r.status < 300)) return null;
  if (r.status === 401) return { type: 'warning', text: '请先登录，登录后才能管理个人令牌。' };
  if (r.status === 403) return { type: 'info', text: refusalText(r) ?? '个人令牌只有属主本人能签发和管理。' };
  if (r.status === 404) return { type: 'info', text: '个人令牌的服务还没上线。' };
  return { type: 'warning', text: '读不到个人令牌，稍后再试。' };
}
/** 签发、撤销没办成：服务端写成中文句子的 message 照说（名字重了、有效期超了），代号不露 */
export function actionProblem(r: SourceResult): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const b = r.body && typeof r.body === 'object' ? (r.body as { message?: unknown; error?: unknown }) : {};
  for (const v of [b.message, b.error]) if (typeof v === 'string' && v.trim() && /[^\x00-\x7f]/.test(v)) return v.trim();
  const refused = refusalText(r); if (refused) return refused;
  if (r.status === 0) return '连不上服务器，检查网络后再试。';
  if (r.status === 401) return '登录过期了，请重新登录后再试。';
  if (r.status === 403) return '你的账号现在不能做这一步。';
  if (r.status === 404) return '找不到这枚令牌了，刷新清单看看。';
  return '没办成，稍后再试。';
}
