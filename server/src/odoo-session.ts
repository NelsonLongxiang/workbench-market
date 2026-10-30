/**
 * Odoo 会话 cookie（SSO v1：Odoo 与市场同主机名，浏览器按主机名把 session_id 带给市场的每个路径）。
 *
 * 它是用户在 Odoo 里的全部身份，也是生命周期审批的身份凭据（lifecycle.ts 用它确认 Odoo 登录名）。
 * 所以门户只许把它转给可信 Odoo 源：转给别的台，等于把用户的 Odoo 会话和审批身份交给那个台的运营方。
 * 台的类型与地址可以经 MCP workbench_register 由 agent 随意登记，所以「类型含 odoo / 端口 8069」不能决定谁拿会话，
 * 只认管理员在部署环境里给的源（WM_ODOO_ORIGINS、LC_ODOO_URL）。HTTP 与 WS 升级两条转发路径都按这里判定与剥除。
 */
export const ODOO_SESSION_COOKIE = 'session_id';

const SID_RE = /(?:^|;\s*)session_id=([^;\s]+)/;

/** 取 Cookie 头里的 Odoo 会话（多个同名时取第一个，与原 SSO v1 解析一致） */
export function odooSessionOf(cookieHeader: string): string {
  return SID_RE.exec(cookieHeader)?.[1] ?? '';
}

/** 去掉 Cookie 头里所有 session_id 项，其余 cookie 原样保留 */
export function withoutOdooSession(cookieHeader: string): string {
  return cookieHeader.split(';').map((c) => c.trim()).filter((c) => c && !c.startsWith(`${ODOO_SESSION_COOKIE}=`)).join('; ');
}

/** SSO v1 旧口径的 Odoo 类台（类型含 odoo 或地址里有 :8069）——注册表可由 agent 写，不参与会话判定，只用于启动时提示 */
export function isOdooLikeTarget(type: unknown, url: string): boolean {
  return /odoo/i.test(String(type ?? '')) || /:8069/.test(url);
}

/** 可信 Odoo 源：LC_ODOO_URL 的源 ∪ WM_ODOO_ORIGINS（逗号分隔）；非法项忽略并列入 invalid */
export function trustedOdooOrigins(): { origins: Set<string>; invalid: string[] } {
  const origins = new Set<string>(), invalid: string[] = [];
  for (const raw of [process.env.LC_ODOO_URL ?? '', ...String(process.env.WM_ODOO_ORIGINS ?? '').split(',')]) {
    const v = raw.trim();
    if (!v) continue;
    try { const u = new URL(v); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(); origins.add(u.origin); } catch { invalid.push(v); }
  }
  return { origins, invalid };
}

/** 这个台能不能走 SSO v1、拿到 Odoo 会话：只按可信源判定，类型、端口一概不算；一个可信源都没配时谁都不转（fail closed） */
export function isOdooSessionTarget(url: string): boolean {
  const { origins } = trustedOdooOrigins();
  try { return origins.has(new URL(url).origin); } catch { return false; }
}

/** #275 登录回跳只回需要身份的市场页（白名单）；其余本站路径一律不收，免得把刚登录的人送到同源的用户产出页 */
const RETURN_PATHS = ['/lifecycle', '/tasks'];

/** #275 登录回跳目标：只收白名单页的 path，不合格返回 null。
 *  归一化前后都查：WHATWG 会消掉点段，/.//evil、/%2e//evil 解析后会变成 //evil（协议相对，外站） */
export function safeReturnPath(v: unknown): string | null {
  const s = String(v ?? '');
  const bad = (x: string) => !x.startsWith('/') || x.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(x);
  if (!s || s.length > 512 || bad(s)) return null;
  try {
    const u = new URL(s, 'http://wm.invalid');
    const out = u.pathname + u.search + u.hash;
    if (u.origin !== 'http://wm.invalid' || bad(out) || !RETURN_PATHS.some((p) => u.pathname === p || u.pathname === `${p}/`)) return null;
    return out;
  } catch { return null; }
}

/** 就地剥除转发请求里的 Odoo 会话（剥空则删掉 Cookie 头） */
export function stripOdooSession(headers: { cookie?: string | string[] }): void {
  const raw = Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie;
  if (!raw) return;
  const kept = withoutOdooSession(raw);
  if (kept) headers.cookie = kept; else delete headers.cookie;
}
