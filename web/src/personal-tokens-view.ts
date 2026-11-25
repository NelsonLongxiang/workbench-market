/** 设置页「个人令牌」（#1063）的纯函数：清单怎么读、状态和期限怎么说、签发表单怎么核、出错怎么说。不碰 React、不碰网络。
 *  字段名随 personal-tokens-api.ts 的契约走（PROVISIONAL）。 */
import type { SourceResult } from './personal-tokens-api';

export type BenchChoice = 'all' | string[];
export interface TokenRow { id: string; name: string; scopes: string[]; benches: BenchChoice; tag: string | null; createdAt: number; expiresAt: number; lastUsedAt: number | null; revokedAt: number | null }
export interface ScopeDef { key: string; label: string; description: string }
export interface TokenDraft { name: string; scopes: string[]; benches: BenchChoice; days: number }

const DAY = 86400000;
export const DEFAULT_DAYS = 30;
export const NAME_MAX = 64;
/** 服务端不给作用域清单时的兜底（#1063 设计里的五项），说法不露代号 */
export const FALLBACK_SCOPES: ScopeDef[] = [
  { key: 'bench:read', label: '读台数据', description: '查询台里的数据' },
  { key: 'bench:write', label: '写台数据', description: '定义数据集、写入行' },
  { key: 'view', label: '改视图', description: '保存台的视图描述' },
  { key: 'grants', label: '批授权', description: '查看并批准、驳回台上的 MCP 申请' },
  { key: 'report-dimensions', label: '报告维度', description: '报告维度的发版、激活、绑定' },
];
export const ONE_TIME_NOTE = '令牌原文只显示这一次：现在复制，存进只有你能读的文件（wm user login --token-file，权限 0600）。离开或刷新这个页面就再也看不到；丢了就撤销，重新签一枚。';
export const SCOPE_NOTE = '令牌只换认证方式，不改授权：用它做的事和你在浏览器里做的一样过同样的规则；审计里记为「属主（令牌 名字）」。';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(v as string[])] : null);

/** 一行令牌：形状不对的不要；原文和哈希即使服务端误给了也不留 */
export function tokenRowOf(v: unknown): TokenRow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const scopes = strs(o.scopes); const created = num(o.created_at); const expires = num(o.expires_at);
  const benches: BenchChoice | null = o.benches === 'all' ? 'all' : strs(o.benches);
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string' || !scopes || !benches || created === null || expires === null) return null;
  const tag = typeof o.prefix === 'string' && /^[A-Za-z0-9]{2,8}$/.test(o.prefix) ? o.prefix : null;
  return { id: o.id, name: o.name, scopes, benches, tag, createdAt: created, expiresAt: expires, lastUsedAt: num(o.last_used_at), revokedAt: num(o.revoked_at) };
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

