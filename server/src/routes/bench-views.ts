/**
 * 数据视图的入口（docs/data-views.md 第三、十节，第三步的前一半）：给登录的人用的 REST 接口，都在 /api/bench-views 下面。
 * 台的登记、数据集、四种写入、查询、快照、视图描述和它的版本、取数、表单提交。逻辑都在 services/bench-store.ts，这里只是路由。
 *
 * 整组路由在一个开关后面（WM_BENCH_VIEWS），缺省开，显式 off 关：关着的时候每一条都直接回 404，不认人、不读请求体、不碰台库。
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
import type { JudgedActor } from '../judgment.ts';
import { everywhere, within, inDept, canBenchAction } from '../services/bench-access.ts';
import { BENCH_LIMITS, BenchError } from '../bench-query.ts';
import { tableTarget, tableCsv } from '../bench-table.ts';
import { benchStore, benchStoreExists, type BenchStore } from '../services/bench-store.ts';
import { captureBenchStorageFence, bindBench, linkWorkbench, renameBench, cardTitle, createBench, getBench, listBenches, resolveBenchRef, unopenedCard, cardSlug, type BenchEntry } from '../services/bench-registry.ts';
import { checkBenchRequest, decideBenchRequest, listBenchMcp, setBenchGrants } from '../services/bench-mcp.ts';
import { personalTokenAuditName, personalTokenOf } from './owner-personal-tokens.ts';
import { viaBegin, viaSettle } from '../attention-via.ts';
import { assertBenchBinding, renderBenchView } from '../services/bench-render.ts';
import { bindReport, generateReport, listReports, readReport, respondReport, SUBJECT_RE } from '../services/bench-report.ts';
import { fetchImage, ImageError, viewRefersImage } from '../bench-image.ts';
import { imageNodesOf } from '../services/report-compile.ts';
import { createHash } from 'node:crypto';

export type BenchViewsConfig = { on: boolean; imageGalleryBase: string | null };
/** 启动时读一次：WM_BENCH_VIEWS（on / off，缺省 on；不需要时显式 off 关掉）；WM_IMAGE_GALLERY_BASE（图库前缀，可不设）。不合法拒绝启动 */
export function benchViewsConfig(env: NodeJS.ProcessEnv = process.env): BenchViewsConfig {
  const raw = String(env.WM_BENCH_VIEWS ?? '').trim();
  if (raw !== '' && raw !== 'on' && raw !== 'off') throw new Error(`WM_BENCH_VIEWS 只接受 on 或 off，现在是 ${JSON.stringify(raw)}`);
  return { on: raw !== 'off', imageGalleryBase: galleryBaseOf(String(env.WM_IMAGE_GALLERY_BASE ?? '').trim()) };
}
/** 图库前缀：http(s)，以 / 结尾，不带账号口令、查询串和片段（docs/image-step1.md 第三节）；空就是没配 */
function galleryBaseOf(raw: string): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`WM_IMAGE_GALLERY_BASE 不是合法的地址：${JSON.stringify(raw)}`); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/')) {
    throw new Error(`WM_IMAGE_GALLERY_BASE 要是 http(s) 地址、以 / 结尾、不带账号口令和查询串，现在是 ${JSON.stringify(raw)}`);
  }
  return u.href;
}

/** 带不带尾斜杠都算（路由本身两种都认；不算的话全局解析会先把请求体读掉，路由再报「不是合法的 JSON」，提示误导人）。
 *  行的写入走原始字节的那条路由：请求体不在市场进程里解析，原样递给台库的工作线程（index.ts 的全局 JSON 解析要跳过它） */
export const BENCH_ROWS_PATH = /^\/api\/bench-views\/[^/]+\/datasets\/[^/]+\/rows\/?$/i;

