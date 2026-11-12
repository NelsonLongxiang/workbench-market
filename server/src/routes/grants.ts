/**
 * 角色与授予的管理接口（阶段六 6b）：/api/roles 列出声明的角色，/api/grants 起草、提交、放行、撤销、列出。
 *
 * 每一条都要管理员（本机命令行、有效口令，或管理员登录 + 同源；和主体管理面同一个口径）；写请求先过 index.ts 的写请求总门。
 * 「谁做的」：本机命令行是属主；口令是管理员，不是主体；管理员登录对到它的主体，持有生效的 owner 授予的才是属主。
 * 每一步在库里记一行（grant_events），并写一行日志。
 *
 * 角色声明由 loadRoleDeclarations 读并校验（roles.ts）：index.ts 在所有路由都注册完、开始监听之前调它，动作清单才齐；
 * 不合格就抛错，启动失败。动作清单取 MCP 工具（类别沿用工具自己的），加上 HTTP 服务登记的全部动作。
 * 到期的授予由周期任务标成过期（挂在根上下文的 effect 上，卸载时一起停）；判断生效时本来就现比期限。
 *
 * 这一步只建结构，不接判定：现有的守卫不读授予，不改变任何人能做什么。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { root } from '../root-context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { MCP_TOOLS } from '../mcp-tools.ts';
import { identity } from '../identity.ts';
import { APPROVAL_TEXT, approvalOf, touchesBusiness, BLOCKS, buildRoles, checkShape, MATRIX_KINDS, matrixSummary, orgRolesFromConfig, PLATFORM_ROLES, roleMatrix, type ActionCatalog, type Kind, type Permission, type RoleDecl } from '../roles.ts';
import type { CustomRoleService } from '../services/custom-role.ts';
import { unknownBuiltinActions } from '../judgment-builtins.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { Actor, GrantService, GrantStatus, Refusal } from '../services/grant.ts';
import type { JudgmentCompareService } from '../services/judgment-compare.ts';
import { compareConfig } from '../judgment-compare.ts';

export type GrantRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 管理员登录是 odoo:<登录名>，口令是 admin-token */
  adminActor: (req: express.Request) => string;
};

const grants = () => svc<GrantService>('grants');
const principals = () => svc<PrincipalService>('principals');
const EXPIRE_EVERY_MS = 10 * 60_000;
const STATUSES: readonly GrantStatus[] = ['draft', 'pending', 'active', 'revoked', 'expired'];

/** 动作清单：MCP 工具（类别沿用工具自己的），加上 HTTP 服务登记的全部动作 */
function actionCatalog(http: HttpService): ActionCatalog {
  const catalog: ActionCatalog = new Map();
  for (const t of MCP_TOOLS) catalog.set(t.name, t.category as Kind);
  for (const a of http.actions()) catalog.set(a.action, a.kind);
  return catalog;
}

/** 声明来自哪里（外部文件还是初始集合）；loadRoleDeclarations 之后才有 */
let rolesSource: 'file' | 'initial' | null = null;
/** 启动时读到的组织角色声明和动作清单：自定义角色改动之后重建角色表要用 */
let declared: readonly unknown[] = [];
let catalogAtLoad: ActionCatalog = new Map();
const customRoles = () => svc<CustomRoleService>('customRoles');

/** 已经被占用的角色 id 和名字：平台预设、声明文件（或初始集合）里的；except 是正在改的那个自定义角色 */
function takenNames(except?: string): { ids: Set<string>; names: Set<string> } {
  const ids = new Set<string>(), names = new Set<string>();
  for (const r of [...PLATFORM_ROLES, ...(declared as RoleDecl[])]) { ids.add(r.id); names.add(r.name); }
  for (const r of customRoles().list()) if (r.id !== except) { ids.add(r.id); names.add(r.name); }
  return { ids, names };
}

/**
 * 重建角色表：平台预设 + 声明文件（或初始集合）+ 生效的自定义角色。声明文件里的优先：声明文件用了同一个 id 或名字的自定义角色不加载（留一行痕）
 */
