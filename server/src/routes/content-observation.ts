/**
 * 门户观测状态的路由（/api/content/observation，只给管理员）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import type { createPortalObservation } from '../portal-observation.ts';

/** 从 index.ts 传进来的：管理员守卫（别的路由也用）；门户观测（启动时按 WM_PORTAL_OBSERVE 建，没开就是 null）。 */
export interface ContentObservationDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  portalObserver: ReturnType<typeof createPortalObservation> | null;
}

export function registerContentObservationRoutes(app: HttpService, deps: ContentObservationDeps): void {
  const { adminGuard, portalObserver } = deps;
  app.get('/api/content/observation', (req, res) => {
    if (!adminGuard(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(portalObserver ? { ...portalObserver.status(), counts: portalObserver.counts() } : { enabled: false, coverageVerified: false });
  });
}
