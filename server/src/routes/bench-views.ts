/**
 * 数据视图的入口（docs/data-views.md 第三、十节，第三步的前一半）：给登录的人用的 REST 接口，都在 /api/bench-views 下面。
 * 台的登记、数据集、四种写入、查询、快照、视图描述和它的版本、取数、表单提交。逻辑都在 services/bench-store.ts，这里只是路由。
 *
 * 整组路由在一个开关后面（WM_BENCH_VIEWS=on），缺省关：关着的时候每一条都直接回 404，不认人、不读请求体、不碰台库。
 * （路由照样注册，是为了让对外面的快照和录制回放看得见它们。）
 *
 * 谁能用（这一步只开放给管理层和范围是「全部」的授予；按部门、团队判的那一半等身份线的部门表和团队登记）：
 *   1. 带跨站标记的请求：拒。
 *   2. 管理口令：拒。台里是业务数据，系统管理员缺省看不到。判定里管理口令是照「系统管理员加管理层」两个角色算的
 *      （存量差异 L6），直接问判定会放行，所以在这里先拒；以后要统一，再到判定的收窄清单里加「按角色」这一种。
 *   3. 认不出是谁：401。
 *   4. 其余问判定（judge）：只有范围是 * 的授予算覆盖。allow 才放行，别的 403。
 *      判定在别的路由上现在还只算不生效（阶段六 6d 之前）；这一组路由是新的、没有旧守卫，在自己的域里直接拿它的结论当准。
 *   5. 台没登记：404（放在权限之后，没权限的人探不出有哪些台）。
 * 所以这些路由回的 401、403、404 不全是「判定的结论」，声明了「状态码不代表授权」。
 *
 * 认人照身份线的先后原样抄了一份（actorOf）。#591 合并后换成 judgment-compare.ts 的 actorResolver，不留第二份。
 */
import express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity } from '../identity.ts';
import type { PrincipalService } from '../services/principal.ts';
import { browserMarked, originIsThisSurface, rawLoopback } from '../surfaces.ts';
import { judge, type JudgedActor } from '../judgment.ts';
import { BENCH_LIMITS, BenchError } from '../bench-query.ts';
import { benchStore, type BenchStore } from '../services/bench-store.ts';
import { createBench, getBench, listBenches } from '../services/bench-registry.ts';

export type BenchViewsConfig = { on: boolean };
/** 启动时读一次：WM_BENCH_VIEWS（on / off，缺省 off）。不合法拒绝启动 */
export function benchViewsConfig(env: NodeJS.ProcessEnv = process.env): BenchViewsConfig {
  const raw = String(env.WM_BENCH_VIEWS ?? '').trim();
  if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`WM_BENCH_VIEWS 只接受 on 或 off，现在是 ${JSON.stringify(raw)}`);
  return { on: raw === 'on' };
}

/** 行的写入走原始字节的那条路由：请求体不在市场进程里解析，原样递给台库的工作线程（index.ts 的全局 JSON 解析要跳过它） */
export const BENCH_ROWS_PATH = /^\/api\/bench-views\/[^/]+\/datasets\/[^/]+\/rows$/i;

type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;
export interface BenchViewRouteDeps {
  /** 开关开着没有；关着时每条路由直接回 404 */
  on: boolean;
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => Handler;
  /** 请求带的管理口令有效 */
  adminTokenOk: (req: express.Request) => boolean;
  devOriginOk: (req: express.Request) => boolean;
}

const NOT_VERDICT = '放不放行由数据视图域自己判：先拒管理口令，再看判定的结论；台没登记回 404';
const OPS = new Map<string, 'replace' | 'upsert' | 'append' | 'deleteRows'>([['replace', 'replace'], ['upsert', 'upsert'], ['append', 'append'], ['delete', 'deleteRows']]);

