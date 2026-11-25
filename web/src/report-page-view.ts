/** 报告页（/use/<卡片 id>/reports，报告第 1 步 PR D）的纯函数：清单怎么分组、同一事物取哪几份并排、回应接在谁后面、错误怎么说。
 *  不碰网络、不碰 DOM，单测见 scripts/report-page-unit.mjs。 */
import type { ReportListItem, ReportNames, ReportPositionPart, ReportResponse, ReportStance } from './api';

export const STANCE_TEXT: Record<ReportStance, string> = { agree: '认可', dispute: '反驳', supplement: '补充' };
export const stanceText = (s: string): string => (s in STANCE_TEXT ? STANCE_TEXT[s as ReportStance] : UNNAMED);

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

/** 论断类别的名字：模板里有就用模板的；没有写「未命名」，不显示类别的键 */
export const kindLabel = (claims: { kind: string; label: string }[], kind: string): string => nameOr(claims.find((c) => c.kind === kind)?.label);

/**
 * 给人看的名字（#937 统筹）：页面不显示维度键、主体串（user:…）、授予串（…@area:…）、论断键、数据路径（槽名、视图键）。
 * 名字由服务端给（names），取不到的写「未命名」，不退回去显示内部串。
 */
export const UNNAMED = '未命名';
export const nameOr = (x: string | null | undefined): string => (typeof x === 'string' && x.trim() ? x : UNNAMED);
/** 位置：「角色名（范围名）」，几条用顿号连；MCP 会话、内置身份各一个说法；没有位置是空串 */
export function positionText(p: ReportPositionPart[] | 'mcp' | 'builtin' | undefined): string {
  if (p === 'mcp') return 'MCP 会话';
  if (p === 'builtin') return '内置身份';
  if (!p) return '';
  return p.map((x) => `${nameOr(x.role)}（${nameOr(x.scope)}）`).join('、');
}
/** 来源一行：视图名（块名）第 v 版，n 行；视图、块的名字取不到写「未命名」，不写视图键、槽名 */
export function sourceText(names: ReportNames['sources'][number] | undefined, s: { view_version: number; rows: number }): string {
  return `${nameOr(names?.view)}${names?.block ? `（${names.block}）` : ''} 第 ${s.view_version} 版，${s.rows} 行`;
}
/** 依据：取自哪个来源（按槽找到视图名）、哪几行（行键的值，是数据本身） */
export function basisText(names: ReportNames['sources'] | undefined, b: { slot: string; key: unknown[] }): string {
  const src = names?.find((x) => x.slot === b.slot);
  return `${nameOr(src?.view)}：${b.key.map((k) => String(k)).join(' / ')}`;
}

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

/**
 * 报告里的图片（docs/image-step1.md 用例 8，图片第 1 步 PR C）：地址一律是市场的代取路由，来源是这份报告（report=<编号>），
 * 浏览器不直接访问图片链接。服务端按「读者能读这个台的报告、报告属于这个台、冻结的正文里有这条链接」判，并按冻结的哈希核对取回的图
 */
export function reportImageSrc(bench: string, reportId: number, ref: unknown): string | null {
  if (typeof ref !== 'string' || ref === '' || !bench || !Number.isSafeInteger(reportId) || reportId < 1) return null;
  const q = new URLSearchParams();
  q.set('u', ref);
  q.set('report', String(reportId));
  return `/api/bench-views/${encodeURIComponent(bench)}/image?${q.toString()}`;
}
/** 代取的应答码 → 图片节点画成什么：200 照显示；409（取回的图和冻结的哈希对不上）「图片已变」，不显示新图；其余「图片取不到」 */
export type ReportImageState = 'ok' | 'changed' | 'missing';
export const reportImageState = (status: number): ReportImageState => (status === 200 ? 'ok' : status === 409 ? 'changed' : 'missing');
export const REPORT_IMAGE_TEXT: Record<Exclude<ReportImageState, 'ok'>, string> = { changed: '图片已变', missing: '图片取不到' };