/** 清单：可用的在前（新签的在上），再是过期的，最后是撤销的 */
export function tokensOf(body: unknown, now: number): TokenRow[] {
  const raw = body && typeof body === 'object' ? (body as { tokens?: unknown }).tokens : null;
  const rows = (Array.isArray(raw) ? raw : []).map(tokenRowOf).filter((x): x is TokenRow => !!x);
  const rank: Record<TokenState, number> = { active: 0, expired: 1, revoked: 2 };
  return rows.sort((a, b) => rank[tokenState(a, now)] - rank[tokenState(b, now)] || b.createdAt - a.createdAt);
}
/** 作用域清单：服务端给了就用，否则兜底；说法只认有中文标签的 */
export function scopesOf(body: unknown): ScopeDef[] {
  const raw = body && typeof body === 'object' ? (body as { scopes?: unknown }).scopes : null;
  if (!Array.isArray(raw)) return FALLBACK_SCOPES;
  const got = raw.filter((s): s is ScopeDef => !!s && typeof s === 'object' && typeof (s as ScopeDef).key === 'string' && typeof (s as ScopeDef).label === 'string')
    .map((s) => ({ key: s.key, label: s.label, description: typeof s.description === 'string' ? s.description : '' }));
  return got.length ? got : FALLBACK_SCOPES;
}
export function maxDaysOf(body: unknown): number {
  const v = body && typeof body === 'object' ? num((body as { max_days?: unknown }).max_days) : null;
  return v !== null && Number.isInteger(v) && v >= 1 ? v : 90;
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
export function scopesLabel(t: TokenRow, defs: ScopeDef[]): string {
  const byKey = new Map(defs.map((d) => [d.key, d.label]));
  const known = t.scopes.filter((k) => byKey.has(k)).map((k) => byKey.get(k) as string);
  const unknown = t.scopes.length - known.length;
  return [...known, ...(unknown ? ['另有 ' + unknown + ' 项'] : [])].join('、') || '—';
}
export function benchesLabel(t: TokenRow, titles: Map<string, string>): string {
  if (t.benches === 'all') return '你进得去的全部台';
  return t.benches.map((s) => titles.get(s) ?? s).join('、') || '—';
}
/** 辨认标记：只有不泄密的尾巴，没有就空 */
export function tagLabel(t: TokenRow): string { return t.tag ? 'wmu_…' + t.tag : ''; }

export function newDraft(): TokenDraft { return { name: '', scopes: [], benches: [], days: DEFAULT_DAYS }; }
/** 签发前核一遍：哪一项没填好就说哪一项；都好返回 null */
export function draftProblem(d: TokenDraft, maxDays: number): string | null {
  const name = d.name.trim();
  if (!name || [...name].length > NAME_MAX) return '给令牌起个名字（' + NAME_MAX + ' 字以内），以后好认、好撤';
  if (!d.scopes.length) return '至少选一项它能做的事';
  if (d.benches !== 'all' && !d.benches.length) return '至少选一个台，或者选「我进得去的全部台」';
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > maxDays) return '有效期在 1 到 ' + maxDays + ' 天之间';
  return null;
}
export function issueBody(d: TokenDraft): { name: string; scopes: string[]; benches: BenchChoice; expires_in_days: number } {
  return { name: d.name.trim(), scopes: [...new Set(d.scopes)].sort(), benches: d.benches === 'all' ? 'all' : [...new Set(d.benches)].sort(), expires_in_days: d.days };
}
/** 签发应答：原文只取这一次；没有原文当没签成 */
export function issuedOf(body: unknown): { token: string; row: TokenRow | null } | null {
  const o = body && typeof body === 'object' ? (body as { token?: unknown; row?: unknown }) : null;
  if (!o || typeof o.token !== 'string' || !/^wmu_[A-Za-z0-9_-]{16,}$/.test(o.token)) return null;
  return { token: o.token, row: tokenRowOf(o.row) };
}

export function listProblem(r: SourceResult | null): { type: 'warning' | 'info'; text: string } | null {
  if (!r || (r.status >= 200 && r.status < 300)) return null;
  if (r.status === 401) return { type: 'warning', text: '请先登录，登录后才能管理个人令牌。' };
  if (r.status === 403) return { type: 'info', text: '个人令牌只有属主本人能签发和管理。' };
  if (r.status === 404) return { type: 'info', text: '个人令牌的服务还没上线。' };
  return { type: 'warning', text: '读不到个人令牌，稍后再试。' };
}
/** 签发、撤销没办成：服务端写成中文句子的 message 照说（比如缺哪项作用域），代号不露 */
export function actionProblem(r: SourceResult): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const b = r.body && typeof r.body === 'object' ? (r.body as { message?: unknown; error?: unknown }) : {};
  for (const v of [b.message, b.error]) if (typeof v === 'string' && v.trim() && /[^\x00-\x7f]/.test(v)) return v.trim();
  if (r.status === 0) return '连不上服务器，检查网络后再试。';
  if (r.status === 401) return '登录过期了，请重新登录后再试。';
  if (r.status === 403) return '你的账号现在不能做这一步。';
  return '没办成，稍后再试。';
}
