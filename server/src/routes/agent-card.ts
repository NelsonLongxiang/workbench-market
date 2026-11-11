/**
 * A2A 签名卡片的路由（/.well-known/agent-card.json）。处理函数原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 卡片是公开的：登录门特意放行它。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 */
import type { HttpService } from '../http.ts';
import { buildAgentCard, a2aKeyPath } from '../a2a.ts';

export function registerAgentCardRoutes(app: HttpService): void {
  app.get('/.well-known/agent-card.json', { action: 'agent-card.read', kind: 'read' }, (_req, res) => {
    res.json(buildAgentCard(a2aKeyPath()));
  });
}
