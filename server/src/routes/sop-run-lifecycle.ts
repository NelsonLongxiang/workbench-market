/**
 * SOP run 的列表、读、写一步、完成、升级预检、升级：GET/PUT /api/sop/runs/:id、GET /api/sop/runs、POST …/finish、GET …/upgrade-preflight、POST …/upgrade。
 * 原样搬自 index.ts，一个字没改，只多了两格缩进。六条在 index.ts 里分五段，中间只夹着升级预检用的几个函数，
 * 在原来最后一段（升级预检、升级）的位置注册，路由的挂载顺序不变。
 * 写一步、完成不经写总门（执行页的公开入口）；读要本 run 的读能力或管理员，不然只回元数据；升级要管理员或本机命令行。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里还在用的（读、写一步、完成、升级预检的执行体也给 MCP 工具用）经第二个参数传进来；处理函数照旧用原来的名字。
 * 读授权（sop-read-auth.ts）、浏览器标记与回环判定（surfaces.ts）、设置（db.ts）由模块直接引入。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { getSettings, type SopRunRow } from '../db.ts';
import type { SopService } from '../services/sop.ts';
import { HttpError } from '../errors.ts';
import { authorizeRunRead } from '../sop-read-auth.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import type { createRunCheckpoints } from '../sop-state-checkpoints.ts';

type UpgradePlan = { row: SopRunRow; data: Record<string, unknown>; target: number; preflight: Record<string, any> & { up_to_date: boolean; violations_after: unknown[] } };

/** 从 index.ts 传进来的：异步包装、管理员头、读能力头、读与元数据、写一步、完成、Odoo 管理员认定、升级计划、400 的快捷写法、run 的检查点队列、审计用的操作者名。 */
export interface SopRunLifecycleDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  adminHeaderOk: (req: express.Request) => boolean;
  runReadCapHeader: (req: express.Request) => string | undefined;
  sopRunGetCore: (id: number) => Promise<object>;
  sopRunGetMeta: (id: number) => object;
  sopRunStepSaveCore: (id: number, stepKeyRaw: string, value: unknown) => Promise<object>;
  sopRunFinishCore: (id: number) => Promise<object>;
  markOdooAdmin: (req: express.Request) => Promise<void>;
  sopRunUpgradePlan: (id: number) => Promise<UpgradePlan>;
  bad: (msg: string) => never;
  runCheckpoints: ReturnType<typeof createRunCheckpoints>;
  adminActor: (req: express.Request) => string;
}

export function registerSopRunLifecycleRoutes(app: HttpService, deps: SopRunLifecycleDeps): void {
  const { wrap, adminHeaderOk, runReadCapHeader, sopRunGetCore, sopRunGetMeta, sopRunStepSaveCore, sopRunFinishCore, markOdooAdmin, sopRunUpgradePlan, bad, runCheckpoints, adminActor } = deps;
  app.get('/api/sop/runs', { action: 'sop-run.list', kind: 'read' }, (req, res) => {
    // P4（F7）：待验收列表 = running 且有派单来源（a2a_run_ctx 有 callback/task_id），不含人自己开的
    if (req.query.dispatched === '1') {
      // #19 ②a：agent 分拣投递「默认关闭」——settings 开关 dispatch_sorting_enabled（'1'=开·缺省关）
      const ds = getSettings() as Record<string, unknown>;
      if (ds['dispatch_sorting_enabled'] !== '1' && ds['dispatch_sorting_enabled'] !== 1) return res.json([]);
      const rows = svc<SopService>('sop').runsDispatched() as unknown as SopRunRow[];
      return res.json(rows);
    }
    const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    res.json(svc<SopService>('sop').runsFiltered(slug, status) as unknown as SopRunRow[]);
  });

  // 异步路由一律经 wrap：Express 4 不接 async 抛出的错，404/409 会变成未处理的 Promise 拒绝让进程退出
  app.get('/api/sop/runs/:id(\\d+)', { action: 'sop-run.read', kind: 'read' }, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, id);
    if (auth.authorized) return res.json(await sopRunGetCore(id));
    res.set('Cache-Control', 'no-store').json(sopRunGetMeta(id)); // #309 phase2：未授权只回元数据，不回私有 data
  }));

  app.put('/api/sop/runs/:id(\\d+)', { action: 'sop-run.save', kind: 'write' }, wrap(async (req, res) => {
    res.json(await sopRunStepSaveCore(Number(req.params.id), String(req.body?.stepKey ?? ''), req.body?.value));
  }));

  app.post('/api/sop/runs/:id(\\d+)/finish', { action: 'sop-run.finish', kind: 'write' }, wrap(async (req, res) => {
    res.json(await sopRunFinishCore(Number(req.params.id)));
  }));

  app.get('/api/sop/runs/:id(\\d+)/upgrade-preflight', { action: 'sop-run.upgrade-preflight', kind: 'read', statusNotVerdict: '按 run 的凭据：读能力、主体读授权由 run 授权判' }, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await markOdooAdmin(req); // 只用 Odoo 登录的管理员能升级，也要能打开预检（GET 不经写门，不会预先认定）
    const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, id);
    if (!auth.authorized) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'run read authorization required' });
    res.set('Cache-Control', 'no-store').json((await sopRunUpgradePlan(id)).preflight);
  }));
  /** 升级要人确认：管理员（口令或 Odoo 管理员）或本机命令行，写明 reason；不在升级里改字段值，只换校验所用的版本 */
  app.post('/api/sop/runs/:id(\\d+)/upgrade', { action: 'sop-run.upgrade', kind: 'admin' }, wrap(async (req, res) => {
    const cli = !browserMarked(req) && rawLoopback(req);
    if (!cli && !adminHeaderOk(req)) throw new HttpError(403, '升级 run 只限管理员或本机命令行');
    const id = Number(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
    if (!reason) bad('升级要写 reason（记入审计）');
    const expected = req.body?.expected_version;
    const out = await runCheckpoints.serial(id, async () => {
      const plan = await sopRunUpgradePlan(id);
      if (plan.preflight.up_to_date) throw new HttpError(409, `run ${id} 已是当前版本 v${plan.target}`);
      if (expected !== undefined && Number(expected) !== plan.target) throw new HttpError(409, `当前版本已是 v${plan.target}，与预检时的 v${expected} 不同，请重新预检`);
      // 未落盘的缓冲与热态一并写回 SQLite，和换版本同一次写入；旧热态的校验点含版本号，之后自然失效、从 SQLite 回填
      const json = JSON.stringify(plan.data);
      if (!svc<SopService>('sop').runUpgrade(id, plan.row.sop_version, plan.target, json).changes) throw new HttpError(409, `run ${id} 状态或版本已变，请重新预检`);
      runCheckpoints.forget(id);
      svc<SopService>('sop').runUpgradeAudit({ runId: id, from: plan.row.sop_version, to: plan.target, actor: cli ? 'cli' : adminActor(req), reason, violations: plan.preflight.violations_after.length });
      return { ok: true, ...plan.preflight, upgraded: true };
    });
    res.json(out);
  }));
}
