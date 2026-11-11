/**
 * 工作台市场（照产品化原型 3fbfd0b 的 #/market）的判断逻辑：把工作台、流程、技能三个来源合成一份卡片列表，
 * 分类、计数、每个来源读不到时怎么说。纯函数，不碰 React；页面在 pages/market/Market.tsx。
 *
 * 原型里还有「连接器」一类和「质量评级」：现在没有数据来源，不出现（不放占位）。
 * 只能 import type：scripts/market-ui-unit.mjs 用 Node 直接加载这个文件。
 */
import type { SopApp, SopRun, Workbench } from './types';

export type MarketKind = '工作台' | '流程' | '技能';
export const MARKET_TABS = ['全部', '工作台', '流程', '技能'] as const;
export type MarketTab = (typeof MARKET_TABS)[number];

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
  /** 卡片底部左边：现在怎么样（在线、在办几件、几个版本） */
  usage: string;
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

/** 地址里的分类（?k=流程）：认不出的当「全部」 */
export function tabFromQuery(raw: string | null): MarketTab {
  return (MARKET_TABS as readonly string[]).includes(String(raw)) ? (raw as MarketTab) : '全部';
}

const NOUN: Record<MarketKind, string> = { 工作台: '工作台', 流程: '流程', 技能: '技能' };

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
  if (tab === '工作台') return admin ? '还没有登记的工作台。点右上角「管理工作台」登记第一个。' : '还没有登记的工作台。工作台由管理员登记，登记后会出现在这里。';
  if (tab === '流程') return '还没有发布的流程。流程在 SOP 交付空间发布之后会出现在这里。';
  if (tab === '技能') return '还没有发布的技能。技能发布第一个版本之后会出现在这里。';
  return '市场里还什么都没有。工作台、流程、技能上架之后会出现在这里。';
}
