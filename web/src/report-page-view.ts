/** 报告页（/use/<卡片 id>/reports，报告第 1 步 PR D）的纯函数：清单怎么分组、同一事物取哪几份并排、回应接在谁后面、错误怎么说。
 *  不碰网络、不碰 DOM，单测见 scripts/report-page-unit.mjs。 */
import type { ReportListItem, ReportResponse, ReportStance } from './api';

export const STANCE_TEXT: Record<ReportStance, string> = { agree: '认可', dispute: '反驳', supplement: '补充' };
export const stanceText = (s: string): string => (s in STANCE_TEXT ? STANCE_TEXT[s as ReportStance] : s);

/** 地址里的状态：?report=<编号> 看一份；?subject=<事物> 看这件事的几个维度并排；都没有是清单。认不出的当没写 */
export type ReportRoute = { kind: 'list' } | { kind: 'subject'; subject: string } | { kind: 'one'; id: number };
export function reportRoute(q: URLSearchParams): ReportRoute {
  const id = q.get('report');
  if (id && /^[1-9]\d{0,8}$/.test(id)) return { kind: 'one', id: Number(id) };
  const subject = q.get('subject');
  if (subject && /^[a-z][a-z0-9-]{0,15}:\S{1,200}$/.test(subject)) return { kind: 'subject', subject };
  return { kind: 'list' };
}

/** 一件事物、一个维度下该看的那一份：没被更正过的（链头）里编号最大的；另有几份链头（各自独立生成的）记在 others */
export type DimHead = { dimension_id: string; head: ReportListItem; others: number };
/** 清单按事物分组：每组里各维度取一份（DimHead，按维度标识排）；组按最近一份的生成时间倒排 */
export type SubjectGroup = { subject: string; latest: number; dims: DimHead[] };
export function headsOf(list: ReportListItem[]): DimHead[] {
  const by = new Map<string, ReportListItem[]>();
  for (const r of list) if (r.superseded_by === null) by.set(r.dimension_id, [...(by.get(r.dimension_id) ?? []), r]);
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([dimension_id, rs]) => {
    const head = rs.reduce((a, b) => (b.id > a.id ? b : a));
    return { dimension_id, head, others: rs.length - 1 };
  });
}
export function groupBySubject(list: ReportListItem[]): SubjectGroup[] {
  const by = new Map<string, ReportListItem[]>();
  for (const r of list) by.set(r.subject, [...(by.get(r.subject) ?? []), r]);
  return [...by.entries()].map(([subject, rs]) => ({ subject, latest: Math.max(...rs.map((r) => r.created_at)), dims: headsOf(rs) }))
    .filter((g) => g.dims.length > 0)
    .sort((a, b) => b.latest - a.latest || (a.subject < b.subject ? -1 : 1));
}

/** 读的人自己在这条论断（claimKey 为空是整份报告）上的链头：自己的回应里没被自己后来那条接上的、编号最大的一条。没有是 null。
 *  页面「改主意」时带上它的编号（supersedes），服务端只许接自己的链头 */
export function myHead(responses: ReportResponse[], claimKey: string): ReportResponse | null {
  const mine = responses.filter((r) => r.mine === true && r.claim_key === claimKey);
  const replaced = new Set(mine.map((r) => r.supersedes).filter((x): x is number => x !== null));
  const heads = mine.filter((r) => !replaced.has(r.id));
  return heads.length ? heads.reduce((a, b) => (b.id > a.id ? b : a)) : null;
}

/** 回应链上被接掉（改过主意）的那些：页面上划掉显示，链头照常显示 */
export function replacedIds(responses: ReportResponse[]): Set<number> {
  return new Set(responses.map((r) => r.supersedes).filter((x): x is number => x !== null));
}

/** 回应框交之前的检查：立场要是模板允许的，理由必填、最多 4000 字；没问题回空串 */
export function respondProblem(stances: string[], stance: string, reason: string): string {
  if (!stances.includes(stance)) return '先选一个立场';
  if (!reason.trim()) return '理由必填';
  if (reason.length > 4000) return '理由最多 4000 个字';
  return '';
}

/** 读报告、回应没成时的说法：400、404、409 照服务端说（它没说给一句默认的）；没登录、没权限、断网各一句；别的不透露原文 */
export function reportError(status: number, body: unknown): string {
  const msg = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : '';
  if (status === 400) return msg || '填的内容不对';
  if (status === 401) return '请先登录';
  if (status === 403) return '你没有这个台报告的权限';
  if (status === 404) return msg || '没有这份报告';
  if (status === 409) return msg || '报告已经变了，刷新后再试';
  if (status === 0) return '连不上服务，稍后再试';
  return '这次没成，稍后再试';
}

/** 论断类别的名字：模板里有就用模板的，没有就照写类别本身 */
export const kindLabel = (claims: { kind: string; label: string }[], kind: string): string => claims.find((c) => c.kind === kind)?.label ?? kind;

/** 产出方、回应者是人还是 AI 的标记文字 */
export const actorKindText = (k: 'human' | 'ai'): string => (k === 'ai' ? 'AI' : '人');

/** 毫秒时间 → 「2026-11-21 08:05」（本地时区） */
export function timeText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 验收声明的说法：只说模板声明了什么（这一步不接验收门） */
export function gateText(gate: Record<string, unknown> | null): string {
  if (!gate) return '';
  return gate.open_dispute_blocks_acceptance === true ? '模板声明：有未处理的反驳时不能验收' : '模板声明：有未处理的反驳也可以验收';
}
