/**
 * 工作台的路由：/api/workbenches 的列表、新建、取、改、删、单个探测，和 /api/check-all。原样搬自 index.ts，一个字没改，只多了两格缩进。
 * 它们在 index.ts 里分成四段（中间是校验、准入、增删改的核心和探测函数，MCP 也用），这里按原来的顺序放在一起。
 * 列表和取一个出队即掩码；写请求的主体只认已核的管理口令；全部探测的冷却窗和巡检共用同一组状态。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * index.ts 里别的路由也在用、还没挪成模块的东西，经第二个参数传进来；处理函数照旧用原来的名字。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { WorkbenchService } from '../services/workbench.ts';
import { getSettings, rowToWorkbench, type WorkbenchRow } from '../db.ts';
import { HttpError } from '../errors.ts';

type WorkbenchView = ReturnType<typeof rowToWorkbench>;
/** 增删改核心的调用上下文（和 index.ts 里的 WriteCtx 同形）：subject 只放已核认证标识；auditOk=false 时回 X-WM-Audit-State: degraded */
type WriteCtx = { subject: string; auditOk?: boolean };

/** 从 index.ts 传进来的：异步处理函数的包装、台的列表与脱敏、写请求的主体、增删改的核心（MCP 也用）、单个探测、台驱逐冷却的状态（巡检也用）。 */
export interface WorkbenchDeps {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  listWorkbenches: () => WorkbenchView[];
  maskForApi: (w: WorkbenchView) => WorkbenchView;
  restSubject: (req: express.Request) => string;
  workbenchCreateCore: (body: any, ctx?: WriteCtx) => WorkbenchView;
  workbenchUpdateCore: (id: number, body: any, ctx?: WriteCtx) => WorkbenchView;
  workbenchDeleteCore: (id: number) => { ok: boolean; deleted: number };
  checkOne: (w: WorkbenchRow) => Promise<WorkbenchView>;
  downSince: Map<number, number>;
  lastProbeAt: Map<number, number>;
  EVICT_COOLDOWN_MS: number;
}

export function registerWorkbenchRoutes(app: HttpService, deps: WorkbenchDeps): void {
  const { wrap, listWorkbenches, maskForApi, restSubject, workbenchCreateCore, workbenchUpdateCore, workbenchDeleteCore, checkOne, downSince, lastProbeAt, EVICT_COOLDOWN_MS } = deps;
  app.get('/api/workbenches', { action: 'workbench.list', kind: 'read' }, (req, res) => {
    const { q, category, type, status } = req.query;
    let list = listWorkbenches();
    if (q) { const s = String(q).toLowerCase(); list = list.filter((w) => w.name.toLowerCase().includes(s) || w.url.toLowerCase().includes(s) || (w.description || '').toLowerCase().includes(s)); }
    if (category) list = list.filter((w) => w.category === category);
    if (type) list = list.filter((w) => w.type === type);
    if (status) list = list.filter((w) => w.last_status === status);
    // 列表出队即掩码（q 过滤仍用原值——搜索语义不变，明文不落响应）
    res.json(list.map(maskForApi));
  });

  app.post('/api/workbenches', { action: 'workbench.create', kind: 'admin', statusNotVerdict: 'URL 准入：地址不许登记时回 403，是登记规则不是授权' }, (req, res) => {
    const ctx: WriteCtx = { subject: restSubject(req) };
    const w = workbenchCreateCore(req.body, ctx);
    if (ctx.auditOk === false) res.setHeader('X-WM-Audit-State', 'degraded');
    res.status(201).json(w);
  });

  app.get('/api/workbenches/:id', { action: 'workbench.read', kind: 'read' }, (req, res) => {
    const row = svc<WorkbenchService>('workbench').byId(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
    if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
    // 与列表同策略掩码（issue #2/#3：auth.value 同为无认证出口的明文凭据向量）；
    // 编辑流由 PUT 掩码回传保护兜底（掩码回传=不变更，DB 原值不毁）
    res.json(maskForApi(rowToWorkbench(row)));
  });

  app.put('/api/workbenches/:id', { action: 'workbench.update', kind: 'admin', statusNotVerdict: 'URL 准入：改成不许登记的地址时回 403，是登记规则不是授权' }, (req, res) => {
    const ctx: WriteCtx = { subject: restSubject(req) };
    const w = workbenchUpdateCore(Number(req.params.id), req.body, ctx);
    if (ctx.auditOk === false) res.setHeader('X-WM-Audit-State', 'degraded');
    res.json(w);
  });

  app.delete('/api/workbenches/:id', { action: 'workbench.delete', kind: 'admin' }, (req, res) => {
    res.json(workbenchDeleteCore(Number(req.params.id)));
  });

  app.post('/api/workbenches/:id/check', { action: 'workbench.check', kind: 'write' }, wrap(async (req, res) => {
    const row = svc<WorkbenchService>('workbench').byId(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
    if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
    res.json(await checkOne(row));
  }));

  app.post('/api/check-all', { action: 'workbench.check-all', kind: 'write' }, wrap(async (_req, res) => {
    const settings = getSettings();
    const limit = Math.max(1, Number(settings.health_concurrency) || 8);
    const rows = svc<WorkbenchService>('workbench').enabled() as unknown as WorkbenchRow[];
    const results: ReturnType<typeof rowToWorkbench>[] = [];
    // 台驱逐冷却两入口一致（patrol/check-all 共享）：down 台窗内跳过，每窗一探
    const queue = [...rows].filter((w) => {
      if (!downSince.has(w.id)) return true;
      if (Date.now() - (lastProbeAt.get(w.id) ?? 0) >= EVICT_COOLDOWN_MS) { lastProbeAt.set(w.id, Date.now()); return true; }
      return false;
    });
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let w = queue.shift(); w; w = queue.shift()) results.push(await checkOne(w));
    });
    await Promise.all(workers);
    for (const r of results) {
      if (r.last_status === 'down') { if (!downSince.has(r.id)) { downSince.set(r.id, Date.now()); lastProbeAt.set(r.id, Date.now()); } }
      else { downSince.delete(r.id); lastProbeAt.delete(r.id); }
    }
    res.json({ checked: results.length, up: results.filter((r) => r.last_status === 'up').length, down: results.filter((r) => r.last_status === 'down').length });
  }));
}
