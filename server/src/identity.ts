/**
 * 身份契约。核心只经这里认人；换登录方式是换一个登录提供方插件，不改核心。
 *
 * 这里有两个角色，分开放：
 *   - 身份来源（认人、是不是管理员、whoami）：Cordis 服务 `identity`。实现是登记在它后面的登录提供方（LoginProvider）。
 *   - 业务台的登录中继（门户把谁的会话转给谁、登录这一跳送去哪、回调票据）：Cordis 服务 `loginRelay`，窄接口 LoginRelay。
 * 两者的实现都在 login-providers/ 下的插件里，装哪些由那里的清单决定。本文件是唯一引用那份清单的地方，
 * 别的核心文件只用下面的 identity() 和 loginRelay()。
 *
 * 服务不照单全收提供方的回答，一律朝认不出人的方向收：
 *   没装提供方、提供方抛错、到点没回答、回答的形状不对 → 认不出（不放行）；管理员标记不是 true → 不是管理员。
 *
 * 提供方认出的人，还要对到一个主体上才算数（主体目录，契约见下，实现在 services/principal.ts）：
 *   主体停用了、对不到主体、目录没装上或出错 → 一样认不出。所以「停用一个主体」对每个经这里认人的入口同时生效。
 *
 * 不碰数据库：登录门、SOP 字段通道这类不开库的模块也引用这里。主体目录按名字现取，本文件不引用它的实现。
 */
import { createHash } from 'node:crypto';
import { Service, type Context } from '@deepseek-ai/cordis';
import type { Express } from 'express';
import { root } from './root-context.ts';
import { loginProviders } from './login-providers/index.ts';

// ---------- 认人 ----------

/**
 * 查看者：一次请求被认成的那个人。
 * login 是提供方那边的登录名；sub 是主体标识（主体目录给的，人是 `user:<名>`；经现有登录认出的人，名就是登录名）；name 只用于显示；
 * admin 是提供方说的「是不是管理员」，缺了按 false。
 */
export interface Viewer { login: string; uid: number; sub: string; name: string | null; admin: boolean }

/** 认人的结果。认不出时 http 是该回给调用方的状态：401 没登录或会话失效，403 不是内部账号、主体已停用或对不到主体，502 身份来源不可达，503 没配置身份来源或主体目录不可用 */
export type ViewerResult = { ok: true; viewer: Viewer; via?: 'session' } | { ok: false; http: number; error: string };

/** whoami 的应答（GET /api/auth/viewer 原样用它） */
export type Whoami = { http: number; body: Record<string, unknown> };

/** 登录提供方：插件实现它，登记到 identity 服务后面。只管认人 */
export interface LoginProvider {
  /** 提供方的名字：排障和留痕用 */
  readonly name: string;
  /**
   * 认一次人最多等多久（毫秒，1～60000）。到点没有回答，服务按身份来源不可用处理，不放行。不写就是 10 秒。
   * 提供方自己也该有期限；这一条是它没守住时的底线。
   */
  readonly deadlineMs?: number;
  /** 有没有配置身份来源 */
  configured(): boolean;
  /** 请求带来的、这个提供方认的凭据。只取不验；没有就是空串 */
  credentialOf(cookieHeader: string): string;
  /** 把请求带来的 cookie 认成查看者，每次现查。source 是调用方显式指定的身份来源地址，缺省用部署配置的 */
  resolveViewer(cookieHeader: string, source?: string): Promise<ViewerResult>;
}

// ---------- 主体目录 ----------

/** 提供方认出的外部身份：提供方的名字，加对方的用户标识（现有登录是登录名） */
export interface ExternalIdentity { provider: string; externalId: string; displayName: string | null }

/**
 * 把外部身份对到主体上的结果。两种对不上都不认：
 *   disabled 主体停用了；unbound 这个外部身份没绑定主体，按它的名字新建又会撞上一个已有的主体（不自动认领，要管理员对一次）。
 */
