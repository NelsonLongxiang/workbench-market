/**
 * 登录探测的路由（/api/auth/viewer）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 认人经身份服务（identity().whoami），不引用任何登录提供方的实现。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { identity, loginRelay } from '../identity.ts';

/** 从 index.ts 传进来的：异步处理函数的包装、登录入口地址（别的路由也用）。 */
export interface AuthViewerDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  odooLoginUrl: (req: express.Request, returnPath: string) => string | null;
}

export function registerAuthViewerRoutes(app: HttpService, deps: AuthViewerDeps): void {
  const { wrap, odooLoginUrl } = deps;
  app.get('/api/auth/viewer', { action: 'auth.viewer', kind: 'read' }, wrap(async (req, res) => {
    const r = await identity().whoami(String(req.headers.cookie ?? ''));
    res.setHeader('Cache-Control', 'private, no-store');
    // #279：未登录时带登录入口（顶栏 chip 复用 #277 弹窗流；中继页只认白名单 return，这里固定 /tasks）
    res.status(r.http).json(r.http === 401 ? { ...r.body, login_url: odooLoginUrl(req, '/tasks') } : (r.http === 200 || r.http === 403) && loginRelay().relayLogin() ? { ...r.body, odoo_logout_supported: true } : r.body);
  }));
}
