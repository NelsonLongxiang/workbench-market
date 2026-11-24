/** 台的 MCP 管理页（/bench-mcp/<台>，#904）和 MCP 网关页「台上的申请」的纯函数：状态、读写、授予从哪来、批之前的检查、没成的说法。
 *  不碰网络、不碰 DOM，单测见 scripts/bench-mcp-page-unit.mjs。 */
import type { BenchMcpPage, BenchMcpRequest } from './api';
import { crossOriginError } from './admin-token.ts';

export const REQUEST_STATUS: Record<BenchMcpRequest['status'], { text: string; color: string }> = {
  pending: { text: '待批', color: 'warning' }, approved: { text: '已批准', color: 'success' }, rejected: { text: '已驳回', color: 'default' }, expired: { text: '已失效', color: 'default' },
};
export const statusOf = (s: string): { text: string; color: string } => REQUEST_STATUS[s as BenchMcpRequest['status']] ?? { text: s, color: 'default' };
/** 工具读写：只有明写是 read 的算只读，别的一律按写算（宁可多提醒一句，和「关注」卡片同一个口径） */
export const categoryText = (c: string): string => (c === 'read' ? '只读' : '写');
/** 一条授予从哪来：批准哪条申请来的，还是有人直接授予的 */
export const grantSource = (requestId: number | null): string => (requestId === null ? '直接授予' : `批准申请 #${requestId}`);

/** 待批的在前（按编号从小到大，先来先办），其余按编号从大到小 */
export function splitRequests(list: BenchMcpRequest[]): { pending: BenchMcpRequest[]; done: BenchMcpRequest[] } {
  return { pending: list.filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id), done: list.filter((r) => r.status !== 'pending').sort((a, b) => b.id - a.id) };
}

/** 批或驳之前：驳回必须写理由（服务端也核，这里先拦住）；理由最多 500 字。没问题回空串 */
export function decideProblem(approve: boolean, note: string): string {
  if (!approve && !note.trim()) return '驳回要写理由，会话看得到';
  if (note.trim().length > 500) return '理由最多 500 个字';
  return '';
}

/** 读管理页、批或驳没成时的说法：400、404、409 照服务端说（它没说给一句默认的）；没登录、没权限、断网各一句；别的不透露原文 */
export function mcpError(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : '';
  if (status === 400) return msg || '填的内容不对';
  if (status === 401) return '请先登录';
  if (status === 403) return crossOriginError(body) ?? '你不能管这个台的 MCP 授权（要有这个台的拍板授予）';
  if (status === 404) return msg || '没有这个台，或者没有这条申请';
  if (status === 409) return msg || '这条申请已经变了，刷新后再看';
  if (status === 0) return '连不上服务，稍后再试';
  return '这次没成，稍后再试';
}

/** 管理页应答像不像样：不像样当读取出错，不显示成「没有申请」 */
export function asMcpPage(body: unknown): BenchMcpPage | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<BenchMcpPage>;
  if (!b.bench || typeof b.bench.slug !== 'string' || !Array.isArray(b.grants) || !Array.isArray(b.requests) || !Array.isArray(b.log)) return null;
  return { bench: b.bench, grants: b.grants, requests: b.requests, unmatched: Array.isArray(b.unmatched) ? b.unmatched : [], log: b.log, can: { decide: b.can?.decide === true } };
}

/** 留痕里的动作说法 */
export function logActionText(a: string): string {
  return ({ approve: '批准申请', reject: '驳回申请', grant: '直接授予', revoke: '收回', expire: '到期失效' } as Record<string, string>)[a] ?? a;
}

/** 毫秒时间 → 「2026-11-21 08:05」（本地时区） */
export function timeText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** MCP 网关页「台上的申请」的一行：从「关注」的 bench-mcp 条目换来。台登记过的去台的授权页办；
 *  写的是还没开台库的卡片的（批准会顺带开台库），台的授权页还没有，去「等你拍板」办 */
export type BenchRequestRow = { key: string; id: number; bench: string; benchTitle: string; registered: boolean; session: string; read: string[]; write: string[]; reason: string; to: string };
type GrantDetailLike = { session: string; bench: string; bench_title: string; read: string[]; write: string[]; reason: string; registered: boolean };
export function benchRequestRows(items: { source: string; source_id: string; detail?: unknown }[], detailOf: (i: { source: string; detail?: unknown }) => GrantDetailLike | null): BenchRequestRow[] {
  const out: BenchRequestRow[] = [];
  for (const it of items) {
    const d = detailOf(it);
    const m = /:(\d+)$/.exec(it.source_id);
    if (!d || !m) continue;
    out.push({ key: it.source_id, id: Number(m[1]), bench: d.bench, benchTitle: d.bench_title, registered: d.registered, session: d.session, read: d.read, write: d.write, reason: d.reason,
      to: d.registered ? `/bench-mcp/${encodeURIComponent(d.bench)}` : '/attention' });
  }
  return out.sort((a, b) => a.id - b.id);
}