export type Admission = { ok: true; principal: string } | { ok: false; reason: 'disabled' | 'unbound' };

/** 主体目录：「谁」的那一张表。实现要开库，是 Cordis 服务 `principals`（services/principal.ts）；这里只有契约 */
export interface PrincipalDirectory {
  /** 把提供方认出的人对到主体：见过的取出来；没见过的建一个（人，标识 `user:<对方的用户标识>`）。每次现查，不缓存 */
  admit(identity: ExternalIdentity): Admission;
}

const NO_PROVIDER = '未配置身份来源';
const NO_DIRECTORY = '主体目录没有装上，不认任何人';
const DIRECTORY_FAILED = '主体目录不可用';
const DISABLED = '主体已停用';
const UNBOUND = '这个登录还没有对到主体，请管理员处理';
const UNAVAILABLE = '身份来源不可用';
const UNRECOGNIZED = '身份来源的回答无法识别，按认不出处理';
/** 提供方没有自报期限时的底线。比自带提供方自己的 5 秒超时长，不会抢在它前面 */
const DEFAULT_DEADLINE_MS = 10_000;
const MAX_DEADLINE_MS = 60_000;

const loginOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
/** 人的主体标识：`user:` 加一个名，名的形状和登录名同一把尺 */
const personIdOk = (v: unknown): v is string => typeof v === 'string' && v.startsWith('user:') && loginOk(v.slice(5));
const deadlineOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_DEADLINE_MS;
const unrecognized = (): ViewerResult => ({ ok: false, http: 502, error: UNRECOGNIZED });

/** 到点还没有回答，就算它出错 */
function within<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); });
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

/**
 * 把提供方的回答收成契约的形状；收不成就是认不出。
 * 回答可以是任何东西，包括带访问器的对象：每个字段只读一次、读出来再判；读的时候抛错，也按认不出。
 */
function checked(answer: unknown): ViewerResult {
  try {
    const a = answer as { ok?: unknown; viewer?: { [K in keyof Viewer]?: unknown } | null; http?: unknown; error?: unknown } | null | undefined;
    if (a === null || a === undefined) return unrecognized();
    const ok = a.ok;
    if (ok === true) {
      const v = a.viewer;
      if (!v) return unrecognized();
      const login = v.login, uid = v.uid, sub = v.sub, name = v.name, admin = v.admin;
      if (!loginOk(login)) return unrecognized();
      if (sub !== `user:${login}`) return unrecognized();
      if (typeof uid !== 'number') return unrecognized();
      if (name !== null && typeof name !== 'string') return unrecognized();
      return { ok: true, viewer: { login, uid, sub: `user:${login}`, name: name as string | null, admin: admin === true } };
    }
    if (ok === false) {
      const http = a.http, error = a.error;
      if (typeof http !== 'number' || !Number.isInteger(http) || http < 400 || http > 599) return unrecognized();
      if (typeof error !== 'string') return unrecognized();
      return { ok: false, http, error };
    }
  } catch { /* 读回答的时候抛错：按认不出 */ }
  return unrecognized();
}

/** 身份服务（Cordis 服务名 `identity`）。字段不用 # 私有：Cordis 交出来的服务是一层代理 */
// ---------- 市场自己的会话 ----------

/** 市场会话的 cookie 名：市场自己的，不是哪一家登录的 */
export const SESSION_COOKIE = 'wm_session';

/** 会话存储：实现要开库，是 Cordis 服务 `loginSessions`（services/login-session.ts）；这里只有契约 */
export interface SessionStore {
  /** 这个会话现在还算不算数（在、没注销、没过期、主体是启用的人）；算数才返回 */
  lookupSession(token: unknown): { principal: string; provider: string; externalId: string; displayName: string } | null;
  /** 注销：立即失效 */
  revokeSession(token: unknown): boolean;
}

/** 请求里的市场会话（同名多个按没有） */
function sessionTokenOf(cookieHeader: string): string {
  const hits = String(cookieHeader ?? '').split(';').map((x) => x.trim()).filter((x) => x.startsWith(`${SESSION_COOKIE}=`));
  return hits.length === 1 ? hits[0].slice(SESSION_COOKIE.length + 1) : '';
}

