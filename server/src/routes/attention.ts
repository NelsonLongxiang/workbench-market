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
import { itemsOf, type AttentionService } from '../services/attention.ts';
import { installAttentionProviders, type AttentionDeps } from '../attention-providers.ts';
import { actorOf, answersOf } from '../attention-answers.ts';
import { identity, IDENTITY_UNAVAILABLE, sourceDown } from '../identity.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { nameResolver } from '../attention-names.ts';
import { actorResolver } from '../judgment-compare.ts';
import { parseRemember, rememberAnswer } from '../knowledge-remember.ts';

export type AttentionRouteDeps = AttentionDeps & {
  /** 按需认定管理员登录（会话登录的管理员）：汇总之前认定一次，每个来源的守卫看到的是同一个结论，和提供方的先后无关 */
  markOdooAdmin: (req: express.Request) => Promise<void>;
  /** 跨站或别的站的页面来的请求：拒（index.ts 里和 /api/tasks 同一个判断） */
  crossOriginDenied: (req: express.Request) => boolean;
  /** 带的是有效的管理口令吗（记成经验时认人：管理口令不能记） */
  adminTokenOk: (req: express.Request) => boolean;
};

/** 「关注」的答复入口：状态码不代表授权——能不能答由条目的来源判（看列表、转给原路由再过守卫、直接实现的各自核） */
const ANSWER_BY_SOURCE = '能不能答由条目的来源判：先看这个人的「关注」列表里有没有这一条；转给原路由的再过写请求总门和原路由的守卫；直接实现的各自核';

export function registerAttentionRoutes(app: HttpService, deps: AttentionRouteDeps): void {
  installAttentionProviders(svc<AttentionService>('attention'), deps);
  const rememberActorOf = actorResolver({ adminTokenOk: deps.adminTokenOk });
  app.get('/api/attention', { action: 'attention.read', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'attention_cross_origin_denied' });
    (async () => {
      await deps.markOdooAdmin(req);
      // 带了 cookie、不是管理员、身份来源不可达：不给一个空列表（看着像「没有要拍板的」），回 502 和固定代号，页面说「登录服务暂时联系不上」
      const cookie = String(req.headers.cookie ?? '');
      if (cookie && !deps.adminHeaderOk(req) && sourceDown(await identity().resolveViewer(cookie))) {
        return void res.status(502).json({ error: IDENTITY_UNAVAILABLE, message: '登录服务暂时联系不上，稍后再试' });
      }
      const view = await svc<AttentionService>('attention').collect(req);
      // 显示名在汇总这一层统一补（attention-names.ts）：只给这个看的人本来就看得到的人的名字，别的给 null
      const who = cookie ? await identity().resolveViewer(cookie) : null;
      const nameOf = nameResolver({ admin: (!browserMarked(req) && rawLoopback(req)) || deps.adminHeaderOk(req), principal: who && who.ok ? who.viewer.sub : null });
      const items = view.items.map((it) => ({
        ...it, waiting_for_name: nameOf(it.waiting_for),
        ...(it.creator ? { creator_name: it.creator.display_name ?? nameOf(it.creator.principal) } : {}),
      }));
      res.json({ ...view, items, generated_at: new Date().toISOString() });
    })().catch(next);
  });

  /**
   * 8d 答复入口：只做三件事——认来源；确认这一条此刻在这个人的「关注」列表里（看不到这个来源的，回旧入口无权时那个拒绝；
   * 看得到但列表里没有、也没答过的，404）；调提供方的 answer。原路由回什么，result 里就是什么，状态码原样。
   * 请求体：{ source, source_id, answer, input }。input 里只有这一种答法要的字段会被用到。
   * 写请求先过 index.ts 的写请求总门（和别的 /api 写一样要管理员）。
   */
  // 动作类别是「决定」：替人拍板的入口（批准、拒绝、验收、对接……），不是普通的写
  // 写请求总门对这条放行（L20，index.ts 的 REMOTE_ALLOW_EXACT）：能不能答由条目的来源判——先看这个人的「关注」列表里有没有这一条，
  // 转给原路由的照样再过一遍写请求总门和原路由的守卫；直接实现的各自核（事项的验收、退回由 itemDecisionVerdict 判：建立人本人、退回时还有负责人、持有管理层授予的人代办，见 L21）
  app.post('/api/attention/answer', { action: 'attention.answer', kind: 'decide', statusNotVerdict: ANSWER_BY_SOURCE }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'attention_cross_origin_denied' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const source = typeof b.source === 'string' ? b.source : '', sourceId = typeof b.source_id === 'string' ? b.source_id : '', answer = typeof b.answer === 'string' ? b.answer : '';
    const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input as Record<string, unknown> : {};
    if (!source || !sourceId || sourceId.length > 300 || !answer) return void res.status(400).json({ error: 'attention_answer_invalid', message: '要有 source、source_id、answer' });
    // 可选的「把这次的取舍记成经验」：形状不对在答复之前就拒（答复不生效）；记不记得上不挡答复（见 knowledge-remember.ts）
    const remember = b.remember === undefined ? null : parseRemember(b.remember);
    if (remember && !remember.ok) return void res.status(400).json({ error: 'remember_invalid', message: remember.message });
    (async () => {
      await deps.markOdooAdmin(req);
      // 带了 cookie、不是管理员、身份来源不可达：502 和固定代号（和「关注」列表、事项接口同一个口径）
      const cookie = String(req.headers.cookie ?? '');
      if (cookie && !deps.adminHeaderOk(req) && sourceDown(await identity().resolveViewer(cookie))) {
        return void res.status(502).json({ error: IDENTITY_UNAVAILABLE, message: '登录服务暂时联系不上，稍后再试' });
      }
      const attention = svc<AttentionService>('attention');
      const provider = attention.provider<express.Request>(source);
      if (!provider) return void res.status(404).json({ error: 'attention_source_unknown' });
      if (!provider.answer || !answersOf(source).includes(answer)) return void res.status(400).json({ error: 'attention_answer_not_offered' });
      const items = itemsOf(await provider.list(req));
      if (items === null) {
        const d = provider.deny ? await provider.deny(req) : { status: 403, body: { error: 'forbidden' } };
        return void res.status(d.status).json(d.body);
      }
      const hit = items.find((x) => x.source_id === sourceId);
      if (hit && !hit.answers.includes(answer)) return void res.status(400).json({ error: 'attention_answer_not_offered' });
      // 不在列表里（答完了、或本来就没有）：只有这个人用这种答法答成过，才往下走拿第一次的应答；别人答的、换了答法的，
      // 回的和这一条不存在时一模一样，不靠「重复」透露它存在过、上一次怎么答的
      if (!hit && !attention.answered(source, provider.key ? await provider.key(sourceId) : sourceId, await actorOf(req), answer)) return void res.status(404).json({ error: 'attention_item_not_found' });
      const out = await provider.answer(req, sourceId, answer, input);
      let remembered: Record<string, unknown> | undefined;
      if (remember?.ok && out.status >= 200 && out.status < 300) {
        const r = await rememberAnswer((await rememberActorOf(req)).actor, { source, sourceId, ...remember.value }, hit?.title ?? '');
        remembered = r.ok ? { status: r.outcome.status, duplicate: r.outcome.duplicate, scope_label: r.scope_label } : { status: 'refused', error: r.error, message: r.message };
      }
      res.status(out.status).json({ source, source_id: sourceId, answer, duplicate: out.duplicate === true, result: out.body, ...(remembered ? { remember: remembered } : {}) });
    })().catch(next);
  });
}
