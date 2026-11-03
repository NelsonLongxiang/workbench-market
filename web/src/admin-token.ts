/**
 * 全局管理员口令（监督席 direct-92be192a 用户报障二连环）：
 * 一处输入（任意页顶栏钥匙图标）· sessionStorage 会话级 · 全页面写请求自动携带。
 * 401/403 统一引导弹窗输入，不再裸报错。
 */
let cached: string | null = null;

export function getAdminToken(): string {
  if (cached !== null) return cached;
  try { cached = sessionStorage.getItem('wm-admin-token') ?? ''; } catch { cached = ''; }
  return cached;
}

export function setAdminToken(token: string): void {
  cached = token;
  try {
    if (token) sessionStorage.setItem('wm-admin-token', token);
    else sessionStorage.removeItem('wm-admin-token');
  } catch { /* 隐私模式降级：仅内存态 */ }
  try { window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED)); } catch { /* 非浏览器环境 */ }
}

/** #292 M4 止血：口令在本标签页时，/use 与驾驶舱不再以 iframe 嵌 /go/（同源 iframe 读得到 sessionStorage、能挂钩父页 fetch） */
export const ADMIN_TOKEN_CHANGED = 'wm:admin-token-changed';
export const adminTokenPresent = (): boolean => getAdminToken() !== '';

/** Odoo 管理员（属主 2026-11-02：Odoo 管理员登录也算管理员）：服务端按浏览器的 Odoo 会话现查 is_admin，
 *  这里只缓存结论给菜单与页面开关用；真正的授权在服务端每次请求判。 */
let odooAdminLogin: string | null = null;
export const odooAdmin = (): string | null => odooAdminLogin;
/** 当前页面是否以管理员身份工作：持口令，或 Odoo 管理员 */
export const adminActive = (): boolean => adminTokenPresent() || odooAdminLogin !== null;
export async function refreshAdminIdentity(): Promise<void> {
  let next: string | null = null;
  try {
    const r = await fetch('/api/admin/whoami', { headers: { Accept: 'application/json' } });
    const j = await r.json() as { via?: string | null; login?: string | null };
    next = j?.via === 'odoo' && typeof j.login === 'string' ? j.login : null;
  } catch { next = null; }
  if (next === odooAdminLogin) return;
  odooAdminLogin = next;
  try { window.dispatchEvent(new Event(ADMIN_TOKEN_CHANGED)); } catch { /* 非浏览器环境 */ }
}
export function subscribeAdminToken(cb: () => void): () => void {
  window.addEventListener(ADMIN_TOKEN_CHANGED, cb);
  return () => window.removeEventListener(ADMIN_TOKEN_CHANGED, cb);
}

/** #292 M4 止血：离开市场页面（同标签页跳到 /go/、/sop/、外站，或刷新）时从 sessionStorage 抹掉口令，
 *  新文档（可能是不可信页）就读不到。代价：刷新后要重输口令。
 *  注意：本文档内存里的副本不清——浏览器若用往返缓存（bfcache）恢复旧页面，旧页面仍持有口令（GoFrame 照样拒嵌）；
 *  本机实测后退未命中 bfcache，这条路径未验证。存储为空不等于口令失效。 */
export function installAdminTokenLeaveGuard(): void {
  window.addEventListener('pagehide', () => {
    try { sessionStorage.removeItem('wm-admin-token'); } catch { /* 忽略 */ }
  });
}

/** 全站登录门（WM_LOGIN_GATE=enforce）拦下的 401 带 X-WM-Login-Required：整页去登录页，登录后回到当前页。
 *  与「缺管理员口令」的 401/403 区分开——那种仍弹口令输入，不跳页。 */
export function loginRequired(r: Response): boolean {
  return r.status === 401 && r.headers.get('X-WM-Login-Required') === '1';
}
let leaving = false;
export function redirectToLogin(): void {
  if (leaving) return;
  leaving = true;
  const here = window.location.pathname + window.location.search + window.location.hash;
  window.location.assign(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
}

/** 统一 API 包装：写请求自动附 X-Admin-Token；登录门 401 去登录页；其余 401/403 抛引导性错误（前端可捕获弹输入框）。 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getAdminToken();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has('X-Admin-Token')) headers.set('X-Admin-Token', token);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const r = await fetch(url, { ...init, headers });
  if (loginRequired(r)) {
    redirectToLogin();
    throw new Error('需要登录：正在前往登录页');
  }
  if ((r.status === 401 || r.status === 403) && url.startsWith('/api/')) {
    const err = new Error('需要管理员：请在顶栏输入管理员口令，或用 Odoo 管理员账号登录') as Error & { needAdminToken?: boolean };
    err.needAdminToken = true;
    throw err;
  }
  return r;
}