// ---------- 登录方式（发会话的那一种登录，比如飞书） ----------

/**
 * 登录方式认出的人：对方的用户标识（飞书是 union_id），加显示名和对方给的企业邮箱（可能没有）。
 * emailTrusted：插件确认了这个人来自本组织（比如核对过租户），邮箱才可以拿来自动对到已有的主体；不确定就是 false。
 * outsider：插件确认这个人不是本组织的（比如租户不符）。这样的人只进待对接清单并留痕，拿不到会话，哪怕他的身份被绑过
 */
export type FlowIdentity = { externalId: string; displayName: string | null; email: string | null; emailTrusted: boolean; outsider: boolean };
export type FlowBegin = { ok: true; location: string } | { ok: false; http: number; error: string };
export type FlowComplete = { ok: true; identity: FlowIdentity } | { ok: false; http: number; error: string };

/**
 * 登录方式：插件实现它，登记到 identity 服务后面。只管和对方打交道的两步：
 *   begin    发起：给出把浏览器送去对方授权页的地址（state、回调地址由核心给）；
 *   complete 回调：拿回调带回来的参数去对方那边换出「这是谁」。
 * state 的签发和核销、回到哪里（next）、对到主体、发会话、cookie，都是核心的事（routes/login-flows.ts），插件不碰。
 */
export interface LoginFlow {
  /** 名字：路径 /login/<name>，也是外部身份表里的提供方名。小写字母、数字、连字符 */
  readonly name: string;
  /** 登录页按钮上的字 */
  readonly label: string;
  /** 配置齐了没有（只看配置，不去对方那边） */
  available(): boolean;
  /** 没对到主体的人，要不要按对方给的企业邮箱自动对到已有的主体上（显式开关，缺省关；见 routes/login-flows.ts） */
  readonly autoBindByEmail?: boolean;
  begin(input: { state: string; callbackUrl: string }): Promise<FlowBegin>;
  complete(query: Record<string, string>, input: { callbackUrl: string }): Promise<FlowComplete>;
}

const FLOW_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 登录方式最多等对方这么久（发起、回调各算一次）。对方慢到这个地步，按不可用处理，不放行 */
const FLOW_DEADLINE_MS = 15_000;
const FLOW_UNAVAILABLE = '登录方式暂时不可用';
const flowFail = (http: number, error: string) => ({ ok: false as const, http, error });
/** 插件交回来的「这是谁」同样不照单全收：标识要合乎外部身份的形状，显示名、邮箱只收字符串 */
function checkedFlowIdentity(answer: unknown): FlowComplete {
  try {
    const a = answer as { ok?: unknown; identity?: { externalId?: unknown; displayName?: unknown; email?: unknown; emailTrusted?: unknown }; http?: unknown; error?: unknown } | null | undefined;
    if (a?.ok === true) {
      const i = a.identity, externalId = i?.externalId, displayName = i?.displayName, email = i?.email;
      if (!loginOk(externalId)) return flowFail(502, '登录方式交回的用户标识形状不对');
      const emailTrusted = (i as { emailTrusted?: unknown }).emailTrusted, outsider = (i as { outsider?: unknown }).outsider;
      // 拿不准的一律朝不放行的方向：emailTrusted 只认 true；outsider 只要不是 false 就当外人
      return { ok: true, identity: { externalId, displayName: typeof displayName === 'string' ? displayName.slice(0, 256) : null, email: typeof email === 'string' && email.length <= 320 ? email : null, emailTrusted: emailTrusted === true && outsider === false, outsider: outsider !== false } };
    }
    if (a?.ok === false) {
      const http = a.http, error = a.error;
      if (typeof http === 'number' && Number.isInteger(http) && http >= 400 && http <= 599 && typeof error === 'string') return flowFail(http, error.slice(0, 200));
    }
  } catch { /* 读回答时抛错 */ }
  return flowFail(502, FLOW_UNAVAILABLE);
}

