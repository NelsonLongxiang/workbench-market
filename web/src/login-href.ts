/** 登录入口的地址。Odoo 下线（2026-11-17）后只有站内的 /login（站内账号、飞书都从这里进）。
 *  服务端给的 login_url 只认本站的 /login（相对路径）；外站、// 开头、别的路径一律不用，换成站内登录页。
 *  服务端给的是回首页的 /login 时，换成登录完回到当前页（next）。纯函数：scripts/login-href-unit.mjs 直接测。 */
export function loginHref(loginUrl: unknown, here: string): string {
  const back = here && here !== '/' && here.startsWith('/') && !here.startsWith('//') ? `/login?next=${encodeURIComponent(here)}` : '/login';
  if (typeof loginUrl !== 'string' || !/^\/login(\?[^#\s]*)?$/.test(loginUrl)) return back;
  return loginUrl === '/login' ? back : loginUrl;
}
