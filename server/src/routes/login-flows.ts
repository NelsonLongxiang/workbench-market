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
 *   站内表单（可选，插件有 form 才有）GET/POST /login/<方式>/form?state=
 *     · 先看 state 还有效（是这个方式的、没过期、没用过；不核销）——表单只在一次真正发起了的登录里出现；
 *     · POST 只收小的 urlencoded 请求体，跨站来的一律拒；页面的安全头由这里加（不许内嵌、不缓存、只许提交回本站）；
 *     · 插件交回一页，或者去回调（只认这个方式自己的回调地址，带一次性码），之后和别的方式一样走回调。
 *
 * 失败一律给一页说明，不带任何对方返回的原文；不 302 去任何地方。
 * app 是 HTTP 服务。两条路由都在登录门的放行清单里（还没有身份才需要登录）。
 */
import express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity, SESSION_COOKIE } from '../identity.ts';
import { safeNext, clientIp, holdPage } from '../login-gate.ts';
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

  app.get('/login/:flow', { action: 'login.begin', kind: 'write' }, route(async (req, res) => {
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

  // 站内表单（账号密码之类）：安全头一律由核心加；插件只给页面内容
  const FORM_HEADERS = {
    'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  };
  const formBody = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 8 });
  const formRoute = (method: 'GET' | 'POST') => route(async (req, res) => {
    const flow = String(req.params.flow);
    if (!FLOW_RE.test(flow) || !identity().flowHasForm(flow)) return page(res, 404, '没有这个登录方式', '请回到登录页选一种可用的登录方式。');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    // 提交时刚被换掉的 state 也放进去（双击、浏览器重发）：同一份提交由登录方式拿第一次的结果，内容不一样的它照样当重放拒
    if (!sessions().peekState(flow, state, Date.now(), { recentlyRotated: method === 'POST' })) return page(res, 400, '登录请求无效或已过期', '请回到登录页重新登录。');
    let fields: Record<string, string> = {};
    if (method === 'POST') {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return page(res, 403, '请求来源不对', '请回到登录页重新登录。');
      if (!req.is('application/x-www-form-urlencoded')) return page(res, 415, '请求格式不对', '请回到登录页重新登录。');
      const parsed = await new Promise<boolean>((ok) => formBody(req, res, (err?: unknown) => ok(!err)));
      if (!parsed) return page(res, 400, '请求格式不对', '请回到登录页重新登录。');
      for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) if (typeof v === 'string') fields[k] = v;
    }
    const view = typeof req.query.view === 'string' && /^[a-z]{1,16}$/.test(req.query.view) ? req.query.view : '';
    // 请求断开了（还没回应答就关了连接）：告诉登录方式，排着队的核对不再排、不再算
    const gone = new AbortController();
    // 挂在响应上：请求体读完时请求那一侧的 close 已经过了；响应的 close 在连接断开（或回完）时才来，没回完就是断了
    const onClose = (): void => { if (!res.writableEnded) gone.abort(); };
    res.once('close', onClose);
    let out;
    try { out = await identity().flowForm(flow, { method, state, callbackUrl: callbackUrl(flow), fields, source: clientIp(req), view, signal: gone.signal }); }
    finally { res.off('close', onClose); }
    fields = {};
    if (out.kind === 'redirect') return res.set('Cache-Control', 'no-store').redirect(302, out.location);
    if (!out.html) return page(res, out.status === 404 ? 404 : 503, '登录方式暂时不可用', '请稍后再试，或者换一种登录方式。');
    res.status(out.status).set(FORM_HEADERS).type('html').send(out.html);
  });
  app.get('/login/:flow/form', { action: 'login.form', kind: 'read' }, formRoute('GET'));
  app.post('/login/:flow/form', { action: 'login.form-submit', kind: 'write', statusNotVerdict: '站内表单：用户名或密码不对回 401，是登录方式的结论不是授权' }, formRoute('POST'));

  app.get('/login/:flow/callback', { action: 'login.callback', kind: 'write', statusNotVerdict: '登录回调：外人、别的租户回 403，是登录方式的结论不是授权' }, route(async (req, res) => {
    const flow = String(req.params.flow);
    res.clearCookie(STATE_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secure(req), path: `/login/${flow}/callback` });
    if (!FLOW_RE.test(flow)) return page(res, 404, '没有这个登录方式', '请回到登录页重新登录。');
    const taken = sessions().takeState(flow, req.query.state, cookieOf(req, STATE_COOKIE));
    if (!taken) return page(res, 400, '登录请求无效或已过期', '请回到登录页重新登录。');
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string' && k !== 'state') query[k] = v;
    // 有站内表单的方式（账号密码）把一次性码绑在 state 上：核销过的 state 交给它核对
    const done = await identity().completeFlow(flow, query, { callbackUrl: callbackUrl(flow), ...(identity().flowHasForm(flow) ? { state: String(req.query.state ?? '') } : {}) });
    if (!done.ok) return page(res, done.http >= 500 ? 502 : done.http, '登录没有完成', done.http === 401 ? '没有同意授权。' : done.http === 403 ? '这个账号不能登录本站。' : '没能从登录方式那边确认你是谁，请稍后再试。');
    const who = done.identity;
    if (who.outsider) {
      // 不是本组织的人（插件说的，比如飞书租户不符）：只进待对接清单并留痕，不对主体、不自动绑定、不发会话——哪怕他的身份被绑过
      principals().notePending({ provider: flow, externalId: who.externalId, displayName: who.displayName, email: who.email });
      console.log(JSON.stringify({ source: 'login', event: 'outsider', flow, external_id: who.externalId, at: new Date().toISOString() }));
      return holdPage(res);
    }
    let admitted = principals().admitBound({ provider: flow, externalId: who.externalId });
    // 自动对上只用插件确认过来自本组织的邮箱（emailTrusted），别的组织的人哪怕邮箱相同也不绑
    if (admitted.ok === false && admitted.reason === 'unbound' && who.email && who.emailTrusted && identity().flowAutoBindsByEmail(flow)) {
      admitted = principals().bindByEmail({ provider: flow, externalId: who.externalId, email: who.email, against: identity().providerName() ?? '' });
      if (admitted.ok) console.log(JSON.stringify({ source: 'principals', event: 'bind', provider: flow, external_id: who.externalId, id: admitted.principal, by: 'auto:email', at: new Date().toISOString() }));
    }
    if (!admitted.ok) {
      // 停用的和还没对到主体的，给同一页、同一个状态码：等待页不透露系统里有没有这个人、是不是被停用了
      if (admitted.reason !== 'disabled') principals().notePending({ provider: flow, externalId: who.externalId, displayName: who.displayName, email: who.email });
      return holdPage(res);
    }
    const session = sessions().createSession(admitted.principal, flow, who.externalId, deps.sessionTtlMs);
    res.cookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'lax', secure: secure(req), path: '/', maxAge: session.expiresAt - Date.now() });
    console.log(JSON.stringify({ source: 'login', event: 'session', flow, id: admitted.principal, at: new Date().toISOString() }));
    res.set('Cache-Control', 'no-store').redirect(302, taken.next);
  }));
}