export class IdentityService extends Service {
  private provider: LoginProvider | null = null;
  private deadlineMs = DEFAULT_DEADLINE_MS;

  constructor(ctx: Context) {
    super(ctx, 'identity');
  }

  /** 登录提供方插件登记自己，返回撤销函数（插件放进 ctx.effect，卸载时一并撤销）。同时只能有一个 */
  register(provider: LoginProvider): () => void {
    if (this.provider) throw new Error(`已经有登录提供方 ${this.provider.name}，不能再登记 ${provider?.name}`);
    const deadline = provider?.deadlineMs;
    if (!provider || typeof provider.name !== 'string' || !provider.name || typeof provider.configured !== 'function' || typeof provider.credentialOf !== 'function' || typeof provider.resolveViewer !== 'function'
      || (deadline !== undefined && !deadlineOk(deadline))) {
      throw new Error('登录提供方不符合契约：要有 name、configured()、credentialOf()、resolveViewer()；deadlineMs 写了就得是 1～60000 的毫秒数');
    }
    this.provider = provider;
    this.deadlineMs = deadline ?? DEFAULT_DEADLINE_MS;
    return () => {
      if (this.provider !== provider) return;
      this.provider = null;
      this.deadlineMs = DEFAULT_DEADLINE_MS;
    };
  }

  /** 现在登记着的提供方的名字；没有为 null */
  providerName(): string | null {
    return this.provider?.name ?? null;
  }

  private readonly flowsByName = new Map<string, LoginFlow>();

  /** 登录方式插件登记自己，返回撤销函数。名字不能重复 */
  registerFlow(flow: LoginFlow): () => void {
    if (!flow || typeof flow.name !== 'string' || !FLOW_NAME.test(flow.name) || typeof flow.label !== 'string' || !flow.label
      || typeof flow.available !== 'function' || typeof flow.begin !== 'function' || typeof flow.complete !== 'function') {
      throw new Error('登录方式不符合契约：要有 name（小写字母、数字、连字符）、label、available()、begin()、complete()');
    }
    if (this.flowsByName.has(flow.name)) throw new Error(`登录方式 ${flow.name} 已经登记过了`);
    this.flowsByName.set(flow.name, flow);
    return () => { if (this.flowsByName.get(flow.name) === flow) this.flowsByName.delete(flow.name); };
  }

  /** 登记着、而且配置齐了的登录方式（登录页列按钮用） */
  flows(): { name: string; label: string }[] {
    const out: { name: string; label: string }[] = [];
    for (const f of this.flowsByName.values()) { try { if (f.available() === true) out.push({ name: f.name, label: f.label }); } catch { /* 当没配 */ } }
    return out;
  }

