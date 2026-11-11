/**
 * 统一待办（omni-inbox）：GET /api/tasks 只读聚合 ygl-trees、market、A2A 和扩展来源，按查看人的授权取；
 * PUT /api/tasks/read-grants、POST /api/tasks/read-grants/revoke 管理员授予、撤销某个内部员工读 ygl 某个项目的授权。
 *
 * 认人和授权范围在 tasks-read-access.ts，取数在 tasks.ts，扩展来源在 extensions.ts；这里只是路由。
 * 管理员判断（口令或管理员登录 + 同源）、开发时的跨源放行、包装异步处理函数、登录入口地址由 index.ts 传进来。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { SopService } from '../services/sop.ts';
import { originIsThisSurface } from '../surfaces.ts';
import { collectTasks } from '../tasks.ts';
import { tasksReadAccess, createTaskSourceGrant, revokeTaskSourceGrant } from '../tasks-read-access.ts';
import { collectExtensionTasks, extensionTaskSourceKeys } from '../extensions.ts';

type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;
export interface TaskRouteDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => Handler;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  adminHeaderOk: (req: express.Request) => boolean;
  devOriginOk: (req: express.Request) => boolean;
  odooLoginUrl: (req: express.Request, returnPath: string) => string | null;
}

export function registerTaskRoutes(app: HttpService, deps: TaskRouteDeps): void {
  const { wrap, adminGuard, adminHeaderOk, devOriginOk, odooLoginUrl } = deps;
  app.get('/api/tasks', { action: 'tasks.list', kind: 'read' }, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req))) return res.status(403).json({ error: 'tasks_cross_origin_denied' });
    const access = await tasksReadAccess(adminHeaderOk(req), String(req.headers.cookie ?? ''));
    if (!access.ok) return res.status(access.http).json({ error: access.error, ...(access.http === 401 ? { login_url: odooLoginUrl(req, '/tasks') } : {}) });
    const payload = await collectTasks(svc<SopService>('sop') as never, access.scope);
    if (!extensionTaskSourceKeys().length) return res.json(payload);
    // 扩展来源自己按查看人判权（ctx.odoo.resolveViewer）；宿主不拿管理员身份替查看人取数
    const ext = await collectExtensionTasks(req);
    for (const [k, m] of Object.entries(ext.sources)) {
      ext.sources[k] = { ...m, ...(m.ok === false && m.error ? { error: `${k}_source_unavailable` } : {}), ...(m.auth_required ? { login_url: odooLoginUrl(req, '/tasks') } : {}) };
    }
    res.json({ ...payload, tasks: [...payload.tasks, ...ext.tasks], sources: { ...payload.sources, ...ext.sources } });
  }));
  app.put('/api/tasks/read-grants', { action: 'tasks.grant-read', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    if (!createTaskSourceGrant(req.body)) return res.status(400).json({ error: 'invalid_task_source_grant' });
    res.status(201).json({ ok: true });
  });
  app.post('/api/tasks/read-grants/revoke', { action: 'tasks.revoke-read', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const n = revokeTaskSourceGrant(req.body);
    if (n === null) return res.status(400).json({ error: 'invalid_task_source_grant' });
    res.json({ ok: true, revoked: n });
  });
}
