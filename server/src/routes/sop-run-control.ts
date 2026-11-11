/**
 * SOP run 的开建、指派与进行中列表：POST /api/sop/runs、POST /api/sop/runs/:id/assign、GET /api/sop/runs/active。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。三条在 index.ts 里分三段，中间只有注释，在原来最后一条（进行中列表）的位置注册。
 * task-center 的录入经身份服务认出提需求的人（request-person.ts）、记一笔不带内容的计数（submission-counts.ts），这里直接引入。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里还在用的经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { SopRunRow } from '../db.ts';
import type { SopService } from '../services/sop.ts';
import { HttpError } from '../errors.ts';
import { requestPerson } from '../request-person.ts';
import { countSubmission } from '../services/submission-counts.ts';

/** 从 index.ts 传进来的：异步包装、按 id 取 run、400 的快捷写法、开 run 的执行体（MCP sop_run_start 也用）。 */
export interface SopRunControlDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  sopRunRow: (id: number) => SopRunRow;
  bad: (msg: string) => never;
  sopRunStartCore: (slugRaw: string, startedByRaw: string, requester?: string | null) => object;
}

export function registerSopRunControlRoutes(app: HttpService, deps: SopRunControlDeps): void {
  const { wrap, sopRunRow, bad, sopRunStartCore } = deps;
  app.post('/api/sop/runs/:id/assign', { action: 'sop-run.assign', kind: 'write' }, wrap(async (req, res) => {
    if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
    const runId = Number(req.params.id);
    const row = sopRunRow(runId);
    if (row.status !== 'running') throw new HttpError(409, `run ${runId} 已 ${row.status}，不可指派`);
    const node = String(req.body?.node ?? '').trim();
    if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9_-]{0,63}$/i.test(node)) bad('node 形态：<zone>/<id8>，如 dsh/1a2b3c4d');
    const existed = svc<SopService>('sop').ctxSourceByRun(runId);
    if (existed) throw new HttpError(409, `run ${runId} 已有派单来源，不可重复指派`);
    svc<SopService>('sop').ctxRegisterFull({ contextId: `task-${runId}`, runId, taskId: `task-${runId}`, caller: node, team: '', receiptStatus: '' });
    res.status(201).json({ ok: true, run_id: runId, node, task_id: `task-${runId}` });
  }));

  // 8f：建任务中心的录入就是「提需求」：经身份服务认出提需求的人记在 run 上（发布时事项的建立人取它），并记一笔不带内容的计数。
  // 认不出照旧放行；请求体里的 started_by 是自填的，只用于显示。别的 SOP 的 run 照旧，不认人
  app.post('/api/sop/runs', { action: 'sop-run.start', kind: 'write' }, wrap(async (req, res) => {
    const slug = String(req.body?.slug ?? '');
    const intake = slug.trim().toLowerCase() === 'task-center';
    const who = intake ? await requestPerson(req) : null;
    const out = sopRunStartCore(slug, String(req.body?.started_by ?? ''), who?.principal ?? null);
    if (who) countSubmission('task-center.intake', who.hasCredential, who.principal !== null);
    res.status(201).json(out);
  }));

  app.get('/api/sop/runs/active', { action: 'sop-run.active', kind: 'read' }, wrap(async (_req, res) => {
    // #338: a nonempty Redis set is not proof that it contains every running row.
    // SQLite creates/status-transitions every run, including unsaved and task-center runs.
    const rows = svc<SopService>('sop').runsRunning() as unknown as SopRunRow[];
    res.json(rows);
  }));
}