  /** 发起一个登录方式。没登记、没配齐、出错、到点没回答，都是 ok:false，不抛错 */
  async beginFlow(name: string, input: { state: string; callbackUrl: string }): Promise<FlowBegin> {
    const flow = this.flowsByName.get(name);
    try { if (!flow || flow.available() !== true) return flowFail(404, '没有这个登录方式'); } catch { return flowFail(404, '没有这个登录方式'); }
    try {
      const a = await within(Promise.resolve(flow.begin(input)), FLOW_DEADLINE_MS) as { ok?: unknown; location?: unknown };
      const location = a?.ok === true ? a.location : null;
      if (typeof location === 'string' && /^https?:\/\//.test(location)) return { ok: true, location };
    } catch { /* 下面按不可用 */ }
    return flowFail(502, FLOW_UNAVAILABLE);
  }

  /** 回调：拿回调参数去对方那边认人。同样从不抛错，形状不对按认不出 */
  async completeFlow(name: string, query: Record<string, string>, input: { callbackUrl: string }): Promise<FlowComplete> {
    const flow = this.flowsByName.get(name);
    try { if (!flow || flow.available() !== true) return flowFail(404, '没有这个登录方式'); } catch { return flowFail(404, '没有这个登录方式'); }
    let answer: unknown;
    try { answer = await within(Promise.resolve(flow.complete(query, input)), FLOW_DEADLINE_MS); } catch { return flowFail(502, FLOW_UNAVAILABLE); }
    return checkedFlowIdentity(answer);
  }

  /** 有没有配置身份来源。没装提供方、提供方答不上来，都算没有 */
  configured(): boolean {
    try { return this.provider?.configured() === true; } catch { return false; }
  }

  /** 请求带来的身份凭据（只取不验）。核心用它判断「值不值得去认人」和做缓存键，不用它认人 */
  credentialOf(cookieHeader: string): string {
    try { const c = this.provider?.credentialOf(cookieHeader); return typeof c === 'string' ? c : ''; } catch { return ''; }
  }

  /** 请求里带没带市场会话（只看有没有，不验） */
  hasSession(cookieHeader: string): boolean {
    return sessionTokenOf(cookieHeader) !== '';
  }

  /** 请求里有没有任何一种身份凭据：市场会话，或者身份来源的凭据。「值不值得去认人」用它 */
  hasCredential(cookieHeader: string): boolean {
    return sessionTokenOf(cookieHeader) !== '' || this.credentialOf(cookieHeader) !== '';
  }

  /** 会话存储（Cordis 服务 `loginSessions`）。没装上、形状不对，都当没有 */
  private sessionStore(): SessionStore | null {
    const s = this.ctx.get('loginSessions') as SessionStore | undefined;
    return s && typeof s.lookupSession === 'function' && typeof s.revokeSession === 'function' ? s : null;
  }

  /**
   * 市场会话认出的人。每次现查（会话在、没注销、没过期，主体是启用的人），不进任何缓存：停用、注销立即生效。
   * 会话发出去的时候已经对到了主体，所以查看者的主体标识直接用会话记着的。管理员标记一律 false（角色和授予是阶段六的事）。
   */
  private sessionViewer(cookieHeader: string): ViewerResult | null {
    const token = sessionTokenOf(cookieHeader);
    if (!token) return null;
    let rec: ReturnType<SessionStore['lookupSession']> = null;
    try { rec = this.sessionStore()?.lookupSession(token) ?? null; } catch { rec = null; }
    if (!rec || !personIdOk(rec.principal)) return null;
    return { ok: true, via: 'session', viewer: { login: rec.principal.slice(5), uid: 0, sub: rec.principal, name: rec.displayName || null, admin: false } };
  }

  private readonly mismatchSeen = new Set<string>();

  /**
   * 两种会话同时带着、而且认出的不是同一个主体：按市场会话算，但留一行痕（两边各认成谁）。
   * 不拖慢这次请求（后台去问身份来源）；同一对会话在本进程里只记一次。
   */
  private noteMismatch(cookieHeader: string, session: Viewer): void {
    const credential = this.credentialOf(cookieHeader);
    if (!credential) return;
    const key = createHash('sha256').update(`${sessionTokenOf(cookieHeader)}\u0000${credential}`).digest('hex');
    if (this.mismatchSeen.has(key)) return;
    if (this.mismatchSeen.size > 5000) this.mismatchSeen.clear();
    this.mismatchSeen.add(key);
    void (async () => {
      try {
        const { provider, result } = await this.recognize(cookieHeader);
        if (!provider || !result.ok) return;
        const other = this.admitted(provider.name, result.viewer);
        if (other.ok && other.viewer.sub !== session.sub) {
          console.log(JSON.stringify({ source: 'identity', event: 'session-mismatch', session: session.sub, other: other.viewer.sub, provider: provider.name, at: new Date().toISOString() }));
        }
      } catch { /* 只是留痕，出错不影响认人 */ }
    })();
  }

  /** 注销请求里的市场会话；返回它原来是不是有效的 */
  endSession(cookieHeader: string): boolean {
    const token = sessionTokenOf(cookieHeader);
    if (!token) return false;
    try { return this.sessionStore()?.revokeSession(token) === true; } catch { return false; }
  }

  /** 这个登录方式要不要按邮箱自动对上主体 */
  flowAutoBindsByEmail(name: string): boolean {
    try { return this.flowsByName.get(name)?.autoBindByEmail === true; } catch { return false; }
  }

  /** 提供方这一层：问提供方，把回答收成契约的形状。认出来的人还没有对到主体，不能直接交出去 */
  private async recognize(cookieHeader: string, source?: string): Promise<{ provider: LoginProvider | null; result: ViewerResult }> {
    const provider = this.provider;
    if (!provider) return { provider: null, result: { ok: false, http: 503, error: NO_PROVIDER } };
    let answer: unknown;
    try { answer = await within(Promise.resolve(provider.resolveViewer(cookieHeader, source)), this.deadlineMs); } catch { return { provider, result: { ok: false, http: 502, error: UNAVAILABLE } }; }
    return { provider, result: checked(answer) };
  }

  /** 把请求带来的 cookie 认成查看者。从不抛错，也不会一直等：认不出、提供方出错、到点没回答、主体停用或对不上，都是 ok:false */
  async resolveViewer(cookieHeader: string, source?: string): Promise<ViewerResult> {
    // 市场会话优先：有效就按它认，不再问身份来源（显式指定了身份来源地址的调用方除外，比如内容面）
    if (source === undefined) { const fromSession = this.sessionViewer(cookieHeader); if (fromSession?.ok) { this.noteMismatch(cookieHeader, fromSession.viewer); return fromSession; } }
    const { provider, result } = await this.recognize(cookieHeader, source);
    return this.settled(provider, result);
  }

  /** 提供方这一层的结果，过了主体目录才交出去。认得出的人只有这一个出口 */
  private settled(provider: LoginProvider | null, result: ViewerResult): ViewerResult {
    if (!result.ok) return { ...result }; // 副本：调用方改它，改不到缓存里的那一份
    if (!provider) return { ok: false, http: 503, error: NO_PROVIDER };
    return this.admitted(provider.name, result.viewer);
  }

  /**
   * 带缓存的认人：不想每个请求都去问提供方的调用方用它（登录门、管理员认定）。调用方各建各的，期限和容量自己定。
   * 缓存的只有提供方那一层的回答（认得出、认不出都留），按凭据的哈希分，最多留 ttlMs 毫秒；
   * 主体那一步不进缓存，每次现查——所以停用和恢复都立即生效，调用方不用、也不该自己再缓存认人的结果。
   */
  cachedResolver(options: { ttlMs: number; max: number }): (cookieHeader: string) => Promise<ViewerResult> {
    const ttlMs = options?.ttlMs, max = options?.max;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 300_000 || !Number.isInteger(max) || max < 1) {
      throw new Error('cachedResolver：ttlMs 要是 1～300000 的毫秒数，max 要是正整数');
    }
    const cache = new Map<string, { at: number; provider: LoginProvider; result: ViewerResult }>();
    return async (cookieHeader: string): Promise<ViewerResult> => {
      const fromSession = this.sessionViewer(cookieHeader); // 市场会话不进缓存，每次现查
      if (fromSession?.ok) { this.noteMismatch(cookieHeader, fromSession.viewer); return fromSession; }
      const credential = this.credentialOf(cookieHeader);
      if (!credential) return this.resolveViewer(cookieHeader);
      const key = createHash('sha256').update(credential).digest('hex');
      const hit = cache.get(key);
      let provider: LoginProvider | null, result: ViewerResult;
      // 换了提供方，旧回答作废
      if (hit && hit.provider === this.provider && Date.now() - hit.at < ttlMs) ({ provider, result } = hit);
      else {
        ({ provider, result } = await this.recognize(cookieHeader));
        if (provider) {
          if (cache.size > max) cache.clear();
          cache.set(key, { at: Date.now(), provider, result });
        }
      }
      return this.settled(provider, result);
    };
  }

