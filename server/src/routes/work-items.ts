/**
 * 事项的读（阶段八 8d 界面要用）：GET /api/work-items/:id 返回一件事项和它的事项日志，事项页的时间线直接渲染日志。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。可见性和「关注」里事项这个来源同一个口径：
 *   管理员（口令或会话登录）看全部；登录的人只看自己建立的；别的一律 404（不说有没有这件事项）；没登录 401。
 * 跨站、别的站的页面来的请求拒。只读，没有写。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity } from '../identity.ts';
import type { WorkItemService } from '../services/work-item.ts';

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
        // 建立人：事项上记的是主体标识；8b 从任务中心来的写成 human:<登录名>
        if (!item || ![who.viewer.sub, `human:${who.viewer.login}`].includes(item.created_by)) return void res.status(404).json({ error: 'work_item_not_found' });
      }
      const item = items.get(id);
      if (!item) return void res.status(404).json({ error: 'work_item_not_found' });
      res.json({ item, log: items.log(id) });
    })().catch(next);
  });
}
