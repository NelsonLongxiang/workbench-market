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
export type ActionSpec = { readonly action: string; readonly kind: ActionKind };
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
  return Object.freeze({ action, kind: kind as ActionKind });
}

export class HttpService extends Service {
  // Express 应用本身是个函数。Cordis 把服务交出去时，会给值是函数的属性包一层代理，所以放在一个普通对象里，拿到的才是应用本身。
  private readonly held = { app: express() };
  /** 现在挂着的每条路由报的动作（撤销时一起去掉） */
  private readonly registered = new Map<Layer, RegisteredAction>();

  constructor(ctx: Context) {
    super(ctx, 'http');
  }

  /** Express 应用本身：全局中间件、监听、还没搬走的路由用它。域模块不直接用它，经下面的方法注册路由。 */
  expressApp(): express.Express {
    return this.held.app;
  }

  /** 现在登记着的动作，按注册顺序 */
  actions(): RegisteredAction[] {
    return [...this.registered.values()].map((a) => ({ ...a }));
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
    for (const other of this.registered.values()) {
      if (other.action === declared.action && other.kind !== declared.kind) {
        throw new Error(`http：${method.toUpperCase()} ${describe(path)} 报的动作 ${declared.action} 是 ${declared.kind}，${other.method.toUpperCase()} ${other.path} 报的同一个动作是 ${other.kind}`);
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
      return () => {
        // 换一个新数组，不在原数组上删：正在处理中的请求拿着的是旧数组，下标不会错位
        const router = routerOf(app);
        router.stack = router.stack.filter((l) => l !== layer);
        this.registered.delete(layer);
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