  /** 主体目录（Cordis 服务 `principals`）。没装上、形状不对，都当没有 */
  private directory(): PrincipalDirectory | null {
    const d = this.ctx.get('principals') as PrincipalDirectory | undefined;
    return d && typeof d.admit === 'function' ? d : null;
  }

  /**
   * 提供方认出的人，对到主体上才算数。查看者的 sub 用目录给的主体标识，不用提供方自己写的。
   * 目录的回答同样不照单全收：停用、对不上、没装上、抛错、形状不对，都是认不出。
   */
  private admitted(provider: string, viewer: Viewer): ViewerResult {
    let answer: unknown;
    try {
      const directory = this.directory();
      if (!directory) return { ok: false, http: 503, error: NO_DIRECTORY };
      answer = directory.admit({ provider, externalId: viewer.login, displayName: viewer.name });
    } catch { return { ok: false, http: 503, error: DIRECTORY_FAILED }; }
    try {
      const a = answer as { ok?: unknown; principal?: unknown; reason?: unknown } | null | undefined;
      if (a !== null && a !== undefined) {
        const ok = a.ok;
        if (ok === true) {
          const principal = a.principal;
          if (personIdOk(principal)) return { ok: true, viewer: { ...viewer, sub: principal } };
        } else if (ok === false) {
          const reason = a.reason;
          if (reason === 'disabled') return { ok: false, http: 403, error: DISABLED };
          if (reason === 'unbound') return { ok: false, http: 403, error: UNBOUND };
        }
      }
    } catch { /* 读回答的时候抛错：按不可用 */ }
    return { ok: false, http: 503, error: DIRECTORY_FAILED };
  }

