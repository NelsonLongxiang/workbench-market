/**
 * 人审变更请求的路由：/api/change-requests 的列表、批准、拒绝。原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 只给管理员；批准时执行回滚或删除（台和技能的执行体 REST 的一步式接口也用，留在 index.ts），执行成功才标 approved。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { ChangeRequestService } from '../services/change-request.ts';
import { HttpError } from '../errors.ts';

/** 从 index.ts 传进来的：管理员守卫、异步处理函数的包装、400 的快捷写法、台和技能的回滚与删除（一步式接口和 MCP 也用）。 */
export interface ChangeRequestDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  bad: (msg: string) => never;
  activateAppVersion: (slug: string, vRaw: unknown) => Promise<object>;
  deleteAppCascade: (slug: string) => Promise<void>;
  executeSkillRollback: (slug: string, targetVersion: number, reviewedBy: string) => Promise<Record<string, unknown>>;
  executeSkillDelete: (slug: string) => void;
}

export function registerChangeRequestRoutes(app: HttpService, deps: ChangeRequestDeps): void {
  const { adminGuard, wrap, bad, activateAppVersion, deleteAppCascade, executeSkillRollback, executeSkillDelete } = deps;
  app.get('/api/change-requests', (req, res) => {
    if (!adminGuard(req, res)) return;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows = status
      ? svc<ChangeRequestService>('changeRequest').listByStatus(status)
      : svc<ChangeRequestService>('changeRequest').listAll();
    res.json(rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload || '{}') })));
  });
  app.post('/api/change-requests/:id/approve', wrap(async (req, res) => {
    if (!adminGuard(req, res)) return; // K11：口令无效→401（adminGuard 已回）
    const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
    if (!reviewedBy) bad('批准必填 reviewed_by（K11——人审语义）'); // K11
    const id = Number(req.params.id);
    const r = svc<ChangeRequestService>('changeRequest').byId(id) as any;
    if (!r) throw new HttpError(404, `change_request not found: ${id}`);
    if (r.status !== 'pending') bad(`请求已处理（status=${r.status}）——不可重复批准`); // 幂等
    // 执行体（v3 契约形状：kind×op 四象限·与一步式 REST 同构）
    if (r.kind === 'app' && r.op === 'rollback') {
      await activateAppVersion(r.slug, r.target_version);
    } else if (r.kind === 'app' && r.op === 'delete') {
      await deleteAppCascade(r.slug);
    } else if (r.kind === 'skill' && r.op === 'rollback') {
      await executeSkillRollback(r.slug, Number(r.target_version), reviewedBy);
    } else if (r.kind === 'skill' && r.op === 'delete') {
      executeSkillDelete(r.slug);
    } else { bad(`未知 kind×op: ${r.kind}/${r.op}`); }
    svc<ChangeRequestService>('changeRequest').markApproved(reviewedBy, id);
    res.json({ ok: true, id, status: 'approved', executed: `${r.kind}/${r.op}`, reviewed_by: reviewedBy });
  }));
  app.post('/api/change-requests/:id/reject', wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
    if (!reviewedBy) bad('拒绝必填 reviewed_by（K11）');
    const id = Number(req.params.id);
    const r = svc<ChangeRequestService>('changeRequest').byId(id) as any;
    if (!r) throw new HttpError(404, `change_request not found: ${id}`);
    if (r.status !== 'pending') bad(`请求已处理（status=${r.status}）`);
    svc<ChangeRequestService>('changeRequest').markRejected(reviewedBy, id);
    res.json({ ok: true, id, status: 'rejected', reviewed_by: reviewedBy });
  }));
}
