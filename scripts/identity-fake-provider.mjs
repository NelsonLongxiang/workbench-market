/**
 * 假的登录提供方（测试夹具）。身份对抗组用它顶替自带的提供方，不访问任何真实的外部系统。
 *
 * 顶替的办法就是契约说的那一种：卸掉清单里的插件（它登记的提供方和中继随之撤销），再装一个插件。
 * 核心一行不改，也没有给测试留后门。
 *
 * 认人只看 session_id 的值：一个值一种回答，见 ANSWERS。
 * 另有一类「只认第一次」的会话（onceSession）：提供方第一次被问到时认得出，之后都说会话失效——
 * 用来看核心有没有在该现查的地方用了缓存、该用缓存的地方现查。
 *
 * 主体目录：起真实入口的测试用真的（services/principal.ts，开库）；进程内不开库的测试用这里的内存版（memoryDirectory）。
 *
 * 只在测试环境里可用（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能让它在别的环境里把提供方换掉。
 */
import { existsSync } from 'node:fs';
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
  flaky: 'fake-flaky-source-000001', // 数据目录里有 fake-identity-down 时不回答，没有时认成 alpha：看来源恢复后不用重启就好
  lateLogin: 'fake-logs-in-later-00001', // 数据目录里有 fake-identity-logged-in 之前说认不出（401），之后认成 alpha：看刚登录的同一个凭据下一次就认得出
  okThrows: 'fake-answer-ok-getter-throws', // 回答对象的 ok 一读就抛错
  viewerThrows: 'fake-answer-viewer-throws-1', // 回答对象的 viewer 一读就抛错
  flipLogin: 'fake-login-flips-on-reread', // 登录名头两次读是 alpha，再读就成了 root-admin
  squatter: 'fake-squatter-session-01', // 登录名 squatted，自称管理员：测「标识已被别的主体占着」时用，别处不要认它
  // 和 alpha 是同一个写法的等价变体（同一个 uid）：只能被拒，不能另建主体，更不能绕过 alpha 的停用
  alphaUpper: 'fake-alpha-upper-case-01', // 登录名 Alpha
  alphaWide: 'fake-alpha-full-width-01', // 登录名是全角的 ａｌｐｈａ
  alphaZeroWidth: 'fake-alpha-zero-width-01', // 登录名 al<零宽空格>pha
  strasse: 'fake-strasse-lowercase-01', // 登录名 strasse
  strasseCapitalSharpS: 'fake-strasse-capital-sharp-s', // 同一个 uid，登录名 stra<大写 ẞ>e（验收 M1′）
};

/** 「只认第一次」的会话：login 是认出来的登录名；admin 为真时第一次的回答自称管理员 */
export const onceSession = (login, admin = false) => `fake-once-${admin ? 'admin' : 'staff'}-${login}`;
const ONCE_RE = /^fake-once-(admin|staff)-([a-z0-9-]{1,40})$/;
const onceAsked = new Set();

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
  [SESSIONS.lateLogin]: () => (existsSync(join(process.env.DATA_DIR ?? '', 'fake-identity-logged-in')) ? viewer('alpha', 11, { admin: false }) : { ok: false, http: 401, error: '会话还没登录（合成）' }),
  [SESSIONS.flaky]: () => (existsSync(join(process.env.DATA_DIR ?? '', 'fake-identity-down')) ? new Promise(() => {}) : viewer('alpha', 11, { admin: false })),
  [SESSIONS.okThrows]: () => ({ get ok() { throw new Error('synthetic accessor failure'); } }),
  [SESSIONS.viewerThrows]: () => ({ ok: true, get viewer() { throw new Error('synthetic accessor failure'); } }),
  [SESSIONS.squatter]: () => viewer('squatted', 31, { admin: true }),
  [SESSIONS.alphaUpper]: () => viewer('Alpha', 11, { admin: false }),
  [SESSIONS.alphaWide]: () => viewer('\uff41\uff4c\uff50\uff48\uff41', 11, { admin: false }),
  [SESSIONS.alphaZeroWidth]: () => viewer('al\u200bpha', 11, { admin: false }),
  [SESSIONS.strasse]: () => viewer('strasse', 41, { admin: false }),
  [SESSIONS.strasseCapitalSharpS]: () => viewer('stra\u1e9ee', 41, { admin: false }),
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
    const once = ONCE_RE.exec(sid);
    if (once) {
      if (onceAsked.has(sid)) return { ok: false, http: 401, error: '会话已失效（合成：只认第一次）' };
      onceAsked.add(sid);
      return viewer(once[2], 900 + onceAsked.size, { admin: once[1] === 'admin' });
    }
    const answer = ANSWERS[sid];
    return answer ? answer() : { ok: false, http: 401, error: '会话无效（合成）' };
  },
};

/**
 * 内存版主体目录：和真的同一份契约（identity.ts 的 PrincipalDirectory），不开库。
 * 见过的外部身份取出主体；没见过的建一个 user:<对方的用户标识>；标识被占着却没绑定的不认领。
 * 另带几个只给测试用的把手：停用、恢复、预先绑定、预先占一个标识、让它出错、看它被问了几次。
 */
