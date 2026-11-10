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

const provider: LoginProvider = {
  name: 'odoo',
  configured: () => odooUrl() !== '',
  credentialOf: odooSessionOf,
  resolveViewer: (cookieHeader, source) => resolveOdooViewer(cookieHeader, source),
};

const relay: LoginRelay = {
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
  browserOrigin: odooBrowserOrigin,
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
