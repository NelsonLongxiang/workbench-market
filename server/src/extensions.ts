/**
 * 扩展挂载点：WM_EXTENSIONS_DIR 指向部署方的私有目录，启动时逐个加载其中的扩展；不设就什么都不加载。
 *
 * 目录形状：<WM_EXTENSIONS_DIR>/<扩展名>/
 *   - server.ts | server.mjs | server.js（可选）：导出 register(ctx)，启动时调用一次，可挂路由、注册待办来源、加登录回跳页；
 *   - web/index.tsx（可选）：前端页面与菜单项，由 web/vite.config.ts 在构建期并入（见 web/src/extensions.ts）。
 * 两者都没有的子目录、加载或 register 失败都**拒绝启动**并点名扩展与原因，不静默跳过。
 * 扩展不 import 本仓库模块：需要的宿主能力都经 ctx 给出（版本见 EXTENSION_API_VERSION）。
 *
 * 路由：经 ctx.routes.add 注册，报上动作（<扩展名>.<动词>）、类别和「谁能调」，和核心路由一样进动作清单。
 * 直接用 ctx.app（或别处拿到的 Express 应用）挂的照旧能跑，但每个扩展 register 前后对比路由栈，没报动作的逐条点名、计数；
 * WM_EXTENSION_ROUTES=enforce 时有这样的路由就拒绝启动。register 之后才挂的路由点不出来。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Express, Request, Response, NextFunction } from 'express';
import type { TaskEnvelope, SourceMeta } from './tasks.ts';
import type { Viewer } from './identity.ts';
import type { ActionKind, HttpService } from './http.ts';

/** 1 版。ctx.routes 是后来加的、只增不改的能力：扩展按有没有 ctx.routes 判断，不靠版本号（版本号不变，按 1 写死的旧扩展照常加载） */
export const EXTENSION_API_VERSION = 1;

/**
 * 扩展路由「谁能调」：只能从市场已有的口径里选，不能自造更宽的。
 *   anonymous 登录门关着时匿名也能调（和核心的开放读面、匿名提交面同类）；member 登录认出来的人；admin 管理员；owner 只有属主
 */
export type ExtensionWho = 'anonymous' | 'member' | 'admin' | 'owner';
export const EXTENSION_WHO: readonly ExtensionWho[] = ['anonymous', 'member', 'admin', 'owner'];
export type ExtensionRouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export interface ExtensionRouteSpec { action: string; kind: ActionKind; who: ExtensionWho; statusNotVerdict?: string }
export interface ExtensionRouteRecord { extension: string; method: ExtensionRouteMethod; path: string; action: string; kind: ActionKind; who: ExtensionWho; statusNotVerdict?: string }
export interface ExtensionUndeclared { extension: string; type: 'route' | 'middleware'; method: string; path: string }
/** 扩展经 routes.use 报了用途的中间件（不是路由，没有动作可报；用途进快照） */
export interface ExtensionMiddlewareRecord { extension: string; path: string; purpose: string }

/**
 * 扩展名不能用的名字：它也是扩展路径的首段（/api/<扩展名>/…、/<扩展名>/…），撞上核心的路径就会把核心的路由抢走
 * （扩展比一部分核心路由先挂）。这里是不在路由栈里、或者挂得比扩展晚的那几类：api 本身、前端页面的首段、
 * 内容面和资源的首段。核心路由栈里的首段另在全部注册完之后自动收集（assertExtensionNamespaces）。
 * 前端页面的首段和 web/src/App.tsx 对得上（scripts/extension-routes-smoke.mjs 核对，漂了就红）
 */
export const SPA_PAGE_SEGMENTS: readonly string[] = ['access', 'attention', 'cockpit', 'dev', 'knowledge', 'market', 'mcp-gateways', 'owner-pending', 'settings', 'sops', 'team', 'types', 'use', 'vault', 'work-items'];
/**
 * 退役的前端页面首段：页面删了，路径照样不给扩展用——旧书签点进来落到市场自己的「找不到」，不会落到某个扩展的页面上。
 * 以后再删页面，把它的首段从上面挪到这里（scripts/extension-routes-smoke.mjs 核对：页面 = 上面那份，保留 = 页面 ∪ 退役）
 */
