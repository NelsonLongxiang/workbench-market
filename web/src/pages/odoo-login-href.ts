/** #275：服务端给的 login_url（/go/<Odoo 台>/?return=…）把 return 换成当前页面；只取 path+query，不带出别的源。
 *  纯函数单放：scripts/odoo-login-href-unit.mjs 直接用 node 剥类型运行 */
export function odooLoginHref(loginUrl: string, origin = window.location.origin, here = window.location.pathname + window.location.search): string {
  const u = new URL(loginUrl, origin);
  u.searchParams.set('return', here);
  return u.pathname + u.search;
}
