/**
 * 自产台静态托管：GET /apps/<slug>/…。处理函数 serveApp（按活跃版本或 ?version=N 出物化目录、CSP sandbox、HTML 注入本台令牌、
 * 目录不在时按 commit 从 LayerFS 冷回读）门户也用，留在 index.ts，经参数传进来；这里只是注册那一行，原样搬自 index.ts，在原来的位置注册
 * （必须在 web/dist 的 SPA 回落之前）。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';

/** 从 index.ts 传进来的：静态托管的处理函数（门户也用）。 */
export interface AppsStaticDeps {
  serveApp: (req: express.Request, res: express.Response) => void;
}

export function registerAppsStaticRoutes(app: HttpService, deps: AppsStaticDeps): void {
  const { serveApp } = deps;
  // 必须在 web/dist SPA fallback 之前注册
  app.get(/^\/apps\/[a-z0-9][a-z0-9-]*(\/.*)?$/, { action: 'app.page', kind: 'read' }, serveApp);
}
