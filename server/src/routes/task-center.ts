/**
 * 任务中心的路由：/api/task-center 的录入发布、任务列表与详情、总开关、录入模板、任务锁、旧的发布接口、撤回、agent 派发开关。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。搬过来之后有意改过的：
 *   · 8e：录入发布经身份服务认出发布的人，把主体记进事件。应答不变。
 *   · 8f：事项的建立人是提需求的人（建录入时记在 run 上的），不是发布的人；发布的人只留痕。发布记一笔不带内容的提交计数。
 * 它们在 index.ts 里分在三处，中间夹着别的路由的注册（工作台事件的路由、执行记录的读授权路由），
 * 所以分三个注册函数，各在原来的位置调用，和别的路由的先后不变。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { TaskCenterService } from '../services/task-center.ts';
import { requestPerson } from '../request-person.ts';
import { countSubmission } from '../services/submission-counts.ts';
import { HttpError } from '../errors.ts';
import { publishTaskIntake, taskCenterSteps, taskView, taskListView, taskCenterPolicy } from '../task-center.ts';
import { cancelTaskCenterDeliveries, kickWorkbenchEvents } from '../workbench-events.ts';
import { authorizeRunRead } from '../sop-read-auth.ts';
import type { AppRow } from '../db.ts';
import type { renderSopRunner } from '../sop-runner.ts';

type SopManifest = Parameters<typeof renderSopRunner>[0];
type Guard = (req: express.Request, res: express.Response) => boolean;

/** 录入发布从 index.ts 传进来的：同源门、管理员守卫（别的路由也用）。 */
export interface TaskIntakeDeps {
  sameOriginGuard: Guard;
  adminGuard: Guard;
}

/** 列表和详情从 index.ts 传进来的：异步处理函数的包装、管理口令的判定、执行记录读能力的请求头（别的路由也用）。 */
export interface TaskReadDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  adminHeaderOk: (req: express.Request) => boolean;
  runReadCapHeader: (req: express.Request) => string | undefined;
}

/** 总开关、模板、任务锁、发布、撤回、派发开关从 index.ts 传进来的：读活跃版本的清单、同源门、管理员守卫（别的路由也用）。 */
export interface TaskControlDeps {
  readActiveManifest: (slug: string) => { manifest: SopManifest; app: AppRow } | null;
  sameOriginGuard: Guard;
  adminGuard: Guard;
}

export function registerTaskIntakeRoutes(app: HttpService, deps: TaskIntakeDeps): void {
  const { sameOriginGuard, adminGuard } = deps;
  app.post('/api/task-center/tasks', { action: 'task-center.publish', kind: 'admin' }, (req, res, next) => {
    if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' }); // C10
    if (!adminGuard(req, res)) return; // C9 无口令 401/403
    (async () => {
      // 发布的人经身份服务认出来（会话登录、主体是启用的人）才记下，只留痕，不当建立人（建立人取 run 上的提需求人）；
      // 口令、本机命令行发布认不出人，留空。请求体里的 published_by 是自填的，只用于显示
      const who = await requestPerson(req);
      const out = publishTaskIntake(req.body ?? {}, { publisherPrincipal: who.principal });
      countSubmission('task-center.publish', who.hasCredential, who.principal !== null);
      res.status(201).json(out);
      kickWorkbenchEvents(); // 工作台事件 v1：发布同事务已记 human 事件，这里立即试投
    })().catch(next);
  });
}

export function registerTaskReadRoutes(app: HttpService, deps: TaskReadDeps): void {
  const { wrap, adminHeaderOk, runReadCapHeader } = deps;
  app.get('/api/task-center/tasks', { action: 'task-center.list', kind: 'read' }, (req, res) => { // 读开放
    res.json(svc<TaskCenterService>('taskCenter').list().map(taskListView)); // #309 phase2：列表同样不带 payload_json 私有副本
  });
  app.get('/api/task-center/tasks/:id', { action: 'task-center.read', kind: 'read' }, wrap(async (req, res) => {
    const hit = svc<TaskCenterService>('taskCenter').byId(Number(req.params.id));
    if (!hit) throw new HttpError(404, 'task not found');
    const events = svc<TaskCenterService>('taskCenter').events(hit.id).map((e: any) => ({...e, action: e.type, detail: JSON.parse(e.payload_json)}));
    // #309 phase2：详情复制的录入数据与全量投影需 run 级读授权；未授权只回元数据（payload_json 是私有副本）
    const auth = hit.intake_run_id ? await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, hit.intake_run_id as number) : { authorized: false };
    if (auth.authorized) return res.json({ ...taskView(hit), events });
    res.set('Cache-Control', 'no-store').json({ ...taskListView(hit), events, private_read: 'authorization-required' });
  }));
}