  /** 我是谁：登录探测和顶栏用户 chip 读它 */
  async whoami(cookieHeader: string): Promise<Whoami> {
    const who = await this.resolveViewer(cookieHeader);
    // 市场会话认出的人：不看身份来源有没有配置
    if (who.ok && who.via === 'session') return { http: 200, body: { ok: true, viewer: { ...who.viewer, kind: '人' }, roles: null } };
    // 没配置身份来源时登录也没用，所以不带 auth_required；说法用提供方自己的
    if (!this.configured()) return { http: 503, body: { ok: false, error: who.ok === false ? who.error : NO_PROVIDER } };
    if (who.ok === false) return { http: who.http, body: { ok: false, error: who.error, auth_required: who.http === 401 } };
    // kind 按主体口径（user: = 人）；roles 暂为 null
    return { http: 200, body: { ok: true, viewer: { ...who.viewer, kind: '人' }, roles: null } };
  }
}

// ---------- 业务台的登录中继 ----------

/** 门户登录回调的一次性票据：把台 id、签发时的可信源和来源绑在一起 */
export interface SsoTicket { id: number; origin: string; source: string; exp: number }

/** 票据存储。中继自带进程内存的；核心装配时换成落库的（重启不丢，同一数据目录的多个实例共享） */
export interface SsoTicketStore {
  get(state: string): SsoTicket | null;
  put(state: string, t: SsoTicket): void;
  /** 原子地取出并删除（多实例下同一张票据只能被一个回调核销）；不存在返回 null */
  take(state: string): SsoTicket | null;
  /** 删掉过期票据；size > max 时删最早签发的，直到不超过 max */
  sweep(now: number, max: number): void;
  activeBySource(source: string, now: number): number;
}

/** 显式配置的、只给浏览器用的登录地址 */
export type BrowserLoginOrigin = { origin: string; hostname: string; upstream: string };

/**
 * 业务台的登录中继（窄接口）。门户、登录门、WS 升级只经它碰业务台的会话。
 * 会话只转给部署配置的可信源；台的类型和地址可以被 agent 登记，不参与判定。
 */
