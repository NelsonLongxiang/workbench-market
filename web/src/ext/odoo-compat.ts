/** Odoo 下线（2026-11-17）前给扩展的旧名字，经 @wm/host（web/src/ext/host.ts）导出，保留一个版本，下个版本删。
 *  以前是 Odoo 弹窗登录；现在登录只走站内 /login，整页跳过去、登录完回到当前页。地址一律经 loginHref 过一遍：
 *  外站地址（以前的 Odoo 登录页）、/web/login、/go/ 都不用，换成站内登录页。
 *  每个旧名字第一次被用时在控制台告警一次，扩展请改用 loginHref（整页跳转即可，不需要弹窗和轮询）。
 *  单独成文件、不碰 React，scripts/odoo-compat-unit.mjs 直接测。 */
import { loginHref } from '../login-href.ts';

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
