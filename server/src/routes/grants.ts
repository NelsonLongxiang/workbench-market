/**
 * 角色与授予的管理接口（阶段六 6b）：/api/roles 列出声明的角色，/api/grants 起草、提交、放行、撤销、列出。
 *
 * 每一条都要管理员（本机命令行、有效口令，或管理员登录 + 同源；和主体管理面同一个口径）；写请求先过 index.ts 的写请求总门。
 * 「谁做的」：本机命令行是属主；口令是管理员，不是主体；管理员登录对到它的主体，持有生效的 owner 授予的才是属主。
 * 每一步在库里记一行（grant_events），并写一行日志。
 *
 * 注册时读角色声明并校验（roles.ts）：不合格就抛错，启动失败。动作清单取 MCP 工具，加上 HTTP 服务登记的动作（服务有 actions() 才取）。
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
import type { PrincipalService } from '../services/principal.ts';
import type { Actor, GrantService, GrantStatus, Refusal } from '../services/grant.ts';

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

/** 动作清单：MCP 工具（类别沿用工具自己的），加上 HTTP 服务登记的动作（服务有 actions() 才取） */
function actionCatalog(http: HttpService): ActionCatalog {
  const catalog: ActionCatalog = new Map();
  for (const t of MCP_TOOLS) catalog.set(t.name, t.category as Kind);
  const listed = (http as unknown as { actions?: () => { action: string; kind: Kind }[] }).actions;
  if (typeof listed === 'function') for (const a of listed.call(http)) catalog.set(a.action, a.kind);
  return catalog;
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
  // 角色声明：读配置（只读一次）、校验、交给授予服务。不合格抛错，启动失败
  const config = orgRolesFromConfig();
  const views = buildRoles(config.roles, actionCatalog(app));
  grants().setRoles(views);
  console.log(JSON.stringify({ source: 'grants', event: 'roles-loaded', from: config.source, roles: [...views.keys()], at: new Date().toISOString() }));

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

  app.get('/api/roles', route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    res.json({ source: config.source, roles: grants().roles().map(({ id, name, includes, permissions, platform, adminLevel, decides }) => ({ id, name, includes: includes ?? [], permissions, platform, admin_level: adminLevel, decides })) });
  }));

  app.get('/api/grants', route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    const principal = req.query.principal === undefined ? undefined : str(req.query.principal, 'principal', 160);
    const status = req.query.status === undefined ? undefined : str(req.query.status, 'status', 16);
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status 只能是 ${STATUSES.join('、')}`);
    grants().expireDue();
    res.json({ grants: grants().list({ principal, status: status as GrantStatus | undefined }) });
  }));

  app.get('/api/grants/:id', route(async (req, res) => {
    if (!(await actorOf(req, res))) return;
    const g = grants().get(idOf(req));
    if (!g) throw new HttpError(404, `授予 ${req.params.id} 不存在`);
    res.json({ grant: g });
  }));

  app.post('/api/grants', route(async (req, res) => {
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

  app.post('/api/grants/:id/submit', route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    send(res, grants().submit(idOf(req), actor), 'submit', actor);
  }));

  app.post('/api/grants/:id/approve', route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    send(res, grants().approve(idOf(req), actor), 'approve', actor);
  }));

  app.post('/api/grants/:id/revoke', route(async (req, res) => {
    const actor = await actorOf(req, res);
    if (!actor) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    send(res, grants().revoke(idOf(req), actor, str(b.reason ?? '', 'reason', 500)), 'revoke', actor);
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
