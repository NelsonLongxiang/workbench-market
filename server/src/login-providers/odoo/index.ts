/**
 * 登录提供方插件：Odoo。把原有实现原样包成插件，两件事：
 *   - 身份来源：向 identity 服务登记一个登录提供方（浏览器带来的 Odoo 会话 → 现查登录名、是否内部员工、是否管理员）；
 *   - 业务台的登录中继：提供 loginRelay 服务（会话只转给可信源、回调票据、同域登录中继、浏览器登录地址）。
 * 核心不引用本目录里的文件，只经 identity.ts 的契约用到它。
 *
 * 从 identity.ts 只引用类型：那边在装配时引用本插件，带值的引用会绕成环。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IdentityService, LoginProvider, LoginRelay } from '../../identity.ts';
import { odooUrl, resolveOdooViewer } from './odoo-viewer.ts';
import {
  addOdooReturnPath, consumeSsoCallback, isOdooLikeTarget, isOdooSessionTarget, issueSsoCallback, odooSessionOf, odooUrlDeprecated,
  safeReturnPath, setSsoTargetLookup, setSsoTicketStore, stripOdooSession, trustedOdooOrigins,
} from './odoo-session.ts';
import { installOdooLoginProxy, odooLoginProxyRoute, revokeOdooSession } from './odoo-login-proxy.ts';
import { browserLoginOrigin, odooBrowserOrigin } from './odoo-browser-origin.ts';

/** Odoo 的会话 cookie 名，和它的值能是什么样子（只用于严格入口的形状检查） */
const SESSION_COOKIE = 'session_id';
const SESSION_VALUE = /^[A-Za-z0-9_.=-]{16,512}$/;
/** Odoo 会话号里轮换时保持不变的前缀长度（Odoo 19 http.py 的 STORED_SESSION_BYTES） */
const SAME_SESSION_PREFIX = 42;

const provider: LoginProvider = {
  name: 'odoo',
  configured: () => odooUrl() !== '',
  credentialOf: odooSessionOf,
  resolveViewer: (cookieHeader, source) => resolveOdooViewer(cookieHeader, source),
  // 登录之后由市场维持会话：市场存下这次的 Odoo 会话号，之后照旧拿它问 Odoo（浏览器里的 Odoo cookie 过期了也不掉登录）
  credentialHeader: (sid) => {
    if (!SESSION_VALUE.test(sid)) throw new Error('Odoo 会话号形状不对');
    return `${SESSION_COOKIE}=${sid}`;
  },
  // Odoo 软轮换前后的两个号前 42 个字符相同（STORED_SESSION_BYTES），后半段换掉；前缀相同就是同一个会话
  sameSession: (a, b) => a.length > SAME_SESSION_PREFIX && b.length > SAME_SESSION_PREFIX && a.slice(0, SAME_SESSION_PREFIX) === b.slice(0, SAME_SESSION_PREFIX),
};
const sessionEntries = (cookieHeader: string): string[] => String(cookieHeader ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(`${SESSION_COOKIE}=`));

const relay: LoginRelay = {
  relayLogin: () => process.env.WM_ODOO_LOGIN_PROXY === '1',
  sessionCookieName: () => SESSION_COOKIE,
  sessionEntries,
  soleSession: (cookieHeader) => {
    const all = sessionEntries(cookieHeader);
    return all.length === 1 && SESSION_VALUE.test(all[0].slice(SESSION_COOKIE.length + 1)) ? all[0] : '';
  },
  sourceUrl: odooUrl,
  legacyConfig: odooUrlDeprecated,
  sessionOf: odooSessionOf,
  stripSession: stripOdooSession,
  isSessionTarget: isOdooSessionTarget,
  trustedOrigins: trustedOdooOrigins,
  looksLikeTarget: isOdooLikeTarget,
  safeReturnPath,
  addReturnPath: addOdooReturnPath,
  useTicketStore: setSsoTicketStore,
  useTargetLookup: setSsoTargetLookup,
  issueCallback: issueSsoCallback,
  consumeCallback: consumeSsoCallback,
  browserOrigin: () => {
    const configured = odooBrowserOrigin();
    // 原来写在 portal.ts 里的启动提示，挪到提供方自己说（核心不再知道这家登录的配置名）；门户启动时只调这一次
    if (configured && process.env.WM_ODOO_LOGIN_PROXY === '1') console.warn('[portal] WM_ODOO_LOGIN_PROXY=1 时同域中继优先，WM_ODOO_BROWSER_URL 对中继覆盖的 Odoo 台不生效');
    return configured;
  },
  browserLoginOrigin,
  install: installOdooLoginProxy,
  publicRoute: (method, pathname) => odooLoginProxyRoute(method, pathname),
  revokeSession: revokeOdooSession,
};

export const name = 'login-provider-odoo';
export const inject = ['identity'];

/** 两样注册都跟着插件走：插件卸载，提供方和中继一并撤销 */
export function apply(ctx: Context): void {
  ctx.effect(() => (ctx.get('identity') as IdentityService).register(provider), 'identity.register(odoo)');
  ctx.provide('loginRelay', relay);
}
