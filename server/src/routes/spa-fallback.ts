/**
 * 页面兜底（SPA 回落）这一条路由：前端构建目录在时，不是 /api/、/assets/、/health 开头的 GET 回注入过的 index.html。
 * 原样搬自 index.ts 末尾 if (existsSync(webDist)) 里的那一条，一个字没改，只多了报给 HTTP 服务的动作。
 * 注入（面、两个地址）的 sendSurfaceIndex 和它前后的静态托管、最后的 404 留在 index.ts，调用点不动，快照里它仍是最后一条路由。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 动作 market.page，读：谁来都回同一个前端外壳，不判权；登录门开着时没有身份的在它前面就被挡下。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';

export function registerSpaFallbackRoute(app: HttpService, sendSurfaceIndex: (req: express.Request, res: express.Response) => void): void {
  // SPA fallback 只兜「路由路径」：静态资源（/assets/*、带扩展名文件）不存在的直接 404——
  // 否则旧缓存 index.html 引用的已删 hash 会被回成 200 text/html，前端炸 MIME 错且难定位（实盘踩坑）
  app.get(/^(?!\/api\/|\/assets\/|\/health).*/, { action: 'market.page', kind: 'read' }, (_req, res, next) => { // P1-4：/health* 不被 SPA 兜底（探活可区分）
    if (/\.[A-Za-z0-9]+$/.test(_req.path) && _req.path !== '/index.html') return next(); // 带扩展名的文件请求不兜底
    sendSurfaceIndex(_req, res);
  });
}
