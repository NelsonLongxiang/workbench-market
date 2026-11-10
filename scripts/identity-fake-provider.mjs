/**
 * 假的登录提供方（测试夹具）。身份对抗组用它顶替自带的提供方，不访问任何真实的外部系统。
 *
 * 顶替的办法就是契约说的那一种：卸掉清单里的插件（它登记的提供方和中继随之撤销），再装一个插件。
 * 核心一行不改，也没有给测试留后门。
 *
 * 认人只看 session_id 的值：一个值一种回答，见 ANSWERS。
 *
 * 只在测试环境里可用（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能让它在别的环境里把提供方换掉。
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
  // 下面几种，主体都照着登录名写、还自称管理员：只有各自那一条校验拦得住
  paddedLogin: 'fake-login-with-padding1', // 登录名前面带空格
  controlLogin: 'fake-login-control-char1', // 登录名里有控制字符
  longLogin: 'fake-login-too-long-0001', // 登录名 129 个字符
  numericLogin: 'fake-login-is-a-number-1', // 登录名是数字，不是字符串
  stringUid: 'fake-uid-is-a-string-001', // uid 是字符串
  missingUid: 'fake-uid-is-missing-0001', // 没有 uid
  numberName: 'fake-name-is-a-number-01', // 显示名是数字
  missingName: 'fake-name-is-missing-001', // 没有显示名这一项（契约要求 null 或字符串）
  refusal200: 'fake-refusal-says-200-01', // 说认不出，状态码却是 200
  refusal302: 'fake-refusal-says-302-01', // 说认不出，状态码是 302
  refusalNoText: 'fake-refusal-no-reason-1', // 说认不出，却没有说法
  hangs: 'fake-provider-never-answers', // 永远不回答
  okThrows: 'fake-answer-ok-getter-throws', // 回答对象的 ok 一读就抛错
  viewerThrows: 'fake-answer-viewer-throws-1', // 回答对象的 viewer 一读就抛错
  flipLogin: 'fake-login-flips-on-reread', // 登录名头两次读是 alpha，再读就成了 root-admin
};

/** 假提供方自报的期限：永远不回答的那一种，到点就按不可用处理 */
export const DEADLINE_MS = 250;

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
  [SESSIONS.paddedLogin]: () => viewer(' padded', 21, { admin: true }),
  [SESSIONS.controlLogin]: () => viewer('ctl\u0007char', 22, { admin: true }),
  [SESSIONS.longLogin]: () => viewer('x'.repeat(129), 23, { admin: true }),
  [SESSIONS.numericLogin]: () => ({ ok: true, viewer: { login: 5, uid: 24, sub: 'user:5', name: null, admin: true } }),
  [SESSIONS.stringUid]: () => ({ ok: true, viewer: { login: 'uid-string', uid: '25', sub: 'user:uid-string', name: null, admin: true } }),
  [SESSIONS.missingUid]: () => ({ ok: true, viewer: { login: 'uid-missing', sub: 'user:uid-missing', name: null, admin: true } }),
  [SESSIONS.numberName]: () => ({ ok: true, viewer: { login: 'name-number', uid: 26, sub: 'user:name-number', name: 123, admin: true } }),
  [SESSIONS.missingName]: () => ({ ok: true, viewer: { login: 'name-missing', uid: 27, sub: 'user:name-missing', admin: true } }),
  [SESSIONS.refusal200]: () => ({ ok: false, http: 200, error: '合成：说认不出，状态码却是 200' }),
  [SESSIONS.refusal302]: () => ({ ok: false, http: 302, error: '合成：说认不出，状态码是 302' }),
  [SESSIONS.refusalNoText]: () => ({ ok: false, http: 401 }),
  [SESSIONS.hangs]: () => new Promise(() => {}),
  [SESSIONS.okThrows]: () => ({ get ok() { throw new Error('synthetic accessor failure'); } }),
  [SESSIONS.viewerThrows]: () => ({ ok: true, get viewer() { throw new Error('synthetic accessor failure'); } }),
  [SESSIONS.flipLogin]: () => { let reads = 0; return { ok: true, viewer: { get login() { reads++; return reads <= 2 ? 'alpha' : 'root-admin'; }, uid: 11, sub: 'user:alpha', name: null, admin: false } }; },
};

const sessionOf = (cookieHeader) => /(?:^|;\s*)session_id=([^;\s]+)/.exec(String(cookieHeader ?? ''))?.[1] ?? '';

export const fakeProvider = {
  name: 'fake',
  deadlineMs: DEADLINE_MS,
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

/** 不是测试环境就不干活：预加载、换提供方的函数、插件自己，三处都先过这一道 */
export function assertTestEnv() {
  if (process.env.NODE_ENV !== 'test') throw new Error('identity-fake-provider 是测试夹具：只在 NODE_ENV=test 下可用');
}

export const fakePlugin = {
  name: 'login-provider-fake',
  inject: ['identity'],
  apply(ctx) {
    assertTestEnv();
    ctx.effect(() => ctx.get('identity').register(fakeProvider), 'identity.register(fake)');
    ctx.provide('loginRelay', fakeRelay);
  },
};

/** 在 treeRoot 这棵目录树的上下文里卸掉自带的提供方。返回这棵树的 { root, identity, loginRelay }。 */
export async function unloadShipped(treeRoot) {
  assertTestEnv();
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
  assertTestEnv();
  const tree = await unloadShipped(treeRoot);
  if (tree.identity().providerName() !== null) throw new Error('自带的登录提供方没有卸干净');
  const fiber = tree.root.plugin(fakePlugin);
  await fiber;
  if (tree.identity().providerName() !== 'fake') throw new Error('假的登录提供方没有装上');
  return { ...tree, fiber };
}