function rebuildRoles(): void {
  const fromDecl = new Set<string>(), declNames = new Set<string>();
  for (const r of [...PLATFORM_ROLES, ...(declared as RoleDecl[])]) { fromDecl.add(r.id); declNames.add(r.name); }
  const usable: RoleDecl[] = [];
  for (const c of customRoles().activeDecls()) {
    if (fromDecl.has(c.id) || declNames.has(c.name)) { console.warn(JSON.stringify({ source: 'grants', event: 'custom-role-shadowed', id: c.id, at: new Date().toISOString() })); continue; }
    usable.push(c);
  }
  grants().setRoles(buildRoles([...declared, ...usable], catalogAtLoad, new Set(usable.map((r) => r.id))));
}

/** 校验一个自定义角色（和声明文件同一套）：不合格抛 422。返回它展开之后的样子（管理员级、带不带决定） */
function checkCustom(candidate: RoleDecl, except?: string): { adminLevel: boolean; decides: boolean; business: boolean } {
  const { ids, names } = takenNames(except);
  if (ids.has(candidate.id)) throw new HttpError(409, `角色 id ${candidate.id} 已经有了（内置预设、声明文件或别的自定义角色）`);
  if (names.has(candidate.name)) throw new HttpError(409, `角色名字「${candidate.name}」已经有了（内置预设、声明文件或别的自定义角色）`);
  try {
    const shaped = checkShape(candidate, `自定义角色 ${candidate.id}`);
    const others = customRoles().activeDecls().filter((r) => r.id !== except && r.id !== candidate.id);
    const views = buildRoles([...declared, ...others, shaped], catalogAtLoad);
    const v = views.get(shaped.id)!;
    return { adminLevel: v.adminLevel, decides: v.decides, business: touchesBusiness(v.closure) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, String((e as Error).message));
  }
}

/**
 * 读角色声明（只读一次）、校验、交给授予服务。要在所有路由都注册完之后调（动作清单要齐）；不合格抛错，启动失败。
 */
export function loadRoleDeclarations(http: HttpService): void {
  const config = orgRolesFromConfig();
  const catalog = actionCatalog(http);
  buildRoles(config.roles, catalog); // 声明本身先单独校验：不合格就拒绝启动，不让库里的自定义角色掺进报错
  declared = config.roles; catalogAtLoad = catalog;
  // 内置身份清单（judgment-builtins.ts）是代码、过评审；清单里的动作都要在，由快照导出把关（surface-snapshot 对不上就失败），这里只提醒
  const unknown = unknownBuiltinActions((a) => catalog.has(a));
  if (unknown.length) console.warn(`[grants] 内置身份引用了动作清单里没有的动作（只影响判定比对）：${unknown.join('、')}`);
  rebuildRoles();
  rolesSource = config.source;
  console.log(JSON.stringify({ source: 'grants', event: 'roles-loaded', from: config.source, roles: grants().roles().map((r) => r.id), at: new Date().toISOString() }));
}

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new HttpError(400, `${name} 要是不超过 ${max} 个字符的字符串`);
  return v;
}
function idOf(req: express.Request): number {
  const id = Number(req.params.id);
  if (!/^[1-9][0-9]{0,15}$/.test(String(req.params.id)) || !Number.isSafeInteger(id)) throw new HttpError(404, `授予 ${String(req.params.id)} 不存在`);
  return id;
}

