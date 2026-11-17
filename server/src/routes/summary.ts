/**
 * 首页总览的路由（/api/summary）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type { HttpService } from '../http.ts';

/** 从 index.ts 传进来的：summaryPayload 也给 MCP 工具用，还在 index.ts 里。 */
export interface SummaryDeps {
  summaryPayload: () => unknown;
}

export function registerSummaryRoutes(app: HttpService, deps: SummaryDeps): void {
  const { summaryPayload } = deps;
  app.get('/api/summary', { action: 'summary.read', kind: 'read' }, (_req, res) => {
    res.json(summaryPayload());
  });
}
