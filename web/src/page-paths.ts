/** 站内页面路径（不碰 React、不引别的文件，scripts/page-paths-unit.mjs 直接测，并核对和 web/src/App.tsx 的路由一致）。
 *  服务端给的条目链接（「关注」的 link）不一定指着站内的页面：有的是接口地址（/api/…），有的指着已经没有的页面。
 *  卡片上只把站内真有的页面做成链接，别的一律不显示，免得点出一个空白页或一段 JSON。 */

/** App.tsx 里路由的首段（「/」本身另算）。加删页面时跟着改，单测会对 */
export const PAGE_SEGMENTS: readonly string[] = ['access', 'attention', 'cockpit', 'dev', 'knowledge', 'market', 'mcp-gateways', 'owner-pending', 'settings', 'sops', 'team', 'types', 'use', 'vault', 'work-items'];

/** 是站内页面就原样返回，不是就返回 null：要以单个「/」开头、不是 /api/、首段在路由表里（「/」本身也算） */
export function pageLink(link: unknown): string | null {
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || /[\\\u0000-\u001f]/.test(link)) return null;
  const seg = link.slice(1).split(/[/?#]/)[0];
  if (seg === '') return link;
  if (seg === 'api') return null;
  return PAGE_SEGMENTS.includes(seg) ? link : null;
}

/** 条目没给可用的链接时去哪办：按来源给缺省的站内页面；实在没有页面的写一句去哪办。认不出的来源返回空 */
const FALLBACK: Record<string, { link?: string; text?: string }> = {
  'relation-proposals': { link: '/team' },
  'team-health': { link: '/team' },
  'principal-pending': { link: '/access', text: '到「谁能做什么」里处理这个外部账号' },
  'a2a-peers': { text: '管理员在 A2A 对端的设置里核对新公钥的指纹后确认' },
  'change-requests': { link: '/market' },
  'mcp-access': { link: '/mcp-gateways' },
};
export function fallbackPlace(source: string): { link: string; text: string } {
  const f = Object.hasOwn(FALLBACK, source) ? FALLBACK[source] : {};
  const link = f.link ? pageLink(f.link) : null;
  return { link: link ?? '', text: f.text ?? '' };
}

/** 删掉的页面，旧链接、书签来了去哪：不落到兜底的首页，跳到现在管这件事的地方。键是旧地址的首段 */
export const RETIRED_REDIRECTS: Readonly<Record<string, string>> = {
  skills: '/market?k=技能', // 2026-11-14 上一版的「技能市场」总表删了（属主：demo，没有用于生产）；技能在市场的「技能」分类里，一个技能一页
};
/** 一个地址是不是删掉的页面：是就给新去处，不是给 null */
export function retiredRedirect(pathname: string): string | null {
  const seg = pathname.replace(/^\/+/, '').split(/[/?#]/)[0];
  return Object.hasOwn(RETIRED_REDIRECTS, seg) ? RETIRED_REDIRECTS[seg] : null;
}
