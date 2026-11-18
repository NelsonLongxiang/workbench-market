/** 给扩展用的宿主能力（import ... from '@wm/host'）：只放稳定的通用组件与工具，扩展不直接 import 宿主内部路径。 */
import { loginHref } from '../login-href';
export { default as WmPage } from '../components/WmPage';
export { loginHref };

/* ---- 下面三个是 Odoo 下线（2026-11-17）前的旧名字，保留一个版本，下个版本删 ----
 * 以前是 Odoo 弹窗登录；现在登录只走站内 /login，整页跳过去、登录完回到当前页。
 * 每个旧名字第一次被用时在控制台告警一次，扩展请改用 loginHref（整页跳转即可，不需要弹窗和轮询）。 */
const warned = new Set<string>();
const warnOnce = (name: string) => { if (!warned.has(name)) { warned.add(name); console.warn(`[@wm/host] ${name} 已弃用（Odoo 已下线），请改用 loginHref；下个版本删除`); } };
const here = () => window.location.pathname + window.location.search + window.location.hash;
/** @deprecated 改用 loginHref */
export function odooLoginHref(loginUrl: string): string { warnOnce('odooLoginHref'); return loginHref(loginUrl, here()); }
/** @deprecated 改用 loginHref：整页跳到登录页。为了旧扩展照常编译，返回的形状和以前一样；polling、blocked、tokenHere 恒为 false */
export function useOdooPopupLogin(href: string | null, _onDone: () => void) {
  warnOnce('useOdooPopupLogin');
  const open = () => { if (href) window.location.assign(loginHref(href, here())); };
  return { open, clearAndOpen: open, polling: false, blocked: false, tokenHere: false };
}
/** @deprecated 不再派发（没有弹窗登录了） */
export const ODOO_SESSION_CONFIRMED = 'wm:odoo-session-confirmed';
