/**
 * HTTP 服务（Cordis 服务 `http`）：持有 Express 应用；域模块经它注册路由，注册可以撤销。
 *
 * 路由照旧直接挂在 Express 应用自己的路由栈上：同一个栈，挂在调用那一刻的位置，处理函数原样传入、不包装。
 * 所以经它注册和直接写 `app.get(...)` 对外没有区别，路由快照（surfaces/routes.json）不变。
 *
 * 每次注册是调用方上下文里的一个 effect：
 *   · 返回撤销函数；
 *   · 调用方是插件（`ctx.http.get(...)`）时，插件卸载会自动撤销它注册的全部路由。
 * 撤销就是把这次挂上去的那一层从路由栈里摘掉，之后的请求当它从没注册过。
 *
 * 动作登记（阶段六 6a）：经它注册的每条路由都要报上动作名和类别，`http.post('/api/x', { action: 'x.create', kind: 'admin' }, handler)`。
 *   · 动作名写成 `<域>.<动词>`（小写字母、数字、连字符，中间一个点）；类别四种：read 读、write 写、decide 决定、admin 管理。
 *   · 没报、报得不合形状、同一个动作这次和别处报的类别不一样：注册不上（抛错），不悄悄放过。
 *   · 动作记在这条路由上（Express 的路由对象多一个只读属性），处理函数照旧原样传入，对外行为不变；
 *     快照把它导出成 surfaces/actions.json，和路由快照一行对一行。
 *   · 这一步只登记，不判定：现在每条路由原有的守卫写法保持不变。判定在 6c。
 * 还直接挂在 Express 应用上的存量路由没有动作，搬进域模块时补；在那之前体检按文件记预算，只减不增。
 */
import express from 'express';
import { Service, type Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    http: HttpService;
  }
}

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'all';
export type ActionKind = 'read' | 'write' | 'decide' | 'admin';
export const ACTION_KINDS: readonly ActionKind[] = ['read', 'write', 'decide', 'admin'];
/** 一条路由报上的动作：`<域>.<动词>` 和类别 */
export type ActionSpec = {
  readonly action: string; readonly kind: ActionKind;
  /**
   * 这条路由回的 401/403 不是授权结论（阶段六 6c）：比如资源状态（已下架）、URL 准入、验签、「你是谁」。
   * 写一句原因；判定的并行比对不拿这条路由的状态码当旧结论比，单列计数。逐条路由声明，不按前缀一揽子声明。
   */
  readonly statusNotVerdict?: string;
  /**
   * 同一条路由上按请求细分的动作（阶段六 6c）：比如带 reveal=1 的导出要管理员、某一个台的发布要管理员。
   * 按顺序取第一个 when 成立的，取不到用上面的动作。when 只看请求和请求进来时的事实，不改请求。逐条写原因，进快照。
   */
  readonly refine?: readonly ActionRefinement[];
};
/** 请求进来时的事实（判定比对在请求进来时取，请求本身可能改掉它们） */
export type RequestFacts = { adminTokenSet: boolean };
export type ActionRefinement = { readonly action: string; readonly kind: ActionKind; readonly why: string; readonly when: (req: express.Request, facts: RequestFacts) => boolean };
/** 登记过的一条：哪条路由、什么动作 */
export type RegisteredAction = { method: RouteMethod; path: string; action: string; kind: ActionKind };
export const ACTION_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,47}$/;
/** 动作挂在 Express 路由对象上的键（快照的录制钩子按这个名字读） */
export const ACTION_KEY = 'wmAction';
export type RoutePath = string | RegExp | Array<string | RegExp>;
type Handler = express.RequestHandler;

/** Express 4 路由栈里的一层。这是它的内部结构，这里只读 route、只换 stack。 */
type Layer = { route?: { path: unknown; [ACTION_KEY]?: ActionSpec } };
type Router = { stack: Layer[] };

function routerOf(app: express.Express): Router {
  const router = (app as unknown as { _router?: Router })._router;
  if (!router || !Array.isArray(router.stack)) throw new Error('http：取不到 Express 的路由栈（这个服务是按 Express 4 的内部结构写的）');
  return router;
}

const describe = (path: RoutePath): string => (Array.isArray(path) ? path.map(String).join(' | ') : String(path));

/** 动作声明的形状：不对就抛，说清楚哪条路由、哪里不对 */
function checkSpec(method: RouteMethod, path: RoutePath, spec: unknown): ActionSpec {
  const where = `${method.toUpperCase()} ${describe(path)}`;
  if (typeof spec === 'function' || !spec || typeof spec !== 'object') throw new Error(`http：${where} 没有报动作（第二个参数要是 { action, kind }）`);
  const { action, kind } = spec as { action?: unknown; kind?: unknown };
  if (typeof action !== 'string' || !ACTION_RE.test(action)) throw new Error(`http：${where} 的动作名「${String(action)}」不对，要写成 <域>.<动词>`);
  if (typeof kind !== 'string' || !(ACTION_KINDS as readonly string[]).includes(kind)) throw new Error(`http：${where} 的动作类别「${String(kind)}」不对，只能是 ${ACTION_KINDS.join('、')}`);
  const snv = (spec as { statusNotVerdict?: unknown }).statusNotVerdict;
  if (snv !== undefined && (typeof snv !== 'string' || !snv.trim() || snv.length > 120 || /[\x00-\x1f\x7f]/.test(snv))) throw new Error(`http：${where} 的 statusNotVerdict 要写一句原因（1～120 个字符）`);
  const refine = (spec as { refine?: unknown }).refine;
  if (refine !== undefined) {
    if (!Array.isArray(refine) || refine.length === 0) throw new Error(`http：${where} 的 refine 要是非空数组`);
    for (const r of refine as { action?: unknown; kind?: unknown; why?: unknown; when?: unknown }[]) {
      if (typeof r?.action !== 'string' || !ACTION_RE.test(r.action)) throw new Error(`http：${where} 细分的动作名「${String(r?.action)}」不对`);
      if (typeof r.kind !== 'string' || !(ACTION_KINDS as readonly string[]).includes(r.kind)) throw new Error(`http：${where} 细分的动作类别「${String(r.kind)}」不对`);
      if (typeof r.why !== 'string' || !r.why.trim() || r.why.length > 120) throw new Error(`http：${where} 细分的动作 ${r.action} 要写一句原因`);
      if (typeof r.when !== 'function') throw new Error(`http：${where} 细分的动作 ${r.action} 要有 when`);
    }
  }
  return Object.freeze({ action, kind: kind as ActionKind, ...(snv !== undefined ? { statusNotVerdict: snv as string } : {}), ...(refine !== undefined ? { refine: Object.freeze([...(refine as ActionRefinement[])]) } : {}) });
}

