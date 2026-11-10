/**
 * Odoo 会话 cookie（SSO v1：Odoo 与市场同主机名，浏览器按主机名把 session_id 带给市场的每个路径）。
 *
 * 它是用户在 Odoo 里的全部身份，也是工作台认人的凭据（odoo-viewer.ts 用它确认 Odoo 登录名）。
 * 所以门户只许把它转给可信 Odoo 源：转给别的台，等于把用户的 Odoo 会话和工作台身份交给那个台的运营方。
 * 台的类型与地址可以经 MCP workbench_register 由 agent 随意登记，所以「类型含 odoo / 端口 8069」不能决定谁拿会话，
 * 只认管理员在部署环境里给的源（WM_ODOO_ORIGINS、WM_ODOO_URL）。HTTP 与 WS 升级两条转发路径都按这里判定与剥除。
 */
import { randomUUID } from 'node:crypto';
import type { SsoTicket, SsoTicketStore } from '../../identity.ts';

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

/** 部署配置的 Odoo 地址原值：WM_ODOO_URL；为空时回退旧名 LC_ODOO_URL（已弃用，启动时告警，见 odooUrlDeprecated） */
export function configuredOdooUrl(): string {
  return String(process.env.WM_ODOO_URL ?? '').trim() || String(process.env.LC_ODOO_URL ?? '').trim();
}
/** 只设了旧名 LC_ODOO_URL（两个都设时以 WM_ODOO_URL 为准，也提示旧名可删） */
export function odooUrlDeprecated(): 'only-old' | 'both' | null {
  const neu = String(process.env.WM_ODOO_URL ?? '').trim(), old = String(process.env.LC_ODOO_URL ?? '').trim();
  return old ? (neu ? 'both' : 'only-old') : null;
}

/** 可信 Odoo 源：WM_ODOO_URL（或旧名）的源 ∪ WM_ODOO_ORIGINS（逗号分隔）；非法项忽略并列入 invalid */
export function trustedOdooOrigins(): { origins: Set<string>; invalid: string[] } {
  const origins = new Set<string>(), invalid: string[] = [];
  for (const raw of [configuredOdooUrl(), ...String(process.env.WM_ODOO_ORIGINS ?? '').split(',')]) {
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
const RETURN_PATHS = ['/tasks', '/login']; // /login：登录门的「用 Odoo 登录」

/** 扩展登记自己需要身份的页面（ctx.odoo.addReturnPath）：只收 /小写段[/小写段]，重复登记无副作用 */
export function addOdooReturnPath(p: string): void {
  if (!/^\/[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})?$/.test(p)) throw new Error(`登录回跳页路径非法：${p}`);
  if (!RETURN_PATHS.includes(p)) RETURN_PATHS.push(p);
}

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

// ---------- 门户 SSO 回调票据（同域登录中继专用） ----------
// 不带 return 的普通 /go/<id>/ 入口登录完要回本台 SSO 回调 /go/<id>/?state=<uuid>。只看形状不够：任何台 id 配一个
// 形状合法的 uuid，都能让中继把刚登录的人送到不可信台（运维席 direct-24dd6c02 反例）。所以回调地址只认门户自己签发、
// 未过期、未用过的票据：票据把台 id、state 和签发时的可信 Odoo 源绑在一起；每次核对都按注册表现查该台仍是同一可信源，
// 部署配置的 WM_ODOO_URL 也还是这个源；门户回调核对 state cookie 通过后作废票据（重放即失效）。
const SSO_TICKET_TTL_MS = 10 * 60 * 1000; // 与 wm_sso_<id> state cookie 同寿命
const SSO_TICKET_MAX = 4096;
/** 同一来源（clientIp）同时持有的有效票据上限：匿名 GET 就能签发，不设上限的话一个来源刷入口就能把别人的票据挤掉 */
export const SSO_TICKET_PER_SOURCE = 20;
// 票据与票据存储的形状见契约（identity.ts 的 SsoTicket、SsoTicketStore）：缺省进程内存；index.ts 装配时换成 SQLite
const memoryTickets = new Map<string, SsoTicket>();
const memoryStore: SsoTicketStore = {
  get: (s) => memoryTickets.get(s) ?? null,
  put: (s, t) => { memoryTickets.set(s, t); },
  take: (s) => { const t = memoryTickets.get(s) ?? null; memoryTickets.delete(s); return t; },
  sweep: (now, max) => {
    for (const [k, t] of memoryTickets) if (t.exp <= now) memoryTickets.delete(k);
    while (memoryTickets.size > max) memoryTickets.delete(memoryTickets.keys().next().value as string);
  },
  activeBySource: (src, now) => { let n = 0; for (const t of memoryTickets.values()) if (t.source === src && t.exp > now) n++; return n; },
};
let ticketStore: SsoTicketStore = memoryStore;
export function setSsoTicketStore(store: SsoTicketStore): void { ticketStore = store; }
let ssoTargetUrl: (id: number) => string | null = () => null;

/** 门户装配时登记：按台 id 现查注册表里的地址（台不存在或已停用返回 null） */
export function setSsoTargetLookup(fn: (id: number) => string | null): void { ssoTargetUrl = fn; }

const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ''; } };

/** 为可信 Odoo 台签一张回调票据，返回 state（同时用作 wm_sso_<id> cookie 值）；该来源已持有上限张有效票据时返回 null（调用方回 429） */
export function issueSsoCallback(id: number, origin: string, source: string): string | null {
  const now = Date.now();
  ticketStore.sweep(now, SSO_TICKET_MAX - 1);
  if (ticketStore.activeBySource(source, now) >= SSO_TICKET_PER_SOURCE) return null;
  const state = randomUUID();
  ticketStore.put(state, { id, origin, source, exp: now + SSO_TICKET_TTL_MS });
  return state;
}

function ssoTicketValid(id: number, state: string): boolean {
  return ticketMatches(ticketStore.get(state), id);
}
function ticketMatches(t: SsoTicket | null, id: number): boolean {
  if (!t || t.id !== id || t.exp <= Date.now()) return false;
  const url = ssoTargetUrl(id);
  if (!url || !isOdooSessionTarget(url) || originOf(url) !== t.origin) return false; // 台改了地址 / 不再是可信源
  return originOf(configuredOdooUrl()) === t.origin; // 部署配置的 Odoo 换了
}

/** 门户 SSO 回调（state cookie 已核对）时作废票据；返回作废前是否有效。经典流程（中继关）没有票据，返回 false 不影响 */
export function consumeSsoCallback(id: number, state: string): boolean {
  return ticketMatches(ticketStore.take(state), id);
}

/** 同域登录中继专用（WM_ODOO_LOGIN_PROXY=1）：白名单页之外，只再收「持有效票据」的门户 SSO 回调
 *  /go/<台id>/?state=<uuid>（精确形状：数字台 id、单个 state 参数、小写 uuid，不带别的参数和 hash） */
export function safeLoginRedirect(v: unknown): string | null {
  const page = safeReturnPath(v);
  if (page) return page;
  const s = String(v ?? '');
  const m = /^\/go\/([1-9][0-9]{0,9})\/\?state=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(s);
  return m && ssoTicketValid(Number(m[1]), m[2]) ? s : null;
}

/** 就地剥除转发请求里的 Odoo 会话（剥空则删掉 Cookie 头） */
export function stripOdooSession(headers: { cookie?: string | string[] }): void {
  const raw = Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie;
  if (!raw) return;
  const kept = withoutOdooSession(raw);
  if (kept) headers.cookie = kept; else delete headers.cookie;
}
