/** #1099 数据视图和报告页的块锚点、本页目录：纯函数，不碰 React、不碰 DOM，Node 直接加载做单测。 */

/** 一页超过这么多块才出目录 */
export const TOC_MIN_BLOCKS = 3;
export interface TocEntry { key: string; title: string; level: number }

/** 数据视图的块键：json-render 元素的 key（jr/to-spec.ts 里的 b<序号>） */
export const blockAnchor = (index: number): string => `b${index}`;

/** 数据视图的目录：有标题的块按次序进目录（没标题的不进）；整页不超过 TOC_MIN_BLOCKS 块不出目录（空数组） */
export function viewTocEntries(blocks: readonly { type?: unknown; title?: unknown }[] | null | undefined): TocEntry[] {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length <= TOC_MIN_BLOCKS) return [];
  return list.flatMap((b, i) => (typeof b?.title === 'string' && b.title.trim() ? [{ key: blockAnchor(i), title: b.title.trim(), level: 1 }] : []));
}

type RNode = { id?: unknown; type?: unknown; title?: unknown; children?: unknown };
/** 报告的目录：章节（有标题的 section）按出现次序，层级跟着嵌套；章节不超过 TOC_MIN_BLOCKS 个不出目录 */
export function reportTocEntries(nodes: unknown): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (ns: unknown, level: number) => {
    if (!Array.isArray(ns)) return;
    for (const n of ns as RNode[]) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'section' && typeof n.id === 'string' && n.id && typeof n.title === 'string' && n.title.trim()) out.push({ key: n.id, title: n.title.trim(), level });
      walk(n.children, n.type === 'section' ? level + 1 : level);
    }
  };
  walk(nodes, 1);
  return out.length > TOC_MIN_BLOCKS ? out : [];
}

/** 地址里的 #<块键>：解码后只认字母、数字、下划线、点、冒号、短横线，至多 80 个；别的（空、坏编码、别的字符）是 null */
export function anchorFromHash(hash: string | null | undefined): string | null {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  let key: string;
  try { key = decodeURIComponent(raw); } catch { return null; }
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(key) ? key : null;
}

/** 本块链接：当前地址（保留视图和筛选），换掉原来的 #，接上这一块 */
export function anchorUrl(origin: string, pathname: string, search: string, key: string): string {
  return `${origin}${pathname}${search}#${encodeURIComponent(key)}`;
}

/** 滚动时高亮哪一条：块的上沿到了滚动区上沿以下 threshold 像素以内的最后一条；滚到底了就是最后一条；一条都没到是第一条 */
export function activeTocKey(tops: readonly { key: string; top: number }[], threshold: number, atBottom: boolean): string | null {
  if (!tops.length) return null;
  if (atBottom) return tops[tops.length - 1].key;
  let cur = tops[0].key;
  for (const t of tops) if (t.top <= threshold) cur = t.key;
  return cur;
}

/** 「回到顶部」：滚过一屏才出现 */
export const showBackToTop = (scrollTop: number, viewport: number): boolean => viewport > 0 && scrollTop > viewport;
