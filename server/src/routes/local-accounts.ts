/**
 * 站内账号的管理（/api/local-accounts，docs/local-accounts.md）：列出、建人、重置密码、解锁；本人改密码。
 *
 * 管理的几条都要管理员（本机命令行、有效口令或管理员登录，和主体管理同一个口径）。停用、恢复、任命管理员不在这里：
 * 停用和恢复用 /api/principals/disable、restore（主体那一层，所有登录方式一起管住），任命走授予（/api/grants）。
 *
 * 建人 = 建一个站内账号 + 新建主体 user:<用户名> + 把外部身份 local/<用户名> 绑上去，一步到位；绑不上就撤回刚建的账号。
 * 临时密码只在建人、重置这一次的应答里出现（不缓存、不进日志），对方下次登录先改密码。
 * 重置密码、本人改密码之后，这个账号已有的市场会话一律注销。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import type { LocalAccountService } from '../services/local-account.ts';
import { USERNAME_RE } from '../services/local-account.ts';
import type { LoginSessionService } from '../services/login-session.ts';
import type { PrincipalService } from '../services/principal.ts';
import { requestPerson } from '../request-person.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { clientIp } from '../login-gate.ts';
import { HttpError } from '../errors.ts';
import { systemAdminTargetRefusal } from '../admin-tier.ts';

export type LocalAccountRouteDeps = {
  /** 按需认定管理员登录（判管理员之前调用） */
  markOdooAdmin: (req: express.Request) => Promise<void>;
  /** 管理门（口令或管理员登录 + 同源）；不过时它自己回 403 */
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  /** 管理员身份落到人（留痕里的写法） */
  adminActor: (req: express.Request) => string;
};

const PROVIDER = 'local';
const accounts = () => svc<LocalAccountService>('localAccounts');
const principals = () => svc<PrincipalService>('principals');
const sessions = () => svc<LoginSessionService>('loginSessions');

function usernameOf(v: unknown): string {
  if (typeof v !== 'string' || !USERNAME_RE.test(v)) throw new HttpError(400, '用户名只能用小写字母、数字和 . _ -，2～32 位，以字母或数字开头');
  return v;
}

const log = (event: string, username: string, by: string) =>
  console.log(JSON.stringify({ source: 'local-accounts', event, username, by, at: new Date().toISOString() }));

export function registerLocalAccountRoutes(app: HttpService, deps: LocalAccountRouteDeps): void {
  async function admin(req: express.Request, res: express.Response): Promise<string | null> {
    if (!browserMarked(req) && rawLoopback(req)) return 'cli'; // 本机命令行
    await deps.markOdooAdmin(req);
    return deps.adminGuard(req, res) ? deps.adminActor(req) : null;
  }
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { res.set('Cache-Control', 'private, no-store'); fn(req, res).catch(next); };

  /** 每个账号连着它对应的主体（没对接的是 null）和主体的状态 */
  const withPrincipal = (a: ReturnType<LocalAccountService['list']>[number]) => {
    const id = principals().principalOf(PROVIDER, a.username);
    const p = id ? principals().get(id) : null;
    return { ...a, principal: id, principal_status: p?.status ?? null };
  };

  app.get('/api/local-accounts', { action: 'local-account.list', kind: 'admin' }, route(async (req, res) => {
    if (!(await admin(req, res))) return;
    res.json({ accounts: accounts().list().map(withPrincipal) });
  }));

  app.post('/api/local-accounts', { action: 'local-account.create', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const made = await accounts().create({ username: req.body?.username, displayName: req.body?.display_name }, actor);
    if (!made.ok) throw new HttpError(made.reason === 'taken' ? 409 : 400, made.message);
    const username = made.account.username;
    const bound = principals().bindIdentity({ provider: PROVIDER, externalId: username, principal: `user:${username}`, create: true, displayName: made.account.display_name || null });
    if (!bound.ok) {
      accounts().remove(username); // 绑不上就撤回刚建的账号，不留一个登不进去的半成品
      throw new HttpError(409, bound.reason === 'taken' || bound.reason === 'conflict' ? '这个用户名不能用（和已有的人重名或等价）' : '没能建出对应的人');
    }
    log('create', username, actor);
    res.status(201).json({ account: withPrincipal(made.account), temp_password: made.tempPassword });
  }));

  app.post('/api/local-accounts/:username/reset-password', { action: 'local-account.reset-password', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const username = usernameOf(req.params.username);
    // 系统管理员不能重置业务侧的人（持 owner 或碰业务的授予）的密码：重置了就能以他的身份登录（admin-tier.ts）
    const guard = systemAdminTargetRefusal(req, principals().principalOf(PROVIDER, username));
    if (guard) return void res.status(403).json(guard);
    const temp = await accounts().resetPassword(username);
    if (temp === null) throw new HttpError(404, '没有这个账号');
    sessions().revokeForIdentity(PROVIDER, username);
    log('reset-password', username, actor);
    res.json({ account: withPrincipal(accounts().get(username)!), temp_password: temp });
  }));

  app.post('/api/local-accounts/:username/unlock', { action: 'local-account.unlock', kind: 'admin' }, route(async (req, res) => {
    const actor = await admin(req, res);
    if (!actor) return;
    const username = usernameOf(req.params.username);
    if (!accounts().unlock(username)) throw new HttpError(404, '没有这个账号');
    log('unlock', username, actor);
    res.json({ account: withPrincipal(accounts().get(username)!) });
  }));

  /**
   * 本人改密码：只认登录着的人自己（市场会话或别的登录方式认出来的主体），而且这个主体名下有站内账号。
   * 原密码要对（同样计输错、同样按来源限额）；改好之后这个账号的市场会话全部注销，要重新登录。
   * 路径段用 _self：用户名不能以 _ 开头，和管理员那几条不会撞。
   */
  app.post('/api/local-accounts/_self/password', { action: 'local-account.change-own-password', kind: 'write', statusNotVerdict: '本人改密码：原密码不对回 403，是核对密码的结论不是授权' }, route(async (req, res) => {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '请求来源不对');
    const who = await requestPerson(req);
    if (!who.principal) throw new HttpError(401, '需要先登录');
    const username = principals().get(who.principal)?.identities.find((i) => i.provider === PROVIDER)?.external_id ?? null;
    if (!username) throw new HttpError(404, '你没有站内账号');
    const r = await accounts().verify(username, req.body?.current, clientIp(req));
    if (!r.ok) throw new HttpError(r.reason === 'throttled' ? 429 : 403, r.reason === 'throttled' ? '尝试太频繁了，请过一分钟再试' : '原密码不对');
    const problem = await accounts().setPassword(username, req.body?.next);
    if (problem) throw new HttpError(400, problem);
    sessions().revokeForIdentity(PROVIDER, username);
    log('change-own-password', username, who.principal);
    res.json({ ok: true, relogin: true });
  }));
}
