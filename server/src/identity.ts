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
 *   没装提供方、提供方抛错、回答的形状不对 → 认不出（不放行）；管理员标记不是 true → 不是管理员。
 *
 * 不碰数据库：登录门、SOP 字段通道这类不开库的模块也引用这里。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { Express } from 'express';
import { root } from './root-context.ts';
import { loginProviders } from './login-providers/index.ts';

// ---------- 认人 ----------

/**
 * 查看者：一次请求被认成的那个人。
 * login 是提供方那边的登录名；sub 是主体标识，现在固定是 `user:<login>`；name 只用于显示；
 * admin 是提供方说的「是不是管理员」，缺了按 false。
 */
export interface Viewer { login: string; uid: number; sub: string; name: string | null; admin: boolean }

/** 认人的结果。认不出时 http 是该回给调用方的状态：401 没登录或会话失效，403 不是内部账号，502 身份来源不可达，503 没配置身份来源 */
export type ViewerResult = { ok: true; viewer: Viewer } | { ok: false; http: number; error: string };

/** whoami 的应答（GET /api/auth/viewer 原样用它） */
export type Whoami = { http: number; body: Record<string, unknown> };

/** 登录提供方：插件实现它，登记到 identity 服务后面。只管认人 */
export interface LoginProvider {
  /** 提供方的名字：排障和留痕用 */
  readonly name: string;
  /** 有没有配置身份来源 */
  configured(): boolean;
  /** 请求带来的、这个提供方认的凭据。只取不验；没有就是空串 */
  credentialOf(cookieHeader: string): string;
  /** 把请求带来的 cookie 认成查看者，每次现查。source 是调用方显式指定的身份来源地址，缺省用部署配置的 */
  resolveViewer(cookieHeader: string, source?: string): Promise<ViewerResult>;
}

const NO_PROVIDER = '未配置身份来源';
const UNAVAILABLE = '身份来源不可用';
const UNRECOGNIZED = '身份来源的回答无法识别，按认不出处理';

const loginOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);

/** 把提供方的回答收成契约的形状；收不成就是认不出 */
function checked(answer: unknown): ViewerResult {
  const a = answer as { ok?: unknown; viewer?: Partial<Viewer> | null; http?: unknown; error?: unknown } | null | undefined;
  if (a?.ok === true) {
    const v = a.viewer;
    if (!v || !loginOk(v.login) || v.sub !== `user:${v.login}` || typeof v.uid !== 'number' || (v.name !== null && typeof v.name !== 'string')) {
      return { ok: false, http: 502, error: UNRECOGNIZED };
    }
    return { ok: true, viewer: { login: v.login, uid: v.uid, sub: v.sub, name: v.name, admin: v.admin === true } };
  }
  if (a?.ok === false && typeof a.http === 'number' && Number.isInteger(a.http) && a.http >= 400 && a.http <= 599 && typeof a.error === 'string') {
    return { ok: false, http: a.http, error: a.error };
  }
  return { ok: false, http: 502, error: UNRECOGNIZED };
}

/** 身份服务（Cordis 服务名 `identity`）。字段不用 # 私有：Cordis 交出来的服务是一层代理 */
export class IdentityService extends Service {
  private provider: LoginProvider | null = null;

  constructor(ctx: Context) {
    super(ctx, 'identity');
  }

  /** 登录提供方插件登记自己，返回撤销函数（插件放进 ctx.effect，卸载时一并撤销）。同时只能有一个 */
  register(provider: LoginProvider): () => void {
    if (this.provider) throw new Error(`已经有登录提供方 ${this.provider.name}，不能再登记 ${provider?.name}`);
    if (!provider || typeof provider.name !== 'string' || !provider.name || typeof provider.configured !== 'function' || typeof provider.credentialOf !== 'function' || typeof provider.resolveViewer !== 'function') {
      throw new Error('登录提供方不符合契约：要有 name、configured()、credentialOf()、resolveViewer()');
    }
    this.provider = provider;
    return () => { if (this.provider === provider) this.provider = null; };
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

  /** 把请求带来的 cookie 认成查看者。从不抛错：认不出就是 ok:false */
  async resolveViewer(cookieHeader: string, source?: string): Promise<ViewerResult> {
    const provider = this.provider;
    if (!provider) return { ok: false, http: 503, error: NO_PROVIDER };
    let answer: unknown;
    try { answer = await provider.resolveViewer(cookieHeader, source); } catch { return { ok: false, http: 502, error: UNAVAILABLE }; }
    return checked(answer);
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

/** 身份服务 */
export function identity(): IdentityService {
  return root.get('identity') as IdentityService;
}

/** 业务台的登录中继。没有插件提供它就抛错，不给一个什么都放行的空实现 */
export function loginRelay(): LoginRelay {
  const relay = root.get('loginRelay') as LoginRelay | undefined;
  if (!relay) throw new Error('登录中继没有装上：login-providers/ 的清单里没有提供 loginRelay 的插件');
  return relay;
}
