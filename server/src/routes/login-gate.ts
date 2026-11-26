/**
 * 登录门的四条路由：登录页 GET /login、口令登录 POST /api/auth/login、登出 POST /api/auth/logout、我是谁 GET /api/auth/me。
 * 原样搬自 login-gate.ts 的 mount()，一个字没改，只少了两格缩进、多了报给 HTTP 服务的动作。
 * 登录 cookie 的签发与校验、限频、同源判断、认人都留在 login-gate.ts（拦截中间件也用），经参数传进来。
 *
 * app 是 HTTP 服务，不是 Express 应用本身：注册的写法和 Express 一样，路由挂在调用那一刻的位置，注册可以撤销。
 * 四条都在登录门的放行范围里（还没有身份才需要登录）。
 */
import type express from 'express';
import type { IncomingMessage } from 'node:http';
import type { HttpService } from '../http.ts';
import { identity as identityService, IDENTITY_UNAVAILABLE, SESSION_COOKIE } from '../identity.ts';
import { clientIp, loginPage, safeNext, LOGIN_COOKIE, SESSION_MS, type Identity, type LoginGateDeps } from '../login-gate.ts';

/** 从 login-gate.ts 传进来的：登录门的配置、留痕、限频、同源判断、登录 cookie 的签发与校验、已登出的 cookie、认人 */
export type LoginGateRouteDeps = {
  deps: LoginGateDeps;
  log: (row: object) => void;
  rateCheck: (ip: string) => { ok: true } | { ok: false; retryS: number };
  rateResult: (ip: string, ok: boolean) => void;
  sameOrigin: (req: express.Request) => boolean;
  secure: (req: express.Request) => boolean;
  setLoginCookie: (req: express.Request, res: express.Response, value: string, maxAgeMs: number) => void;
  issueCookie: () => { value: string; exp: number };
  verifyCookie: (raw: string) => { jti: string; exp: number } | null;
  cookieValue: (req: IncomingMessage) => string;
  revoked: Map<string, number>;
  identity: (req: IncomingMessage) => Promise<Identity | null>;
  sourceUnavailable: (req: IncomingMessage) => boolean;
};

export function registerLoginGateRoutes(app: HttpService, routeDeps: LoginGateRouteDeps): void {
  const { deps, log, rateCheck, rateResult, sameOrigin, secure, setLoginCookie, issueCookie, verifyCookie, cookieValue, revoked, identity, sourceUnavailable } = routeDeps;
  app.get('/login', { action: 'login.page', kind: 'read' }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.type('html').send(loginPage(safeNext(req.query.next), deps.tokensCss(), deps.mode, deps.loginFlows?.() ?? []));
  });
  app.post('/api/auth/login', { action: 'auth.login', kind: 'write', statusNotVerdict: '口令登录：口令不对 401、跨源 403、太频繁 429，是认口令和同源、限频的结果，不是授权的结论' }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return res.status(403).json({ error: '跨源登录被拒绝' });
    const ip = clientIp(req);
    const rc = rateCheck(ip);
    if (!rc.ok) { res.setHeader('Retry-After', String(rc.retryS)); return res.status(429).json({ error: '尝试过于频繁，请稍后再试', retry_after_s: rc.retryS }); }
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const ok = token.length > 0 && token.length <= 256 && deps.adminTokenFingerprint() !== '' && deps.adminTokenCheck(token);
    rateResult(ip, ok);
    log({ source: 'login-gate', event: 'login', ok, ip, at: new Date().toISOString() }); // 只记结果、来源与时间，不记口令
    if (!ok) return res.status(401).json({ error: '口令无效' }); // 口令错与未设置口令同答
    const c = issueCookie();
    setLoginCookie(req, res, c.value, SESSION_MS);
    res.json({ ok: true, expires_at: new Date(c.exp).toISOString() });
  });
  app.post('/api/auth/logout', { action: 'auth.logout', kind: 'write', statusNotVerdict: '登出：跨源 403，是同源检查的结果，不是授权的结论' }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return res.status(403).json({ error: '跨源登出被拒绝' });
    const cookie = String(req.headers.cookie ?? '');
    const v = verifyCookie(cookieValue(req));
    if (v) {
      revoked.set(v.jti, v.exp);
      for (const [j, exp] of revoked) if (exp <= Date.now()) revoked.delete(j);
    }
    res.clearCookie(LOGIN_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: secure(req) });
    // 市场会话：注销即失效（库里记下 revoked_at），浏览器那边也清掉
    const marketSession = identityService().endSession(cookie);
    if (marketSession) res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: secure(req) });
    return res.json({ ok: true });
  });
  app.get('/api/auth/me', { action: 'auth.me', kind: 'read' }, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      res.vary('Cookie');
      const id = await identity(req);
      if (deps.mode === 'enforce' && sourceUnavailable(req)) {
        return res.status(502).json({ error: IDENTITY_UNAVAILABLE, message: '登录服务暂时联系不上，稍后再试' });
      }
      // 只有认出了人（市场会话、身份来源）才有主体和角色；口令、本机命令行、没登录：principal 为 null、roles 为空
      const person = id && (id.via === 'source' || id.via === 'session');
      const extra = person && deps.profile ? await deps.profile(req) : { principal: null, display_name: null, roles: [] };
      const can = deps.can ? await deps.can(req) : undefined;
      res.json({ gate: deps.mode, authenticated: !!id, via: id?.via ?? null, login: id?.login ?? null, ...extra, ...(can ? { can } : {}) });
    } catch (e) { next(e); }
  });
}
