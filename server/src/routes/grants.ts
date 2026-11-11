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
import { buildRoles, orgRolesFromConfig, type ActionCatalog, type Kind } from '../roles.ts';
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

/**
 * 读角色声明（只读一次）、校验、交给授予服务。要在所有路由都注册完之后调（动作清单要齐）；不合格抛错，启动失败。
 */
export function loadRoleDeclarations(http: HttpService): void {
  const config = orgRolesFromConfig();
  const catalog = actionCatalog(http);
  const views = buildRoles(config.roles, catalog);
  // 内置身份清单（judgment-builtins.ts）是代码、过评审；清单里的动作都要在，由快照导出把关（surface-snapshot 对不上就失败），这里只提醒
  const unknown = unknownBuiltinActions((a) => catalog.has(a));
  if (unknown.length) console.warn(`[grants] 内置身份引用了动作清单里没有的动作（只影响判定比对）：${unknown.join('、')}`);
  grants().setRoles(views);
  rolesSource = config.source;
  console.log(JSON.stringify({ source: 'grants', event: 'roles-loaded', from: config.source, roles: [...views.keys()], at: new Date().toISOString() }));
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
    res.json({ source: rolesSource, roles: grants().roles().map(({ id, name, includes, permissions, platform, adminLevel, decides }) => ({ id, name, includes: includes ?? [], permissions, platform, admin_level: adminLevel, decides })) });
  }));

  app.get('/api/grants', { action: 'grant.list', kind: 'admin' }, route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    const principal = req.query.principal === undefined ? undefined : str(req.query.principal, 'principal', 160);
    const status = req.query.status === undefined ? undefined : str(req.query.status, 'status', 16);
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status 只能是 ${STATUSES.join('、')}`);
    const source = req.query.source === undefined ? undefined : str(req.query.source, 'source', 16);
    if (source !== undefined && source !== 'manual' && source !== 'migration') throw new HttpError(400, 'source 只能是 manual、migration');
    grants().expireDue();
    res.json({ grants: grants().list({ principal, status: status as GrantStatus | undefined, source: source as 'manual' | 'migration' | undefined }) });
  }));

  app.get('/api/grants/:id', { action: 'grant.read', kind: 'admin' }, route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    const g = grants().get(idOf(req));
    if (!g) throw new HttpError(404, `授予 ${req.params.id} 不存在`);
    res.json({ grant: g });
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
