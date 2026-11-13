/**
 * 门户转发前去掉市场自身的认证信息：经 /go/<台号>/… 转给台的请求（HTTP 和 WebSocket 握手）只带台要的东西，
 * 市场自己的口令、令牌、凭据和会话 cookie 一概不往外带。清单集中在这里，HTTP 的 proxyReq 钩子和 index.ts 的升级处理都用它。
 *
 * 去掉的请求头：
 *   · 市场的管理口令、台令牌、SOP run 的读写凭据（下面的 MARKET_AUTH_HEADERS）；
 *   · x-wm-、x-a2a- 开头的（市场自己的标记、自检、请求体签名、A2A 投递签名）。
 * 去掉的 cookie（Cookie 头里按名字摘，别的 cookie 原样留下）：
 *   · 市场会话、登录门、登录流程的 state、内容面的上下文（MARKET_COOKIES）；
 *   · 门户自己的 SSO 状态 wm_sso_<台号>、wm_sso_ok_<台号>、wm_sso_ret_<台号>。
 * Authorization：形状是 Bearer 加 64 位十六进制、并且市场查得到的（MCP 会话令牌等市场自己发的令牌），摘掉；
 *   别的照旧——没配凭据的台，浏览器自己带的 Basic、Bearer 是给台的，原样转；配了凭据的台由门户覆盖成台的凭据（HTTP 那边覆盖之后不再查）。
 *   查法由发令牌的模块登记（useMarketTokenCheck），这里不开库；一个都没登记时启动自检不过。
 * Odoo 台的 session_id 由门户的 SSO 规则管（没过检剥掉、过检只转它一个），不在这里。
 */
import type { IncomingHttpHeaders, OutgoingHttpHeader } from 'node:http';

export const MARKET_AUTH_HEADERS: readonly string[] = [
  'x-admin-token',
  'x-app-token',
  'x-run-read-capability',
  'x-run-upload-token',
  'x-sop-run-capability',
  'x-sop-upload-capability',
  'x-sop-finish-capability',
  'x-market-client',
];
export const MARKET_AUTH_HEADER_PREFIXES: readonly string[] = ['x-wm-', 'x-a2a-'];
export const MARKET_COOKIES: readonly string[] = ['wm_session', 'wm_login', 'wm_login_state', 'wm_content_context'];
const PORTAL_SSO_COOKIE = /^wm_sso_(?:ok_|ret_)?\d+$/;
const MARKET_BEARER = /^Bearer ([0-9a-f]{64})$/i;

/** 市场自己发的令牌的查法：给令牌原文，回答「是不是市场现在认得的令牌」。发令牌的模块各登记一个，返回撤销函数 */
export type MarketTokenCheck = (token: string) => boolean;
const tokenChecks = new Set<MarketTokenCheck>();
export function useMarketTokenCheck(check: MarketTokenCheck): () => void {
  tokenChecks.add(check);
  return () => { tokenChecks.delete(check); };
}

/** Authorization 是不是市场自己的令牌：形状对，并且有一个登记的查法认得它（查法出错按不认得算） */
export function isMarketAuthorization(value: unknown): boolean {
  const m = MARKET_BEARER.exec(String(value ?? '').trim());
  if (!m) return false;
  for (const check of tokenChecks) {
    try { if (check(m[1].toLowerCase())) return true; } catch { /* 查不了：不认得 */ }
  }
  return false;
}

export function isMarketAuthHeader(name: string): boolean {
  const n = name.toLowerCase();
  return MARKET_AUTH_HEADERS.includes(n) || MARKET_AUTH_HEADER_PREFIXES.some((p) => n.startsWith(p));
}

export function isMarketCookie(name: string): boolean {
  return MARKET_COOKIES.includes(name) || PORTAL_SSO_COOKIE.test(name);
}