export function registerTaskControlRoutes(app: HttpService, deps: TaskControlDeps): void {
  const { readActiveManifest, sameOriginGuard, adminGuard } = deps;
  app.get('/api/task-center/policy', { action: 'task-center.policy', kind: 'read' }, (req, res) => { // C7 读开放
    res.json(taskCenterPolicy());
  });
  app.get('/api/task-center/template', { action: 'task-center.template', kind: 'read' }, (req, res) => { // C17 六固定步骤
    const current = readActiveManifest('task-center');
    res.json({ version: current?.app.active_version, steps: current?.manifest.steps ?? taskCenterSteps });
  });
  app.put('/api/task-center/policy', { action: 'task-center.policy-update', kind: 'admin' }, (req, res) => {
    if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
    if (!adminGuard(req, res)) return;
    const body = req.body ?? {};
    if (typeof body.agent_dispatch_enabled !== 'boolean') throw new HttpError(400, 'agent_dispatch_enabled 必须是布尔值');
    const enabled = body.agent_dispatch_enabled;
    svc<TaskCenterService>('taskCenter').policyBegin();
    try {
      const changed = taskCenterPolicy().agent_dispatch_enabled !== enabled;
      svc<TaskCenterService>('taskCenter').setCenterSwitch(enabled ? 'on' : 'off');
      if (changed) svc<TaskCenterService>('taskCenter').recordPolicyChanged(JSON.stringify({agent_dispatch_enabled:enabled}));
      svc<TaskCenterService>('taskCenter').policyCommit();
    } catch(e) { svc<TaskCenterService>('taskCenter').policyRollback(); throw e; }
    res.json({ ok: true, ...taskCenterPolicy() });
  });
  app.patch('/api/task-center/tasks/:id/switch', { action: 'task-center.toggle', kind: 'admin' }, (req, res) => { // 任务级锁
    if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
    if (!adminGuard(req, res)) return;
    const hit = svc<TaskCenterService>('taskCenter').switchState(Number(req.params.id));
    if (!hit) throw new HttpError(404, 'task not found');
    const nv = hit.enabled ? 0 : 1;
    svc<TaskCenterService>('taskCenter').applyTransition(hit.id as number, 'toggled', 'human:' + String((req as express.Request & { adminActor?: string }).adminActor ?? 'human'), { enabled: nv });
    res.json({ ok: true, enabled: nv === 1 });
  });

  // #159 M3 B3（决策 #010）：发布冻结 + 撤回 + agent 派发开关（C2-C6/C8/C11/C18-C22·监督席两对齐）
  app.post('/api/task-center/tasks/:id/publish', { action: 'task-center.publish-legacy', kind: 'admin' }, (req, res) => {
    if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
    if (!adminGuard(req, res)) return;
    const hit = svc<TaskCenterService>('taskCenter').byId(Number(req.params.id)) as any;
    if (!hit) throw new HttpError(404, 'task not found');
    if (hit.status === 'published') throw new HttpError(409, '已发布不可再写（#159 C11）');
    if (hit.status === 'withdrawn') throw new HttpError(409, '已撤回任务不可发布');
    throw new HttpError(409, '旧草稿不得绕过录入 run 发布；请完成 task-center 录入后统一发布');

  });
  app.post('/api/task-center/tasks/:id/withdraw', { action: 'task-center.withdraw', kind: 'admin' }, (req, res) => {
    if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
    if (!adminGuard(req, res)) return;
    const hit = svc<TaskCenterService>('taskCenter').byId(Number(req.params.id)) as any;
    if (!hit) throw new HttpError(404, 'task not found');
    if (hit.status !== 'published') throw new HttpError(409, '仅已发布可撤回');
    const actor = 'human:' + String((req as express.Request & { adminActor?: string }).adminActor ?? 'admin');
    // 工作台事件 v1：撤回与取消未发出的投递同一事务；正在发送的那次如实报 in_flight
    const c = svc<TaskCenterService>('taskCenter').applyTransition(hit.id, 'withdrawn', actor, { status: 'withdrawn' }, () => cancelTaskCenterDeliveries(hit.id, actor));
    res.json({ ok: true, id: hit.id, status: 'withdrawn', cancelled_deliveries: c?.cancelled ?? 0, in_flight_deliveries: c?.in_flight ?? 0 });
  });
  app.patch('/api/task-center/tasks/:id/agent-dispatch', { action: 'task-center.dispatch-toggle', kind: 'admin' }, (req, res) => { // 监督席对齐②：任务级 agent 派发开关（默认关·与任务锁语义对齐）
    if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
    if (!adminGuard(req, res)) return;
    const hit = svc<TaskCenterService>('taskCenter').byId(Number(req.params.id)) as any;
    if (!hit) throw new HttpError(404, 'task not found');
    if (hit.status !== 'published') throw new HttpError(409, '仅已发布任务可变更开关');
    if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
    const enabled = req.body?.enabled ?? !Boolean(hit.agent_dispatch_enabled);
    const actor = 'human:' + String((req as express.Request & { adminActor?: string }).adminActor ?? 'admin');
    if (enabled !== Boolean(hit.agent_dispatch_enabled)) svc<TaskCenterService>('taskCenter').applyTransition(hit.id, 'toggled', actor, { agent_dispatch_enabled: enabled ? 1 : 0 });
    res.json({ ok: true, ...taskView(svc<TaskCenterService>('taskCenter').reload(hit.id)) });
  });
}
