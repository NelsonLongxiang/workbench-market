// #336 工作台变量与常量：每个登记台（自产台 / SOP 台 / 外部 Web 台 / Odoo 台）按 workbench id 各有一份键值空间，供看板读写。
//   · 持久化只用 SQLite（workbench_vars），写入返回即已落库；不经 Redis，也就没有「缓存写成功 ≠ 持久化成功」的歧义。
//   · 并发：乐观锁。每次写 revision +1；改/删已存在的键必须带期望 revision（If-Match 或 revision 参数），不符 409 并回当前 revision。
//     新建时可带 revision=0 表示「只在不存在时创建」；不带也行（撞上并发创建同样 409）。
//   · 常量 kind=const：写入后不能改、不能删；管理员（含本机命令行）显式带 override 才能修订，留审计（审计只记值的 sha256）。
//   · 读写口径：本机命令行 / 管理员（口令或 Odoo 管理员）可读写任意台；自产台、SOP 台页面凭本台 X-App-Token 只能读写本台；
//     外部台没有按台令牌，只有管理员能读写。匿名一律 403。
import { createHash, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { db } from './db.ts';
import { svc } from './context.ts';
import { HttpError } from './errors.ts';
import { browserMarked, rawLoopback } from './surfaces.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { WorkbenchVarsService, WorkbenchVarRow } from './services/workbench-vars.ts';

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KEYS_PER_WORKBENCH = 512;
const PATH_RE = /^\/api\/workbenches\/(\d{1,12})\/vars(?:\/|$)/i;

export type WorkbenchClass = 'app' | 'sop' | 'external';
type Scope = { id: number; cls: WorkbenchClass; slug: string | null };
/** 调用方：admin=true 才能修订常量（本机命令行与管理员）；按台令牌与 MCP 会话都是 false */
type Caller = { actor: string; admin: boolean };

export type WorkbenchVarsDeps = {
  /** 按台令牌（index.ts 的 wmAppToken） */
  appToken: (slug: string) => string;
  /** 按需认定 Odoo 管理员（写门/读面判管理员前调用） */
  markOdooAdmin: (req: express.Request) => Promise<void>;
  /** 管理读门（与凭据库同口径：同源页面 GET 也要管理员） */
  adminRead: (req: express.Request, res: express.Response) => boolean;
  /** 管理写门（口令或 Odoo 管理员 + 同源） */
  adminWrite: (req: express.Request, res: express.Response) => boolean;
};

const vars = () => svc<WorkbenchVarsService>('workbenchVars');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function tokenEq(a: string, b: string): boolean {
  return a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** 台分类：market-app 的 /apps/<slug>/ 是自产台、/sop/<slug>/ 是 SOP 台；其余（Web、Odoo 等）都是外部台 */
export function workbenchScope(id: number): Scope {
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'workbench id 必须是正整数');
  const row = svc<WorkbenchService>('workbench').byId(id) as { id: number; url: string; type: string } | undefined;
  if (!row) throw new HttpError(404, `workbench not found: ${id}`);
  const m = row.type === 'market-app' ? /^\/(apps|sop)\/([a-z0-9][a-z0-9-]{0,63})\/$/.exec(row.url) : null;
  return m ? { id, cls: m[1] === 'apps' ? 'app' : 'sop', slug: m[2] } : { id, cls: 'external', slug: null };
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new HttpError(400, 'key 规范：字母/数字/下划线开头，字母/数字/_ . : -，≤128 字符');
  return key;
}

function view(r: WorkbenchVarRow) {
  return { key: r.key, kind: r.kind, value: JSON.parse(r.value), revision: r.revision, updated_by: r.updated_by, created_at: r.created_at, updated_at: r.updated_at };
}

/** 期望 revision：If-Match（"3" / W/"3" / 3）与 revision 参数二选一；都给且不同 400 */
function expectedRevision(ifMatch: unknown, param: unknown): number | undefined {
  const parse = (v: unknown, what: string): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
    if (!/^\d{1,12}$/.test(s)) throw new HttpError(400, `${what} 必须是非负整数 revision`);
    return Number(s);
  };
  const a = parse(ifMatch, 'If-Match');
  const b = parse(param, 'revision');
  if (a !== undefined && b !== undefined && a !== b) throw new HttpError(400, 'If-Match 与 revision 不一致');
  return a ?? b;
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

function conflict(scope: Scope, key: string, message: string, code: string, status = 409): never {
  const cur = vars().get(scope.id, key) as WorkbenchVarRow | undefined;
  throw new HttpError(status, message, { code, workbench_id: scope.id, key, current_revision: cur?.revision ?? 0, current: cur ? view(cur) : null });
}

function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ } throw e; }
}

