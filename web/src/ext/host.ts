/** 给扩展用的宿主能力（import ... from '@wm/host'）：只放稳定的通用组件与工具，扩展不直接 import 宿主内部路径。 */
export { default as WmPage } from '../components/WmPage';
export { odooLoginHref, useOdooPopupLogin, ODOO_SESSION_CONFIRMED } from '../pages/odoo-login';
