/**
 * 统一门户 /go/<台号>/… 这一条路由：按台号把请求代理到台的上游，SOP 台出执行页，自产台交给静态托管。
 * 处理函数在 portal.ts（createPortal 造的前置准备和代理两个，内容原样）；这里只把它们经 HTTP 服务注册、报上动作。
 * 原来是两层全局中间件（app.use），现在是同一条路由上的两个处理函数，挂在原来的位置，前后次序不变。
 *
 * 路径用正则、方法用 ALL：原来的中间件什么方法都接，按 req.url 匹配 ^/go/<数字>；正则路由不剥前缀，
 * 代理的 pathFilter 和 pathRewrite 看到的 URL 和原来一样。正则匹配的是不带查询串的路径，前置准备里照旧先按 req.url 再核一遍，
 * 对不上（比如绝对形式的请求行）就 next()，和原来一样。WebSocket 升级不经 Express，仍由 index.ts 调 moduleProxy.upgrade。
 *
 * 动作 portal.use，读：门户不分读写，什么方法都原样转给台；匿名能用（登录门开着时没有身份的在它前面就被挡下）。
 * 应答的 401/403/404 多半来自台自己（上游原样转回）或台的状态（SOP 没上架 403、没有这个台 404），不是「谁能做什么」的结论。
 */
import type { HttpService } from '../http.ts';
import { createPortal } from '../portal.ts';

export function registerPortalRoutes(app: HttpService, ...args: Parameters<typeof createPortal>): void {
  const { prepare, proxy } = createPortal(...args);
  app.all(/^\/go\/(\d+)(.*)$/, {
    action: 'portal.use', kind: 'read',
    statusNotVerdict: '门户转回的状态码多半是台自己的（上游原样），或台的状态（SOP 没上架 403、没有这个台 404），不是授权结论',
  }, prepare, proxy);
}
