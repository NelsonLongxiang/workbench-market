/** #275：服务端给的 login_url 把回跳换成当前页面；只取 path+query，不带出别的源。
 *  /go/<Odoo 台>/?return=… 换 return；同域登录中继的 /web/login?redirect=… 换 redirect（中继只放行白名单回跳页，其余丢弃）。
 *  纯函数单放：scripts/odoo-login-href-unit.mjs 直接用 node 剥类型运行 */
export function odooLoginHref(loginUrl: string, origin = window.location.origin, here = window.location.pathname + window.location.search): string {
  const u = new URL(loginUrl, origin);
  u.searchParams.set(u.pathname === '/web/login' ? 'redirect' : 'return', here);
  return u.pathname + u.search;
}