export const RETIRED_PAGE_SEGMENTS: readonly string[] = [
  'overview', // 2026-11-12 退役：原来的总览（#646，旧页面删除清单第一批）
  'tasks', // 2026-11-12 退役：统一待办（旧页面删除清单第二批；发布任务由「安排一件事」取代）
  'reviews', // 2026-11-12 退役：审核（变更申请在全景的卡片上当场办）
  'skills', // 2026-11-14 退役：上一版的「技能市场」总表（属主：demo，没有用于生产）；技能在市场里一个技能一页（/market/skill/<标识>）
];
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['api', 'apps', 'go', 'sop', 'design', 'login', 'mcp', 'assets', 'static', 'openapi.json', '.well-known', '~wm', 'favicon.ico', 'index.html', ...SPA_PAGE_SEGMENTS, ...RETIRED_PAGE_SEGMENTS]);
/** 扩展路由的模式：warn 点名计数（缺省），enforce 有没报动作的扩展路由就拒绝启动（6d 切换时打开） */
export type ExtensionRoutesMode = 'warn' | 'enforce';
export function extensionRoutesMode(raw: string | undefined): ExtensionRoutesMode {
  const v = (raw ?? '').trim();
  if (v === '' || v === 'warn') return 'warn';
  if (v === 'enforce') return 'enforce';
  throw new Error(`WM_EXTENSION_ROUTES 只能是 warn 或 enforce（缺省 warn），现在是 ${JSON.stringify(v)}`);
}

const extRoutes: ExtensionRouteRecord[] = [];
const extUndeclared: ExtensionUndeclared[] = [];
const extMiddleware: ExtensionMiddlewareRecord[] = [];
/** 扩展加载期间新增的每一层（报了的、没报的都在）：收集核心路径首段时排除它们 */
const extensionLayers = new Set<unknown>();
/** 经 routes.use 报了用途的中间件层 */
const declaredMiddlewareLayers = new Set<unknown>();
/** 扩展报了用途的中间件 */
export function extensionMiddleware(): ExtensionMiddlewareRecord[] { return extMiddleware.map((r) => ({ ...r })); }
/** 扩展经 ctx.routes.add 报的路由和动作（快照 --extensions 和判定读它） */
export function extensionRoutes(): ExtensionRouteRecord[] { return extRoutes.map((r) => ({ ...r })); }
/** 扩展没报动作的路由和中间件（register 前后对比路由栈点出来的） */
export function extensionUndeclared(): ExtensionUndeclared[] { return extUndeclared.map((r) => ({ ...r })); }
/** 一个动作是不是扩展报的；是的话给出它声明的类别和谁能调 */
export function extensionAction(action: string): ExtensionRouteRecord | undefined { return extRoutes.find((r) => r.action === action); }

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
/** 扩展注册一条路由前的检查：都在注册之前做，不合格抛错（加载失败，拒绝启动并点名） */
function checkExtensionRoute(name: string, method: string, path: unknown, spec: ExtensionRouteSpec): void {
  const where = `扩展 ${name} 的 ${String(method).toUpperCase()} ${String(path)}`;
  if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) throw new Error(`${where}：方法只能是 get / post / put / patch / delete`);
  if (typeof path !== 'string') throw new Error(`${where}：路径要是字符串（不收正则和数组）`);
  const ownPath = path === `/api/${name}` || path.startsWith(`/api/${name}/`) || path === `/${name}` || path.startsWith(`/${name}/`);
  if (!ownPath) throw new Error(`${where}：路径只能在 /api/${name}/… 或 /${name}/… 下，不能挂到宿主或别的扩展的命名空间`);
  if (!spec || typeof spec !== 'object') throw new Error(`${where}：第三个参数要是 { action, kind, who }`);
  // 和核心一样只有一个点：<扩展名>.<动词>，动词里要分段用连字符（lifecycle.board-read）
  if (typeof spec.action !== 'string' || !spec.action.startsWith(`${name}.`) || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(spec.action)) {
    throw new Error(`${where}：动作名要以「${name}.」开头，写成 ${name}.<动词>（动词里分段用连字符，比如 ${name}.board-read）`);
  }
  if (!EXTENSION_WHO.includes(spec.who)) throw new Error(`${where}：who 只能是 ${EXTENSION_WHO.join(' / ')}（市场已有的口径）`);
  if (WRITE_METHODS.has(method) && spec.kind === 'read') throw new Error(`${where}：${method.toUpperCase()} 是会写的方法，不能报成 read`);
  if (spec.kind === 'admin' && spec.who !== 'admin' && spec.who !== 'owner') throw new Error(`${where}：管理类只能给 admin 或 owner`);
  if (spec.who === 'anonymous' && spec.kind !== 'read' && spec.kind !== 'write') throw new Error(`${where}：who=anonymous 只能配 read 或 write`);
  if (spec.statusNotVerdict !== undefined && (typeof spec.statusNotVerdict !== 'string' || !spec.statusNotVerdict.trim() || spec.statusNotVerdict.length > 120)) {
    throw new Error(`${where}：statusNotVerdict 要写原因（1～120 字）`);
  }
  const same = extRoutes.find((r) => r.action === spec.action);
  if (same && (same.who !== spec.who || same.kind !== spec.kind)) throw new Error(`${where}：动作 ${spec.action} 在 ${same.method.toUpperCase()} ${same.path} 报的是 ${same.kind}/${same.who}，同一个动作要一致`);
}