export class HttpService extends Service {
  // Express 应用本身是个函数。Cordis 把服务交出去时，会给值是函数的属性包一层代理，所以放在一个普通对象里，拿到的才是应用本身。
  private readonly held = { app: express() };
  /** 现在挂着的每条路由报的动作（撤销时一起去掉） */
  private readonly registered = new Map<Layer, RegisteredAction>();
  /** 细分的动作（refine），按路由那一层记，撤销时一起去掉 */
  private refined: { layer: Layer; entry: RegisteredAction }[] = [];

  constructor(ctx: Context) {
    super(ctx, 'http');
  }

  /** Express 应用本身：全局中间件、监听、还没搬走的路由用它。域模块不直接用它，经下面的方法注册路由。 */
  expressApp(): express.Express {
    return this.held.app;
  }

  /** 现在登记着的动作，按注册顺序 */
  actions(): RegisteredAction[] {
    return [...this.registered.values(), ...this.refined.map((v) => v.entry)].map((a) => ({ ...a }));
  }

  /** Express 路由栈现在的各层（只读快照）：扩展加载前后对比用，点出没经这里注册、没报动作的路由 */
  stackLayers(): readonly unknown[] {
    return [...routerOf(this.held.app).stack];
  }

  /** 这一层是不是经这里注册、报了动作的路由 */
  declaredLayer(layer: unknown): RegisteredAction | undefined {
    const hit = this.registered.get(layer as Layer);
    return hit ? { ...hit } : undefined;
  }

  /**
   * 注册一条路由：`http.route('get', '/api/x', { action: 'x.read', kind: 'read' }, handler)`。处理函数同 Express。
   * 挂在调用方的作用域上，返回撤销函数。没报动作、动作不合形状、同一个动作和已登记的类别不同：抛错，注册不上。
   */
  route(method: RouteMethod, path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void {
    const app = this.held.app;
    const declared = checkSpec(method, path, spec);
    // 不带处理函数的 app.get(x) 在 Express 里是读配置项，不是注册路由
    if (handlers.length === 0) throw new Error(`http：${method.toUpperCase()} ${describe(path)} 没有处理函数`);
    for (const mine of [declared, ...(declared.refine ?? [])]) {
      for (const other of [...this.registered.values(), ...this.refined.map((v) => v.entry)]) {
        if (other.action === mine.action && other.kind !== mine.kind) {
          throw new Error(`http：${method.toUpperCase()} ${describe(path)} 报的动作 ${mine.action} 是 ${mine.kind}，${other.method.toUpperCase()} ${other.path} 报的同一个动作是 ${other.kind}`);
        }
      }
    }
    const revoke = this.ctx.effect(() => {
      (app as unknown as Record<RouteMethod, (path: RoutePath, ...handlers: Handler[]) => unknown>)[method](path, ...handlers);
      // Express 每注册一条路由，就往栈尾压一层；记下这一层，撤销时只摘它
      const stack = routerOf(app).stack;
      const layer = stack[stack.length - 1];
      if (!layer?.route || layer.route.path !== path) throw new Error(`http：注册 ${method.toUpperCase()} ${describe(path)} 之后，栈尾不是这条路由`);
      Object.defineProperty(layer.route, ACTION_KEY, { value: declared, enumerable: false });
      this.registered.set(layer, { method, path: describe(path), action: declared.action, kind: declared.kind });
      for (const r of declared.refine ?? []) this.refined.push({ layer, entry: { method, path: describe(path), action: r.action, kind: r.kind } });
      return () => {
        // 换一个新数组，不在原数组上删：正在处理中的请求拿着的是旧数组，下标不会错位
        const router = routerOf(app);
        router.stack = router.stack.filter((l) => l !== layer);
        this.registered.delete(layer);
        this.refined = this.refined.filter((v) => v.layer !== layer);
      };
    }, `ctx.http.${method}(${describe(path)})`);
    return () => { void revoke(); };
  }

  get(path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void { return this.route('get', path, spec, ...handlers); }
  post(path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void { return this.route('post', path, spec, ...handlers); }
  put(path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void { return this.route('put', path, spec, ...handlers); }
  patch(path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void { return this.route('patch', path, spec, ...handlers); }
  delete(path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void { return this.route('delete', path, spec, ...handlers); }
  all(path: RoutePath, spec: ActionSpec, ...handlers: Handler[]): () => void { return this.route('all', path, spec, ...handlers); }
}
