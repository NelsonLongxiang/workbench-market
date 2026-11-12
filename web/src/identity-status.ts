/** 身份服务连不上（#639）：要认人的接口在身份来源不可达时回 502 { error: 'identity_unavailable' }。
 *  这和「没登录」（401）是两回事：不跳登录页、不清登录态，外壳上挂一条整页提示，退避着自动重试，连上了提示自己消失、页面重读。
 *  认法只有一条：状态码 502、而且 error 正好是 identity_unavailable——别的 502（比如上游工具失败）不算；401 照旧按没登录处理。
 *  这一处装在 window.fetch 上（installIdentityWatch），所有同源 /api/ 的请求都经过它，不必每页各写。
 *  不引别的文件：scripts/identity-status-unit.mjs 直接测。 */

export const IDENTITY_UNAVAILABLE = 'identity_unavailable';
/** 页面上给人看的话（外壳的提示、取数失败时的说法共用） */
export const IDENTITY_DOWN_TEXT = '身份服务暂时连不上';

/** 这一个应答是不是「身份服务连不上」 */
export function isIdentityUnavailable(status: number, body: unknown): boolean {
  return status === 502 && !!body && typeof body === 'object' && (body as { error?: unknown }).error === IDENTITY_UNAVAILABLE;
}

/** 第几次重试之前等多久（毫秒）：4、8、15 秒，之后每 30 秒一次。
 *  第一次不短于 3 秒：服务端把「来源不可达」的回答留 3 秒，早问只会再拿一次 502 */
const DELAYS = [4000, 8000, 15000];
export function retryDelay(attempt: number): number {
  return attempt < DELAYS.length ? DELAYS[Math.max(0, attempt)] : 30000;
}

/** 只看同源、以 /api/ 开头的请求（外链、静态文件不管） */
export function isApiUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin);
    return u.origin === origin && u.pathname.startsWith('/api/');
  } catch { return false; }
}

export type IdentityWatch = {
  /** 现在是不是连不上 */
  down: () => boolean;
  /** 看一个应答：是「连不上」就记下并开始重试 */
  observe: (status: number, body: unknown) => void;
  /** 不等下一次，马上重试一次 */
  retryNow: () => void;
  subscribe: (fn: () => void) => () => void;
};

/** 状态和重试。probe：重试时去问一次（返回状态码和应答体；断网返回状态码 0）；
 *  问到的不是「连不上」、也不是断网，就算连上了：清掉状态、调 onRecover（页面重读） */
export function createIdentityWatch(deps: {
  probe: () => Promise<{ status: number; body: unknown }>;
  onRecover?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): IdentityWatch {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let isDown = false;
  let attempt = 0;
  let timer: unknown = null;
  let probing = false;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void tryOnce(); }, retryDelay(attempt));
  };
  const tryOnce = async () => {
    if (!isDown || probing) return;
    probing = true;
    attempt += 1;
    let r: { status: number; body: unknown };
    try { r = await deps.probe(); } catch { r = { status: 0, body: null }; }
    probing = false;
    if (!isDown) return;
    if (r.status !== 0 && !isIdentityUnavailable(r.status, r.body)) {
      isDown = false; attempt = 0;
      if (timer !== null) { clearTimer(timer); timer = null; }
      emit(); deps.onRecover?.();
      return;
    }
    schedule();
  };
  return {
    down: () => isDown,
    observe: (status, body) => {
      if (!isIdentityUnavailable(status, body) || isDown) return;
      isDown = true; attempt = 0;
      emit(); schedule();
    },
    retryNow: () => { if (isDown) { if (timer !== null) { clearTimer(timer); timer = null; } void tryOnce(); } },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

/** 只读 JSON 应答的体：流式（text/event-stream）、HTML、纯文本都放过 */
export function isJsonType(ct: string | null): boolean {
  return !!ct && /^application\/(?:[\w.+-]+\+)?json\b/i.test(ct.trim());
}

let watch: IdentityWatch | null = null;
/** 外壳和页面读状态用（useSyncExternalStore）；没装的时候当作连得上 */
export const identityDown = (): boolean => watch?.down() ?? false;
export const subscribeIdentity = (fn: () => void): (() => void) => watch?.subscribe(fn) ?? (() => undefined);
export const retryIdentityNow = (): void => watch?.retryNow();

/** 装在 window.fetch 上（应用启动时调一次）：同源 /api/ 的应答是 502、而且是 JSON，就在它的副本（response.clone()）上读 error，是「连不上」就记下。
 *  原应答原样交回、应答体不被消费，不改任何请求的行为；流式应答（text/event-stream）和别的非 JSON 应答直接放过、不读体。
 *  重试问的是 /api/attention——要认人的接口里最常用、登录门关着时也会回这个代号的那一个。onRecover：连上之后让页面重读 */
export function installIdentityWatch(onRecover: () => void): void {
  if (watch || typeof window === 'undefined') return;
  const raw = window.fetch.bind(window);
  const origin = window.location.origin;
  const probe = async () => {
    try {
      const r = await raw('/api/attention', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch { return { status: 0, body: null }; }
  };
  const w = createIdentityWatch({ probe, onRecover });
  watch = w;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await raw(input, init);
    if (r.status === 502 && isJsonType(r.headers.get('content-type'))) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isApiUrl(url, origin)) void r.clone().json().then((b: unknown) => w.observe(r.status, b), () => undefined);
    }
    return r;
  };
}
