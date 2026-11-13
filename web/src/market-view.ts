/**
 * 工作台市场（照产品化原型 3fbfd0b 的 #/market）的判断逻辑：把工作台、流程、技能三个来源合成一份卡片列表，
 * 分类、计数、每个来源读不到时怎么说。纯函数，不碰 React；页面在 pages/market/Market.tsx。
 *
 * 「连接器」只给管理员（MCP 上游的名字、状态、工具数是部署内部信息，GET /api/mcp/upstreams 只给管理员）；别人这一类整个不出现。
 * 原型里的「质量评级」没有数据来源，不出现（不造字母）。
 * 只能 import type：scripts/market-ui-unit.mjs 用 Node 直接加载这个文件。
 */
import type { SopApp, SopRun, Workbench } from './types';

export type MarketKind = '工作台' | '流程' | '技能' | '连接器';
export const MARKET_TABS = ['全部', '工作台', '流程', '技能', '连接器'] as const;
export type MarketTab = (typeof MARKET_TABS)[number];
/** 看的人能看到的分类页签：连接器只给管理员 */
export function tabsFor(admin: boolean): MarketTab[] {
  return MARKET_TABS.filter((t) => admin || t !== '连接器');
}

/** /api/skills 的一行（只取卡片用到的） */
export interface SkillRow {
  slug: string; name: string; layer: number; layer_name: string; family_parent: string;
  description?: string; legacy: boolean; versions: number; active_version: number | null;
}

export interface MarketCard {
  key: string;
  kind: MarketKind;
  /** 图标：工作台登记的 emoji；没有就用名字的第一个字 */
  icon: string;
  /** 图标是不是名字的头一个字（样式上要换成色块里的字） */
  initial: boolean;
  name: string;
  /** 名字下面那一行小字：工作台的分类、流程的版本、技能的层 */
  caption: string;
  description: string;
  tags: string[];
  /** 卡片底部左边：一句有来源的事实（工作台的在线状态、流程在办几件、技能几个版本）；没有来源就只写状态，不造数字 */
  usage: string;
  /** 工作台最近一次检测的时间（服务端 UTC 时间）：页面在状态后面接相对时间 */
  checkedAt?: string;
  /** 卡片底部右边的去处 */
  href: string;
  action: '打开' | '查看';
}

/** 一个来源读下来的结果：状态码和应答体（页面按状态码给说法） */
export interface SourceResult { status: number; body: unknown }

/** 名字的头一个字（按字符算，不切坏 emoji 和汉字） */
export function initialOf(name: string): string {
  const first = Array.from(String(name ?? '').trim())[0];
  return first ? first.toUpperCase() : '·';
}

/** 登记的图标能不能直接显示：一两个字符的符号（emoji），不是网址、不是图标库的名字 */
export function usableIcon(icon: unknown): string | null {
  if (typeof icon !== 'string') return null;
  const s = icon.trim();
  if (!s || /^[\w.:/-]+$/.test(s)) return null; // 空、网址、英文图标名
  return Array.from(s).length <= 2 ? s : null;
}

const HEALTH: Record<string, string> = { up: '在线', down: '离线', unknown: '还没检查过' }; // 和管理工作台那页的说法一致
export function healthLabel(status: unknown): string {
  return HEALTH[String(status)] ?? '还没检查过';
}

export function workbenchCards(list: unknown): MarketCard[] {
  if (!Array.isArray(list)) return [];
  return (list as Workbench[])
    .filter((w) => w && typeof w === 'object' && w.enabled !== false && typeof w.name === 'string' && Number.isInteger(w.id))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name, 'zh-CN'))
    .map((w) => {
      const icon = usableIcon(w.icon);
      return {
        key: `wb-${w.id}`, kind: '工作台' as const,
        icon: icon ?? initialOf(w.name), initial: !icon,
        name: w.name, caption: String(w.category ?? '').trim(),
        description: String(w.description ?? '').trim(),
        tags: Array.isArray(w.tags) ? w.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 3) : [],
        usage: healthLabel(w.last_status),
        ...(typeof w.last_checked_at === 'string' && w.last_checked_at.trim() ? { checkedAt: w.last_checked_at.trim() } : {}),
        href: `/use/${w.id}`, action: '打开' as const,
      };
    });
}

/** 正在办的流程 run 按流程数一下（任务中心的录入模板 run 不算） */
export function runningBySlug(runs: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(runs)) return out;
  for (const r of runs as SopRun[]) {
    if (!r || r.status !== 'running' || typeof r.sop_slug !== 'string') continue;
    out.set(r.sop_slug, (out.get(r.sop_slug) ?? 0) + 1);
  }
  return out;
}

