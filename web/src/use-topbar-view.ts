/** #1098 台页、报告页（/use/*，整屏、不套侧栏）的顶栏：面包屑每一级去哪、「上一页」去哪。不碰 React，Node 直接加载做单测。 */
export type UsePage = 'bench' | 'reports' | 'card';
export interface Crumb { key: 'home' | 'bench' | 'reports'; label: string; to: string | null; testid: string }

/** 面包屑：「全景 / <台名>」，报告页再加「 / 报告」。除了当前这一级，每一级都能点 */
export function topCrumbs(cardId: string, title: string, page: UsePage): Crumb[] {
  const bench = `/use/${encodeURIComponent(cardId)}`;
  const out: Crumb[] = [
    { key: 'home', label: '全景', to: '/', testid: 'use-crumb-home' },
    { key: 'bench', label: title, to: page === 'reports' ? bench : null, testid: 'use-crumb-bench' },
  ];
  if (page === 'reports') out.push({ key: 'reports', label: '报告', to: null, testid: 'use-crumb-reports' });
  return out;
}

/** 「上一页」：本站里有上一页（路由给的 location.key 不是 default）就退一步；
 *  直接打开的（新标签、外链、刷新后的第一页）历史里的上一页不是本站，回全景，不退出站点 */
export function backTarget(locationKey: string | null | undefined): -1 | '/' {
  return locationKey && locationKey !== 'default' ? -1 : '/';
}