export function registerGrantRoutes(app: HttpService, deps: GrantRouteDeps): void {
  /** 是管理员就返回「谁」；不是就已经回了 403，返回 null */
  async function actorOf(req: express.Request, res: express.Response): Promise<Actor | null> {
    if (!browserMarked(req) && rawLoopback(req)) return { by: 'cli', principal: null, owner: true }; // 本机命令行是属主
    await deps.markOdooAdmin(req);
    if (!deps.adminGuard(req, res)) return null;
    const by = deps.adminActor(req);
    // 管理员登录对到主体：和主体管理面「不能停用自己」同一个取法
    const principal = by.startsWith('odoo:') ? principals().principalOf(identity().providerName() ?? '', by.slice(5)) : null;
    return { by, principal, owner: grants().isOwner(principal) };
  }
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };
  const send = (res: express.Response, r: { ok: true; grant: unknown } | Refusal, step: string, actor: Actor) => {
    if (!r.ok) return res.status(r.http).json({ error: r.code, message: r.message });
    const g = r.grant as { id: number; principal_id: string; role: string; scope: string; status: string };
    console.log(JSON.stringify({ source: 'grants', event: step, id: g.id, principal: g.principal_id, role: g.role, scope: g.scope, status: g.status, by: actor.by, at: new Date().toISOString() }));
    return res.status(step === 'draft' ? 201 : 200).json({ grant: r.grant });
  };

  app.get('/api/roles', { action: 'role.list', kind: 'admin' }, route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    res.json({
      source: rolesSource,
      // approval：这个角色的授予谁能放行（owner / business / admin），approval_text 是给页面原样显示的说法
      roles: grants().roles().map((v) => {
        const { id, name, includes, permissions, platform, custom, adminLevel, decides, businessWrite } = v;
        const approval = approvalOf(v);
        return { id, name, includes: includes ?? [], permissions, platform, custom, admin_level: adminLevel, decides, business_write: businessWrite, approval, approval_text: APPROVAL_TEXT[approval] };
      }),
      // 自定义角色全部（含待属主放行的新角色和改动）
      custom: customRoles().list(),
    });
  }));

  // 「谁能做什么」的角色矩阵：角色 × 七大块 × 看/做/拍板/管理，服务端从角色定义算，前端不自己拼
  app.get('/api/roles/matrix', { action: 'role.matrix', kind: 'admin' }, route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    const roles = grants().roles();
    const order = (r: { platform: boolean }) => (r.platform ? 0 : 1);
    res.set('Cache-Control', 'no-store').json({
      blocks: BLOCKS.map(({ key, name }) => ({ key, name })),
      kinds: MATRIX_KINDS,
      roles: [...roles].sort((a, b) => order(a) - order(b)).map((r) => {
        const cells = roleMatrix(r.id, r.closure, catalogAtLoad);
        return { id: r.id, name: r.name, preset: r.platform, custom: r.custom, cells, summary: matrixSummary(cells) };
      }),
    });
  }));

  // ---------- 自定义角色：复制、改、删、属主放行、导出 ----------
  const roleIdOf = (req: express.Request): string => {
    const id = String(req.params.id ?? '');
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new HttpError(404, `角色 ${id} 不存在`);
    return id;
  };
  const lockedRole = (id: string): string | null => (PLATFORM_ROLES.some((r) => r.id === id) ? '内置预设不能改，只能复制成自定义角色再改'
    : (declared as RoleDecl[]).some((r) => r.id === id) ? '声明文件里的角色改动走提交，不在界面上改' : null);
  const logRole = (event: string, id: string, actor: Actor, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ source: 'grants', event, role: id, by: actor.by, ...extra, at: new Date().toISOString() }));

  app.post('/api/roles/:id/copy', { action: 'role.copy', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const from = grants().roles().find((r) => r.id === roleIdOf(req));
    if (!from) throw new HttpError(404, `角色 ${req.params.id} 不存在`);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const candidate: RoleDecl = { id: str(b.id, 'id', 48), name: str(b.name, 'name', 64), permissions: from.closure.map((p) => ({ ...p })) };
    const shape = checkCustom(candidate);
    // 会带来管理类或决定类权限的：不是属主建的，先待属主放行
    // 带来管理类、决定类，或者碰业务的：不是属主建的，先待属主放行
    const pending = (shape.adminLevel || shape.decides || shape.business) && !actor.owner;
    const role = customRoles().create({ id: candidate.id, name: candidate.name, basedOn: from.id, permissions: candidate.permissions, pending }, actor);
    if (!pending) rebuildRoles();
    logRole('role-copy', role.id, actor, { from: from.id, status: role.status });
    res.status(201).json({ role, pending });
  }));

  app.put('/api/roles/:id', { action: 'role.update', kind: 'admin', statusNotVerdict: '内置预设、声明文件里的角色锁住不让改，回 403，是角色本身的规则' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const id = roleIdOf(req);
    const locked = lockedRole(id);
    if (locked) return res.status(403).json({ error: 'role_locked', message: locked });
    const cur = customRoles().get(id);
    if (!cur) throw new HttpError(404, `角色 ${id} 不存在`);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = { name: b.name === undefined ? cur.name : str(b.name, 'name', 64), permissions: (b.permissions ?? cur.permissions) as Permission[] };
    const shape = checkCustom({ id, name: next.name, permissions: next.permissions }, id);
    // 从 AI 员工复制出来的不许带决定类：决定只认人。复制几层都算（沿来源链往上找）
    if (customRoles().descendsFrom(id, 'ai-staff') && shape.decides) return res.status(422).json({ error: 'decide_non_person', message: '从 AI 员工复制出来的角色不能带决定类权限（决定只认人）' });
    const propose = (shape.adminLevel || shape.decides || shape.business) && !actor.owner;
    const role = customRoles().update(id, { name: next.name, permissions: checkShape({ id, ...next }, `自定义角色 ${id}`).permissions }, propose, actor);
    if (!propose) rebuildRoles();
    logRole(propose ? 'role-propose' : 'role-update', id, actor);
    res.json({ role, pending: propose, affected_grants: customRoles().grantsUsing(id) });
  }));

  app.delete('/api/roles/:id', { action: 'role.delete', kind: 'admin', statusNotVerdict: '内置预设、声明文件里的角色锁住不让删，回 403，是角色本身的规则' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const id = roleIdOf(req);
    const locked = lockedRole(id);
    if (locked) return res.status(403).json({ error: 'role_locked', message: locked });
    if (!customRoles().get(id)) throw new HttpError(404, `角色 ${id} 不存在`);
    const using = customRoles().grantsUsing(id);
    if (using.length) return res.status(409).json({ error: 'role_in_use', message: `还有 ${using.length} 条授予在用这个角色，先撤销它们`, grants: using });
    customRoles().delete(id, actor);
    rebuildRoles();
    logRole('role-delete', id, actor);
    res.json({ ok: true, id });
  }));

  app.post('/api/roles/:id/approve', { action: 'role.approve', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    if (!actor.owner) return res.status(403).json({ error: 'owner_required', message: '带管理类或决定类权限的自定义角色只有属主能放行' });
    const id = roleIdOf(req);
    const cur = customRoles().get(id);
    if (!cur) throw new HttpError(404, `角色 ${id} 不存在`);
    if (cur.status === 'active' && !cur.proposed) return res.status(409).json({ error: 'nothing_pending', message: `角色 ${id} 没有待放行的东西` });
    const target = cur.proposed ?? { name: cur.name, permissions: cur.permissions };
    checkCustom({ id, ...target }, id); // 放行的时候再核一次：动作清单可能变了
    const role = customRoles().approve(id, actor);
    rebuildRoles();
    logRole('role-approve', id, actor);
    res.json({ role, affected_grants: customRoles().grantsUsing(id) });
  }));

  app.get('/api/roles/export', { action: 'role.export', kind: 'admin' }, route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    // 声明文件的格式（{ roles: [...] }）：方便评审、备份，或者改成声明文件走提交（声明文件里的优先）
    res.set('Cache-Control', 'no-store').json({ roles: customRoles().activeDecls() });
  }));

  // 列表和单条都带 can_approve / approve_denied / approve_denied_text：当前看的人能不能放行，和放行接口用同一处判断
  app.get('/api/grants', { action: 'grant.list', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const principal = req.query.principal === undefined ? undefined : str(req.query.principal, 'principal', 160);
    const status = req.query.status === undefined ? undefined : str(req.query.status, 'status', 16);
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status 只能是 ${STATUSES.join('、')}`);
    const source = req.query.source === undefined ? undefined : str(req.query.source, 'source', 16);
    if (source !== undefined && source !== 'manual' && source !== 'migration') throw new HttpError(400, 'source 只能是 manual、migration');
    grants().expireDue();
    const now = Date.now();
    res.json({ grants: grants().list({ principal, status: status as GrantStatus | undefined, source: source as 'manual' | 'migration' | undefined }).map((g) => ({ ...g, ...grants().approvability(g, actor, now) })) });
  }));

  app.get('/api/grants/:id', { action: 'grant.read', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const g = grants().get(idOf(req));
    if (!g) throw new HttpError(404, `授予 ${req.params.id} 不存在`);
    res.json({ grant: { ...g, ...grants().approvability(g, actor) } });
  }));

  app.post('/api/grants', { action: 'grant.create', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const expires = b.expires_at;
    if (expires !== undefined && expires !== null && typeof expires !== 'number') throw new HttpError(400, 'expires_at 要是毫秒时刻，或者不写');
    const r = grants().draft({
      principal: str(b.principal, 'principal', 160), role: str(b.role, 'role', 48), scope: str(b.scope, 'scope', 300),
      expiresAt: typeof expires === 'number' ? expires : null, reason: str(b.reason ?? '', 'reason', 500),
    }, actor);
    send(res, r, 'draft', actor);
  }));

  app.post('/api/grants/:id/submit', { action: 'grant.submit', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    send(res, grants().submit(idOf(req), actor), 'submit', actor);
  }));

  app.post('/api/grants/:id/approve', { action: 'grant.approve', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    send(res, grants().approve(idOf(req), actor), 'approve', actor);
  }));

  app.post('/api/grants/:id/revoke', { action: 'grant.revoke', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    send(res, grants().revoke(idOf(req), actor, str(b.reason ?? '', 'reason', 500)), 'revoke', actor);
  }));

  // 迁移出来的授予整批撤销（阶段六 6c）：只有属主能做，要写理由，每条照样留痕
  app.post('/api/grants/revoke-migration', { action: 'grant.revoke-migration', kind: 'admin' }, route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    if (!actor.owner) return res.status(403).json({ error: 'owner_required', message: '迁移出来的授予只有属主能整批撤销' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = grants().revokeMigrated(actor, str(b.reason ?? '', 'reason', 500));
    if (!r.ok) return res.status(r.http).json({ error: r.code, message: r.message });
    console.log(JSON.stringify({ source: 'grants', event: 'revoke-migration', revoked: r.revoked, by: actor.by, at: new Date().toISOString() }));
    res.json({ revoked: r.revoked });
  }));

  // 判定并行比对的结果（阶段六 6c）：开关关着时照样回，只是空的
  const compareOn = compareConfig().on;
  app.get('/api/judgment/compare', { action: 'judgment.report', kind: 'admin' }, route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    // 关着时不碰比对的库文件（也不建）
    res.set('Cache-Control', 'no-store').json(compareOn ? { on: true, ...svc<JudgmentCompareService>('judgmentCompare').report() } : { on: false, tally: [], mismatches: [], writeFailures: 0, dropped: 0 });
  }));

  // 到期的标成过期：挂在根上下文的 effect 上，卸载时一起停
  root.effect(() => {
    const every = setTimeout(function tick() {
      try { grants().expireDue(); } catch (e) { console.error(`[grants] 标记过期出错：${String((e as Error)?.message ?? e).slice(0, 200)}`); }
      timer = setTimeout(tick, EXPIRE_EVERY_MS); timer.unref?.();
    }, EXPIRE_EVERY_MS);
    let timer = every;
    every.unref?.();
    return () => { clearTimeout(timer); };
  }, 'grants.expire(10min)');
}
