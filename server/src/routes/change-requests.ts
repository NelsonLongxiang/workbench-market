/**
 * 人审变更请求的路由：/api/change-requests 的列表、批准、拒绝。批准、拒绝的判断和执行收在 changeRequestReview 一处，「关注」的审核卡片也调它。
 * 只给管理员；批准时执行回滚或删除（台和技能的执行体 REST 的一步式接口也用，留在 index.ts），执行成功才标 approved。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import type { CardDeleter } from '../bench-card-delete.ts';
import { svc } from '../context.ts';
import type { ChangeRequestService } from '../services/change-request.ts';
import { HttpError } from '../errors.ts';
import { principalsAdmin } from './principals.ts';

/** 从 index.ts 传进来的：管理员守卫、异步处理函数的包装、400 的快捷写法、台和技能的回滚与删除（一步式接口和 MCP 也用）。 */
export interface ChangeRequestDeps {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  bad: (msg: string) => never;
  activateAppVersion: (slug: string, vRaw: unknown) => Promise<object>;
  deleteAppCascade: (slug: string, card?: { deleter: CardDeleter; confirmBenchData: boolean }) => Promise<void>;
  /** 批准删台时删卡片的人（卡片的台库有业务数据时要管理层并且确认，见 bench-card-delete.ts） */
  cardDeleter: (req: express.Request) => Promise<CardDeleter>;
  executeSkillRollback: (slug: string, targetVersion: number, reviewedBy: string) => Promise<Record<string, unknown>>;
  executeSkillDelete: (slug: string) => void;
}

/**
 * 批准、拒绝的判断和执行（只有这一处）：旧的两个 REST 入口和「关注」里审核卡片的答法都调它。注册之后可取用。
 *   reviewedBy 是留痕里显示的审核人（旧入口是自填的 reviewed_by，「关注」是认出来的管理员）；principal 是经身份认出来的审核人。
 *   判不过抛 HttpError（和旧入口一样的状态码和说法），调用方照旧交给错误处理或换成应答。
 */
export type ChangeRequestReview = {
  /** card：批准删台时删卡片的人和确认（不给：认出来的审核人是主体就按主体，否则按管理口令；不确认） */
  approve: (id: number, reviewedBy: string, principal: string, card?: { deleter: CardDeleter; confirmBenchData: boolean }) => Promise<Record<string, unknown>>;
  reject: (id: number, reviewedBy: string, principal: string, note: string) => Record<string, unknown>;
};
export let changeRequestReview: ChangeRequestReview | null = null;

/** 认出来的管理员（留痕里的写法）；认不出给空串。路由已经过了管理门，这里只取「是谁」 */
async function reviewerPrincipal(req: express.Request): Promise<string> {
  if (!principalsAdmin) return '';
  const res: Record<string, unknown> = { statusCode: 200 };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = () => res;
  return (await principalsAdmin(req, res as unknown as express.Response)) ?? '';
}

export function registerChangeRequestRoutes(app: HttpService, deps: ChangeRequestDeps): void {
  const { adminGuard, wrap, bad, activateAppVersion, deleteAppCascade, executeSkillRollback, executeSkillDelete } = deps;
  const review: ChangeRequestReview = {
    approve: async (id, reviewedBy, principal, card) => {
      if (!reviewedBy) bad('批准必填 reviewed_by（K11——人审语义）'); // K11
      const r = svc<ChangeRequestService>('changeRequest').byId(id) as any;
      if (!r) throw new HttpError(404, `change_request not found: ${id}`);
      if (r.status !== 'pending') bad(`请求已处理（status=${r.status}）——不可重复批准`); // 幂等
      // 执行体（v3 契约形状：kind×op 四象限·与一步式 REST 同构）
      if (r.kind === 'app' && r.op === 'rollback') {
        await activateAppVersion(r.slug, r.target_version);
      } else if (r.kind === 'app' && r.op === 'delete') {
        await deleteAppCascade(r.slug, card ?? { deleter: principal ? { kind: 'principal', id: principal } : { kind: 'admin-token' }, confirmBenchData: false });
      } else if (r.kind === 'skill' && r.op === 'rollback') {
        await executeSkillRollback(r.slug, Number(r.target_version), reviewedBy);
      } else if (r.kind === 'skill' && r.op === 'delete') {
        executeSkillDelete(r.slug);
      } else { bad(`未知 kind×op: ${r.kind}/${r.op}`); }
      svc<ChangeRequestService>('changeRequest').markApproved(reviewedBy, id, principal);
      return { ok: true, id, status: 'approved', executed: `${r.kind}/${r.op}`, reviewed_by: reviewedBy };
    },
    reject: (id, reviewedBy, principal, note) => {
      if (!reviewedBy) bad('拒绝必填 reviewed_by（K11）');
      const r = svc<ChangeRequestService>('changeRequest').byId(id) as any;
      if (!r) throw new HttpError(404, `change_request not found: ${id}`);
      if (r.status !== 'pending') bad(`请求已处理（status=${r.status}）`);
      svc<ChangeRequestService>('changeRequest').markRejected(reviewedBy, id, principal, note);
      return { ok: true, id, status: 'rejected', reviewed_by: reviewedBy };
    },
  };
  changeRequestReview = review;
  app.get('/api/change-requests', { action: 'change-request.list', kind: 'admin' }, (req, res) => {
    if (!adminGuard(req, res)) return;
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows = status
      ? svc<ChangeRequestService>('changeRequest').listByStatus(status)
      : svc<ChangeRequestService>('changeRequest').listAll();
    res.json(rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload || '{}') })));
  });
  app.post('/api/change-requests/:id/approve', { action: 'change-request.approve', kind: 'decide' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return; // K11：口令无效→401（adminGuard 已回）
    const confirm = (req.body as { confirm_bench_data?: unknown } | undefined)?.confirm_bench_data === true;
    res.json(await review.approve(Number(req.params.id), String(req.body?.reviewed_by ?? '').trim(), await reviewerPrincipal(req), { deleter: await deps.cardDeleter(req), confirmBenchData: confirm }));
  }));
  app.post('/api/change-requests/:id/reject', { action: 'change-request.reject', kind: 'decide' }, wrap(async (req, res) => {
    if (!adminGuard(req, res)) return;
    // 旧入口：理由可选（不打断现有调用方）；「关注」入口要求必填
    const note = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    res.json(review.reject(Number(req.params.id), String(req.body?.reviewed_by ?? '').trim(), await reviewerPrincipal(req), note));
  }));
}