export interface LoginRelay {
  /** 中继的上游地址（今天也是身份来源的地址），去掉末尾斜杠；没配置为空串 */
  sourceUrl(): string;
  /** 还在用已弃用的旧配置名吗：只设了旧名、新旧都设了、没用旧名。只用于启动提示 */
  legacyConfig(): 'only-old' | 'both' | null;

  /** 同域登录中继开着没有（部署配置）。核心不再自己读这家登录的开关 */
  relayLogin(): boolean;
  /** 业务台会话的 cookie 名。核心不再写死它 */
  sessionCookieName(): string;
  /** 请求 Cookie 头里业务台会话的各项，原样（`名=值`），按出现顺序；同名多项都在 */
  sessionEntries(cookieHeader: string): string[];
  /** 恰好一项、而且值的形状合格时返回那一项（`名=值`），否则空串。严格的入口（内容面、SOP 字段通道）用它，不继承「多项取第一项」的旧歧义 */
  soleSession(cookieHeader: string): string;
  /** 请求里的业务台会话（只取不验）；没有为空串 */
  sessionOf(cookieHeader: string): string;
  /** 就地剥掉转发请求里的业务台会话 */
  stripSession(headers: { cookie?: string | string[] }): void;
  /** 这个地址能不能拿到业务台会话：只按可信源判定，一个可信源都没配时谁都不给 */
  isSessionTarget(url: string): boolean;
  /** 可信源，和配置里被忽略的非法项 */
  trustedOrigins(): { origins: Set<string>; invalid: string[] };
  /** 旧口径下看起来像业务台的登记。不参与判定，只用于启动提示 */
  looksLikeTarget(type: unknown, url: string): boolean;

  /** 登录回跳目标：只收登记过的市场页的 path，不合格返回 null */
  safeReturnPath(v: unknown): string | null;
  /** 登记一个需要身份的市场页，作为登录回跳目标 */
  addReturnPath(path: string): void;

  /** 换掉票据存储 */
  useTicketStore(store: SsoTicketStore): void;
  /** 登记「按台 id 现查地址」的函数；台不存在或已停用返回 null */
  useTargetLookup(lookup: (id: number) => string | null): void;
  /** 给可信的台签一张回调票据，返回 state；这个来源手里的有效票据已到上限时返回 null */
  issueCallback(id: number, origin: string, source: string): string | null;
  /** 回调核对通过后作废票据；返回作废前它是否有效 */
  consumeCallback(id: number, state: string): boolean;

  /** 显式配置的浏览器登录地址；没配置为 null，配置非法就抛错（调用方在监听之前调，等于拒绝启动） */
  browserOrigin(): BrowserLoginOrigin | null;
  /** 登录这一跳把浏览器送到哪个源；null 表示送不了（主机名对不上，或者要从 https 降到 http） */
  browserLoginOrigin(target: string, authority: string, configured: BrowserLoginOrigin | null, secure?: boolean): string | null;

  /** 装上同域登录中继的路由；没开就什么都不装 */
  install(app: Express): void;
  /** 这个请求是不是中继放行的登录面（不要身份也能访问） */
  publicRoute(method: string, pathname: string): boolean;
  /** 到上游注销这一个会话；确认注销了才返回 true */
  revokeSession(sid: string): Promise<boolean>;
}

// ---------- 装配与取用 ----------

// 装配在这里做完再交出模块：引用方拿到的 identity() 后面已经有提供方。
await root.plugin(IdentityService);
for (const plugin of loginProviders) await root.plugin(plugin);

/** 身份服务。不在就抛错，不让调用点拿着 undefined 往下走 */
export function identity(): IdentityService {
  const service = root.get('identity') as IdentityService | undefined;
  if (!service) throw new Error('身份服务没有装上');
  return service;
}

/** 业务台的登录中继。没有插件提供它就抛错，不给一个什么都放行的空实现 */
export function loginRelay(): LoginRelay {
  const relay = root.get('loginRelay') as LoginRelay | undefined;
  if (!relay) throw new Error('登录中继没有装上：login-providers/ 的清单里没有提供 loginRelay 的插件');
  return relay;
}
