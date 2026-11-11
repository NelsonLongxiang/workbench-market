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
import { answersOf } from '../attention-answers.ts';

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

  /**
   * 8d 答复入口：只做三件事——认来源；确认这一条此刻在这个人的「关注」列表里（看不到这个来源的，回旧入口无权时那个拒绝；
   * 看得到但列表里没有、也没答过的，404）；调提供方的 answer。原路由回什么，result 里就是什么，状态码原样。
   * 请求体：{ source, source_id, answer, input }。input 里只有这一种答法要的字段会被用到。
   * 写请求先过 index.ts 的写请求总门（和别的 /api 写一样要管理员）。
   */
  app.post('/api/attention/answer', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'attention_cross_origin_denied' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const source = typeof b.source === 'string' ? b.source : '', sourceId = typeof b.source_id === 'string' ? b.source_id : '', answer = typeof b.answer === 'string' ? b.answer : '';
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input as Record<string, unknown> : {};
    if (!source || !sourceId || sourceId.length > 300 || !answer) return void res.status(400).json({ error: 'attention_answer_invalid', message: '要有 source、source_id、answer' });
    (async () => {
      await deps.markOdooAdmin(req);
      const attention = svc<AttentionService>('attention');
      const provider = attention.provider<express.Request>(source);
      if (!provider) return void res.status(404).json({ error: 'attention_source_unknown' });
      if (!provider.answer || !answersOf(source).includes(answer)) return void res.status(400).json({ error: 'attention_answer_not_offered' });
      const items = await provider.list(req);
      if (items === null) {
        const d = provider.deny ? await provider.deny(req) : { status: 403, body: { error: 'forbidden' } };
        return void res.status(d.status).json(d.body);
      }
      const hit = items.find((x) => x.source_id === sourceId);
      if (hit && !hit.answers.includes(answer)) return void res.status(400).json({ error: 'attention_answer_not_offered' });
      if (!hit && !attention.answered(source, provider.key ? provider.key(sourceId) : sourceId)) return void res.status(404).json({ error: 'attention_item_not_found' });
      const out = await provider.answer(req, sourceId, answer, input);
      res.status(out.status).json({ source, source_id: sourceId, answer, duplicate: out.duplicate === true, result: out.body });
    })().catch(next);
  });
}
