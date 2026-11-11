/**
 * 「关注」的只读接口（阶段八 8c）：GET /api/attention 返回当前这个人的全部条目和各类条数。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。七个提供方在这里装到「关注」服务上（见 attention-providers.ts），
 * 每个提供方用那个来源旧接口自己的守卫判可见性：看不到的来源不报错、不计数，sources 里标 visible:false。
 * 跨站请求一律拒（和统一待办 /api/tasks 同一个口径）。答复入口在 8d。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { AttentionService } from '../services/attention.ts';
import { installAttentionProviders, type AttentionDeps } from '../attention-providers.ts';

export type AttentionRouteDeps = AttentionDeps & {
  /** 按需认定管理员登录（会话登录的管理员）：汇总之前认定一次，每个来源的守卫看到的是同一个结论，和提供方的先后无关 */
  markOdooAdmin: (req: express.Request) => Promise<void>;
  /** 跨站或别的站的页面来的请求：拒（index.ts 里和 /api/tasks 同一个判断） */
  crossOriginDenied: (req: express.Request) => boolean;
};

export function registerAttentionRoutes(app: HttpService, deps: AttentionRouteDeps): void {
  installAttentionProviders(svc<AttentionService>('attention'), deps);
  app.get('/api/attention', { action: 'attention.read', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'attention_cross_origin_denied' });
    deps.markOdooAdmin(req)
      .then(() => svc<AttentionService>('attention').collect(req))
      .then((view) => res.json({ ...view, generated_at: new Date().toISOString() }))
      .catch(next);
  });
}