export function memoryDirectory() {
  const principals = new Map(); // 主体标识 → 'active' | 'disabled'
  const bound = new Map(); // `${provider}\u0000${externalId}` → 主体标识
  const state = { admitted: 0, fail: null, answer: null };
  return {
    admit(identity) {
      state.admitted++;
      if (state.fail) throw state.fail;
      if (state.answer) return state.answer();
      const key = `${identity.provider}\u0000${identity.externalId}`;
      let id = bound.get(key);
      if (!id) {
        id = `user:${identity.externalId}`;
        if (principals.has(id)) return { ok: false, reason: 'unbound' };
        principals.set(id, 'active');
        bound.set(key, id);
      }
      return principals.get(id) === 'active' ? { ok: true, principal: id } : { ok: false, reason: 'disabled' };
    },
    // —— 以下只给测试用 ——
    disable(id) { principals.set(id, 'disabled'); },
    restore(id) { principals.set(id, 'active'); },
    bind(provider, externalId, id) { if (!principals.has(id)) principals.set(id, 'active'); bound.set(`${provider}\u0000${externalId}`, id); },
    occupy(id) { principals.set(id, 'active'); },
    failWith(error) { state.fail = error; },
    answerWith(fn) { state.answer = fn; },
    get admitted() { return state.admitted; },
    get size() { return principals.size; },
  };
}

/** 把一个主体目录装成 Cordis 服务 `principals`（进程内不开库的测试用） */
export const directoryPlugin = (directory) => ({
  name: 'principal-directory-memory',
  apply(ctx) {
    assertTestEnv();
    ctx.provide('principals', directory);
  },
});

/** 假的登录中继：不给任何地址转会话，不开任何登录面。 */
const fakeEntries = (cookieHeader) => String(cookieHeader ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith('session_id='));
export const fakeRelay = {
  relayLogin: () => process.env.WM_ODOO_LOGIN_PROXY === '1', // 对抗组按这个开关起「中继」实例，核心走中继那一支
  sessionCookieName: () => 'session_id',
  sessionEntries: fakeEntries,
  soleSession: (cookieHeader) => { const all = fakeEntries(cookieHeader); return all.length === 1 && /^session_id=[A-Za-z0-9_.=-]{16,512}$/.test(all[0]) ? all[0] : ''; },
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
  // 内容面要求身份来源是可信源：测试要开内容面时，用 IDENTITY_FAKE_TRUSTED_ORIGIN 指定一个（只在测试环境里装得上，见 assertTestEnv）
  trustedOrigins: () => ({ origins: new Set(process.env.IDENTITY_FAKE_TRUSTED_ORIGIN ? [process.env.IDENTITY_FAKE_TRUSTED_ORIGIN] : []), invalid: [] }),
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

/**
 * 假登录方式 untrusted：打开了按邮箱自动对上，但交回的身份一律 emailTrusted=false（插件没法确认邮箱来自本组织）。
 * 发起时把浏览器送去一个不存在的本机地址（只用来带回 state）；回调里的 who、email 就是认出来的人和邮箱。
 * 核心那一道「只用可信邮箱自动对上」的检查，只有它测得到：真的飞书插件在前面已经按租户拒了。
 */
export const untrustedFlowPlugin = {
  name: 'login-flow-untrusted-fake',
  inject: ['identity'],
  apply(ctx) {
    assertTestEnv();
    const flow = {
      name: 'untrusted', label: '不可信的假登录', autoBindByEmail: true, available: () => true,
      async begin({ state, callbackUrl }) { return { ok: true, location: `http://127.0.0.1:9/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(callbackUrl)}` }; },
      async complete(query) { return { ok: true, identity: { externalId: String(query.who ?? ''), displayName: null, email: String(query.email ?? ''), emailTrusted: false, outsider: false } }; },
    };
    ctx.effect(() => ctx.get('identity').registerFlow(flow), 'identity.registerFlow(untrusted)');
  },
};

/**
 * 假登录方式 noflags：交回的身份既不说邮箱可不可信，也不说是不是外人（两个标记都缺）。
 * 核心要朝不放行的方向收：当外人，只进待对接清单，不发会话——哪怕这条身份被绑过。
 */
export const noFlagsFlowPlugin = {
  name: 'login-flow-noflags-fake',
  inject: ['identity'],
  apply(ctx) {
    assertTestEnv();
    const flow = {
      name: 'noflags', label: '不给标记的假登录', available: () => true,
      async begin({ state, callbackUrl }) { return { ok: true, location: `http://127.0.0.1:9/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(callbackUrl)}` }; },
      async complete(query) { return { ok: true, identity: { externalId: String(query.who ?? ''), displayName: null, email: null } }; },
    };
    ctx.effect(() => ctx.get('identity').registerFlow(flow), 'identity.registerFlow(noflags)');
  },
};

/** 在 treeRoot 这棵目录树的上下文里卸掉自带的提供方。返回这棵树的 { root, identity, loginRelay }。 */
export async function unloadShipped(treeRoot) {
  assertTestEnv();
  const at = (p) => pathToFileURL(join(treeRoot, p)).href;
  const { root } = await import(at('server/src/root-context.ts'));
  const contract = await import(at('server/src/identity.ts')); // 装配在这一步做完：自带的提供方已经装上
  const { loginProviders } = await import(at('server/src/login-providers/index.ts'));
  // 只卸身份来源那一个（Odoo）；发会话的登录方式（飞书）不是提供方，留着——测试要两种登录并存
  for (const plugin of loginProviders.filter((p) => p.name === 'login-provider-odoo')) {
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