/** 只列已发布的流程（草稿、已停用的不进市场；管理在 SOP 交付空间） */
export function sopCards(list: unknown, running: Map<string, number> | null): MarketCard[] {
  if (!Array.isArray(list)) return [];
  return (list as SopApp[])
    .filter((s) => s && typeof s === 'object' && s.status === 'published' && typeof s.slug === 'string' && s.slug !== 'task-center')
    .sort((a, b) => String(a.title || a.slug).localeCompare(String(b.title || b.slug), 'zh-CN'))
    .map((s) => {
      const name = String(s.title || s.slug);
      const n = running?.get(s.slug) ?? 0;
      return {
        key: `sop-${s.slug}`, kind: '流程' as const,
        icon: initialOf(name), initial: true,
        name, caption: Number.isInteger(s.active_version) && s.active_version > 0 ? `第 ${s.active_version} 版` : '',
        description: String(s.description ?? '').trim(),
        tags: [],
        // 在办数读不到时不写（不说成 0）
        usage: running === null ? '' : n > 0 ? `在办 ${n} 件` : '现在没有在办的',
        href: `/sops/${encodeURIComponent(s.slug)}`, action: '打开' as const,
      };
    });
}

/** 只列有版本的技能（没有版本的拿不到、装不上） */
export function skillCards(body: unknown): MarketCard[] {
  const list = Array.isArray(body) ? body : (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : null);
  if (!list) return [];
  return (list as SkillRow[])
    .filter((k) => k && typeof k === 'object' && typeof k.slug === 'string' && Number(k.versions) > 0)
    .sort((a, b) => (Number(a.layer) || 0) - (Number(b.layer) || 0) || String(a.name || a.slug).localeCompare(String(b.name || b.slug), 'zh-CN'))
    .map((k) => {
      const name = String(k.name || k.slug);
      const tags = [k.family_parent, k.legacy ? '旧版' : ''].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      return {
        key: `skill-${k.slug}`, kind: '技能' as const,
        icon: initialOf(name), initial: true,
        name, caption: String(k.layer_name ?? '').trim(),
        description: String(k.description ?? '').trim(),
        tags,
        usage: `${Number(k.versions)} 个版本`,
        href: '/skills', action: '查看' as const,
      };
    });
}

export function cardsOf(cards: MarketCard[], tab: MarketTab): MarketCard[] {
  return tab === '全部' ? cards : cards.filter((c) => c.kind === tab);
}

/** 没有说明的卡片在说明区写这一句（卡片等高、同一排底部对齐） */
export const NO_DESCRIPTION = '还没有说明';

/** 标签行只放类别以外的标签（类别已经是上面的分类页签了）；没有就不显示这一行 */
export function extraTags(c: MarketCard): string[] {
  return c.tags.filter((t) => t !== c.kind);
}
/** 卡片上的标签：某一类的页签里不重复类别（#584）；「全部」里几类混排，第一个补上类别，分得清是台、流程还是技能 */
export function cardTags(c: MarketCard, tab: MarketTab): string[] {
  return tab === '全部' ? [c.kind, ...extraTags(c)] : extraTags(c);
}

/** GET /api/mcp/upstreams 的一行（只取卡片用到的） */
export interface UpstreamRow { prefix: string; kind?: string; enabled?: boolean; reachable?: boolean | null; tools?: number; last_checked_at?: string }
/** 连接器卡片（只给管理员）：名字是上游的前缀；底部写连得上几个工具 / 连不上 / 还没检查过；停用的写停用。点了去 MCP 网关的管理页 */
export function connectorCards(list: unknown): MarketCard[] {
  if (!Array.isArray(list)) return [];
  return (list as UpstreamRow[])
    .filter((u) => u && typeof u === 'object' && typeof u.prefix === 'string' && u.prefix.trim() !== '')
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((u) => {
      const tools = Number.isInteger(u.tools) && (u.tools as number) >= 0 ? (u.tools as number) : 0;
      const usage = u.enabled === false ? '已停用' : u.reachable === true ? `连得上 · ${tools} 个工具` : u.reachable === false ? '连不上' : '还没检查过';
      return {
        key: `conn-${u.prefix}`, kind: '连接器' as const,
        icon: initialOf(u.prefix), initial: true,
        name: u.prefix, caption: u.kind === 'ygl-trees' ? '经验库连接' : 'MCP 上游',
        description: '', tags: [], usage,
        ...(typeof u.last_checked_at === 'string' && u.last_checked_at.trim() && u.enabled !== false ? { checkedAt: u.last_checked_at.trim() } : {}),
        href: '/mcp-gateways', action: '查看' as const,
      };
    });
}

