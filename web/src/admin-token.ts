/**
 * 全局管理员口令（监督席 direct-92be192a 用户报障二连环）：
 * 一处输入（任意页顶栏钥匙图标）· sessionStorage 会话级 · 全页面写请求自动携带。
 * 管理认证失败引导输入；具名的来源拒绝或台授权错误保留各自的提示。
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

/** 保存前向服务端核对口令：输错的口令不再存下来、再到每个管理页报「需要管理员」。
 *  返回 null = 可用（或服务端暂时不可达，照旧存下）；否则是给人看的原因。 */
export async function checkAdminToken(token: string): Promise<string | null> {
  if (!/^[\x21-\x7e]+$/.test(token)) return '口令只能是可见的 ASCII 字符，不能含空格、中文或全角符号';
  try {
    const r = await fetch('/api/admin/whoami', { headers: { Accept: 'application/json', 'X-Admin-Token': token } });
    if (r.status === 429) return '尝试太频繁，请稍后再试'; // 限频时不能当作「连不上」照旧存下
    if (!r.ok) return null;
    const j = await r.json() as { via?: string | null };
    if (j?.via === 'token') return null;
    const s: { source?: string } = await fetch('/api/admin-token/state', { headers: { Accept: 'application/json' } })
      .then((x) => (x.ok ? x.json() : {}))
      .catch(() => ({}));
    if (s.source === 'none') return '服务端还没有设置管理员口令；请用有管理员授予的站内账号登录，或在本机设置口令';
    if (s.source === 'env') return '口令不对：服务端口令来自部署环境变量 ADMIN_TOKEN，以前在设置页改过的口令不再生效';
    return '口令不对：与服务端当前口令不一致';
  } catch { return null; }
}

/** #292 M4 止血：口令在本标签页时，/use 与驾驶舱不再以 iframe 嵌 /go/（同源 iframe 读得到 sessionStorage、能挂钩父页 fetch） */
export const ADMIN_TOKEN_CHANGED = 'wm:admin-token-changed';
export const adminTokenPresent = (): boolean => getAdminToken() !== '';

/** 站内管理员：登录的人持 owner/admin 授予（服务端 /api/admin/whoami 回 via=grant）。Odoo 已下线（2026-11-17），
 *  身份来源自己说「是管理员」不再算数。这里只缓存结论给菜单与页面开关用；真正的授权在服务端每次请求判。 */
let grantAdminLogin: string | null = null;
export const adminLogin = (): string | null => grantAdminLogin;
/** 当前页面是否以管理员身份工作：持口令，或持 owner/admin 授予的站内管理员 */
export const adminActive = (): boolean => adminTokenPresent() || grantAdminLogin !== null;
export async function refreshAdminIdentity(): Promise<void> {
  let next: string | null = null;
  try {
    const r = await fetch('/api/admin/whoami', { headers: { Accept: 'application/json' } });
    const j = await r.json() as { via?: string | null; login?: string | null };
    next = j?.via === 'grant' && typeof j.login === 'string' ? j.login : null; // 只认授予；服务端遗留的 via=odoo 不再算
  } catch { next = null; }
  if (next === grantAdminLogin) return;
  grantAdminLogin = next;
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

export function crossOriginError(body: unknown): string | null {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === 'string' && /^[a-z_]+_cross_origin_denied$/.test(code)
    ? '请求来源校验未通过。请从市场的正式地址打开页面后重试。'
    : null;
}

/** 统一 API 包装：写请求自动附 X-Admin-Token；登录门 401 去登录页。 */
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
    // 拒绝仍按原来的身份门处理；先读完正文，让浏览器结束这次网络请求。
    if (r.status === 401) await r.text().catch(() => undefined);
    if (r.status === 403) {
      const body = await r.json().catch(() => null);
      const originError = crossOriginError(body);
      if (originError) throw new Error(originError);
      if (/^\/api\/bench-views\/[^/]+\/mcp-requests\/\d+$/.test(url)) {
        if (body?.error === 'bench_views_forbidden') throw new Error('你没有权限办理这个台的 MCP 授权。');
        if (body?.error === 'bench_views_admin_token_denied') throw new Error('台的 MCP 授权需要个人账号。请清除顶栏管理口令后重试。');
      }
    }
    const err = new Error('需要管理员：请在顶栏输入管理员口令，或用有管理员授予的站内账号登录') as Error & { needAdminToken?: boolean };
    err.needAdminToken = true;
    throw err;
  }
  return r;
}
