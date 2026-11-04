/**
 * Odoo 查看人（SSO v1）：浏览器带来的 Odoo session_id（Odoo 与市场同主机名，cookie 跨端口共享）→ 服务端调
 * WM_ODOO_URL 的 /web/session/get_session_info 现查登录名。登录门、统一待办读权、SOP 读权、管理员认定和扩展共用这一处。
 * Odoo 地址只认环境变量——注册表里的 Odoo 类台可经 MCP workbench_register 登记，不能当身份源。
 */
import { odooSessionOf } from './odoo-session.ts';

/** name：Odoo 显示名（get_session_info.name，缺省 null），只用于显示；sub = user:<Odoo 登录名> */
/** admin：Odoo session_info.is_admin（res.users._is_admin，设置/访问权限管理员）；字段缺失按 false（fail closed） */
export interface Viewer { login: string; uid: number; sub: string; name: string | null; admin: boolean }

/** 部署配置的 Odoo 地址（去掉末尾斜杠）；未配置为空串 */
export function odooUrl(): string {
  return String(process.env.WM_ODOO_URL ?? '').trim().replace(/\/+$/, '');
}

export function loginOk(login: string): boolean {
  return login.length > 0 && login.length <= 128 && login === login.trim() && !/[\x00-\x1f\x7f]/.test(login);
}

/** 用浏览器的 Odoo session_id 向 WM_ODOO_URL 现查登录名（每次都查：Odoo 侧注销即刻生效）；非内部用户 403 */
export async function resolveOdooViewer(cookieHeader: string, url = odooUrl()): Promise<{ ok: true; viewer: Viewer } | { ok: false; http: number; error: string }> {
  if (!url) return { ok: false, http: 503, error: '未配置 WM_ODOO_URL' };
  const sid = odooSessionOf(cookieHeader);
  if (!sid) return { ok: false, http: 401, error: '未登录 Odoo（请先经门户 Odoo 单点登录）' };
  if (!/^[A-Za-z0-9_.=-]{16,512}$/.test(sid)) return { ok: false, http: 401, error: 'Odoo 会话格式不对' };
  let j: any;
  try {
    const r = await fetch(`${url}/web/session/get_session_info`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json', Cookie: `session_id=${sid}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
    });
    if (!r.ok) return { ok: false, http: r.status >= 500 ? 502 : 401, error: `Odoo 会话无效（HTTP ${r.status}）` };
    j = await r.json();
  } catch (e) {
    return { ok: false, http: 502, error: `Odoo 不可达：${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  const info = j?.result;
  const login = typeof info?.username === 'string' ? info.username : '';
  if (j?.error || !info?.uid || !login) return { ok: false, http: 401, error: 'Odoo 会话已失效，请重新登录' };
  // 只认内部员工：门户/公共用户（res.users.share）也能登 Odoo，但不能看工作台。Odoo 19 session_info 的
  // is_internal_user = user._is_internal()；字段缺失或非 true 一律拒（fail closed），每次现查，Odoo 侧改了即刻生效
  if (typeof info.is_internal_user !== 'boolean') return { ok: false, http: 403, error: '无法确认是否内部员工（Odoo 会话信息缺 is_internal_user），按无权处理' };
  if (info.is_internal_user !== true) return { ok: false, http: 403, error: '门户账号不能访问工作台（仅限内部员工的 Odoo 账号）' };
  if (!loginOk(login)) return { ok: false, http: 401, error: 'Odoo 登录名不可用' };
  const name = typeof info.name === 'string' && info.name.trim() && !/[\x00-\x1f\x7f]/.test(info.name) ? info.name.trim().slice(0, 128) : null;
  return { ok: true, viewer: { login, uid: Number(info.uid), sub: `user:${login}`, name, admin: info.is_admin === true } };
}

/** #275 登录探测（GET /api/auth/viewer）：前端弹窗送 Odoo 登录后轮询此端点，200 即已登录——真实 Odoo 19 无法跨源回跳
 *  （request.redirect 默认 local=True），回程由市场源轮询完成。顶栏用户 chip 也读这里 */
export async function odooViewerWhoami(cookieHeader: string): Promise<{ http: number; body: Record<string, unknown> }> {
  if (!odooUrl()) return { http: 503, body: { ok: false, error: '未配置 WM_ODOO_URL' } };
  const who = await resolveOdooViewer(cookieHeader);
  if (!who.ok) return { http: who.http, body: { ok: false, error: who.error, auth_required: who.http === 401 } };
  // kind 按主体口径（user: = 人；经 Odoo 登录的查看人都是「人」）；roles 暂为 null（最终归 #221 A6 /api/auth/me）
  return { http: 200, body: { ok: true, viewer: { ...who.viewer, kind: '人' }, roles: null } };
}
