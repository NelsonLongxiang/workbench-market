/** 嵌台的防护：驾驶舱和 /use/<id> 用 /go/<id>/ 把一个台嵌进来。台登记的地址要是指向市场自己，嵌出来就是「市场套市场」。
 *  两层：嵌之前看登记的地址（同源、又不在台的路径下就不嵌）；嵌进来以后看框里是不是市场自己的页面（index.html 里的 wm-surface 标记），是就换成一句话。
 *  第二层兜住「路径没有对应的台，回退成了市场自己的页面」这种。纯函数，不引别的文件：scripts/embed-guard-unit.mjs 直接测。 */

/** 和市场同源时，台在这些路径下（平台托管的应用、流程的执行页、跳转口）；别的同源路径就是市场自己的页面 */
export const BENCH_PATHS = ['/apps/', '/sop/', '/go/'] as const;

export const MARKET_SELF_TEXT = '这个台的地址指向市场本身，不能嵌在驾驶舱里';

/** 登记的地址是不是指向市场自己：解析不了的不算（交给服务端的准入）；别的来源不算 */
export function pointsAtMarket(url: unknown, origin: string): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  let u: URL;
  try { u = new URL(url.trim(), origin); } catch { return false; }
  if (u.origin !== origin) return false;
  return !BENCH_PATHS.some((p) => u.pathname.startsWith(p));
}

/** 框里的页面是不是市场自己（同源才读得到；读不到的是别的来源，当不是） */
export function isMarketDocument(doc: { querySelector: (s: string) => unknown } | null | undefined): boolean {
  try { return !!doc?.querySelector('meta[name="wm-surface"][content="market"]'); } catch { return false; }
}