/** 地址里的分类（?k=流程）：认不出的当「全部」 */
export function tabFromQuery(raw: string | null): MarketTab {
  return (MARKET_TABS as readonly string[]).includes(String(raw)) ? (raw as MarketTab) : '全部';
}

const NOUN: Record<MarketKind, string> = { 工作台: '工作台', 流程: '流程', 技能: '技能', 连接器: '连接器' };

/** 一个来源读不到时怎么说；读到了返回 null。type 对应 antd Alert 的 type */
export function sourceProblem(kind: MarketKind, r: SourceResult | null): { type: 'warning' | 'info'; text: string } | null {
  if (!r) return null;
  const noun = NOUN[kind];
  if (r.status === 401) return { type: 'warning', text: `请先登录，登录后才能看到${noun}。` };
  if (r.status === 403) return { type: 'warning', text: `你的账号现在不能查看${noun}。` };
  if (r.status === 404) return { type: 'info', text: `${noun}的服务还没上线。` };
  if (r.status === 0 || r.status >= 400) return { type: 'warning', text: `读不到${noun}，稍后再试。` };
  return null;
}

/** 某一类空着时怎么说：为什么空、下一步能做什么 */
export function emptyText(tab: MarketTab, admin: boolean): string {
  if (tab === '工作台') return admin ? '还没有登记的工作台。点右上角「管理」里的「管理工作台」登记第一个。' : '还没有登记的工作台。工作台由管理员登记，登记后会出现在这里。';
  if (tab === '流程') return '还没有发布的流程。流程在 SOP 交付空间发布之后会出现在这里。';
  if (tab === '技能') return '还没有发布的技能。技能发布第一个版本之后会出现在这里。';
  if (tab === '连接器') return '还没有接上的连接器。在管理菜单的「MCP 网关」里加上游之后会出现在这里。';
  return '市场里还什么都没有。工作台、流程、技能上架之后会出现在这里。';
}

/** 单个台的详情（/market/wb/:id）：读不到时怎么说。null = 读到了 */
export function detailProblem(status: number): { kind: 'gone' | 'login' | 'denied' | 'error'; text: string } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404) return { kind: 'gone', text: '这个台不在了，可能已经被删掉。' };
  if (status === 401) return { kind: 'login', text: '请先登录，登录后才能看这个台。' };
  if (status === 403) return { kind: 'denied', text: '你的账号现在不能查看这个台。' };
  return { kind: 'error', text: '读不到这个台，稍后再试。' };
}
/** 地址里的台号：正整数才认 */
export function workbenchIdOf(raw: string | undefined): number | null {
  return raw && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
}
/** 「编辑」先回到管理页的那一行：按名字筛出来（管理页读 ?q=） */
export function manageHref(name: string): string {
  return `/market/manage?q=${encodeURIComponent(name)}`;
}

/** 这个登记的台对应哪个数据视图的台（#674：GET /api/bench-views 每一项带 workbench_id）。只认 workbench_id 正好是这个台号的那一项，不按名字配。
 *  清单没取到（没登录、没权限 403、没开启 404、出错）或者没有对应的，都是 null——详情页这一块就不出现 */
export function benchSlugFor(status: number, body: unknown, workbenchId: number): string | null {
  if (status !== 200) return null;
  const list = (body as { benches?: unknown } | null)?.benches;
  if (!Array.isArray(list)) return null;
  const hit = list.find((b) => !!b && typeof b === 'object' && (b as { workbench_id?: unknown }).workbench_id === workbenchId && typeof (b as { slug?: unknown }).slug === 'string');
  return hit ? (hit as { slug: string }).slug : null;
}
/** 一个数据视图的台有哪些视图的名字（GET /api/bench-views/<台>/view 的 view.content.views[]）。没取到、没有视图都是空——这一块不出现。
 *  名字没写的用不上（不拿视图键顶替：键是代号） */
export function viewTitles(status: number, body: unknown): string[] {
  if (status !== 200) return [];
  const views = (body as { view?: { content?: { views?: unknown } } | null } | null)?.view?.content?.views;
  if (!Array.isArray(views)) return [];
  return views.flatMap((v) => (v && typeof v === 'object' && typeof (v as { title?: unknown }).title === 'string' && (v as { title: string }).title.trim() ? [(v as { title: string }).title.trim()] : []));
}
