/**
 * 主体管理的路由（/api/principals）：列出、停用、恢复、对一次外部身份。改责任人、建非人的主体后面再加。
 *
 * 另有对一次外部身份的绑定和解绑（/api/principals/bind、/unbind）：变体写法先登录、把本人挡在外面的，或者飞书身份要接到已有的主体上，都靠它。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。
 * 每一条都要管理员：本机命令行、有效口令，或管理员登录（和别的管理面同一个口径）。
 * 写请求先过 index.ts 的写请求总门，这里再判一次，顺便取到「谁做的」。
 *
 * 停用是本地动作：改的是主体那一行的状态，每个入口认人时现查，所以立即生效，恢复也一样。
 * 应急口令和本机命令行不是主体，停不掉；管理员不能停用自己（把自己锁在外面之后，只能靠口令或本机命令行恢复）。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { LoginSessionService } from '../services/login-session.ts';
import { identity } from '../identity.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';

export type PrincipalRouteDeps = {
  /** 按需认定管理员登录（判管理员之前调用） */
  markOdooAdmin: (req: express.Request) => Promise<void>;
  /** 管理门（口令或管理员登录 + 同源）；不过时它自己回 403 */
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 管理员身份落到人：管理员登录是 odoo:<登录名>，口令是 admin-token */
  adminActor: (req: express.Request) => string;
};

const principals = () => svc<PrincipalService>('principals');

/** 主体标识：类别前缀加一个名。名里不许有控制字符，两头不许有空白 */
function principalId(v: unknown): string {
  if (typeof v !== 'string' || v.length > 160 || v !== v.trim() || /[\x00-\x1f\x7f]/.test(v) || !/^(user|seat|app|system|node):.+$/.test(v)) {
    throw new HttpError(400, 'id 必须是主体标识（user: / seat: / app: / system: / node: 加一个名）');
  }
  return v;
}

function reasonOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 500) throw new HttpError(400, 'reason 必须是不超过 500 个字符的字符串');
  return v;
}

