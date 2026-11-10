/**
 * 假的登录提供方（测试夹具）。身份对抗组用它顶替自带的提供方，不访问任何真实的外部系统。
 *
 * 顶替的办法就是契约说的那一种：卸掉清单里的插件（它登记的提供方和中继随之撤销），再装一个插件。
 * 核心一行不改，也没有给测试留后门。
 *
 * 认人只看 session_id 的值：一个值一种回答，见 ANSWERS。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const viewer = (login, uid, extra = {}) => ({ ok: true, viewer: { login, uid, sub: `user:${login}`, name: `Synthetic ${login}`, ...extra } });

/** 会话值 → 提供方的回答。会话值都够 16 位，合乎核心对会话形状的检查。 */
export const SESSIONS = {
  alpha: 'fake-internal-alpha-0001', // 内部员工，不是管理员
  beta: 'fake-internal-beta-00001', // 另一个内部员工
  admin: 'fake-internal-admin-0001', // 管理员
  forged: 'fake-forged-session-0001', // 提供方不认的会话
  unreachable: 'fake-source-unreachable1', // 身份来源不可达
  throws: 'fake-provider-throws-001', // 提供方自己抛错
  portal: 'fake-portal-account-0001', // 非内部账号
  noAdminFlag: 'fake-admin-flag-missing1', // 回答里没有管理员标记
  truthyAdmin: 'fake-admin-flag-truthy-1', // 管理员标记是字符串 "true"
  malformed: 'fake-malformed-answer-01', // ok:true 但没有查看者
  impersonate: 'fake-sub-impersonation-1', // 登录名是 mallory，主体却写成 user:alpha
};

const ANSWERS = {
  [SESSIONS.alpha]: () => viewer('alpha', 11, { admin: false }),
  [SESSIONS.beta]: () => viewer('beta', 12, { admin: false }),
  [SESSIONS.admin]: () => viewer('root-admin', 1, { admin: true }),
  [SESSIONS.unreachable]: () => ({ ok: false, http: 502, error: '身份来源不可达（合成）' }),
  [SESSIONS.throws]: () => { throw new Error('synthetic provider failure'); },
  [SESSIONS.portal]: () => ({ ok: false, http: 403, error: '非内部账号（合成）' }),
  [SESSIONS.noAdminFlag]: () => viewer('no-flag', 13),
  [SESSIONS.truthyAdmin]: () => viewer('truthy-flag', 14, { admin: 'true' }),
  [SESSIONS.malformed]: () => ({ ok: true }),
  [SESSIONS.impersonate]: () => ({ ok: true, viewer: { login: 'mallory', uid: 15, sub: 'user:alpha', name: null, admin: true } }),
};

const sessionOf = (cookieHeader) => /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(cookieHeader ?? ''))?.[1] ?? '';

export const fakeProvider = {
  name: 'fake',
  configured: () => true,
  credentialOf: sessionOf,
  async resolveViewer(cookieHeader) {
    const sid = sessionOf(cookieHeader);
    if (!sid) return { ok: false, http: 401, error: '没有会话（合成）' };
    const answer = ANSWERS[sid];
    return answer ? answer() : { ok: false, http: 401, error: '会话无效（合成）' };
  },
};

/** 假的登录中继：不给任何地址转会话，不开任何登录面。 */
export const fakeRelay = {
  sourceUrl: () => 'http://identity-source.invalid',
  legacyConfig: () => null,
  sessionOf,
  stripSession(headers) {
    const raw = Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie;
    if (!raw) return;
    const kept = raw.split(';').map((c) => c.trim()).filter((c) => c && !c.startsWith('session_id=')).join('; ');
    if (kept) headers.cookie = kept; else delete headers.cookie;
  },
  isSessionTarget: () => false,
  trustedOrigins: () => ({ origins: new Set(), invalid: [] }),
  looksLikeTarget: () => false,
  safeReturnPath: () => null,
  addReturnPath() {},
  useTicketStore() {},
  useTargetLookup() {},
  issueCallback: () => null,
  consumeCallback: () => false,
  browserOrigin: () => null,
  browserLoginOrigin: (target) => target,
  install() {},
  publicRoute: () => false,
  revokeSession: async () => false,
};

export const fakePlugin = {
  name: 'login-provider-fake',
  inject: ['identity'],
  apply(ctx) {
    ctx.effect(() => ctx.get('identity').register(fakeProvider), 'identity.register(fake)');
    ctx.provide('loginRelay', fakeRelay);
  },
};

/** 在 treeRoot 这棵目录树的上下文里卸掉自带的提供方。返回这棵树的 { root, identity, loginRelay }。 */
export async function unloadShipped(treeRoot) {
  const at = (p) => pathToFileURL(join(treeRoot, p)).href;
  const { root } = await import(at('server/src/root-context.ts'));
  const contract = await import(at('server/src/identity.ts')); // 装配在这一步做完：自带的提供方已经装上
  const { loginProviders } = await import(at('server/src/login-providers/index.ts'));
  for (const plugin of loginProviders) {
    for (const fiber of [...(root.registry.get(plugin)?.fibers ?? [])]) await fiber.dispose();
  }
  return { root, identity: contract.identity, loginRelay: contract.loginRelay };
}

/** 卸掉自带的，装上假的。 */
export async function swapInFake(treeRoot) {
  const tree = await unloadShipped(treeRoot);
  if (tree.identity().providerName() !== null) throw new Error('自带的登录提供方没有卸干净');
  const fiber = tree.root.plugin(fakePlugin);
  await fiber;
  if (tree.identity().providerName() !== 'fake') throw new Error('假的登录提供方没有装上');
  return { ...tree, fiber };
}