type Handler = (req: express.Request, res: express.Response, next: express.NextFunction) => unknown;
export interface BenchViewRouteDeps {
  /** 开关开着没有；关着时每条路由直接回 404 */
  on: boolean;
  /** 图库前缀（WM_IMAGE_GALLERY_BASE）；没配是 null，格子里的相对路径就取不了 */
  imageGalleryBase?: string | null;
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
  // 路径里的台可以写卡片 id（纯数字）或台标识：一进来就换成台标识，下面一律按台标识认（docs/data-views.md 第十三节）
  const wrap: BenchViewRouteDeps['wrap'] = (fn) => wrapInner(async (req, res) => {
    if (!deps.on) return res.status(404).json({ error: 'bench_views_off' });
    if (typeof req.params?.bench === 'string') req.params.bench = personalTokenOf(req)?.authorizedBench ?? resolveBenchRef(req.params.bench);
    return fn(req, res);
  });
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
    const token = personalTokenOf(req);
    if (token) {
      const p = principals().get(token.principal);
      return p ? { type: 'principal', id: p.id, kind: p.kind, status: p.status, owner: p.owner } : { type: 'builtin', name: 'anonymous' };
    }
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
   *   二、部门、领域这一档：台绑了一个标识（部门或领域，同一个写法），这个人在这上面有一条已放行的授予盖住这个动作（scopedVerdict：
   *       领域在、没撤时认 area:<标识>，过渡期也认 dept:<标识>；领域撤了都不认；还没迁成领域的部门照旧只认 dept:<标识>）。
   *       只认授予：部门成员表、部门负责人、团队认领这些关系是系统管理员一个人写得出来的，不带来权限。
   *       细到团队的台，写再收窄到这个团队的负责人、成员的主人，或者有这个部门拍板授予的人——关系在这里只会让人更少。
   * 没绑部门的台只有第一档。路由登记的类别（read / write）照实写，只用于动作清单；放不放行不看它。
   */
  // 问判定用的类别不看路由登记的类别（读也按「写」问），都照 judgment-builtins.ts 的 ASKED 取：矩阵照同一张表推，不会各说各的
  /** 认人。跨站、管理口令、没登录在这里拒（已经回了应答，返回 null） */
  async function who(req: express.Request, res: express.Response): Promise<JudgedActor | null> {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req, true) && !devOriginOk(req))) { res.status(403).json({ error: 'bench_views_cross_origin_denied' }); return null; }
    const actor = await actorOf(req);
    if (actor.type === 'builtin' && actor.name === 'admin-token') { res.status(403).json({ error: 'bench_views_admin_token_denied', message: '台里是业务数据，管理口令看不了、也改不了；用有管理层授予的账号登录' }); return null; }
    if (actor.type === 'builtin' && actor.name === 'anonymous') { res.status(401).json({ error: 'login_required' }); return null; }
    return actor;
  }
  const idOf = (actor: JudgedActor): string => (actor.type === 'principal' ? actor.id : `builtin:${actor.name}`);
  const forbid = (res: express.Response): null => { res.status(403).json({ error: 'bench_views_forbidden' }); return null; };
  /** 放行返回做这件事的人的标识；不放行已经回了应答，返回 null。bench 是这次要碰的台（没登记是 null：只剩第一档，所以没权限的人看不出台存不存在） */
  async function allow(req: express.Request, res: express.Response, action: string, bench: BenchEntry | null = null): Promise<string | null> {
    const actor = await allowActor(req, res, action, bench);
    return actor ? idOf(actor) : null;
  }
  /** 同 allow，返回的是判过的人本身（还要再问别的动作时用，比如取数时顺带问能不能交表单） */
  async function allowActor(req: express.Request, res: express.Response, action: string, bench: BenchEntry | null = null): Promise<JudgedActor | null> {
    const actor = await who(req, res);
    if (!actor) return null;
    return everywhere(actor, action) || within(actor, action, bench) ? actor : forbid(res);
  }
  /** 这个人能不能在这个台上做这件事（不回应答，只给真假） */
  const may = canBenchAction;
  /** 能不能改台名（#905）：PUT /title 拒不拒、入口给不给 can.rename，都只问这一处——页面的按钮和接口不会一个说能一个说不能 */
  const mayRename = (actor: JudgedActor): boolean => everywhere(actor, 'bench-store.bench-link');

  benchMcpDecider = async (req, res, bench) => {
    if (!deps.on) { res.status(404).json({ error: 'bench_views_off' }); return null; }
    return allow(req, res, 'bench-store.mcp-decide', bench === null ? null : getBench(bench));
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
  const auditActor = (req: express.Request, actor: string) => {
    const token = personalTokenOf(req);
    return token ? personalTokenAuditName(token) : actor;
  };
  const ctxOf = (req: express.Request, actor: string, note?: unknown) => ({ actor: auditActor(req, actor), idemActor: actor, at: Date.now(), idemKey: str(req.headers['idempotency-key']), note: str(note) });

  const rawRows = express.raw({ type: () => true, limit: BENCH_LIMITS.datasetBytes + 1_000_000 });
  /** 一条「在某个台上做一件事」的路由：先判权限，再核台登记过，然后把台库交给 fn */
  const on = (action: string, fn: (req: express.Request, res: express.Response, s: BenchStore, actor: string, fence: ReturnType<typeof captureBenchStorageFence> | undefined) => Promise<unknown>) => wrap(async (req, res) => {
    const fence = ['bench-store.report-bind', 'bench-store.report-generate'].includes(action) ? captureBenchStorageFence() : undefined;
    const bench = getBench(req.params.bench);
    const actor = await allow(req, res, action, bench);
    if (!actor) return;
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    try { res.json(await fn(req, res, await benchStore(req.params.bench), actor, fence)); } catch (e) { fail(res, e); }
  });

  // —— 台的登记 ——
  app.get('/api/bench-views', { action: 'bench-store.bench-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    // 清单只列这个人进得去的台：管理层全部；别的人是自己有授予的部门的台，一个都没有就是 403
    const actor = await who(req, res);
    if (!actor) return;
    const all = listBenches();
    if (everywhere(actor, 'bench-store.bench-list')) return void res.json({ benches: all });
    const mine = all.filter((b) => within(actor, 'bench-store.bench-list', b));
    if (!mine.length) return void forbid(res);
    res.json({ benches: mine });
  }));
  app.post('/api/bench-views', { action: 'bench-store.bench-create', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    // 管理层可以登记到任何部门（或者先不绑）；别的人只能登记到自己有拍板授予的部门，而且必须绑。
    // 给一张卡片开台库：只给 workbench_id，标识定成 wb-<卡片 id>、名字用卡片的（只有管理层，见下）
    const actor = await who(req, res);
    if (!actor) return;
    const body = req.body as { department?: unknown; workbench_id?: unknown } | undefined;
    const dep = body?.department;
    const all = everywhere(actor, 'bench-store.bench-create');
    const ok = all || (typeof dep === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(dep) && inDept(actor, 'bench-store.bench-create', dep));
    // 对应市场登记的台号只有管理层设（和改绑一样不交给部门自己）
    if (!ok || (body?.workbench_id !== undefined && !all)) return void forbid(res);
    try { res.status(201).json({ bench: createBench(req.body, idOf(actor), Date.now()) }); } catch (e) { fail(res, e); }
  }));
  // 改绑、解绑：只有管理层。绑到哪个部门决定了谁进得来，不交给部门自己
  app.put('/api/bench-views/:bench/binding', { action: 'bench-store.bench-bind', kind: 'decide', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    if (!everywhere(actor, 'bench-store.bench-bind')) return void forbid(res);
    if (!getBench(req.params.bench)) return void res.status(404).json({ error: 'bench_not_found' });
    try { res.json(bindBench(req.params.bench, req.body, idOf(actor), Date.now())); } catch (e) { fail(res, e); }
  }));

  // 对应市场登记的哪个台：只有管理层。清单里每个台带 workbench_id，市场的台详情页靠它找这个台的视图（清单本来就按看的人裁剪）
  app.put('/api/bench-views/:bench/workbench', { action: 'bench-store.bench-link', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    if (!everywhere(actor, 'bench-store.bench-link')) return void forbid(res);
    if (!getBench(req.params.bench)) return void res.status(404).json({ error: 'bench_not_found' });
    try { res.json(linkWorkbench(req.params.bench, req.body, idOf(actor), Date.now())); } catch (e) { fail(res, e); }
  }));
  // 只改台的名字（#905）：和改对应关系一样只有管理层，沿用同一个动作（都是改台的登记、不动谁进得来）。
  // { title } 直接给名字，或 { from_card: true } 照对应卡片现在的名字抄；base_title 写了就核「我看到的是这个名字」
  app.put('/api/bench-views/:bench/title', { action: 'bench-store.bench-link', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    if (!mayRename(actor)) return void forbid(res);
    if (!getBench(req.params.bench)) return void res.status(404).json({ error: 'bench_not_found' });
    try { res.json(renameBench(req.params.bench, req.body, idOf(actor), Date.now())); } catch (e) { fail(res, e); }
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

  // —— 视图台页面的入口（第十三节第 5 条第 4 步）——
  // 从市场目录打开一张卡片时先问这一条（路径写卡片 id 或台标识）：给页面菜单要的最少信息——台名、生效的版本、默认视图（第一份）、各视图的键和标题。
  // 取数照旧走 /render（不给 view 就是第一份），表单照旧走 /form。
  // 读不到的、不存在的、卡片没开台库的、台还没有视图描述的，一律同一个 404（通则一：读不到按不存在回；页面据此照原来的方式打开卡片）。
  // 管理口令、跨站、没登录照这组路由的口径先拒（403 / 403 / 401）
  app.get('/api/bench-views/:bench/entry', { action: 'bench-store.view-get', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    const bench = getBench(req.params.bench);
    const none = () => void res.status(404).json({ error: 'bench_not_found' });
    if (!bench || !(everywhere(actor, 'bench-store.view-get') || within(actor, 'bench-store.view-get', bench))) return none();
    let view: Awaited<ReturnType<BenchStore['getView']>>;
    try { view = await (await benchStore(bench.slug)).getView(); } catch (e) { return fail(res, e); }
    const doc = view?.content as { title?: unknown; views?: { key: string; title: string }[] } | undefined;
    if (!view || !Array.isArray(doc?.views) || !doc.views.length) return none();
    const rename = mayRename(actor);
    res.json({
      // card_title（卡片现在的名字）只给能改名的人：页面据此决定出不出「跟卡片同名」；不能改的人用不上，也不多给
      bench: { slug: bench.slug, title: bench.title, workbench_id: bench.workbench_id, ...(rename ? { card_title: cardTitle(bench.workbench_id) } : {}) },
      version: view.version,
      title: typeof doc.title === 'string' ? doc.title : bench.title,
      default_view: doc.views[0].key,
      views: doc.views.map((v) => ({ key: v.key, title: v.title })),
      // 页面据此决定出不出「改名」按钮、「MCP 授权」入口和上面的批准驳回（#904）、「报告」按钮和报告上的回应框（报告第 1 步 PR D）；
      // 和对应接口是同一个判法（PUT /title、mayRename / may）
      can: { rename, mcp: may(actor, 'bench-store.mcp-list', bench), mcp_decide: may(actor, 'bench-store.mcp-decide', bench), reports: may(actor, 'bench-store.report-read', bench), respond: may(actor, 'bench-store.report-respond', bench) },
    });
  }));

  // —— 报告（docs/report-step1.md 第四节；报告第 1 步 PR B、C）——
  // 规矩都在 services/bench-report.ts（和 MCP 的 report_* 工具共用）；这里只按动作判谁能做。四个动作和视图描述、取数同一档
  // （ASKED 里 global、scoped 都按「写」问）：管理层，和台所绑的领域上有授予的人
  const benchOf = (req: express.Request): BenchEntry => getBench(req.params.bench) as BenchEntry;
  app.get('/api/bench-views/:bench/reports/:dimension/binding', { action: 'bench-store.report-read', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.report-read', async (req, _res, s) => {
    const b = await s.reportBindingGet(String(req.params.dimension));
    if (!b) throw new BenchError('not_found', '这个台还没有绑这个维度');
    return { binding: b };
  }));
  app.put('/api/bench-views/:bench/reports/:dimension/binding', { action: 'bench-store.report-bind', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.report-bind',
    (req, _res, s, actor, fence) => bindReport(benchOf(req), s, req.params.dimension, req.body, auditActor(req, actor), Date.now(), fence!)));
  app.post('/api/bench-views/:bench/reports/:dimension/binding/stop', { action: 'bench-store.report-bind-stop', kind: 'decide', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    if (!deps.on) return res.status(404).json({ error: 'bench_views_off' });
    const fence = captureBenchStorageFence();
    const actor = await who(req, res);
    if (!actor) return;
    if (actor.type !== 'principal' || actor.kind !== 'person' || actor.status !== 'active' || !everywhere(actor, 'bench-store.report-bind-stop')) return forbid(res);
    if (!getBench(req.params.bench)) return res.status(404).json({ error: 'bench_not_found' });
    try {
      const dimension = String(req.params.dimension);
      const base = int(req.body?.base);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(dimension) || !base || !reason || reason.length > 500 || Object.keys(req.body).some(k => !['base', 'reason'].includes(k))) {
        throw new BenchError('invalid', '停用报告生成需要绑定版本和理由（1～500 字）');
      }
      const store = await benchStore(req.params.bench);
      return res.json({ binding: await store.reportBindingStop(dimension, { base, reason, actor: actor.id, at: Date.now() }, fence) });
    } catch (err) { fail(res, err); }
  }));
  app.post('/api/bench-views/:bench/reports', { action: 'bench-store.report-generate', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.report-generate', async (req, res, s, actor, fence) => {
    const out = await generateReport(benchOf(req), s, req.body, actor, Date.now(), fence!, { galleryBase: deps.imageGalleryBase ?? null });
    res.status(201);
    return out;
  }));
  app.get('/api/bench-views/:bench/reports', { action: 'bench-store.report-read', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.report-read', (req, _res, s) => {
    const q = req.query as Record<string, unknown>;
    return listReports(s, { dimension: q.dimension, subject: q.subject, limit: qint(q.limit, 'limit') });
  }));
  app.get('/api/bench-views/:bench/reports/:id', { action: 'bench-store.report-read', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.report-read', (req, _res, s, actor) => {
    const id = qint(req.params.id, '报告编号');
    return readReport(s, id, actor);
  }));
  // 跨台的同一事物（报告第 1 步 F，规格用例 16）：同一件事物在各台上的报告，按读者能读的台裁剪。
  // 每个台照单台清单同一个判法（bench-store.report-read，may）：读不了的台连台库都不打开，所以它上面的报告、份数、台名都进不了应答。
  // 一个台都读不了也回 200、空清单（不拿 403 暗示「别处有」）；没开过台库的台没有报告，跳过，不为了读顺手建库。
  app.get('/api/report-subjects/:subject', { action: 'bench-store.report-read', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    try {
      const subject = req.params.subject;
      if (typeof subject !== 'string' || !SUBJECT_RE.test(subject)) throw new BenchError('invalid', 'subject 要写成「种类:标识」，比如 item:123');
      const limit = qint((req.query as Record<string, unknown>).limit, 'limit');
      const benches: Array<{ bench: { slug: string; title: string } } & Awaited<ReturnType<typeof listReports>>> = [];
      for (const b of listBenches()) {
        if (!may(actor, 'bench-store.report-read', b) || !benchStoreExists(b.slug)) continue;
        let got: Awaited<ReturnType<typeof listReports>>;
        try { got = await listReports(await benchStore(b.slug), { subject, limit }); }
        catch (e) { if (e instanceof BenchError && e.code === 'conflict') continue; throw e; } // 这个台正在删：当它不在
        if (got.reports.length) benches.push({ bench: { slug: b.slug, title: b.title }, ...got });
      }
      res.json({ subject, total: benches.reduce((n, x) => n + x.reports.length, 0), benches });
    } catch (e) { fail(res, e); }
  }));
  // 回应（PR C）：能读这份报告的人表态（规格第六节评审定的推荐：随含取数的预设一起给，这里和读同一档）。
  // 能回应、却读不了这个台上的报告的人：和报告不存在一样回 404（规格第五节第 14 条：不泄露报告在不在；#932 独立验收）
  app.post('/api/bench-views/:bench/reports/:id/responses', { action: 'bench-store.report-respond', kind: 'write', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const bench = getBench(req.params.bench);
    const actor = await allowActor(req, res, 'bench-store.report-respond', bench);
    if (!actor) return;
    if (!bench) return void res.status(404).json({ error: 'bench_not_found' });
    if (!may(actor, 'bench-store.report-read', bench)) return void fail(res, new BenchError('not_found', '没有这份报告'));
    try {
      const out = await respondReport(await benchStore(req.params.bench), qint(req.params.id, '报告编号'), req.body, idOf(actor), Date.now());
      res.status(201).json(out);
    } catch (e) { fail(res, e); }
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
  // 表单块各带 can_submit：这个人能不能在这个台上交表单（和 /form 那条路由同一处判断），页面据此先把按钮置灰、说清原因，不用交了才知道
  app.get('/api/bench-views/:bench/render', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const bench = getBench(req.params.bench);
    const actor = await allowActor(req, res, 'bench-store.render', bench);
    if (!actor) return;
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (k.startsWith('p.') && typeof v === 'string') params[k.slice(2)] = v;
    try {
      // No request-supplied variable selectors: only saved view slots may cause reads.
      const invalidSelectors = Object.keys(req.query).some(k => k !== 'view' && k !== 'version' && !k.startsWith('p.'));
      const out = await renderBenchView(bench, await benchStore(bench.slug), { view: str(req.query.view), params, version: qint(req.query.version, 'version') }, invalidSelectors);
      const canSubmit = may(actor, 'bench-store.form-submit', bench);
      assertBenchBinding(bench); // Last synchronous gate: nothing may await between this and res.json.
      res.json({ ...out, blocks: (out.blocks ?? []).map((b) => (b?.type === 'form' ? { ...b, can_submit: canSubmit } : b)) });
    } catch (e) { fail(res, e); }
  }));
  // 变更游标（docs/task-graph-step1.md 第五节之六）：页面可见时轮询它，变了才重新取数。几十字节，不带任何数据。
  // 顺序照取数：先判 render 权（任何台库读取之前），台没登记判过权才 404，最后同步核绑定再回应。不收任何查询参数。
  app.get('/api/bench-views/:bench/changes', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const bench = getBench(req.params.bench);
    const actor = await allowActor(req, res, 'bench-store.render', bench);
    if (!actor) return;
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'invalid', message: '变更游标不收查询参数' });
    try {
      const out = await (await benchStore(bench.slug)).changeCursor();
      assertBenchBinding(bench); // Last synchronous gate: nothing may await between this and res.json.
      res.json(out); // Cache-Control: private, no-store 由 who() 统一设
    } catch (e) { fail(res, e); }
  }));
  // 图片代取（docs/image-step1.md 第四节）：浏览器不访问图库，由市场取了再给。
  // 属主 2026-11-23 定 Q9 按引用判：来源是这个台的一份视图（view、version、p.* 照渲染时的写法），读者能读它（render），
  // 照这组参数渲染出来确实有这条链接（image 列）——三条都满足才放行；任何一条不满足同一个 403，不发外部请求，缓存命中也照判。
  // 台没登记的，判过第一档权才回 404（没权限的人看不出台存不存在）。
  // 报告作来源（图片第 1 步 PR C，用例 8）：带 report=<编号> 时，判法同样三条——读者能读这个台的报告（report-read，不要 render）、
  // 这份报告属于这个台、报告冻结的正文里有一个图片节点就是这条链接；都满足才取。取回的图按冻结的哈希核：不一样回 409 image_changed（页面显示「图片已变」），不给新图。
  app.get('/api/bench-views/:bench/image', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const bench = getBench(req.params.bench);
    const actor = await who(req, res);
    if (!actor) return;
    const fromReport = req.query.report !== undefined;
    if (!may(actor, fromReport ? 'bench-store.report-read' : 'bench-store.render', bench)) return forbid(res);
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    const ref = typeof req.query.u === 'string' ? req.query.u : '';
    if (fromReport) {
      const id = typeof req.query.report === 'string' && /^[1-9][0-9]{0,14}$/.test(req.query.report) ? Number(req.query.report) : 0;
      let frozenSha: string | null = null;
      try {
        const r = id ? await (await benchStore(bench.slug)).reportGet(id) : null;
        if (r) frozenSha = imageNodesOf((JSON.parse(r.report.body) as { body?: unknown }).body).find((n) => n.src === ref)?.sha256 || null;
      } catch { frozenSha = null; } // 报告不存在、正文读不出：都当没引用
      if (!frozenSha) return forbid(res);
      try {
        const got = await fetchImage(ref, deps.imageGalleryBase ?? null);
        if (createHash('sha256').update(got.body).digest('hex') !== frozenSha) return void res.status(409).json({ error: 'image_changed', message: '图片已变' });
        res.set({ 'Content-Type': got.type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=300', 'Referrer-Policy': 'no-referrer' });
        return void res.send(got.body);
      } catch (e) {
        if (e instanceof ImageError) return void res.status(e.http).json({ error: e.code, message: e.message });
        throw e;
      }
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (k.startsWith('p.') && typeof v === 'string') params[k.slice(2)] = v;
    let referenced = false;
    try {
      const out = await renderBenchView(bench, await benchStore(bench.slug), { view: str(req.query.view), params, version: qint(req.query.version, 'version') });
      referenced = viewRefersImage(out, ref);
    } catch { referenced = false; } // 视图不存在、版本不对、参数不合：都当没引用
    if (!referenced) return forbid(res);
    try {
      const got = await fetchImage(ref, deps.imageGalleryBase ?? null);
      res.set({ 'Content-Type': got.type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=300', 'Referrer-Policy': 'no-referrer' });
      res.send(got.body);
    } catch (e) {
      if (e instanceof ImageError) return void res.status(e.http).json({ error: e.code, message: e.message });
      throw e;
    }
  }));
  // Table operations reuse the existing render/query authorization; no new grant or binding is introduced.
  app.post('/api/bench-views/:bench/table/export', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Cookie');
    const bench = getBench(req.params.bench);
    const actor = await allowActor(req, res, 'bench-store.render', bench);
    if (!actor) return;
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    try {
      const target = tableTarget(req.body);
      const out = await (await benchStore(bench.slug)).tableExport(target);
      const csv = tableCsv(out.columns, out.rows, out.value_labels);
      // Long reads must not publish after access was revoked or a binding changed.
      const current = await allowActor(req, res, 'bench-store.render', getBench(bench.slug));
      if (!current) return;
      assertBenchBinding(bench);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('table-' + out.view + '-v' + out.version + '.csv'));
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('X-Row-Count', String(out.row_count));
      res.set('X-View-Version', String(out.version));
      res.set('X-Table-Revision', out.revision);
      res.send(csv);
    } catch (e) { fail(res, e); }
  }));
  app.post('/api/bench-views/:bench/table/row', { action: 'bench-store.render', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Cookie');
    const bench = getBench(req.params.bench);
    const actor = await allowActor(req, res, 'bench-store.render', bench);
    if (!actor) return;
    if (!bench) return res.status(404).json({ error: 'bench_not_found' });
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['target', 'index', 'row'].includes(k))) throw new BenchError('invalid', '记录详情需要表格上下文、行号和所选记录');
      const target = tableTarget(body.target), mayOriginal = may(actor, 'bench-store.query', bench);
      const out = await (await benchStore(bench.slug)).tableRow(target, body.index, body.row, mayOriginal);
      const current = await allowActor(req, res, 'bench-store.render', getBench(bench.slug));
      if (!current) return;
      const canReadOriginal = mayOriginal && may(current, 'bench-store.query', getBench(bench.slug));
      assertBenchBinding(bench);
      res.json(canReadOriginal ? out : { ...out, source_row: null, source_rows: [], source_truncated: false, source_columns: [], source_status: 'forbidden', source_message: '你无权查看原行或原证详情；未扩大读取权限。' });
    } catch (e) { fail(res, e); }
  }));
  app.post('/api/bench-views/:bench/form', { action: 'bench-store.form-submit', kind: 'write', statusNotVerdict: NOT_VERDICT }, on('bench-store.form-submit', (req, _res, s, actor) => {
    const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
    const view = str(b.view), block = int(b.block), version = int(b.version);
    if (view === undefined || block === undefined || version === undefined) throw new BenchError('invalid', '要给 view（哪份视图）、block（第几块，从 0 数）、version（页面是第几版的）');
    return s.submitForm({ view, block, version }, b.values, ctxOf(req, actor));
  }));

  // 把台的数据交给一个 AI 会话是「拍板」（和批授予、批角色同类），不是普通的写：以后有能改数据、但不该替会话开权限的角色时分得开
  // —— MCP 工具的授予（3b）：按「会话 × 台 × 工具」记，由能改这个台的人批；管理口令在上面已经拒了 ——
  // 台的 MCP 管理页（#904）照应答里的 can.decide 出批准、驳回：和 POST .../mcp-requests/:id 同一个判法（may），页面不自己猜
  app.get('/api/bench-views/:bench/mcp-grants', { action: 'bench-store.mcp-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    const bench = getBench(req.params.bench);
    const judged = await allowActor(req, res, 'bench-store.mcp-list', bench);
    if (!judged) return;
    if (!bench) return void res.status(404).json({ error: 'bench_not_found' });
    res.json({ ...listBenchMcp(req.params.bench), bench: { slug: bench.slug, title: bench.title, workbench_id: bench.workbench_id }, can: { decide: may(judged, 'bench-store.mcp-decide', bench) } });
  }));
  app.put('/api/bench-views/:bench/mcp-grants', { action: 'bench-store.mcp-grant', kind: 'decide', statusNotVerdict: NOT_VERDICT }, on('bench-store.mcp-grant', async (req, _res, _s, actor) => setBenchGrants(req.params.bench, req.body, actor, Date.now())));
  // 「关注」里「台的 MCP 授予申请」卡片照 answer_via 调这里：带来的（from_attention）批成了记进「关注」的答复账，可以顺带记成经验（attention-via.ts）；
  // remember 写得不对在批之前就拒（400，申请不动）。别处直接调的照旧
  // 先后和 on() 一样（判权限、核台登记过），只是 remember 写得不对要回和答复入口同一个 400 remember_invalid
  // 会话申请时写的可能是一张还没开台库的卡片（卡片 id 或 wb-<卡片 id>）：这种申请也批得了——
  //   台没绑部门，只有管理层那一档判得过；批准还要能登记台（和 POST /api/bench-views 带 workbench_id 同一道门），
  //   先核这条申请批得了，再给卡片开台库（标识 wb-<卡片 id>、名字用卡片的），再写授予，一步办成。驳回不开台库。
  app.post('/api/bench-views/:bench/mcp-requests/:id', { action: 'bench-store.mcp-decide', kind: 'decide', statusNotVerdict: NOT_VERDICT }, wrap(async (req, res) => {
    let bench = getBench(req.params.bench);
    const card = bench ? null : unopenedCard(req.params.bench);
    const judged = await allowActor(req, res, 'bench-store.mcp-decide', bench);
    if (!judged) return;
    const actor = auditActor(req, idOf(judged));
    if (!bench && !card) return res.status(404).json({ error: 'bench_not_found' });
    const slug = bench ? bench.slug : cardSlug(card!.workbench_id);
    try {
      const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : NaN;
      if (!Number.isInteger(id) || id < 1) throw new BenchError('not_found', '没有这条申请');
      const opening = !!card && req.body?.approve === true;
      // 开台库之前先把拒的情形都排除掉（还没碰「关注」的答复账）：不能登记台的 403；这条申请批不了的照常 404 / 409
      if (opening && !everywhere(judged, 'bench-store.bench-create')) return void forbid(res);
      if (opening) checkBenchRequest(slug, id, true);
      const answer = req.body?.approve === true ? 'approve' : req.body?.approve === false ? 'reject' : '';
      const via = answer ? await viaBegin(req, 'bench-mcp', `${req.params.bench}:${id}`, answer) : { ok: true as const, plan: null };
      if (!via.ok) return void res.status(via.status).json(via.body);
      let opened: { slug: string; title: string } | null = null;
      if (opening) {
        const b = createBench({ workbench_id: card!.workbench_id }, actor, Date.now());
        bench = b; opened = { slug: b.slug, title: b.title };
      }
      if (bench) await benchStore(slug);
      const out = await decideBenchRequest(slug, id, req.body?.approve, actor, req.body?.note, Date.now());
      const body = opened ? { ...(out as object), opened_bench: opened } : out;
      const remembered = await viaSettle(req, via.plan, 200, body, async (r) => ({ actor: await actorOf(r) }));
      res.json(remembered ? { ...(body as object), remember: remembered } : body);
    } catch (e) { fail(res, e); }
  }));

  // —— 留痕 ——
  app.get('/api/bench-views/:bench/log', { action: 'bench-store.log-list', kind: 'read', statusNotVerdict: NOT_VERDICT }, on('bench-store.log-list', async (_req, _res, s) => ({ changes: await s.changes(100), writes: await s.writes(100) })));
}