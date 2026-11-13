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
import { judge, scopedVerdict, type JudgedActor } from '../judgment.ts';
import { BENCH_LIMITS, BenchError } from '../bench-query.ts';
import { benchStore, type BenchStore } from '../services/bench-store.ts';
import { bindBench, linkWorkbench, createBench, getBench, listBenches, type BenchEntry } from '../services/bench-registry.ts';
import { relationOf } from '../team-relation.ts';
import { decideBenchRequest, listBenchMcp, setBenchGrants } from '../services/bench-mcp.ts';

export type BenchViewsConfig = { on: boolean };
/** 启动时读一次：WM_BENCH_VIEWS（on / off，缺省 off）。不合法拒绝启动 */
export function benchViewsConfig(env: NodeJS.ProcessEnv = process.env): BenchViewsConfig {
  const raw = String(env.WM_BENCH_VIEWS ?? '').trim();
  if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`WM_BENCH_VIEWS 只接受 on 或 off，现在是 ${JSON.stringify(raw)}`);
  return { on: raw === 'on' };
}

/** 带不带尾斜杠都算（路由本身两种都认；不算的话全局解析会先把请求体读掉，路由再报「不是合法的 JSON」，提示误导人）。
 *  行的写入走原始字节的那条路由：请求体不在市场进程里解析，原样递给台库的工作线程（index.ts 的全局 JSON 解析要跳过它） */
export const BENCH_ROWS_PATH = /^\/api\/bench-views\/[^/]+\/datasets\/[^/]+\/rows\/?$/i;

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

/**
 * 「关注」用（attention-providers.ts、attention-answers.ts）：这个请求能不能批台上的 MCP 授予申请。
 * 能，返回做这件事的人；不能，照这组路由的口径往 res 里写拒绝（入口关着 404、跨站 403、管理口令 403、没登录 401、没有拍板权限 403）并返回 null。
 * bench 给台的标识：问这一个台（管理层，或者在这个台所绑的部门上有拍板授予的人）；给 null：只问管理层那一档（不指哪个台）。
 * 判断和下面三条授予路由是同一处（allow），不另写一份。路由还没注册时是 null。
 */
