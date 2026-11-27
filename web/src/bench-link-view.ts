/** #1086 数据视图台和主页卡片的对应：卡片地址指向本站台页面时怎么说、卡片的健康状态怎么显示、「对应卡片」的结果怎么说。
 *  纯函数，不碰 React、不碰网络，Node 直接加载做单测。 */

/** 服务端记「待对应」时 last_error 的前缀（server/src/services/bench-card-health.ts 同一个） */
export const PENDING_LINK_PREFIX = '待对应：';

/** 卡片地址是不是本站的 /use/<台>（同源或相对地址）；是就回 <台> 的引用，不是回 null */
export function benchUseRef(url: unknown, origin: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const s = url.trim();
  let u: URL;
  try { u = new URL(s, origin || 'http://relative.invalid'); } catch { return null; }
  const relative = s.startsWith('/') && !s.startsWith('//');
  if (!relative && u.origin !== origin) return null;
  const m = /^\/use\/([^/?#]+)(?:\/|$)/.exec(u.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).trim() || null; } catch { return null; }
}

export type CardHealthKey = 'up' | 'down' | 'unknown' | 'pending';
/** 卡片的健康状态：服务端记了「待对应」，或地址是本站 /use/<台> 而且不在线——都是「待对应」，不显示「离线」 */
export function cardHealthKey(status: unknown, lastError: unknown, url: unknown, origin: string): CardHealthKey {
  if (typeof lastError === 'string' && lastError.startsWith(PENDING_LINK_PREFIX)) return 'pending';
  if (status === 'up') return 'up';
  if (benchUseRef(url, origin) !== null) return 'pending';
  return status === 'down' ? 'down' : 'unknown';
}

/** /use/<卡片 id> 打开、卡片地址又是本站台页面时的说法：写明下一步（不在这里跳转——入口按卡片 id 判权） */
export function benchUseText(title: string | null): string {
  return `这张卡片的地址是市场里的数据视图台${title ? `「${title}」` : ''}，从这里打不开。请管理层在台的页面顶栏点「对应卡片」，选这张卡片；对应好以后，从主页点这张卡片就直接进到数据视图页。`;
}

/** 「对应卡片」里能选的卡片：启用的、id 是正整数的，按名字排；写成「名字（#id）」 */
export function cardOptions(list: unknown): { value: number; label: string }[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((w): w is { id: number; name: string; enabled?: unknown } => !!w && typeof w === 'object' && Number.isInteger((w as { id?: unknown }).id) && (w as { id: number }).id > 0 && typeof (w as { name?: unknown }).name === 'string' && (w as { enabled?: unknown }).enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id - b.id)
    .map((w) => ({ value: w.id, label: `${w.name.trim() || '未命名'}（#${w.id}）` }));
}

/** 改对应的结果：办成了说变没变；被拒的照服务端写成中文句子的说，代号不露 */
export function linkOutcome(status: number, body: unknown): { kind: 'ok'; changed: boolean } | { kind: 'error'; text: string } {
  const b = body && typeof body === 'object' ? (body as { changed?: unknown; message?: unknown; error?: unknown }) : {};
  if (status >= 200 && status < 300) return { kind: 'ok', changed: b.changed === true };
  for (const v of [b.message, b.error]) if (typeof v === 'string' && v.trim() && /[^\x00-\x7f]/.test(v)) return { kind: 'error', text: v.trim() };
  if (status === 409) return { kind: 'error', text: '这张卡片已经对应了别的视图台；先在那个台上去掉对应，再来这里选。' };
  if (status === 403) return { kind: 'error', text: '只有管理层能改台对应的卡片。' };
  if (status === 404) return { kind: 'error', text: '找不到这个台了，刷新页面看看。' };
  if (status === 0) return { kind: 'error', text: '连不上服务器，检查网络后再试。' };
  return { kind: 'error', text: '没改成，稍后再试。' };
}