export function listVars(scope: Scope, prefix = '') {
  if (prefix && (prefix.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(prefix))) throw new HttpError(400, 'prefix 只能含字母/数字/_ . : -');
  const items = (vars().list(scope.id, prefix) as WorkbenchVarRow[]).map(view);
  return { workbench_id: scope.id, class: scope.cls, items, count: items.length };
}

export function getVar(scope: Scope, key: string) {
  const r = vars().get(scope.id, checkKey(key)) as WorkbenchVarRow | undefined;
  if (!r) throw new HttpError(404, `var not found: ${key}`, { code: 'not_found', workbench_id: scope.id, key, current_revision: 0 });
  return { workbench_id: scope.id, ...view(r) };
}

export function setVar(scope: Scope, key: string, input: { value?: unknown; hasValue: boolean; kind?: unknown; expected?: number; override?: boolean; reason?: unknown }, caller: Caller) {
  checkKey(key);
  if (!input.hasValue) throw new HttpError(400, '缺 value（任意 JSON 值，null 也算）');
  if (input.kind !== undefined && input.kind !== 'var' && input.kind !== 'const') throw new HttpError(400, "kind 只能是 'var' 或 'const'");
  const json = JSON.stringify(input.value);
  if (json === undefined) throw new HttpError(400, 'value 不是合法 JSON 值');
  if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new HttpError(400, `value 超 ${MAX_VALUE_BYTES / 1024}KB 上限`);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const S = vars();
  return tx(() => {
    const cur = S.get(scope.id, key) as WorkbenchVarRow | undefined;
    if (!cur) {
      if (input.expected !== undefined && input.expected !== 0) conflict(scope, key, `键不存在，期望 revision ${input.expected} 不成立`, 'revision_conflict');
      if (S.count(scope.id) >= MAX_KEYS_PER_WORKBENCH) throw new HttpError(400, `每台最多 ${MAX_KEYS_PER_WORKBENCH} 个键`);
      const kind = (input.kind as string | undefined) ?? 'var';
      if (!S.insert(scope.id, key, kind, json, caller.actor).changes) conflict(scope, key, '并发创建：键已被写入', 'revision_conflict');
      S.audit({ workbench_id: scope.id, key, action: 'create', actor: caller.actor, kind, old_revision: null, new_revision: 1, old_sha256: '', new_sha256: sha(json), reason });
      return { ok: true, created: true, workbench_id: scope.id, ...view(S.get(scope.id, key) as WorkbenchVarRow) };
    }
    if (cur.kind === 'const') {
      if (!input.override) conflict(scope, key, '常量写入后不能修改（管理员可显式带 override 修订）', 'const_locked', 403);
      if (!caller.admin) conflict(scope, key, '常量修订只限管理员或本机命令行（按台令牌与 MCP 不能 override）', 'const_override_forbidden', 403);
    }
    if (input.expected === undefined) conflict(scope, key, '改已存在的键必须带期望 revision（If-Match 或 revision）', 'revision_required', 428);
    if (input.expected !== cur.revision) conflict(scope, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
    const kind = (input.kind as string | undefined) ?? cur.kind;
    if (!S.update(scope.id, key, cur.revision, kind, json, caller.actor).changes) conflict(scope, key, 'revision 冲突：已被并发修改', 'revision_conflict');
    const action = cur.kind === 'const' ? 'const_override' : kind === 'const' ? 'freeze' : 'update';
    S.audit({ workbench_id: scope.id, key, action, actor: caller.actor, kind, old_revision: cur.revision, new_revision: cur.revision + 1, old_sha256: sha(cur.value), new_sha256: sha(json), reason });
    return { ok: true, created: false, workbench_id: scope.id, ...view(S.get(scope.id, key) as WorkbenchVarRow) };
  });
}

export function deleteVar(scope: Scope, key: string, input: { expected?: number; override?: boolean; reason?: unknown }, caller: Caller) {
  checkKey(key);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
  const S = vars();
  return tx(() => {
    const cur = S.get(scope.id, key) as WorkbenchVarRow | undefined;
    if (!cur) throw new HttpError(404, `var not found: ${key}`, { code: 'not_found', workbench_id: scope.id, key, current_revision: 0 });
    if (cur.kind === 'const') {
      if (!input.override) conflict(scope, key, '常量不能删除（管理员可显式带 override）', 'const_locked', 403);
      if (!caller.admin) conflict(scope, key, '常量删除只限管理员或本机命令行', 'const_override_forbidden', 403);
    }
    if (input.expected === undefined) conflict(scope, key, '删除必须带期望 revision（If-Match 或 revision）', 'revision_required', 428);
    if (input.expected !== cur.revision || !S.delete(scope.id, key, cur.revision).changes) conflict(scope, key, `revision 冲突：期望 ${input.expected}，当前 ${cur.revision}`, 'revision_conflict');
    S.audit({ workbench_id: scope.id, key, action: cur.kind === 'const' ? 'const_delete' : 'delete', actor: caller.actor, kind: cur.kind, old_revision: cur.revision, new_revision: null, old_sha256: sha(cur.value), new_sha256: '', reason });
    return { ok: true, deleted: true, workbench_id: scope.id, key, revision: cur.revision };
  });
}

/** 删台级联：变量随台删除，审计行保留 */
export function dropWorkbenchVars(workbenchId: number): void {
  vars().deleteAll(workbenchId);
}

// ---------- MCP（workbench_vars_get / workbench_vars_set）：会话授权由 /mcp 网关管，这里不认 override ----------
export function mcpVarsGet(args: any) {
  const scope = workbenchScope(Number(args?.id));
  return args?.key === undefined ? listVars(scope, typeof args?.prefix === 'string' ? args.prefix : '') : getVar(scope, String(args.key));
}

export function mcpVarsSet(args: any, subject: string) {
  if (args?.override !== undefined) throw new HttpError(403, '常量修订只走 REST（管理员带 override），MCP 不提供');
  const scope = workbenchScope(Number(args?.id));
  return setVar(scope, String(args?.key ?? ''), {
    value: args?.value, hasValue: args != null && Object.prototype.hasOwnProperty.call(args, 'value'),
    kind: args?.kind, expected: expectedRevision(undefined, args?.revision), reason: args?.reason,
  }, { actor: subject, admin: false });
}

// ---------- REST ----------
export function createWorkbenchVars(deps: WorkbenchVarsDeps) {
  /** 本台令牌是否有效（只有自产台 / SOP 台有令牌） */
  function appTokenOk(req: express.Request, scope: Scope): boolean {
    const presented = String(req.headers['x-app-token'] ?? '').trim();
    return !!scope.slug && tokenEq(presented, deps.appToken(scope.slug));
  }

  async function authorize(req: express.Request, res: express.Response, scope: Scope, write: boolean): Promise<Caller | null> {
    if (!browserMarked(req) && rawLoopback(req)) return { actor: 'cli', admin: true }; // 本机命令行
    if (req.headers['x-app-token'] !== undefined) {
      if (appTokenOk(req, scope)) return { actor: `app:${scope.slug}`, admin: false };
      res.status(403).json({ error: '按台令牌不属于该工作台（只能读写本台变量；外部台只限管理员）', code: 'app_token_mismatch' });
      return null;
    }
    await deps.markOdooAdmin(req);
    if (!(write ? deps.adminWrite(req, res) : deps.adminRead(req, res))) return null;
    return { actor: 'admin', admin: true };
  }

  const handle = (write: boolean, fn: (req: express.Request, res: express.Response, scope: Scope, caller: Caller) => void) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      (async () => {
        const scope = workbenchScope(Number(req.params.id));
        const caller = await authorize(req, res, scope, write);
        if (!caller) return;
        res.set('Cache-Control', 'no-store');
        fn(req, res, scope, caller);
      })().catch(next);
    };

  return {
    /** 沙箱页面（Origin: null）凭本台令牌跨源读写：预检只回允许头；实际请求令牌对了才发 ACAO */
    cors(req: express.Request, res: express.Response, next: express.NextFunction) {
      const m = PATH_RE.exec(String(req.url ?? '').split('?')[0]);
      if (!m || String(req.headers.origin ?? '') !== 'null') return next();
      const setAcao = () => {
        res.setHeader('access-control-allow-origin', 'null');
        res.setHeader('access-control-allow-methods', 'GET,PUT,DELETE,OPTIONS');
        res.setHeader('access-control-allow-headers', 'content-type,x-app-token,if-match');
        res.setHeader('access-control-expose-headers', 'etag');
        res.setHeader('access-control-max-age', '600');
      };
      if (req.method === 'OPTIONS') { setAcao(); return res.status(204).end(); }
      try { if (appTokenOk(req, workbenchScope(Number(m[1])))) setAcao(); } catch { /* 台不存在：不发 ACAO，路由回 404 */ }
      return next();
    },

    /** 写门豁免：/api/workbenches/:id/vars 写请求带本台有效令牌（路由内再判一次） */
    appTokenWrite(req: express.Request): boolean {
      const m = PATH_RE.exec(req.path);
      if (!m || req.headers['x-app-token'] === undefined) return false;
      try { return appTokenOk(req, workbenchScope(Number(m[1]))); } catch { return false; }
    },

    mount(app: express.Express): void {
      app.get('/api/workbenches/:id/vars', handle(false, (req, res, scope) => {
        res.json(listVars(scope, typeof req.query.prefix === 'string' ? req.query.prefix : ''));
      }));
      app.get('/api/workbenches/:id/vars/:key', handle(false, (req, res, scope) => {
        const out = getVar(scope, req.params.key);
        res.set('ETag', `"${out.revision}"`).json(out);
      }));
      // 审计只给管理员（本机命令行同）
      app.get('/api/workbenches/:id/vars/:key/audit', handle(false, (req, res, scope, caller) => {
        if (!caller.admin) return void res.status(403).json({ error: '审计只限管理员' });
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        res.json({ workbench_id: scope.id, key: checkKey(req.params.key), items: vars().auditList(scope.id, req.params.key, limit) });
      }));
      app.put('/api/workbenches/:id/vars/:key', handle(true, (req, res, scope, caller) => {
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const out = setVar(scope, req.params.key, {
          value: b.value, hasValue: Object.prototype.hasOwnProperty.call(b, 'value'), kind: b.kind,
          expected: expectedRevision(req.headers['if-match'], b.revision ?? req.query.revision),
          override: truthy(b.override) || truthy(req.query.override), reason: b.reason,
        }, caller);
        res.status(out.created ? 201 : 200).set('ETag', `"${out.revision}"`).json(out);
      }));
      app.delete('/api/workbenches/:id/vars/:key', handle(true, (req, res, scope, caller) => {
        res.json(deleteVar(scope, req.params.key, {
          expected: expectedRevision(req.headers['if-match'], req.query.revision),
          override: truthy(req.query.override), reason: req.query.reason,
        }, caller));
      }));
    },
  };
}
