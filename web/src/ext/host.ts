/** 给扩展用的宿主能力（import ... from '@wm/host'）：只放稳定的通用组件与工具，扩展不直接 import 宿主内部路径。 */
import { loginHref } from '../login-href';
export { default as WmPage } from '../components/WmPage';
export { loginHref };
// Odoo 下线前的旧名字（odooLoginHref、useOdooPopupLogin、ODOO_SESSION_CONFIRMED），保留一个版本，见 odoo-compat.ts
export { odooLoginHref, useOdooPopupLogin, ODOO_SESSION_CONFIRMED } from './odoo-compat';