export let benchMcpDecider: ((req: express.Request, res: express.Response, bench: string | null) => Promise<string | null>) | null = null;

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

  /**
   * 放不放行，两档：
   *   一、管理层这一档：问统一判定（它现在只认范围是「全部」的授予）。读和写是同一道门，都按「能不能写」问——
   *       普通员工的预设带着全部业务域的「看」，每个登录过的员工又都会迁出一条范围「全部」的普通员工授予，按「看」放行等于全公司可读。
   *   二、部门这一档：台绑了部门，这个人在这个部门上有一条已放行的授予盖住这个动作（scopedVerdict）。
   *       只认授予：部门成员表、部门负责人、团队认领这些关系是系统管理员一个人写得出来的，不带来权限。
   *       细到团队的台，写再收窄到这个团队的负责人、成员的主人，或者有这个部门拍板授予的人——关系在这里只会让人更少。
   * 没绑部门的台只有第一档。路由登记的类别（read / write）照实写，只用于动作清单；放不放行不看它。
   */
  type Gate = 'write' | 'decide';
  /** 认人。跨站、管理口令、没登录在这里拒（已经回了应答，返回 null） */
  async function who(req: express.Request, res: express.Response): Promise<JudgedActor | null> {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req))) { res.status(403).json({ error: 'bench_views_cross_origin_denied' }); return null; }
    const actor = await actorOf(req);
    if (actor.type === 'builtin' && actor.name === 'admin-token') { res.status(403).json({ error: 'bench_views_admin_token_denied', message: '台里是业务数据，管理口令看不了、也改不了；用有管理层授予的账号登录' }); return null; }
    if (actor.type === 'builtin' && actor.name === 'anonymous') { res.status(401).json({ error: 'login_required' }); return null; }
    return actor;
  }
  const idOf = (actor: JudgedActor): string => (actor.type === 'principal' ? actor.id : `builtin:${actor.name}`);
  const everywhere = (actor: JudgedActor, action: string, gate: Gate): boolean => judge({ actor, action, kind: gate, declared: true }).verdict === 'allow';
  const inDept = (actor: JudgedActor, action: string, gate: Gate, department: string): boolean =>
    actor.type === 'principal' && scopedVerdict({ principal: actor.id, action, kind: gate, scope: `dept:${department}` }).verdict === 'allow';
  function within(actor: JudgedActor, action: string, gate: Gate, bench: BenchEntry | null): boolean {
    if (actor.type !== 'principal' || !bench || !bench.department_id) return false;
    if (!inDept(actor, action, gate, bench.department_id)) return false;
    if (!bench.team || gate === 'decide') return true;
    if (inDept(actor, 'bench-store.mcp-decide', 'decide', bench.department_id)) return true;
    const rel = relationOf({ principal: actor.id }, { team: { host: bench.team_host, team: bench.team } }).relations;
    return rel.includes('team-lead') || rel.includes('seat-owner');
  }
  const forbid = (res: express.Response): null => { res.status(403).json({ error: 'bench_views_forbidden' }); return null; };
  /** 放行返回做这件事的人的标识；不放行已经回了应答，返回 null。bench 是这次要碰的台（没登记是 null：只剩第一档，所以没权限的人看不出台存不存在） */
  async function allow(req: express.Request, res: express.Response, action: string, gate: Gate = 'write', bench: BenchEntry | null = null): Promise<string | null> {
    const actor = await who(req, res);
    if (!actor) return null;
    return everywhere(actor, action, gate) || within(actor, action, gate, bench) ? idOf(actor) : forbid(res);
  }

  benchMcpDecider = async (req, res, bench) => {
    if (!deps.on) { res.status(404).json({ error: 'bench_views_off' }); return null; }
    return allow(req, res, 'bench-store.mcp-decide', 'decide', bench === null ? null : getBench(bench));
  };

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
  /** 请求体里的编号：只收整数（数字类型），写成文字的不收 */
  const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  /** 查询串里的编号：没写是 undefined；写了就得是整数，写错了直接拒——不能当成没写（那样会悄悄给出另一版） */
  const qint = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === 'string' && /^\d{1,9}$/.test(v)) return Number(v);
    throw new BenchError('invalid', `${name} 要写成整数`);
  };
  const ctxOf = (req: express.Request, actor: string, note?: unknown) => ({ actor, at: Date.now(), idemKey: str(req.headers['idempotency-key']), note: str(note) });

  const rawRows = express.raw({ type: () => true, limit: BENCH_LIMITS.datasetBytes + 1_000_000 });
  /** 一条「在某个台上做一件事」的路由：先判权限，再核台登记过，然后把台库交给 fn */
  const on = (action: string, fn: (req: express.Request, res: express.Response, s: BenchStore, actor: string) => Promise<unknown>, gate: 'write' | 'decide' = 'write') => wrap(async (req, res) => {
    const bench = getBench(req.params.bench);
    const actor = await allow(req, res, action, gate, bench);
    if (!actor) return;
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    try { res.json(await fn(req, res, await benchStore(req.params.bench), actor)); } catch (e) { fail(res, e); }
  });

  // —— 台的登记 ——
  app.get('/api/bench-views', { action: 'bench-store.bench-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    // 清单只列这个人进得去的台：管理层全部；别的人是自己有授予的部门的台，一个都没有就是 403
    const actor = await who(req, res);
    if (!actor) return;
    const all = listBenches();
    if (everywhere(actor, 'bench-store.bench-list', 'write')) return void res.json({ benches: all });
    const mine = all.filter((b) => within(actor, 'bench-store.bench-list', 'write', b));
    if (!mine.length) return void forbid(res);
    res.json({ benches: mine });
  }));
  app.post('/api/bench-views', { action: 'bench-store.bench-create', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    // 管理层可以登记到任何部门（或者先不绑）；别的人只能登记到自己有拍板授予的部门，而且必须绑
    const actor = await who(req, res);
    if (!actor) return;
    const body = req.body as { department?: unknown; workbench_id?: unknown } | undefined;
    const dep = body?.department;
    const all = everywhere(actor, 'bench-store.bench-create', 'write');
    const ok = all || (typeof dep === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(dep) && inDept(actor, 'bench-store.bench-create', 'decide', dep));
    // 对应市场登记的台号只有管理层设（和改绑一样不交给部门自己）
    if (!ok || (body?.workbench_id !== undefined && !all)) return void forbid(res);
    try { res.status(201).json({ bench: createBench(req.body, idOf(actor), Date.now()) }); } catch (e) { fail(res, e); }
  }));
  // 改绑、解绑：只有管理层。绑到哪个部门决定了谁进得来，不交给部门自己
  app.put('/api/bench-views/:bench/binding', { action: 'bench-store.bench-bind', kind: 'decide', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    if (!everywhere(actor, 'bench-store.bench-bind', 'decide')) return void forbid(res);
    if (!getBench(req.params.bench)) return void res.status(404).json({ error: 'bench_not_found' });
    try { res.json(bindBench(req.params.bench, req.body, idOf(actor), Date.now())); } catch (e) { fail(res, e); }
  }));

  // 对应市场登记的哪个台：只有管理层。清单里每个台带 workbench_id，市场的台详情页靠它找这个台的视图（清单本来就按看的人裁剪）
  app.put('/api/bench-views/:bench/workbench', { action: 'bench-store.bench-link', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    if (!everywhere(actor, 'bench-store.bench-link', 'write')) return void forbid(res);
    if (!getBench(req.params.bench)) return void res.status(404).json({ error: 'bench_not_found' });
    try { res.json(linkWorkbench(req.params.bench, req.body, idOf(actor), Date.now())); } catch (e) { fail(res, e); }
  }));

  // —— 数据集 ——
  app.get('/api/bench-views/:bench/datasets', { action: 'bench-store.dataset-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.dataset-list', async (_req, _res, s) => ({ datasets: await s.datasets() })));
  app.put('/api/bench-views/:bench/datasets/:name', { action: 'bench-store.dataset-define', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.dataset-define',
    (req, _res, s, actor) => s.defineDataset({ ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}), name: req.params.name }, ctxOf(req, actor, req.query.note))));
  // 行的写入：请求体是行的数组（JSON 文本），原样递给工作线程解析。op=replace / upsert / append / delete（delete 时给的是主键的数组）
  app.post('/api/bench-views/:bench/datasets/:name/rows', { action: 'bench-store.rows-write', kind: 'write', statusNotVerdict: NOT_VERDICT },
    // 请求体最后才收：开关、认人、判定、台的登记、op 都过了才读。没过的请求一个字节都不进内存
    on('bench-store.rows-write', async (req, res, s, actor) => {
      const op = OPS.get(String(req.query.op ?? ''));
      if (!op) throw new BenchError('invalid', 'op 须为 replace、upsert、append、delete 之一');
      await new Promise<void>((ok, no) => rawRows(req, res, (e?: unknown) => (e ? no(e) : ok())));
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return s[op](req.params.name, body, ctxOf(req, actor, req.query.note));
    }));
  app.post('/api/bench-views/:bench/query', { action: 'bench-store.query', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.query', (req, _res, s) => {
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as { query?: unknown; params?: unknown };
    return s.query(b.query, b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params as Record<string, unknown> : {});
  }));

  // —— 快照 ——
  app.get('/api/bench-views/:bench/datasets/:name/snapshots', { action: 'bench-store.snapshot-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.snapshot-list', async (req, _res, s) => ({ snapshots: await s.snapshots(req.params.name) })));
  app.post('/api/bench-views/:bench/datasets/:name/snapshots', { action: 'bench-store.snapshot-take', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.snapshot-take', (req, _res, s, actor) => s.snapshot(req.params.name, ctxOf(req, actor, req.body?.note))));
  app.post('/api/bench-views/:bench/restore', { action: 'bench-store.snapshot-restore', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.snapshot-restore', (req, _res, s, actor) => {
    const id = int(req.body?.snapshot_id);
    if (id === undefined) throw new BenchError('invalid', '要给 snapshot_id（快照编号）');
    return s.restore(id, ctxOf(req, actor, req.body?.note));
  }));

  // —— 视图描述 ——
  app.get('/api/bench-views/:bench/view', { action: 'bench-store.view-get', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-get', async (req, _res, s) => ({ view: await s.getView(qint(req.query.version, 'version')) })));
  app.put('/api/bench-views/:bench/view', { action: 'bench-store.view-put', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-put', (req, _res, s, actor) => {
    const base = int(req.body?.base);
    if (base === undefined) throw new BenchError('invalid', '要给 base（你是基于第几版改的；还没有版本时给 0）');
    return s.putView(req.body?.doc, { ...ctxOf(req, actor, req.body?.note), base });
  }));
  app.get('/api/bench-views/:bench/view/versions', { action: 'bench-store.view-versions', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-versions', async (_req, _res, s) => ({ versions: await s.viewVersions() })));
  app.get('/api/bench-views/:bench/view/diff', { action: 'bench-store.view-diff', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-diff', async (req, _res, s) => {
    const a = qint(req.query.a, 'a'), b = qint(req.query.b, 'b');
    if (a === undefined || b === undefined) throw new BenchError('invalid', '要给 a 和 b 两个版本号');
    return { diff: await s.diffViews(a, b) };
  }));
  app.post('/api/bench-views/:bench/view/rollback', { action: 'bench-store.view-rollback', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.view-rollback', (req, _res, s, actor) => {
    const to = int(req.body?.to), base = int(req.body?.base);
    if (to === undefined || base === undefined) throw new BenchError('invalid', '要给 to（让第几版重新生效）和 base（你看到的生效版本）');
    return s.rollbackView(to, { ...ctxOf(req, actor, req.body?.note), base });
  }));

  // —— 取数和表单 ——
  // 筛选栏的值经查询串给：p.<字段名>=值（只收文本；没声明的字段在服务里会被忽略）
  app.get('/api/bench-views/:bench/render', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.render', (req, _res, s) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (k.startsWith('p.') && typeof v === 'string') params[k.slice(2)] = v;
    return s.renderView({ view: str(req.query.view), params, version: qint(req.query.version, 'version') });
  }));
  app.post('/api/bench-views/:bench/form', { action: 'bench-store.form-submit', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.form-submit', (req, _res, s, actor) => {
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const view = str(b.view), block = int(b.block), version = int(b.version);
    if (view === undefined || block === undefined || version === undefined) throw new BenchError('invalid', '要给 view（哪份视图）、block（第几块，从 0 数）、version（页面是第几版的）');
    return s.submitForm({ view, block, version }, b.values, ctxOf(req, actor));
  }));

  // 把台的数据交给一个 AI 会话是「拍板」（和批授予、批角色同类），不是普通的写：以后有能改数据、但不该替会话开权限的角色时分得开
  // —— MCP 工具的授予（3b）：按「会话 × 台 × 工具」记，由能改这个台的人批；管理口令在上面已经拒了 ——
  app.get('/api/bench-views/:bench/mcp-grants', { action: 'bench-store.mcp-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.mcp-list', async (req) => listBenchMcp(req.params.bench)));
  app.put('/api/bench-views/:bench/mcp-grants', { action: 'bench-store.mcp-grant', kind: 'decide', statusNotVerdict: NOT_VERDICT }, on('bench-store.mcp-grant', async (req, _res, _s, actor) => setBenchGrants(req.params.bench, req.body, actor, Date.now()), 'decide'));
  app.post('/api/bench-views/:bench/mcp-requests/:id', { action: 'bench-store.mcp-decide', kind: 'decide', statusNotVerdict: NOT_VERDICT }, on('bench-store.mcp-decide', async (req, _res, _s, actor) => {
    const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!Number.isInteger(id) || id < 1) throw new BenchError('not_found', '没有这条申请');
    return decideBenchRequest(req.params.bench, id, req.body?.approve, actor, req.body?.note, Date.now());
  }, 'decide'));

  // —— 留痕 ——
  app.get('/api/bench-views/:bench/log', { action: 'bench-store.log-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.log-list', async (_req, _res, s) => ({ changes: await s.changes(100), writes: await s.writes(100) })));
}