export function registerPrincipalRoutes(app: HttpService, deps: PrincipalRouteDeps): void {
  /** 是管理员就返回「谁」（留痕里的写法）；不是就已经回了 403，返回 null */
  async function admin(req: express.Request, res: express.Response): Promise<string | null> {
    if (!browserMarked(req) && rawLoopback(req)) return 'cli'; // 本机命令行
    await deps.markOdooAdmin(req);
    return deps.adminGuard(req, res) ? deps.adminActor(req) : null;
  }
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  /** 等管理员对接的清单：登录方式认出了人，却还没对到主体（对上之后自动从清单里消失） */
  app.get('/api/principals/pending', route(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!(await admin(req, res))) return;
    res.json({ pending: principals().pending() });
  }));

  app.get('/api/principals', route(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!(await admin(req, res))) return;
    res.json({ principals: principals().list() });
  }));

  const setStatus = (status: 'active' | 'disabled') => route(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const actor = await admin(req, res);
    if (!actor) return;
    const id = principalId(req.body?.id);
    const reason = reasonOf(req.body?.reason);
    if (status === 'disabled' && actor.startsWith('odoo:')) {
      // 管理员登录的留痕写法是 odoo:<登录名>，冒号后面就是提供方那边的用户标识
      const self = principals().principalOf(identity().providerName() ?? '', actor.slice(5));
      if (self === id) throw new HttpError(409, '不能停用自己');
    }
    const out = principals().setStatus(id, status, actor, reason);
    if (!out) throw new HttpError(404, `principal not found: ${id}`);
    // 停用：这个人的市场会话全部注销（认人时本来就连着主体状态查，停用已经立即生效；注销是让恢复之后也要重新登录）
    if (status === 'disabled') svc<LoginSessionService>('loginSessions').revokeAllFor(id);
    if (out.changed) console.log(JSON.stringify({ source: 'principals', event: status === 'disabled' ? 'disable' : 'restore', id, by: actor, at: new Date().toISOString() }));
    res.json({ ok: true, changed: out.changed, principal: out.principal });
  });
  app.post('/api/principals/disable', setStatus('disabled'));
  app.post('/api/principals/restore', setStatus('active'));

  /** 发请求的管理员自己是哪个主体（管理员登录才有；口令和本机命令行不是主体） */
  const selfOf = (actor: string): string | null => (actor.startsWith('odoo:') ? principals().principalOf(identity().providerName() ?? '', actor.slice(5)) : null);
  const identityOf = (body: any): { provider: string; externalId: string } => {
    const provider = body?.provider, externalId = body?.external_id;
    if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) throw new HttpError(400, 'provider 必须是提供方的名字（小写字母、数字、连字符、下划线）');
    if (typeof externalId !== 'string' || !externalId || externalId.length > 128 || externalId !== externalId.trim() || /[\x00-\x1f\x7f]/.test(externalId)) throw new HttpError(400, 'external_id 必须是对方的用户标识（非空、不超过 128 个字符、两头没有空白、没有控制字符）');
    return { provider, externalId };
  };
  const BIND_REFUSED: Record<string, [number, string]> = {
    conflict: [409, '这个外部身份（或者它的等价写法）已经绑在一个主体上，先解绑'],
    missing: [404, '目标主体不存在；要新建一个人，带上 create: true'],
    taken: [409, '要新建的主体标识和一个已有的主体等价（只差大小写、全角半角之类）'],
    'not-person': [409, '只能绑到人身上'],
    disabled: [409, '目标主体已停用'],
  };

  /** 管理员对一次：把一条外部身份绑到一个人身上（可以同时新建这个人）。不能动自己名下的绑定 */
  app.post('/api/principals/bind', route(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const actor = await admin(req, res);
    if (!actor) return;
    const { provider, externalId } = identityOf(req.body);
    const target = principalId(req.body?.principal);
    if (!target.startsWith('user:')) throw new HttpError(400, 'principal 必须是人（user:<名>）');
    const create = req.body?.create === true;
    const displayName = req.body?.display_name === undefined || req.body?.display_name === null ? null : typeof req.body.display_name === 'string' && req.body.display_name.length <= 256 ? req.body.display_name : (() => { throw new HttpError(400, 'display_name 必须是不超过 256 个字符的字符串'); })();
    const reason = reasonOf(req.body?.reason);
    if (selfOf(actor) === target) throw new HttpError(409, '不能往自己身上绑外部身份');
    const out = principals().bindIdentity({ provider, externalId, principal: target, create, displayName });
    if (!out.ok) { const [status, message] = BIND_REFUSED[out.reason]; return res.status(status).json({ error: message, reason: out.reason, ...(out.principal ? { principal: out.principal } : {}) }); }
    console.log(JSON.stringify({ source: 'principals', event: 'bind', provider, external_id: externalId, id: target, created: out.created, by: actor, reason, at: new Date().toISOString() }));
    res.json({ ok: true, created: out.created, principal: out.principal });
  }));

  /**
   * 成批对接（第一次上线时是一批人）：items 是若干条「外部身份 → 主体」，每条和单条绑定的规则一样，逐条给结果；
   * 一条不成不影响别的条。一次最多 500 条。
   */
  app.post('/api/principals/bind-batch', route(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const actor = await admin(req, res);
    if (!actor) return;
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 500) throw new HttpError(400, 'items 必须是 1～500 条的数组');
    const reason = reasonOf(req.body?.reason);
    const self = selfOf(actor);
    const results = items.map((item: any, index: number) => {
      try {
        const { provider, externalId } = identityOf(item);
        const target = principalId(item?.principal);
        if (!target.startsWith('user:')) throw new HttpError(400, 'principal 必须是人（user:<名>）');
        const displayName = item?.display_name === undefined || item?.display_name === null ? null : typeof item.display_name === 'string' && item.display_name.length <= 256 ? item.display_name : (() => { throw new HttpError(400, 'display_name 必须是不超过 256 个字符的字符串'); })();
        if (self === target) return { index, ok: false, status: 409, error: '不能往自己身上绑外部身份' };
        const out = principals().bindIdentity({ provider, externalId, principal: target, create: item?.create === true, displayName });
        if (!out.ok) { const [status, message] = BIND_REFUSED[out.reason]; return { index, ok: false, status, error: message, reason: out.reason, ...(out.principal ? { principal: out.principal } : {}) }; }
        console.log(JSON.stringify({ source: 'principals', event: 'bind', provider, external_id: externalId, id: target, created: out.created, by: actor, reason, batch: true, at: new Date().toISOString() }));
        return { index, ok: true, created: out.created, principal: target };
      } catch (e) {
        if (e instanceof HttpError) return { index, ok: false, status: e.status, error: e.message };
        return { index, ok: false, status: 400, error: '这一条的形状不对' };
      }
    });
    res.json({ ok: true, bound: results.filter((r: { ok: boolean }) => r.ok).length, results });
  }));

  /** 解绑一条外部身份。不能动自己名下的绑定 */
  app.post('/api/principals/unbind', route(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const actor = await admin(req, res);
    if (!actor) return;
    const { provider, externalId } = identityOf(req.body);
    const reason = reasonOf(req.body?.reason);
    const self = selfOf(actor);
    if (self && principals().principalOf(provider, externalId) === self) throw new HttpError(409, '不能解绑自己名下的外部身份');
    const was = principals().unbindIdentity(provider, externalId);
    if (!was) throw new HttpError(404, `identity not found: ${provider}/${externalId}`);
    // 凭这条身份发出的会话一并注销（查会话时本来就核对这条身份还绑没绑着；注销是让重新绑回去之后也要重新登录）
    svc<LoginSessionService>('loginSessions').revokeForIdentity(provider, externalId);
    console.log(JSON.stringify({ source: 'principals', event: 'unbind', provider, external_id: externalId, id: was, by: actor, reason, at: new Date().toISOString() }));
    res.json({ ok: true, unbound_from: was });
  }));
}
