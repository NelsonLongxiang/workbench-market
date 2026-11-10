/**
 * 主体管理的路由（/api/principals）：列出、停用、恢复。先只做这三件；建主体、改责任人、绑外部身份后面再加。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。
 * 三条都要管理员：本机命令行、有效口令，或管理员登录（和别的管理面同一个口径）。
 * 两条写请求先过 index.ts 的写请求总门，这里再判一次，顺便取到「谁做的」。
 *
 * 停用是本地动作：改的是主体那一行的状态，每个入口认人时现查，所以立即生效，恢复也一样。
 * 应急口令和本机命令行不是主体，停不掉；管理员不能停用自己（把自己锁在外面之后，只能靠口令或本机命令行恢复）。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { PrincipalService } from '../services/principal.ts';
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
    if (out.changed) console.log(JSON.stringify({ source: 'principals', event: status === 'disabled' ? 'disable' : 'restore', id, by: actor, at: new Date().toISOString() }));
    res.json({ ok: true, changed: out.changed, principal: out.principal });
  });
  app.post('/api/principals/disable', setStatus('disabled'));
  app.post('/api/principals/restore', setStatus('active'));
}
