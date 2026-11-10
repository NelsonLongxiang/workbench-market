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
 * 访问类别和动作声明先不引入：那一步等身份与判定就位之后再加。现在每条路由原有的守卫写法保持不变。
 */
import express from 'express';
import { Service, type Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    http: HttpService;
  }
}

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'all';
export type RoutePath = string | RegExp | Array<string | RegExp>;
type Handler = express.RequestHandler;

/** Express 4 路由栈里的一层。这是它的内部结构，这里只读 route、只换 stack。 */
type Layer = { route?: { path: unknown } };
type Router = { stack: Layer[] };

function routerOf(app: express.Express): Router {
  const router = (app as unknown as { _router?: Router })._router;
  if (!router || !Array.isArray(router.stack)) throw new Error('http：取不到 Express 的路由栈（这个服务是按 Express 4 的内部结构写的）');
  return router;
}

const describe = (path: RoutePath): string => (Array.isArray(path) ? path.map(String).join(' | ') : String(path));

export class HttpService extends Service {
  // Express 应用本身是个函数。Cordis 把服务交出去时，会给值是函数的属性包一层代理，所以放在一个普通对象里，拿到的才是应用本身。
  private readonly held = { app: express() };

  constructor(ctx: Context) {
    super(ctx, 'http');
  }

  /** Express 应用本身：全局中间件、监听、还没搬走的路由用它。域模块不直接用它，经下面的方法注册路由。 */
  expressApp(): express.Express {
    return this.held.app;
  }

  /** 注册一条路由，参数同 Express：`http.route('get', '/api/x', handler)`。挂在调用方的作用域上，返回撤销函数。 */
  route(method: RouteMethod, path: RoutePath, ...handlers: Handler[]): () => void {
    const app = this.held.app;
    // 不带处理函数的 app.get(x) 在 Express 里是读配置项，不是注册路由
    if (handlers.length === 0) throw new Error(`http：${method.toUpperCase()} ${describe(path)} 没有处理函数`);
    const revoke = this.ctx.effect(() => {
      (app as unknown as Record<RouteMethod, (path: RoutePath, ...handlers: Handler[]) => unknown>)[method](path, ...handlers);
      // Express 每注册一条路由，就往栈尾压一层；记下这一层，撤销时只摘它
      const stack = routerOf(app).stack;
      const layer = stack[stack.length - 1];
      if (!layer?.route || layer.route.path !== path) throw new Error(`http：注册 ${method.toUpperCase()} ${describe(path)} 之后，栈尾不是这条路由`);
      return () => {
        // 换一个新数组，不在原数组上删：正在处理中的请求拿着的是旧数组，下标不会错位
        const router = routerOf(app);
        router.stack = router.stack.filter((l) => l !== layer);
      };
    }, `ctx.http.${method}(${describe(path)})`);
    return () => { void revoke(); };
  }

  get(path: RoutePath, ...handlers: Handler[]): () => void { return this.route('get', path, ...handlers); }
  post(path: RoutePath, ...handlers: Handler[]): () => void { return this.route('post', path, ...handlers); }
  put(path: RoutePath, ...handlers: Handler[]): () => void { return this.route('put', path, ...handlers); }
  patch(path: RoutePath, ...handlers: Handler[]): () => void { return this.route('patch', path, ...handlers); }
  delete(path: RoutePath, ...handlers: Handler[]): () => void { return this.route('delete', path, ...handlers); }
  all(path: RoutePath, ...handlers: Handler[]): () => void { return this.route('all', path, ...handlers); }
}
