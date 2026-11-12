/** 站内页面路径（不碰 React、不引别的文件，scripts/page-paths-unit.mjs 直接测，并核对和 web/src/App.tsx 的路由一致）。
 *  服务端给的条目链接（「关注」的 link）不一定指着站内的页面：有的是接口地址（/api/…），有的指着已经没有的页面。
 *  卡片上只把站内真有的页面做成链接，别的一律不显示，免得点出一个空白页或一段 JSON。 */

/** App.tsx 里路由的首段（「/」本身另算）。加删页面时跟着改，单测会对 */
export const PAGE_SEGMENTS: readonly string[] = ['access', 'attention', 'cockpit', 'dev', 'knowledge', 'market', 'mcp-gateways', 'overview', 'owner-pending', 'reviews', 'settings', 'skills', 'sops', 'tasks', 'team', 'types', 'use', 'vault', 'work-items'];

/** 是站内页面就原样返回，不是就返回 null：要以单个「/」开头、不是 /api/、首段在路由表里（「/」本身也算） */
export function pageLink(link: unknown): string | null {
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || /[\\\u0000-\u001f]/.test(link)) return null;
  const seg = link.slice(1).split(/[/?#]/)[0];
  if (seg === '') return link;
  if (seg === 'api') return null;
  return PAGE_SEGMENTS.includes(seg) ? link : null;
}
