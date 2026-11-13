/** 经验库（照产品化原型 3fbfd0b 的 #/knowledge）的纯函数：四类条目叫什么、各是什么；读接口（#717，GET /api/knowledge、/api/knowledge/:key）的应答怎么读、怎么说。
 *  条目按这里的类别显示（类别名、图标、颜色同一处）。不引别的文件：scripts/knowledge-ui-unit.mjs 用 Node 直接加载。 */

export type KnowledgeKind = 'claim' | 'kb' | 'skill' | 'verify';

/** tone：图标底色用哪一档（antd 的 success / info / purple） */
export const KNOWLEDGE_KINDS: { key: KnowledgeKind; label: string; meaning: string; tone: 'success' | 'info' | 'purple' }[] = [
  { key: 'claim', label: '依据', meaning: '有原始记录、复核过的结论', tone: 'success' },
  { key: 'kb', label: '经验', meaning: '你拍过板的取舍，AI 员工以后照着办，不再问你', tone: 'info' },
  { key: 'skill', label: '方法', meaning: '反复用到的做法，整理成公司的标准方法', tone: 'purple' },
  { key: 'verify', label: '检查', meaning: '数据规范的检查结果，结果封存不改', tone: 'success' },
];

/** 页面顶上那一句（照原型） */
export const KNOWLEDGE_INTRO = '公司越用越聪明：你拍过板的取舍会记下来，下次 AI 员工照着办、不再问你；反复用到的做法会整理成公司的标准方法。';

/** 一条都没有时的说法：只说现在没有、以后从哪里来 */
export const KNOWLEDGE_EMPTY = '经验库里还没有内容。以后从事项里沉淀下来的东西会按这四类出现在这里：';

/** 类别的名字：认不出的类别不露代号，写「其他」 */
export function kindLabel(kind: unknown): string {
  return KNOWLEDGE_KINDS.find((k) => k.key === kind)?.label ?? '其他';
}

/** 列表里的一条（#717）。key 是不透明的编号，只用在地址里，不写在页面的字上 */
export type KnowledgeItem = { key: string; kind: KnowledgeKind | string; title: string; summary: string; status: string | null; tags: string[]; created: string; updated: string; scope_label: string };
export type KnowledgeSource = 'ok' | 'not_ready' | 'degraded';
export type KnowledgeEvidence = { quote: string; note: string; stance: string; created: string; source: { title: string; url: string | null } | null };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** 一条的形状核一遍：key、标题是文字才要；别的缺了给空。tags 只留文字 */
export function asItem(v: unknown): KnowledgeItem | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as Record<string, unknown>;
  if (!str(x.key) || !str(x.title)) return null;
  return { key: str(x.key), kind: str(x.kind), title: str(x.title), summary: str(x.summary), status: typeof x.status === 'string' && x.status ? x.status : null,
    tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [], created: str(x.created), updated: str(x.updated), scope_label: str(x.scope_label) };
}
/** 列表应答：{ items, source }。形状不对的条目丢掉；source 认不出当 ok */
export function asList(body: unknown): { items: KnowledgeItem[]; source: KnowledgeSource } {
  const b = (body && typeof body === 'object' ? body : {}) as { items?: unknown; source?: unknown };
  const items = Array.isArray(b.items) ? b.items.map(asItem).filter((x): x is KnowledgeItem => x !== null) : [];
  const source: KnowledgeSource = b.source === 'not_ready' || b.source === 'degraded' ? b.source : 'ok';
  return { items, source };
}

/** 状态怎么说：依据是仲裁结果，检查是总结论；认不出的不显示（不露代号） */
const STATUS: Record<string, { text: string; tone: 'success' | 'error' | 'warning' | 'default' }> = {
  supported: { text: '有依据支持', tone: 'success' }, refuted: { text: '被推翻了', tone: 'error' }, contested: { text: '有争议', tone: 'warning' }, open: { text: '还没定', tone: 'default' },
  PASS: { text: '通过', tone: 'success' }, FAIL: { text: '没通过', tone: 'error' }, 'NEEDS-MATERIAL': { text: '缺材料', tone: 'warning' }, ERROR: { text: '没查成', tone: 'warning' },
};
export function statusOf(status: string | null | undefined): { text: string; tone: 'success' | 'error' | 'warning' | 'default' } | null {
  return status ? STATUS[status] ?? null : null;
}
/** 依据的一条原文是支持还是反驳 */
export const stanceLabel = (s: unknown): string => (s === 'supports' ? '支持' : s === 'refutes' ? '反驳' : '');

/** 地址里的类别：?k=claim 这类；认不出、没写的当全部 */
export type KnowledgeTab = KnowledgeKind | 'all';
export function tabFromQuery(q: string | null): KnowledgeTab {
  return KNOWLEDGE_KINDS.some((k) => k.key === q) ? q as KnowledgeKind : 'all';
}
/** 各类有几条（全部也算上） */
export function countsOf(items: KnowledgeItem[]): Record<KnowledgeTab, number> {
  const c = { all: items.length, claim: 0, kb: 0, skill: 0, verify: 0 } as Record<KnowledgeTab, number>;
  for (const x of items) if (x.kind in c && x.kind !== 'all') c[x.kind as KnowledgeKind]++;
  return c;
}
export const itemsOf = (items: KnowledgeItem[], tab: KnowledgeTab): KnowledgeItem[] => (tab === 'all' ? items : items.filter((x) => x.kind === tab));

/** 读不到时怎么说（列表、详情共用）：401 请先登录；403 是管理口令或跨站；详情的 404 一律「没有这一条」；503 暂时读不到；别的读不到。不露代号 */
export const KNOWLEDGE_FORBIDDEN = '经验库是业务内容，请用自己的账号登录。';
export function problemOf(status: number, where: 'list' | 'detail'): { text: string; retry: boolean } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return { text: '请先登录。', retry: false };
  if (status === 403) return { text: KNOWLEDGE_FORBIDDEN, retry: false };
  if (status === 404 && where === 'detail') return { text: '没有这一条。', retry: false };
  if (status === 503) return { text: '经验库暂时读不到，稍后再试。', retry: true };
  if (status === 0) return { text: '连不上服务器，稍后再试。', retry: true };
  return { text: '读不到经验库，稍后再试。', retry: true };
}
/** 来源的说法：还没同步成过——整页说「还在准备」；最近一轮没同步上——列表照常，轻提示 */
export const SOURCE_NOT_READY = '经验库还在准备，过一会儿再来看。';
export const SOURCE_DEGRADED = '经验库最近一次没更新上，这里的内容可能不是最新的。';
/** 某一类空着时 */
export const emptyKindText = (tab: KnowledgeTab): string => (tab === 'all' ? KNOWLEDGE_EMPTY : `「${kindLabel(tab)}」这一类还没有内容。`);
/** 依据原文的出处链接：只认 http / https，别的不做成链接 */
export const safeUrl = (u: unknown): string | null => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