export function registerBenchViewRoutes(app: HttpService, deps: BenchViewRouteDeps): void {
  const { wrap: wrapInner, adminTokenOk, devOriginOk } = deps;
  // 开关关着：在一切之前回 404
  const wrap: BenchViewRouteDeps['wrap'] = (fn) => wrapInner(async (req, res) => (deps.on ? fn(req, res) : res.status(404).json({ error: 'bench_views_off' })));
  const principals = () => svc<PrincipalService>('principals');
  const resolve = identity().cachedResolver({ ttlMs: 60_000, max: 1000 });

  /** Origin 是本站（和判定比对里认「本机页面」的口径一样） */
  const sameSiteOrigin = (req: express.Request): boolean => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !origin) return false;
    try { return new URL(origin).host === String(req.headers.host ?? ''); } catch { return false; }
  };
  /** 这个请求是谁发的。#591 合并后换成 judgment-compare.ts 的 actorResolver（先后和它一样，一处不差） */
  async function actorOf(req: express.Request): Promise<JudgedActor> {
    if (adminTokenOk(req)) return { type: 'builtin', name: 'admin-token' };
    const cookie = String(req.headers.cookie ?? '');
    if (cookie) {
      let who: { ok: boolean; viewer?: { sub?: unknown } };
      try { who = await resolve(cookie) as typeof who; } catch { who = { ok: false }; }
      const id = who.ok && typeof who.viewer?.sub === 'string' ? who.viewer.sub : '';
      const p = id ? principals().get(id) : null;
      if (p) return { type: 'principal', id: p.id, kind: p.kind, status: p.status, owner: p.owner };
    }
    if (rawLoopback(req)) {
      if (!browserMarked(req)) return { type: 'builtin', name: 'local-cli' };
      if (sameSiteOrigin(req)) return { type: 'builtin', name: 'local-page' };
    }
    return { type: 'builtin', name: 'anonymous' };
  }

  /** 放不放行。放行返回做这件事的人的标识；不放行已经回了应答，返回 null */
  async function allow(req: express.Request, res: express.Response, action: string, kind: 'read' | 'write'): Promise<string | null> {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req))) { res.status(403).json({ error: 'bench_views_cross_origin_denied' }); return null; }
    const actor = await actorOf(req);
    if (actor.type === 'builtin' && actor.name === 'admin-token') { res.status(403).json({ error: 'bench_views_admin_token_denied', message: '台里是业务数据，管理口令看不了、也改不了；用有管理层授予的账号登录' }); return null; }
    if (actor.type === 'builtin' && actor.name === 'anonymous') { res.status(401).json({ error: 'login_required' }); return null; }
    const verdict = judge({ actor, action, kind, declared: true });
    if (verdict.verdict !== 'allow') { res.status(403).json({ error: 'bench_views_forbidden' }); return null; }
    return actor.type === 'principal' ? actor.id : `builtin:${actor.name}`;
  }

  const fail = (res: express.Response, e: unknown): void => {
    if (e instanceof BenchError) {
      // 内部错误：原始的错（库的报错原文）只进日志，不对外
      if (e.code === 'internal') console.error(`[bench-views] 内部错误：${String((e.cause as Error | undefined)?.message ?? e.cause ?? '')}`);
      res.status(e.http).json({ error: e.code, message: e.message, ...(e.details.length ? { details: e.details } : {}) });
      return;
    }
    throw e;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const int = (v: unknown): number | undefined => (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);
  const ctxOf = (req: express.Request, actor: string, note?: unknown) => ({ actor, at: Date.now(), idemKey: str(req.headers['idempotency-key']), note: str(note) });

  /** 一条「在某个台上做一件事」的路由：先判权限，再核台登记过，然后把台库交给 fn */
  const on = (action: string, kind: 'read' | 'write', fn: (req: express.Request, res: express.Response, s: BenchStore, actor: string) => Promise<unknown>) => wrap(async (req, res) => {
    const actor = await allow(req, res, action, kind);
    if (!actor) return;
    if (!getBench(req.params.bench)) return res.status(404).json({ error: 'bench_not_found' });
    try { res.json(await fn(req, res, await benchStore(req.params.bench), actor)); } catch (e) { fail(res, e); }
  });

  // —— 台的登记 ——
  app.get('/api/bench-views', { action: 'bench-store.bench-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    if (!await allow(req, res, 'bench-store.bench-list', 'read')) return;
    res.json({ benches: listBenches() });
  }));
  app.post('/api/bench-views', { action: 'bench-store.bench-create', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await allow(req, res, 'bench-store.bench-create', 'write');
    if (!actor) return;
    try { res.status(201).json({ bench: createBench(req.body, actor, Date.now()) }); } catch (e) { fail(res, e); }
  }));

  // —— 数据集 ——
  app.get('/api/bench-views/:bench/datasets', { action: 'bench-store.dataset-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.dataset-list', 'read', async (_req, _res, s) => ({ datasets: await s.datasets() })));
  app.put('/api/bench-views/:bench/datasets/:name', { action: 'bench-store.dataset-define', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.dataset-define', 'write',
    (req, _res, s, actor) => s.defineDataset({ ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}), name: req.params.name }, ctxOf(req, actor, req.query.note))));
  // 行的写入：请求体是行的数组（JSON 文本），原样递给工作线程解析。op=replace / upsert / append / delete（delete 时给的是主键的数组）
  app.post('/api/bench-views/:bench/datasets/:name/rows', { action: 'bench-store.rows-write', kind: 'write', statusNotVerdict: NOT_VERDICT },
    // 开关关着不读请求体，直接往下走（下面的处理函数回 404）
    (req, res, next) => (deps.on ? express.raw({ type: () => true, limit: BENCH_LIMITS.datasetBytes + 1_000_000 })(req, res, next) : next()),
    on('bench-store.rows-write', 'write', async (req, _res, s, actor) => {
      const op = OPS.get(String(req.query.op ?? ''));
      if (!op) throw new BenchError('invalid', 'op 须为 replace、upsert、append、delete 之一');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return s[op](req.params.name, body, ctxOf(req, actor, req.query.note));
    }));
  app.post('/api/bench-views/:bench/query', { action: 'bench-store.query', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.query', 'read', (req, _res, s) => {
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as { query?: unknown; params?: unknown };
    return s.query(b.query, b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params as Record<string, unknown> : {});
  }));

  // —— 快照 ——
  app.get('/api/bench-views/:bench/datasets/:name/snapshots', { action: 'bench-store.snapshot-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.snapshot-list', 'read', async (req, _res, s) => ({ snapshots: await s.snapshots(req.params.name) })));
  app.post('/api/bench-views/:bench/datasets/:name/snapshots', { action: 'bench-store.snapshot-take', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.snapshot-take', 'write', (req, _res, s, actor) => s.snapshot(req.params.name, ctxOf(req, actor, req.body?.note))));
  app.post('/api/bench-views/:bench/restore', { action: 'bench-store.snapshot-restore', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.snapshot-restore', 'write', (req, _res, s, actor) => {
    const id = int(req.body?.snapshot_id);
    if (id === undefined) throw new BenchError('invalid', '要给 snapshot_id（快照编号）');
    return s.restore(id, ctxOf(req, actor, req.body?.note));
  }));

  // —— 视图描述 ——
  app.get('/api/bench-views/:bench/view', { action: 'bench-store.view-get', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-get', 'read', async (req, _res, s) => ({ view: await s.getView(int(req.query.version)) })));
  app.put('/api/bench-views/:bench/view', { action: 'bench-store.view-put', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-put', 'write', (req, _res, s, actor) => {
    const base = int(req.body?.base);
    if (base === undefined) throw new BenchError('invalid', '要给 base（你是基于第几版改的；还没有版本时给 0）');
    return s.putView(req.body?.doc, { ...ctxOf(req, actor, req.body?.note), base });
  }));
  app.get('/api/bench-views/:bench/view/versions', { action: 'bench-store.view-versions', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-versions', 'read', async (_req, _res, s) => ({ versions: await s.viewVersions() })));
  app.get('/api/bench-views/:bench/view/diff', { action: 'bench-store.view-diff', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-diff', 'read', async (req, _res, s) => {
    const a = int(req.query.a), b = int(req.query.b);
    if (a === undefined || b === undefined) throw new BenchError('invalid', '要给 a 和 b 两个版本号');
    return { diff: await s.diffViews(a, b) };
  }));
  app.post('/api/bench-views/:bench/view/rollback', { action: 'bench-store.view-rollback', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-rollback', 'write', (req, _res, s, actor) => {
    const to = int(req.body?.to), base = int(req.body?.base);
    if (to === undefined || base === undefined) throw new BenchError('invalid', '要给 to（让第几版重新生效）和 base（你看到的生效版本）');
    return s.rollbackView(to, { ...ctxOf(req, actor, req.body?.note), base });
  }));

  // —— 取数和表单 ——
  // 筛选栏的值经查询串给：p.<字段名>=值（只收文本；没声明的字段在服务里会被忽略）
  app.get('/api/bench-views/:bench/render', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.render', 'read', (req, _res, s) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (k.startsWith('p.') && typeof v === 'string') params[k.slice(2)] = v;
    return s.renderView({ view: str(req.query.view), params, version: int(req.query.version) });
  }));
  app.post('/api/bench-views/:bench/form', { action: 'bench-store.form-submit', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.form-submit', 'write', (req, _res, s, actor) => {
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    return s.submitForm({ view: String(b.view ?? ''), block: int(b.block) ?? -1, version: int(b.version) ?? -1 }, b.values, ctxOf(req, actor));
  }));

  // —— 留痕 ——
  app.get('/api/bench-views/:bench/log', { action: 'bench-store.log-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.log-list', 'read', async (_req, _res, s) => ({ changes: await s.changes(100), writes: await s.writes(100) })));
}
