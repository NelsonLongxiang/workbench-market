/**
 * 部门的读写接口。读：登录的人（以及管理员、本机命令行）；写：管理员（和主体、授予管理面同一个口径），写请求先过 index.ts 的写请求总门。
 *
 *   GET    /api/departments                         部门列表：标识、名称、职能代号、负责人（主体和显示名）、成员人数、来源
 *   GET    /api/departments/:id                     一个部门，连同成员（主体、显示名、类型、状态、是不是负责人）
 *   GET    /api/departments/of/:principal           某个主体属于哪些部门（成员的、负责的）
 *   PUT    /api/departments/:id                     停写：410（部门迁成领域，docs/domains-step1.md 第六节；改用 /api/areas）
 *   DELETE /api/departments/:id                     停写：410
 *   PUT    /api/departments/:id/members/:principal  停写：410
 *   DELETE /api/departments/:id/members/:principal  停写：410
 *
 * 读接口只给部门和人，不带任何事项内容。空就是空：没建部门时列表是空数组，不造数据。
 * 写接口先过鉴权再回 410（department_write_closed），不读参数、不碰库。第 5 步删表、删路由。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { identity } from '../identity.ts';
import type { PrincipalService } from '../services/principal.ts';
import { DEPARTMENT_ID_RE, type DepartmentService } from '../services/department.ts';

export type DepartmentRouteDeps = {
  markAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 管理员（口令或管理员登录），浏览器来的要同源；不写应答 */
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  /** 浏览器从别的站点发来的 */
  crossOriginDenied: (req: express.Request) => boolean;
};

/** 停写的代号和说法：启动自检也认它 */
export const DEPARTMENT_WRITE_CLOSED = 'department_write_closed';
export const DEPARTMENT_WRITE_CLOSED_TEXT = '部门已停写：建、改、删部门和增删成员改用领域（/api/areas）。读照旧';

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
export function registerDepartmentRoutes(app: HttpService, deps: DepartmentRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  /** 读：本机命令行、管理员、登录的人（主体停用的不行）。不过就已经写好应答（跨站 403、没登录 401），返回 false */
  async function reader(req: express.Request, res: express.Response): Promise<boolean> {
    res.set('Cache-Control', 'private, no-store');
    if (!browserMarked(req) && rawLoopback(req)) return true;
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'departments_cross_origin_denied' }); return false; }
    await deps.markAdmin(req);
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
    await deps.markAdmin(req);
    if (!deps.adminGuard(req, res)) return null;
    return deps.adminActor(req);
  }

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

  /**
   * 部门已停写（docs/domains-step1.md 第六节、用例 17）：增、改、删部门，成员增删，一律 410，提示改用领域。
   * 先过鉴权（没登录、不是管理员照旧 401 / 403，不对外透露停写），再回 410，不读参数、不碰库。属主、本机命令行也一样。
   */
  const closed = route(async (req, res) => {
    if (!(await writer(req, res))) return;
    res.status(410).json({ error: DEPARTMENT_WRITE_CLOSED, message: DEPARTMENT_WRITE_CLOSED_TEXT });
  });
  app.put('/api/departments/:id', { action: 'department.upsert', kind: 'admin' }, closed);
  app.delete('/api/departments/:id', { action: 'department.delete', kind: 'admin' }, closed);
  app.put('/api/departments/:id/members/:principal', { action: 'department.member-add', kind: 'admin' }, closed);
  app.delete('/api/departments/:id/members/:principal', { action: 'department.member-remove', kind: 'admin' }, closed);
}
