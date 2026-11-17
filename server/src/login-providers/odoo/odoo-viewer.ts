/**
 * Odoo 查看人（SSO v1）：浏览器带来的 Odoo session_id（Odoo 与市场同主机名，cookie 跨端口共享）→ 服务端调
 * WM_ODOO_URL 的 /web/session/get_session_info 现查登录名。登录门、统一待办读权、SOP 读权、管理员认定和扩展
 * 都经身份服务（identity.ts）用到这一处。
 * Odoo 地址只认环境变量——注册表里的 Odoo 类台可经 MCP workbench_register 登记，不能当身份源。
 */
import type { ViewerResult } from '../../identity.ts';
import { configuredOdooUrl, odooSessionOf } from './odoo-session.ts';

// 查看者的形状见契约（identity.ts 的 Viewer）。这里填法：name = get_session_info.name（缺省 null），只用于显示；
// sub = user:<Odoo 登录名>；admin = session_info.is_admin（res.users._is_admin，设置/访问权限管理员），字段缺失按 false（fail closed）

/** 部署配置的 Odoo 地址（去掉末尾斜杠；WM_ODOO_URL，空时回退旧名 LC_ODOO_URL）；未配置为空串 */
export function odooUrl(): string {
  return configuredOdooUrl().replace(/\/+$/, '');
}

export function loginOk(login: string): boolean {
  return login.length > 0 && login.length <= 128 && login === login.trim() && !/[\x00-\x1f\x7f]/.test(login);
}

/** 用浏览器的 Odoo session_id 向 WM_ODOO_URL 现查登录名（每次都查：Odoo 侧注销即刻生效）；非内部用户 403 */
export async function resolveOdooViewer(cookieHeader: string, url = odooUrl()): Promise<ViewerResult> {
  if (!url) return { ok: false, http: 503, error: '未配置 WM_ODOO_URL' };
  const sid = odooSessionOf(cookieHeader);
  if (!sid) return { ok: false, http: 401, error: '未登录 Odoo（请先经门户 Odoo 单点登录）' };
  if (!/^[A-Za-z0-9_.=-]{16,512}$/.test(sid)) return { ok: false, http: 401, error: 'Odoo 会话格式不对' };
  let j: any;
  let renewed: string | undefined;
  try {
    const r = await fetch(`${url}/web/session/get_session_info`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json', Cookie: `session_id=${sid}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
    });
    if (!r.ok) return { ok: false, http: r.status >= 500 ? 502 : 401, error: `Odoo 会话无效（HTTP ${r.status}）`, cause: r.status >= 500 ? 'http-5xx' : 'rejected' };
    // Odoo 19 的软轮换：会话建了 3 小时以后，这次核验的应答会换一个会话号（Set-Cookie 里的 session_id 变了）。
    // 交给身份服务：由市场维持的会话当场换成新号（不然旧号宽限期一过就失效）
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const m = /^session_id=([A-Za-z0-9_.=-]{16,512})(?:;|$)/.exec(c);
      if (m && m[1] !== sid) renewed = m[1];
    }
    j = await r.json();
  } catch (e) {
    return { ok: false, http: 502, error: `Odoo 不可达：${String((e as Error)?.message ?? e).slice(0, 120)}`, cause: 'network' };
  }
  const info = j?.result;
  const login = typeof info?.username === 'string' ? info.username : '';
  if (j?.error || !info?.uid || !login) return { ok: false, http: 401, error: 'Odoo 会话已失效，请重新登录', cause: 'rejected' };
  // 只认内部员工：门户/公共用户（res.users.share）也能登 Odoo，但不能看工作台。Odoo 19 session_info 的
  // is_internal_user = user._is_internal()；字段缺失或非 true 一律拒（fail closed），每次现查，Odoo 侧改了即刻生效
  if (typeof info.is_internal_user !== 'boolean') return { ok: false, http: 403, error: '无法确认是否内部员工（Odoo 会话信息缺 is_internal_user），按无权处理', cause: 'bad-answer' };
  if (info.is_internal_user !== true) return { ok: false, http: 403, error: '门户账号不能访问工作台（仅限内部员工的 Odoo 账号）', cause: 'not-internal' };
  if (!loginOk(login)) return { ok: false, http: 401, error: 'Odoo 登录名不可用', cause: 'bad-answer' };
  const name = typeof info.name === 'string' && info.name.trim() && !/[\x00-\x1f\x7f]/.test(info.name) ? info.name.trim().slice(0, 128) : null;
  return { ok: true, viewer: { login, uid: Number(info.uid), sub: `user:${login}`, name, admin: info.is_admin === true }, ...(renewed ? { renewed } : {}) };
}