/** Cookie 头摘掉市场自己的 cookie；一个不剩时返回 null（整个头去掉） */
export function withoutMarketCookies(cookie: string): string | null {
  const kept = cookie.split(';').map((p) => p.trim()).filter((p) => p && !isMarketCookie(p.split('=')[0].trim()));
  return kept.length ? kept.join('; ') : null;
}

const cookieText = (v: OutgoingHttpHeader | string | string[] | undefined): string | null =>
  v === undefined ? null : Array.isArray(v) ? v.join('; ') : String(v);

/** HTTP：转给台的请求（http.ClientRequest）发出之前摘。benchAuth：门户已经把 Authorization 换成台配的凭据，不再查 */
export function stripOutgoing(req: { getHeaderNames(): string[]; getHeader(name: string): OutgoingHttpHeader | undefined; removeHeader(name: string): void; setHeader(name: string, value: string): unknown }, benchAuth = false): void {
  for (const name of req.getHeaderNames()) if (isMarketAuthHeader(name)) req.removeHeader(name);
  if (!benchAuth && isMarketAuthorization(req.getHeader('authorization'))) req.removeHeader('authorization');
  const cookie = cookieText(req.getHeader('cookie'));
  if (cookie === null) return;
  const kept = withoutMarketCookies(cookie);
  if (kept === null) req.removeHeader('cookie');
  else if (kept !== cookie) req.setHeader('cookie', kept);
}

/** WebSocket 握手：升级不走 proxyReq 钩子，直接改进来的请求头（之后原样转给台；握手里不注入台的凭据，所以 Authorization 一律查） */
export function stripIncoming(headers: IncomingHttpHeaders): void {
  for (const name of Object.keys(headers)) if (isMarketAuthHeader(name)) delete headers[name];
  if (isMarketAuthorization(headers.authorization)) delete headers.authorization;
  const cookie = cookieText(headers.cookie);
  if (cookie === null) return;
  const kept = withoutMarketCookies(cookie);
  if (kept === null) delete headers.cookie;
  else headers.cookie = kept;
}

/**
 * 启动自检的一行：拿一组编出来的请求头（市场的口令、台令牌、会话 cookie，加台自己的头和 cookie）各过一遍上面两个函数，
 * 市场的全部摘掉、台的全部留下才算过；另外至少要登记了一个市场令牌的查法。不碰网络、不读库。
 */
export function verifyPortalForwardStrip(): { ok: boolean; reason: string | null } {
  if (tokenChecks.size === 0) return { ok: false, reason: 'no-market-token-check' };
  const market = { 'x-admin-token': 'p', 'x-app-token': 'p', 'x-run-upload-token': 'p', 'x-wm-self-probe': 'p', 'x-a2a-caller-sig': 'p' };
  const cookie = 'wm_session=p; pref=1; wm_login=p; wm_sso_ok_7=1; session_x=2';
  const want = 'pref=1; session_x=2';
  const incoming: IncomingHttpHeaders = { ...market, 'x-bench': 'keep', authorization: 'Bearer bench', cookie };
  stripIncoming(incoming);
  const inOk = Object.keys(market).every((h) => !(h in incoming)) && incoming['x-bench'] === 'keep' && incoming.authorization === 'Bearer bench' && incoming.cookie === want;
  const out = new Map<string, OutgoingHttpHeader>(Object.entries({ ...market, 'x-bench': 'keep', authorization: 'Bearer bench', cookie }));
  stripOutgoing({
    getHeaderNames: () => [...out.keys()],
    getHeader: (n) => out.get(n),
    removeHeader: (n) => { out.delete(n); },
    setHeader: (n, v) => out.set(n, v),
  });
  const outOk = Object.keys(market).every((h) => !out.has(h)) && out.get('x-bench') === 'keep' && out.get('authorization') === 'Bearer bench' && out.get('cookie') === want;
  if (inOk && outOk) return { ok: true, reason: null };
  return { ok: false, reason: inOk ? 'outgoing-not-stripped' : 'incoming-not-stripped' };
}
