/**
 * 登录方式的路由（/login/<方式>、/login/<方式>/callback）。哪一家都一样：飞书、以后别的，都是登记在身份服务后面的登录方式（LoginFlow）。
 * 核心只管通用的几步，和对方打交道的两步交给插件（identity().beginFlow / completeFlow）：
 *
 *   发起  GET /login/<方式>?next=<站内地址>
 *     · next 只收站内路径，复用登录门的防外跳（safeNext）；
 *     · 签一个 state（库里只存哈希），同时把「浏览器半边」放进一个只发给回调路径的 cookie——state 绑在发起它的浏览器上；
 *     · 按来源限额；302 到插件给的授权页。
 *   回调  GET /login/<方式>/callback?state=&code=
 *     · state 一次性：在、没过期、是这个方式的、浏览器半边对得上，才核销（伪造、重放、换个浏览器用，都不行）；
 *     · 插件去对方那边认出「这是谁」（union_id 之类），形状不对按认不出；
 *     · 对到主体：已经绑定的外部身份取出它的主体；没绑定的——按邮箱自动对上（插件的开关，缺省关），或者停在「等管理员对接」；
 *       主体停用就不认；
 *     · 发市场会话（绝对期限、不续期），302 回当初的 next。
 *
 * 失败一律给一页说明，不带任何对方返回的原文；不 302 去任何地方。
 * app 是 HTTP 服务。两条路由都在登录门的放行清单里（还没有身份才需要登录）。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity, SESSION_COOKIE } from '../identity.ts';
import { safeNext, clientIp } from '../login-gate.ts';
import type { LoginSessionService } from '../services/login-session.ts';
import type { PrincipalService } from '../services/principal.ts';

export type LoginFlowRouteDeps = {
  /** 市场对外地址（MARKET_PUBLIC_URL）：回调地址按它拼，要和对方应用里登记的一致；不信请求自带的 Host */
  publicUrl: () => string;
  /** 会话的绝对期限（毫秒） */
  sessionTtlMs: number;
};

/** 浏览器半边放在这个 cookie 里，只发给回调路径 */
const STATE_COOKIE = 'wm_login_state';
const FLOW_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const sessions = () => svc<LoginSessionService>('loginSessions');
const principals = () => svc<PrincipalService>('principals');

function page(res: express.Response, status: number, title: string, text: string): void {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.status(status).set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" })
    .type('html').send(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/login">回到登录页</a></p>`);
}

const secure = (req: express.Request): boolean => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
const cookieOf = (req: express.Request, name: string): string => {
  const hits = String(req.headers.cookie ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(`${name}=`));
  return hits.length === 1 ? hits[0].slice(name.length + 1) : ''; // 同名多个按没有：不继承「取第一个」的歧义
};

export function registerLoginFlowRoutes(app: HttpService, deps: LoginFlowRouteDeps): void {
  const callbackUrl = (flow: string) => `${deps.publicUrl().replace(/\/+$/, '')}/login/${flow}/callback`;
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  app.get('/login/:flow', route(async (req, res) => {
    const flow = String(req.params.flow);
    if (!FLOW_RE.test(flow) || !identity().flows().some((f) => f.name === flow)) return page(res, 404, '没有这个登录方式', '请回到登录页选一种可用的登录方式。');
    const next = safeNext(req.query.next);
    const issued = sessions().issueState(flow, next, clientIp(req));
    if (!issued) { res.set('Retry-After', '60'); return page(res, 429, '登录请求太频繁', '请稍后再试。'); }
    const begun = await identity().beginFlow(flow, { state: issued.state, callbackUrl: callbackUrl(flow) });
    if (!begun.ok) return page(res, begun.http === 404 ? 404 : 503, '登录方式暂时不可用', '请稍后再试，或者换一种登录方式。');
    res.cookie(STATE_COOKIE, issued.browser, { httpOnly: true, sameSite: 'lax', secure: secure(req), path: `/login/${flow}/callback`, maxAge: issued.expiresAt - Date.now() });
    res.set('Cache-Control', 'no-store').redirect(302, begun.location);
  }));

  app.get('/login/:flow/callback', route(async (req, res) => {
    const flow = String(req.params.flow);
    res.clearCookie(STATE_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secure(req), path: `/login/${flow}/callback` });
    if (!FLOW_RE.test(flow)) return page(res, 404, '没有这个登录方式', '请回到登录页重新登录。');
    const taken = sessions().takeState(flow, req.query.state, cookieOf(req, STATE_COOKIE));
    if (!taken) return page(res, 400, '登录请求无效或已过期', '请回到登录页重新登录。');
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string' && k !== 'state') query[k] = v;
    const done = await identity().completeFlow(flow, query, { callbackUrl: callbackUrl(flow) });
    if (!done.ok) return page(res, done.http >= 500 ? 502 : done.http, '登录没有完成', done.http === 401 ? '没有同意授权。' : done.http === 403 ? '这个账号不能登录本站。' : '没能从登录方式那边确认你是谁，请稍后再试。');
    const who = done.identity;
    let admitted = principals().admitBound({ provider: flow, externalId: who.externalId });
    if (admitted.ok === false && admitted.reason === 'unbound' && who.email && identity().flowAutoBindsByEmail(flow)) {
      admitted = principals().bindByEmail({ provider: flow, externalId: who.externalId, email: who.email, against: identity().providerName() ?? '' });
      if (admitted.ok) console.log(JSON.stringify({ source: 'principals', event: 'bind', provider: flow, external_id: who.externalId, id: admitted.principal, by: 'auto:email', at: new Date().toISOString() }));
    }
    if (!admitted.ok) {
      // 停用的和还没对到主体的，给同一页、同一个状态码：等待页不透露系统里有没有这个人、是不是被停用了
      if (admitted.reason !== 'disabled') principals().notePending({ provider: flow, externalId: who.externalId, displayName: who.displayName, email: who.email });
      return page(res, 403, '等管理员处理', '你的账号现在还不能登录本站，请联系管理员。');
    }
    const session = sessions().createSession(admitted.principal, flow, who.externalId, deps.sessionTtlMs);
    res.cookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'lax', secure: secure(req), path: '/', maxAge: session.expiresAt - Date.now() });
    console.log(JSON.stringify({ source: 'login', event: 'session', flow, id: admitted.principal, at: new Date().toISOString() }));
    res.set('Cache-Control', 'no-store').redirect(302, taken.next);
  }));
}
