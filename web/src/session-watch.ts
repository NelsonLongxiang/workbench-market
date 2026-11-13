/** 身份变了以后页面重读：看的人没登录了、或者换成了另一个人，页面上上一个人的东西要清掉，按现在的人重读。
 *  · 什么时候去确认：同源 /api/ 回 401（合并、去抖，一轮只问一次）；窗口回到前台（focus、visibilitychange）；
 *    从浏览器缓存恢复的页面（pageshow 且 persisted）；另外每 60 秒一次。
 *  · 怎么确认：问 GET /api/auth/me。真的没登录了、或者登录的人和上次不一样，才算身份变了——
 *    有些接口对登录着的人也会回 401（管理口令类的入口等），光凭 401 不算。
 *    /api/auth/me 自己不通、或回 502 identity_unavailable（身份服务连不上，#641 那一套）时不算变，什么都不清。
 *  · 身份变了：世代号加一、广播 wm-session-lost。外壳按世代号整棵重挂页面（各页的状态一起丢掉、按新的人重读），
 *    共用的取数缓存清空；旧世代发出去、还在路上的请求回来时直接丢弃（不交回页面，免得把上一个人的数据写回去）。
 *  不引别的文件：scripts/session-watch-unit.mjs 直接测核心（createSessionWatch）。 */

export const SESSION_LOST = 'wm-session-lost';

/** /api/auth/me 的回答 → 「这是谁」的键；回答不可用（断网、502、形状不对）返回 undefined（不当成变了） */
export function whoKey(status: number, body: unknown): string | undefined {
  if (status === 0 || status >= 500) return undefined;
  if (status === 401) return '';
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') return undefined;
  const b = body as { authenticated?: unknown; login?: unknown; via?: unknown };
  if (b.authenticated !== true) return '';
  return `${typeof b.via === 'string' ? b.via : ''}:${typeof b.login === 'string' ? b.login : ''}`;
}

export type SessionWatch = {
  generation: () => number;
  /** 去确认一次（合并：已经在问就不再发） */
  check: () => Promise<void>;
  /** 有接口回了 401：去抖之后确认一次 */
  saw401: () => void;
  subscribe: (fn: () => void) => () => void;
};

export function createSessionWatch(deps: {
  ask: () => Promise<{ status: number; body: unknown }>;
  onLost?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  debounceMs?: number;
}): SessionWatch {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let gen = 0;
  let known: string | undefined;
  /** 启动时那一问没问成（断网、502）：页面可能已经按当时的人读了数据，之后第一次问成时不知道是不是同一个人——按变了算，重读一次 */
  let baselineMissed = false;
  let asking: Promise<void> | null = null;
  let pending = false;
  const subs = new Set<() => void>();
  const check = (): Promise<void> => {
    if (asking) return asking;
    asking = (async () => {
      let r: { status: number; body: unknown };
      try { r = await deps.ask(); } catch { r = { status: 0, body: null }; }
      const k = whoKey(r.status, r.body);
      if (k === undefined) { if (known === undefined) baselineMissed = true; return; }
      if (known === undefined && !baselineMissed) { known = k; return; } // 第一次问成就只是记下是谁
      if (k !== known) {
        known = k; gen += 1;
        subs.forEach((f) => f()); deps.onLost?.();
      }
    })().finally(() => { asking = null; });
    return asking;
  };
  return {
    generation: () => gen,
    check,
    saw401: () => {
      if (pending) return;
      pending = true;
      setTimer(() => { pending = false; void check(); }, deps.debounceMs ?? 300);
    },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** 装在 fetch 外面的那一层（拆出来好单测）：同源 /api/ 回 401 就去确认；发出时记下世代号，
 *  拿到响应头时、读完正文（json / text）时各比一次，世代号变了就不交回（这个 Promise 不再结束）。 */
export function guardedFetch(raw: typeof fetch, w: SessionWatch, origin: string): typeof fetch {
  const isApi = (url: string): boolean => { try { const u = new URL(url, origin); return u.origin === origin && u.pathname.startsWith('/api/'); } catch { return false; } };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isApi(url)) return raw(input, init);
    const at = w.generation();
    const r = await raw(input, init);
    // 旧身份发出去的请求：身份已经变了，应答不交回页面
    if (w.generation() !== at) return new Promise<Response>(() => undefined);
    // 读应答体（json / text）是在拿到响应头之后：读完再比一次，期间换了人也不交回
    const fresh = <T,>(p: Promise<T>): Promise<T> => p.then((v) => (w.generation() !== at ? new Promise<T>(() => undefined) : v));
    const json = r.json.bind(r), text = r.text.bind(r);
    Object.defineProperty(r, 'json', { value: () => fresh(json()) });
    Object.defineProperty(r, 'text', { value: () => fresh(text()) });
    if (r.status === 401 && !new URL(url, origin).pathname.startsWith('/api/auth/me')) w.saw401();
    return r;
  }) as typeof fetch;
}

let watch: SessionWatch | null = null;
export const sessionGeneration = (): number => watch?.generation() ?? 0;
export const subscribeSession = (fn: () => void): (() => void) => watch?.subscribe(fn) ?? (() => undefined);

/** 应用启动时调一次。onLost：身份变了要做的事（清共用缓存等）。
 *  装在 window.fetch 上：同源 /api/ 回 401 就去确认；请求发出时记下世代号，回来时世代号已经变了就丢弃（这个 Promise 不再结束）。 */
export function installSessionWatch(onLost: () => void): void {
  if (watch || typeof window === 'undefined') return;
  const raw = window.fetch.bind(window);
  const origin = window.location.origin;
  const ask = async () => {
    const r = await raw('/api/auth/me', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const w = createSessionWatch({
    ask,
    onLost: () => { onLost(); window.dispatchEvent(new Event(SESSION_LOST)); },
  });
  watch = w;
  window.fetch = guardedFetch(raw, w, origin);

  void w.check();
  window.addEventListener('focus', () => { void w.check(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void w.check(); });
  window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) void w.check(); });
  window.setInterval(() => { void w.check(); }, 60_000);
}
