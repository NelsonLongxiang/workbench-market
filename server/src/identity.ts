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
export type ViewerResult = { ok: true; viewer: Viewer } | { ok: false; http: number; error: string };

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

  /** 有没有配置身份来源。没装提供方、提供方答不上来，都算没有 */
  configured(): boolean {
    try { return this.provider?.configured() === true; } catch { return false; }
  }

  /** 请求带来的身份凭据（只取不验）。核心用它判断「值不值得去认人」和做缓存键，不用它认人 */
  credentialOf(cookieHeader: string): string {
    try { const c = this.provider?.credentialOf(cookieHeader); return typeof c === 'string' ? c : ''; } catch { return ''; }
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