/**
 * 启动收尾时核对：扩展名（也就是它的动作前缀）不能和核心动作的域重名，否则扩展的动作会和核心的混在一起。
 * 核心路由有的在扩展之后才注册，所以在全部注册完之后再核一次。不合格抛错（调用方拒绝启动）
 */
export function assertExtensionNamespaces(coreActions: readonly { action: string }[], stackLayers: readonly unknown[] = []): void {
  const extNames = new Set(loadedNames);
  // 先核路径首段（抢走核心路由是更直接的后果），再核动作的域：一个名字两样都撞时报路径那一条
  const segments = corePathSegments(stackLayers);
  for (const n of extNames) if (RESERVED_SEGMENTS.has(n) || segments.has(n)) throw new Error(`扩展名 ${n} 和核心的路径首段重名（/${n}/…）：扩展会抢走核心的路由，改扩展目录名`);
  const core = new Set(coreActions.map((a) => a.action).filter((a) => !extRoutes.some((r) => r.action === a)).map((a) => a.split('.')[0]));
  for (const n of extNames) if (core.has(n)) throw new Error(`扩展名 ${n} 和核心动作的域重名：改扩展目录名（它也是动作前缀）`);
}

/** 核心路由栈里每一层的路径首段：路由取路径字符串，中间件和挂载点取正则开头的那段字面量。扩展加的层不算 */
function corePathSegments(stackLayers: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const layer of stackLayers) {
    if (extensionLayers.has(layer)) continue;
    const l = layer as { route?: { path?: unknown }; regexp?: { source?: string } };
    const paths = l.route ? (Array.isArray(l.route.path) ? l.route.path : [l.route.path]) : [];
    for (const p of paths) { const m = typeof p === 'string' ? /^\/([^/:*?()]+)/.exec(p) : null; if (m) out.add(m[1].toLowerCase()); }
    if (!l.route && typeof l.regexp?.source === 'string') { const m = /^\^\\\/([a-z0-9~._-]+)/i.exec(l.regexp.source); if (m) out.add(m[1].replace(/\\/g, '').toLowerCase()); }
  }
  return out;
}
const loadedNames: string[] = [];
const SERVER_ENTRIES = ['server.ts', 'server.mjs', 'server.js'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 待办来源（统一待办 /api/tasks 的扩展点）：按请求现取，失败降级成 ok:false，不阻塞其它来源 */
export interface TaskSourceResult { meta: SourceMeta & Record<string, unknown>; tasks: TaskEnvelope[] }
export interface TaskSource {
  /** 来源键：小写字母开头，[a-z0-9-]，不得与内置来源（ygl-trees、market、a2a）重名 */
  key: string;
  /** 页面上显示的来源名 */
  label: string;
  /** antd Tag 颜色名，缺省 default */
  color?: string;
  collect(req: Request): Promise<TaskSourceResult>;
}

export interface ExtensionContext {
  apiVersion: typeof EXTENSION_API_VERSION;
  name: string;
  dir: string;
  /** 挂路由用；挂在宿主的身份/写门之后、SPA 回落之前。新写的路由请用 routes.add（报动作）；直接挂的会被点名为「没报动作」 */
  app: Express;
  /** 注册一条报了动作的路由：路径在 /api/<扩展名>/… 或 /<扩展名>/… 下，动作名 <扩展名>.<动词>，who 从市场已有口径里选。返回撤销函数 */
  routes: {
    add: (method: ExtensionRouteMethod, path: string, spec: ExtensionRouteSpec, ...handlers: ((req: Request, res: Response, next: NextFunction) => unknown)[]) => () => void;
    /** 挂一个中间件（不是路由，没有动作可报）：路径在自己的命名空间下，写明用途（进快照）。不经它挂的中间件、子路由器算没报的 */
    use: (path: string, spec: { purpose: string }, ...handlers: ((req: Request, res: Response, next: NextFunction) => unknown)[]) => void;
  };
  /** 包 async 路由：抛错交给宿主统一的错误处理 */
  wrap: (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void;
  /** 管理员门（口令或 Odoo 管理员）：未通过时已写好响应并返回 false */
  adminGuard: (req: Request, res: Response) => Promise<boolean>;
  odoo: {
    url: () => string;
    sessionOf: (cookieHeader: string) => string | null;
    resolveViewer: (cookieHeader: string) => Promise<{ ok: true; viewer: Viewer } | { ok: false; http: number; error: string }>;
    /** 门户 Odoo 登录入口（/go/<Odoo 台>/?return=…）；returnPath 须先经 addReturnPath 登记 */
    loginUrl: (req: Request, returnPath: string) => string | null;
    addReturnPath: (path: string) => void;
  };
  tasks: { addSource: (src: TaskSource) => void };
  /** 业务写面：远程浏览器 POST 该精确路径不经宿主管理写门（不要口令、不查 Odoo 管理员），由扩展路由自己判身份与同源。
   *  只收 /api/<命名空间>/…，命名空间不得是宿主的；进 S3 豁免面快照（/api/remote-allow/diff） */
  remoteWrite: { allowExact: (path: string) => void };
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export type ExtensionHost = Omit<ExtensionContext, 'apiVersion' | 'name' | 'dir' | 'log' | 'warn' | 'tasks' | 'routes'> & {
  /** 经它注册扩展的路由、对比路由栈 */
  http: HttpService;
  routesMode: ExtensionRoutesMode;
};

const BUILTIN_SOURCES = new Set(['ygl-trees', 'market', 'a2a']);
const taskSources: TaskSource[] = [];

function addTaskSource(owner: string, src: TaskSource): void {
  if (!src || typeof src.collect !== 'function') throw new Error(`扩展 ${owner} 的待办来源缺 collect()`);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(src.key)) || BUILTIN_SOURCES.has(src.key)) throw new Error(`扩展 ${owner} 的待办来源键非法或与内置来源重名：${String(src.key)}`);
  if (taskSources.some((s) => s.key === src.key)) throw new Error(`待办来源 ${src.key} 已被注册`);
  if (typeof src.label !== 'string' || !src.label.trim()) throw new Error(`扩展 ${owner} 的待办来源 ${src.key} 缺 label`);
  taskSources.push(src);
}

/** 统一待办：逐个调扩展来源；抛错按 ok:false 降级（错误细节只进日志，不回给查看人） */
export async function collectExtensionTasks(req: Request): Promise<{ tasks: TaskEnvelope[]; sources: Record<string, Record<string, unknown>> }> {
  const tasks: TaskEnvelope[] = [];
  const sources: Record<string, Record<string, unknown>> = {};
  for (const s of taskSources) {
    const t0 = Date.now();
    const deco = { label: s.label, color: s.color ?? 'default' };
    try {
      const r = await s.collect(req);
      const own = (r?.tasks ?? []).filter((t) => t && t.source === s.key);
      tasks.push(...own);
      sources[s.key] = { ...r.meta, ...deco };
    } catch (e) {
      console.warn(`[extensions] 待办来源 ${s.key} 失败：${String((e as Error)?.message ?? e).slice(0, 200)}`);
      sources[s.key] = { ok: false, count: 0, latency_ms: Date.now() - t0, error: `${s.key}_source_unavailable`, ...deco };
    }
  }
  return { tasks, sources };
}

export function extensionTaskSourceKeys(): string[] {
  return taskSources.map((s) => s.key);
}

/** 启动时加载：dir 为空 → []；目录不对、入口缺失、加载或 register 失败 → 抛错（调用方拒绝启动） */
export async function loadExtensions(dirRaw: string | undefined, host: ExtensionHost): Promise<string[]> {
  const dir = String(dirRaw ?? '').trim();
  if (!dir) return [];
  if (!isAbsolute(dir)) throw new Error(`WM_EXTENSIONS_DIR 须为绝对路径：${dir}`);
  let st;
  try { st = statSync(dir); } catch { throw new Error(`WM_EXTENSIONS_DIR 不存在：${dir}`); }
  if (!st.isDirectory()) throw new Error(`WM_EXTENSIONS_DIR 不是目录：${dir}`);
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
  const loaded: string[] = [];
  for (const name of names) {
    const extDir = join(dir, name);
    if (!NAME_RE.test(name)) throw new Error(`扩展目录名非法（须 [a-z0-9-]）：${name}`);
    const entry = SERVER_ENTRIES.map((f) => join(extDir, f)).find((f) => existsSync(f));
    if (!entry) {
      if (existsSync(join(extDir, 'web', 'index.tsx'))) { loaded.push(name); continue; } // 只有前端部分
      throw new Error(`扩展 ${name} 没有 ${SERVER_ENTRIES.join(' / ')}，也没有 web/index.tsx`);
    }
    let mod: { register?: unknown };
    try { mod = await import(pathToFileURL(entry).href); } catch (e) { throw new Error(`扩展 ${name} 加载失败（${entry}）：${String((e as Error)?.message ?? e).slice(0, 300)}`); }
    if (typeof mod.register !== 'function') throw new Error(`扩展 ${name} 未导出 register(ctx)：${entry}`);
    const { http, routesMode, ...shared } = host;
    const ctx: ExtensionContext = {
      ...shared, apiVersion: EXTENSION_API_VERSION, name, dir: extDir,
      tasks: { addSource: (src) => addTaskSource(name, src) },
      routes: {
        add: (method, path, spec, ...handlers) => {
          checkExtensionRoute(name, method, path, spec);
          const revoke = http.route(method, path, { action: spec.action, kind: spec.kind }, ...(handlers as never[]));
          const record: ExtensionRouteRecord = { extension: name, method, path, action: spec.action, kind: spec.kind, who: spec.who, ...(spec.statusNotVerdict ? { statusNotVerdict: spec.statusNotVerdict } : {}) };
          extRoutes.push(record);
          return () => { revoke(); const i = extRoutes.indexOf(record); if (i >= 0) extRoutes.splice(i, 1); };
        },
        use: (path, spec, ...handlers) => {
          const where = `扩展 ${name} 的中间件 ${String(path)}`;
          if (typeof path !== 'string' || !(path === `/api/${name}` || path.startsWith(`/api/${name}/`) || path === `/${name}` || path.startsWith(`/${name}/`))) {
            throw new Error(`${where}：只能挂在 /api/${name}/… 或 /${name}/… 下`);
          }
          if (!spec || typeof spec.purpose !== 'string' || !spec.purpose.trim() || spec.purpose.length > 120) throw new Error(`${where}：要写明用途（purpose，1～120 字）`);
          if (handlers.length === 0) throw new Error(`${where}：没有处理函数`);
          const before = new Set(http.stackLayers());
          (shared.app as unknown as { use: (p: string, ...h: unknown[]) => unknown }).use(path, ...handlers);
          for (const layer of http.stackLayers()) if (!before.has(layer)) declaredMiddlewareLayers.add(layer);
          extMiddleware.push({ extension: name, path, purpose: spec.purpose });
        },
      },
      log: (m) => console.log(`[ext:${name}] ${m}`),
      warn: (m) => console.warn(`[ext:${name}] ${m}`),
    };
    if (RESERVED_SEGMENTS.has(name)) throw new Error(`扩展名 ${name} 和核心的路径首段重名（/${name}/…）：扩展会抢走核心的路由，改扩展目录名`);
    const already = corePathSegments(http.stackLayers());
    if (already.has(name)) throw new Error(`扩展名 ${name} 和核心的路径首段重名（/${name}/…）：扩展会抢走核心的路由，改扩展目录名`);
    loadedNames.push(name);
    const before = new Set(http.stackLayers());
    try { await (mod.register as (c: ExtensionContext) => unknown)(ctx); } catch (e) { throw new Error(`扩展 ${name} 的 register 失败：${String((e as Error)?.message ?? e).slice(0, 300)}`); }
    // register 前后对比路由栈：新增的层里，没经 routes.add 报动作的逐条点名（经 req.app 等别处拿到的应用挂的也点得出）
    for (const layer of http.stackLayers()) {
      if (before.has(layer)) continue;
      extensionLayers.add(layer);
      if (http.declaredLayer(layer) || declaredMiddlewareLayers.has(layer)) continue;
      const l = layer as { route?: { path?: unknown; methods?: Record<string, boolean> }; regexp?: unknown; name?: string };
      const item: ExtensionUndeclared = l.route
        ? { extension: name, type: 'route', method: Object.keys(l.route.methods ?? {}).join(',').toUpperCase() || 'ALL', path: String(l.route.path) }
        : { extension: name, type: 'middleware', method: 'USE', path: String(l.regexp ?? l.name ?? '') };
      extUndeclared.push(item);
      console.warn(JSON.stringify({ source: 'extensions', event: item.type === 'route' ? 'route-undeclared' : 'middleware-added', extension: name, method: item.method, path: item.path }));
    }
    loaded.push(name);
  }
  // 没报的路由、没报用途的中间件（含子路由器：它里面的路由看不见，整层算没报）都算：中间件一样能直接应答
  if (extUndeclared.length) {
    const routes = extUndeclared.filter((u) => u.type === 'route').length, mws = extUndeclared.length - routes;
    console.warn(`[extensions] 扩展没报的层：路由 ${routes} 条、中间件或子路由器 ${mws} 个（${[...new Set(extUndeclared.map((u) => u.extension))].join('、')}）；路由改用 ctx.routes.add 报动作，中间件改用 ctx.routes.use 写明用途`);
    if (host.routesMode === 'enforce') throw new Error(`WM_EXTENSION_ROUTES=enforce：扩展有 ${extUndeclared.length} 处没报（路由 ${routes} 条、中间件或子路由器 ${mws} 个：${extUndeclared.slice(0, 5).map((u) => `${u.extension} ${u.method} ${u.path}`).join('；')}）`);
  }
  return loaded;
}
