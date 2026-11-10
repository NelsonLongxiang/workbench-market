/**
 * 扩展挂载点：WM_EXTENSIONS_DIR 指向部署方的私有目录，启动时逐个加载其中的扩展；不设就什么都不加载。
 *
 * 目录形状：<WM_EXTENSIONS_DIR>/<扩展名>/
 *   - server.ts | server.mjs | server.js（可选）：导出 register(ctx)，启动时调用一次，可挂路由、注册待办来源、加登录回跳页；
 *   - web/index.tsx（可选）：前端页面与菜单项，由 web/vite.config.ts 在构建期并入（见 web/src/extensions.ts）。
 * 两者都没有的子目录、加载或 register 失败都**拒绝启动**并点名扩展与原因，不静默跳过。
 * 扩展不 import 本仓库模块：需要的宿主能力都经 ctx 给出（版本见 EXTENSION_API_VERSION）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Express, Request, Response, NextFunction } from 'express';
import type { TaskEnvelope, SourceMeta } from './tasks.ts';
import type { Viewer } from './identity.ts';

export const EXTENSION_API_VERSION = 1;
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
  /** 挂路由用；挂在宿主的身份/写门之后、SPA 回落之前 */
  app: Express;
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

export type ExtensionHost = Omit<ExtensionContext, 'apiVersion' | 'name' | 'dir' | 'log' | 'warn' | 'tasks'>;

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
    const ctx: ExtensionContext = {
      ...host, apiVersion: EXTENSION_API_VERSION, name, dir: extDir,
      tasks: { addSource: (src) => addTaskSource(name, src) },
      log: (m) => console.log(`[ext:${name}] ${m}`),
      warn: (m) => console.warn(`[ext:${name}] ${m}`),
    };
    try { await (mod.register as (c: ExtensionContext) => unknown)(ctx); } catch (e) { throw new Error(`扩展 ${name} 的 register 失败：${String((e as Error)?.message ?? e).slice(0, 300)}`); }
    loaded.push(name);
  }
  return loaded;
}
