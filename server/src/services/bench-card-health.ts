/** #1086 卡片地址指向市场自己的数据视图台页面（/use/<台>）时，健康巡检不对它做外部探测：
 *  已经对应到台的按台的状态（台在就是在线），还没对应的记「待对应」，不判离线。纯函数，不碰库。 */

/** 地址是不是市场自己的 /use/<台>：相对地址 /use/…，或与市场已知来源同源。是就回 <台> 的引用（解码后），不是回 null */
export function ownUseRef(url: unknown, origins: readonly (string | null | undefined)[]): string | null {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (!s) return null;
  const relative = s.startsWith('/') && !s.startsWith('//');
  let u: URL;
  try { u = new URL(s, 'http://relative.invalid'); } catch { return null; }
  if (!relative && !origins.some((o) => typeof o === 'string' && o && o === u.origin)) return null;
  const m = /^\/use\/([^/?#]+)(?:\/|$)/.exec(u.pathname);
  if (!m) return null;
  try { const ref = decodeURIComponent(m[1]).trim(); return ref || null; } catch { return null; }
}

/** 「待对应」记在卡片的 last_error 上：前缀固定（页面据此显示「待对应」），后面写下一步 */
export const PENDING_LINK_PREFIX = '待对应：';
export function pendingLinkError(ref: string): string {
  return `${PENDING_LINK_PREFIX}这张卡片的地址是市场里的数据视图台「${ref.slice(0, 64)}」，请管理层在台的页面上把台对应到这张卡片`;
}
