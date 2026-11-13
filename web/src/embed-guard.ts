/** 嵌台的防护：驾驶舱和 /use/<id> 用 /go/<id>/ 把一个台嵌进来。台登记的地址要是指向市场自己，嵌出来就是「市场套市场」。
 *  两层：嵌之前看登记的地址（同源、又不在台的路径下就不嵌）；嵌进来以后看框里是不是市场自己的页面（index.html 里的 wm-surface 标记），是就换成一句话。
 *  第二层兜住「路径没有对应的台，回退成了市场自己的页面」这种。纯函数，不引别的文件：scripts/embed-guard-unit.mjs 直接测。 */

/** 和市场同源时，台在这些路径下（平台托管的应用、流程的执行页、跳转口）；别的同源路径就是市场自己的页面 */
export const BENCH_PATHS = ['/apps/', '/sop/', '/go/'] as const;

export const MARKET_SELF_TEXT = '这个台的地址指向市场本身，不能嵌在驾驶舱里';
/** /use/<id> 上的说法（不在驾驶舱里） */
export const USE_SELF_TEXT = '这个台的地址指向市场本身，在这里打不开；请管理员改一下登记的地址';
/** 嵌进框里、才发现框里是市场自己的页面时，框里写的一句（不管外面是驾驶舱还是 /use） */
export const FRAMED_SELF_TEXT = '这个台的地址指向市场本身，嵌在这里打不开；请管理员改一下登记的地址';

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

/** 这一页是不是被市场自己嵌在框里（第二层防护，在框里的页面上判）：
 *  在框里（不是最外层）、外面那一页读得到、而且外面也是市场——那这一页就是「市场套市场」，不画整个市场，只写一句。
 *  外面读不到（别的来源）的不算；自己就是最外层的不算。 */
export function framedByMarket(win: { self: unknown; top: unknown; parent: { document?: { querySelector: (s: string) => unknown } } | null }): boolean {
  try {
    if (!win.parent || win.self === win.top || win.parent === (win.self as unknown)) return false;
    return isMarketDocument(win.parent.document);
  } catch { return false; }
}
