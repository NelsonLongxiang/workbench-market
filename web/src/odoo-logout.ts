/** Explicitly sign out of the market and, when supported, the Odoo session. */
export async function logoutCurrentSession(): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await fetch('/api/auth/logout', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-WM-Odoo-Logout': '1' }, body: '{}',
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) return { ok: false, message: typeof body?.error === 'string' ? body.error : '无法确认退出，请勿在共享设备上离开当前浏览器。' };
    if (body.odoo_session && body.odoo_session_revoked !== true) return { ok: false, message: '市场登录已退出，但 Odoo 会话仍有效，请在 Odoo 中退出。' };
    return { ok: true };
  } catch { return { ok: false, message: '无法连接服务器，无法确认退出，请勿在共享设备上离开当前浏览器。' }; }
}
