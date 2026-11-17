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
import { createHash, timingSafeEqual } from 'node:crypto';
import { hasLoginCredential } from '../request-person.ts';

/** run 写守卫的模式：enforce 拒绝（缺省），warn 只告警计数（上线过渡） */
export type SopRunWriteMode = 'enforce' | 'warn';
/** 启动时读一次 WM_SOP_RUN_WRITE：没设或空是 enforce，别的值抛错（装配方拒绝启动） */
/** 保存一步、完成：放不放行看这个 run 的写凭据（不是登录身份），401、403 不拿来和统一判定比 */
const RUN_WRITE_DECIDES = '按 run 的写凭据判：上传令牌（run 还在执行）、管理员或本机命令行，403 不是登录身份的结论';

export function sopRunWriteMode(raw: string | undefined): SopRunWriteMode {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'enforce') return 'enforce';
  if (v === 'warn') return 'warn';
  throw new Error(`WM_SOP_RUN_WRITE 只能是 enforce 或 warn（缺省 enforce），现在是 ${JSON.stringify(v)}`);
}
/** 告警模式的计数：按路由 × 调用方类别。不记正文、不记凭据和 run 号 */
const writeWarnCounts = new Map<string, number>();
export function sopRunWriteWarnCounts(): Record<string, number> { return Object.fromEntries(writeWarnCounts); }
const WRITE_DENIED = { error: 'run_write_denied', message: '写 run 要这个 run 的上传令牌（X-Run-Upload-Token）、管理员或本机命令行' };
/** 比较用的摘要：两边都先摘要成等长，不让长度和 run 在不在影响比较的路径 */
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const NO_RUN = digest('\u0000no-run\u0000');

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
  /** 「等你拍板」里待验收派单 run 的卡片内容（index.ts 的 sopRunAcceptDetail） */
  sopRunAcceptDetail: (id: number) => Promise<Record<string, unknown>>;
  markOdooAdmin: (req: express.Request) => Promise<void>;
  sopRunUpgradePlan: (id: number) => Promise<UpgradePlan>;
  bad: (msg: string) => never;
  /** 写守卫：模式（WM_SOP_RUN_WRITE） */
  writeMode: SopRunWriteMode;
  runCheckpoints: ReturnType<typeof createRunCheckpoints>;
  adminActor: (req: express.Request) => string;
}

/**
 * 「等你拍板」里待验收的派单 run（注册之后可取用）：验收通过就是完成这个 run，和 POST /api/sop/runs/:id/finish 同一处判断、同一个执行。
 *   allowed：能不能写 run 而不靠这个 run 的上传令牌（管理员、本机命令行）——「关注」里的人不带令牌，和完成接口里令牌之外的那两条同一处
 *   finish：完成接口的执行（字段校验、完成、给派单方发回执），判不过抛 HttpError
 *   detail：卡片内容
 */
export type SopRunAcceptance = {
  allowed: (req: express.Request) => Promise<boolean>;
  finish: (id: number) => Promise<object>;
  detail: (id: number) => Promise<Record<string, unknown>>;
};
export let sopRunAcceptance: SopRunAcceptance | null = null;

export function registerSopRunLifecycleRoutes(app: HttpService, deps: SopRunLifecycleDeps): void {
  const { wrap, adminHeaderOk, runReadCapHeader, sopRunGetCore, sopRunGetMeta, sopRunStepSaveCore, sopRunFinishCore, sopRunAcceptDetail, markOdooAdmin, sopRunUpgradePlan, bad, runCheckpoints, adminActor, writeMode } = deps;
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

  /**
   * 写 run（保存一步、完成）：要这个 run 的上传令牌（开建或被派单的一方，run 还在执行）、管理员（同源）或本机命令行。
   * 不按 started_by 推权，读授权也不推出写权。都不满足 403，先于查 run 的存在：run 在不在、令牌对不对，走同样的路径、给同样的应答
   */
  /** 不靠上传令牌能写 run 的（只有这一处）：本机命令行；管理员（口令或会话登录的管理员，同源由写请求总门判） */
  async function withoutToken(req: express.Request): Promise<boolean> {
    if (!browserMarked(req) && rawLoopback(req)) return true; // 本机命令行
    await markOdooAdmin(req);
    return adminHeaderOk(req);
  }
  sopRunAcceptance = { allowed: withoutToken, finish: (id) => sopRunFinishCore(id), detail: (id) => sopRunAcceptDetail(id) };

  async function writeAllowed(req: express.Request, res: express.Response, route: string): Promise<boolean> {
    const id = Number(req.params.id);
    const presented = req.headers['x-run-upload-token'];
    const token = typeof presented === 'string' ? presented.trim() : '';
    const cred = svc<SopService>('sop').runWriteCredential(id);
    const want = cred && cred.status === 'running' && cred.upload_token ? digest(cred.upload_token) : NO_RUN;
    const tokenOk = timingSafeEqual(digest(token), want) && want !== NO_RUN && token.length > 0;
    if (tokenOk) return true;
    if (await withoutToken(req)) return true;
    const caller = token ? 'other-token' : req.headers['x-admin-token'] !== undefined ? 'admin-token-rejected' : hasLoginCredential(req) ? 'login-not-admin' : 'anonymous';
    if (writeMode === 'warn') {
      const key = `${route}|${caller}`;
      const n = (writeWarnCounts.get(key) ?? 0) + 1;
      writeWarnCounts.set(key, n);
      if (n === 1 || n % 100 === 0) console.warn(JSON.stringify({ source: 'sop-run-write', event: 'would-deny', route, caller, count: n, at: new Date().toISOString() }));
      return true;
    }
    res.status(403).set('Cache-Control', 'no-store').json(WRITE_DENIED);
    return false;
  }

  app.put('/api/sop/runs/:id(\\d+)', { action: 'sop-run.save', kind: 'write', statusNotVerdict: RUN_WRITE_DECIDES }, wrap(async (req, res) => {
    if (!(await writeAllowed(req, res, 'PUT /api/sop/runs/:id'))) return;
    res.json(await sopRunStepSaveCore(Number(req.params.id), String(req.body?.stepKey ?? ''), req.body?.value));
  }));

  app.post('/api/sop/runs/:id(\\d+)/finish', { action: 'sop-run.finish', kind: 'write', statusNotVerdict: RUN_WRITE_DECIDES }, wrap(async (req, res) => {
    if (!(await writeAllowed(req, res, 'POST /api/sop/runs/:id/finish'))) return;
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
