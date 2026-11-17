/**
 * 端点命中统计的路由（/api/stats）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 计数的中间件还在 index.ts 里挂着（endpointStatsMiddleware），这里只有读统计的这一条路由。读开放。
 */
import type { HttpService } from '../http.ts';
import { statsPayload } from '../endpoint-stats.ts';

export function registerStatsRoutes(app: HttpService): void {
  app.get('/api/stats', { action: 'stats.read', kind: 'read' }, (_req, res) => { res.json(statsPayload()); });
}
