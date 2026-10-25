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
}

/** 统一 API 包装：写请求自动附 X-Admin-Token；401/403 时抛引导性错误（前端可捕获弹输入框）。 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getAdminToken();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has('X-Admin-Token')) headers.set('X-Admin-Token', token);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const r = await fetch(url, { ...init, headers });
  if ((r.status === 401 || r.status === 403) && url.startsWith('/api/')) {
    const err = new Error('管理员口令缺失或无效') as Error & { needAdminToken?: boolean };
    err.needAdminToken = true;
    throw err;
  }
  return r;
}
