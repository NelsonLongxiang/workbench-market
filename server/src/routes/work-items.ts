/**
 * 事项的读（阶段八 8d 界面要用）：GET /api/work-items/:id 返回一件事项和它的事项日志，事项页的时间线直接渲染日志。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。可见性和「关注」里事项这个来源同一个口径：
 *   管理员（口令或会话登录）看全部；登录的人只看自己建立的（只认事项上的建立人主体，isCreator；建立人主体空着的只有管理员看得到）；
 *   别的一律 404（不说有没有这件事项）；没登录 401。
 * 跨站、别的站的页面来的请求拒。
 *
 * 8e：POST /api/work-items/:id/decision——建立人本人验收、退回自己的事项。这一个入口不经管理门
 * （index.ts 的写请求总门对它放行，只放这一条路径）；认人、同源、主体是不是启用的人在这里判，
 * 「是不是这件事项的建立人、能不能由建立人答、是不是等验收」由事项服务判。只收 verify、return 两种。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity } from '../identity.ts';
import { isCreator, type WorkItemService } from '../services/work-item.ts';
import type { PrincipalService } from '../services/principal.ts';
import { creatorAnswer } from '../attention-answers.ts';

export type WorkItemRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  crossOriginDenied: (req: express.Request) => boolean;
};

const ITEM_ID = /^wi_[A-Za-z0-9_-]{1,96}$/;

/** 不落地的应答：管理门判不过时写的 403 写到这里 */
function silentRes(): express.Response {
  const res: Record<string, unknown> = { statusCode: 200 };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = () => res;
  return res as unknown as express.Response;
}

export function registerWorkItemRoutes(app: HttpService, deps: WorkItemRouteDeps): void {
  app.get('/api/work-items/:id', { action: 'work-item.read', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    (async () => {
      await deps.markOdooAdmin(req);
      const items = svc<WorkItemService>('workItems');
      if (!deps.adminGuard(req, silentRes())) {
        const cookie = String(req.headers.cookie ?? '');
        if (!cookie) return void res.status(401).json({ error: 'work_items_auth_required' });
        const who = await identity().resolveViewer(cookie);
        if (!who.ok) return void res.status(401).json({ error: 'work_items_auth_required' });
        const item = items.get(id);
        if (!item || !isCreator(item, who.viewer.sub)) return void res.status(404).json({ error: 'work_item_not_found' });
      }
      const item = items.get(id);
      if (!item) return void res.status(404).json({ error: 'work_item_not_found' });
      res.json({ item, log: items.log(id) });
    })().catch(next);
  });

  // 动作类别是「决定」：建立人替自己的事项拍板
  app.post('/api/work-items/:id/decision', { action: 'work-items.accept', kind: 'decide' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const answer = typeof b.answer === 'string' ? b.answer : '';
    (async () => {
      // 认人只经身份服务；请求体里写的任何「我是谁」都不看
      const cookie = String(req.headers.cookie ?? '');
      if (!cookie) return void res.status(401).json({ error: 'work_items_auth_required' });
      const who = await identity().resolveViewer(cookie);
      if (!who.ok) return void res.status(401).json({ error: 'work_items_auth_required' });
      const principal = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | undefined;
      if (!principal || principal.kind !== 'person' || principal.status !== 'active') return void res.status(403).json({ error: 'work_items_principal_not_active' });
      const out = await creatorAnswer(id, who.viewer.sub, answer, { reason: b.reason });
      res.status(out.status).json({ item_id: id, answer, duplicate: out.duplicate === true, result: out.body });
    })().catch(next);
  });
}
