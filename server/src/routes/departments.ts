/**
 * 部门的读写接口。读：登录的人（以及管理员、本机命令行）；写：管理员（和主体、授予管理面同一个口径），写请求先过 index.ts 的写请求总门。
 *
 *   GET    /api/departments                         部门列表：标识、名称、职能代号、负责人（主体和显示名）、成员人数、来源
 *   GET    /api/departments/:id                     一个部门，连同成员（主体、显示名、类型、状态、是不是负责人）
 *   GET    /api/departments/of/:principal           某个主体属于哪些部门（成员的、负责的）
 *   PUT    /api/departments/:id                     建或改：{ name, function_code?, lead? }（function_code、lead 给 null 或空串表示清掉）
 *   DELETE /api/departments/:id                     删（还有没结束的 dept:<标识> 授予时 409）
 *   PUT    /api/departments/:id/members/:principal  加成员（已在里面不重复加）
 *   DELETE /api/departments/:id/members/:principal  移出
 *
 * 读接口只给部门和人，不带任何事项内容。空就是空：没建部门时列表是空数组，不造数据。
 * 每次写记一行日志（谁、做了什么），不记别的内容。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { identity } from '../identity.ts';
import type { PrincipalService } from '../services/principal.ts';
import { DEPARTMENT_ID_RE, type DepartmentRefusal, type DepartmentService } from '../services/department.ts';

export type DepartmentRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 管理员（口令或管理员登录），浏览器来的要同源；不写应答 */
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  /** 浏览器从别的站点发来的 */
  crossOriginDenied: (req: express.Request) => boolean;
};

const departments = () => svc<DepartmentService>('departments');
const principals = () => svc<PrincipalService>('principals');
const PRINCIPAL_RE = /^[a-z]+:[\x21-\x7e]{1,150}$/;

function deptId(req: express.Request): string {
  const id = String(req.params.id ?? '');
  if (!DEPARTMENT_ID_RE.test(id)) throw new HttpError(400, '部门标识要是小写字母开头的字母、数字、连字符，最多 48 个字符', { code: 'department_id_invalid' });
  return id;
}
function principalId(req: express.Request): string {
  const id = String(req.params.principal ?? '');
  if (!PRINCIPAL_RE.test(id)) throw new HttpError(400, '主体标识写法不对（形如 user:<登录名>）', { code: 'principal_id_invalid' });
  return id;
}
/** 可选的字符串字段：不写为 undefined（建时当空、改时当清掉，见 PUT）；null 或空串表示清掉 */
function optional(v: unknown, name: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${name} 要是不超过 ${max} 个字符的字符串，或者 null`, { code: `${name}_invalid` });
  return v;
}

export function registerDepartmentRoutes(app: HttpService, deps: DepartmentRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };
  const refused = (res: express.Response, r: DepartmentRefusal) => res.status(r.http).json({ error: r.code, message: r.message });

  /** 读：本机命令行、管理员、登录的人（主体停用的不行）。不过就已经写好应答（跨站 403、没登录 401），返回 false */
  async function reader(req: express.Request, res: express.Response): Promise<boolean> {
    res.set('Cache-Control', 'private, no-store');
    if (!browserMarked(req) && rawLoopback(req)) return true;
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'departments_cross_origin_denied' }); return false; }
    await deps.markOdooAdmin(req);
    if (deps.adminHeaderOk(req)) return true;
    const cookie = String(req.headers.cookie ?? '');
    const who = cookie ? await identity().resolveViewer(cookie) : null;
    if (!who || !who.ok) { res.status(401).json({ error: 'departments_auth_required' }); return false; }
    const bound = principals().principalOf(identity().providerName() ?? '', who.viewer.login) ?? who.viewer.sub;
    const p = principals().get(bound);
    if (p && p.status !== 'active') { res.status(403).json({ error: 'departments_principal_not_active' }); return false; }
    return true;
  }
  /** 写：本机命令行或管理员；返回留痕写法，不过就已经回了 403，返回 null */
  async function writer(req: express.Request, res: express.Response): Promise<string | null> {
    if (!browserMarked(req) && rawLoopback(req)) return 'cli';
    await deps.markOdooAdmin(req);
    if (!deps.adminGuard(req, res)) return null;
    return deps.adminActor(req);
  }
  const logged = (event: string, fields: Record<string, unknown>, by: string) =>
    console.log(JSON.stringify({ source: 'departments', event, ...fields, by, at: new Date().toISOString() }));

  app.get('/api/departments', { action: 'department.list', kind: 'read' }, route(async (req, res) => {
    if (!(await reader(req, res))) return;
    res.json({ departments: departments().list() });
  }));

  app.get('/api/departments/of/:principal', { action: 'department.membership', kind: 'read' }, route(async (req, res) => {
    if (!(await reader(req, res))) return;
    const principal = principalId(req);
    res.json({ principal, departments: departments().of(principal) });
  }));

  app.get('/api/departments/:id', { action: 'department.read', kind: 'read' }, route(async (req, res) => {
    if (!(await reader(req, res))) return;
    const id = deptId(req);
    const d = departments().get(id);
    if (!d) return void res.status(404).json({ error: 'department_missing', message: `部门 ${id} 不存在` });
    res.json({ department: d, members: departments().members(id) });
  }));

  app.put('/api/departments/:id', { action: 'department.upsert', kind: 'admin' }, route(async (req, res) => {
    const by = await writer(req, res);
    if (!by) return;
    const id = deptId(req);
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (typeof b.name !== 'string') throw new HttpError(400, 'name 要是部门名称（1～64 个字符）', { code: 'department_name_invalid' });
    const current = departments().get(id);
    const code = optional(b.function_code, 'function_code', 48);
    const lead = optional(b.lead, 'lead', 160);
    // 不写的字段：改的时候保持原样，建的时候为空
    const r = departments().upsert({
      id, name: b.name,
      functionCode: code === undefined ? current?.function_code ?? null : code,
      lead: lead === undefined ? current?.lead?.principal ?? null : lead,
    }, by, Date.now());
    if (!r.ok) return void refused(res, r);
    logged(r.created ? 'create' : 'update', { id, function_code: r.department.function_code, lead: r.department.lead?.principal ?? null }, by);
    res.status(r.created ? 201 : 200).json({ department: r.department });
  }));

  app.delete('/api/departments/:id', { action: 'department.delete', kind: 'admin' }, route(async (req, res) => {
    const by = await writer(req, res);
    if (!by) return;
    const id = deptId(req);
    const r = departments().remove(id);
    if (!r.ok) return void refused(res, r);
    logged('delete', { id, members: r.members }, by);
    res.json({ ok: true, id, members_removed: r.members });
  }));

  app.put('/api/departments/:id/members/:principal', { action: 'department.member-add', kind: 'admin' }, route(async (req, res) => {
    const by = await writer(req, res);
    if (!by) return;
    const id = deptId(req);
    const principal = principalId(req);
    const r = departments().addMember(id, principal, by, Date.now());
    if (!r.ok) return void refused(res, r);
    if (r.added) logged('member-add', { id, principal }, by);
    res.status(r.added ? 201 : 200).json({ ok: true, id, principal, added: r.added });
  }));

  app.delete('/api/departments/:id/members/:principal', { action: 'department.member-remove', kind: 'admin' }, route(async (req, res) => {
    const by = await writer(req, res);
    if (!by) return;
    const id = deptId(req);
    const principal = principalId(req);
    const r = departments().removeMember(id, principal);
    if (!r.ok) return void refused(res, r);
    if (r.removed) logged('member-remove', { id, principal }, by);
    res.json({ ok: true, id, principal, removed: r.removed });
  }));
}
