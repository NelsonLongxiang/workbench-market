/** 门户 /go/<id>/ 按台访问范围（access）。
 *
 * 只管经门户代理的外部台：自产台、SOP 台还能从 /apps、/sop 直接打开，在门户上设范围不起作用，所以拒绝设置。
 *
 * 三档：
 *  - all：凡是过了登录门的人（未开登录门时就是所有人）——旧行为；
 *  - admin：只给管理员（本机命令行、X-Admin-Token、口令登录 cookie、Odoo 管理员）；
 *  - listed：管理员 + access_logins 里点名的 Odoo 账号（`odoo:<登录名>`）。
 *
 * 带凭据（auth 头、Cookie 池、URL 里的 token 类查询参数）的台，没有显式给 access 时一律按 admin：
 * 门户会把凭据注入给每个能打开它的人，凭据的权限面不能默认对全员开放。
 */
import type { IncomingMessage } from 'node:http';

export type Access = 'all' | 'admin' | 'listed';
export const ACCESS_VALUES: readonly Access[] = ['all', 'admin', 'listed'];

/** API 出口掩码与「URL 自带凭据」判定共用的唯一一份键表：被掩码的就是被当作凭据的 */
export const SENSITIVE_QUERY_KEYS = /^(token|password|passwd|secret|api[-_]?key|access[-_]?token|auth)$/i;

export interface AccessRow {
  url: string;
  auth_config?: string | null;
  cookie_set_id?: number | null;
  access?: string | null;
  /** 库里是 JSON 字符串；经 rowToWorkbench 后是数组 */
  access_logins?: string | string[] | null;
}

/** 登录门认出的身份（与 login-gate.ts 的 Identity 同形；只用到这几项） */
export interface Viewer { via: 'cli' | 'token' | 'cookie' | 'odoo'; login: string | null; admin: boolean }

export function isInternalTarget(url: string): boolean {
  return url.startsWith('/');
}

export function urlCarriesSecret(url: string): boolean {
  try {
    const u = new URL(url);
    for (const k of u.searchParams.keys()) if (SENSITIVE_QUERY_KEYS.test(k)) return true;
  } catch { /* 非绝对 URL：不是外部台 */ }
  return false;
}

/** 门户会替打开者注入的凭据：auth 头、Cookie 池、URL 自带的 token 类参数 */
export function isCredentialed(row: AccessRow): boolean {
  return (row.auth_config ?? '') !== '' || Number(row.cookie_set_id ?? 0) > 0 || urlCarriesSecret(row.url);
}

export function normalizeLogin(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return '';
  return s.startsWith('odoo:') ? s : `odoo:${s}`;
}

/** 校验并规范化写入值；非法抛 Error（调用方转 400） */
export function parseAccessInput(access: unknown, logins: unknown): { access: Access; logins: string[] } {
  if (typeof access !== 'string' || !(ACCESS_VALUES as readonly string[]).includes(access)) {
    throw new Error(`access 只能是 ${ACCESS_VALUES.join(' / ')}`);
  }
  let list: string[] = [];
  if (logins !== undefined && logins !== null) {
    if (!Array.isArray(logins)) throw new Error('access_logins 必须是数组');
    if (logins.length > 200) throw new Error('access_logins 最多 200 项');
    list = [...new Set(logins.map(normalizeLogin).filter((s) => s !== ''))];
    for (const s of list) if (!/^odoo:[^\s:]{1,128}$/.test(s)) throw new Error(`access_logins 项非法：${s}`);
  }
  if (access === 'listed' && list.length === 0) throw new Error('access=listed 时 access_logins 不能为空');
  if (access !== 'listed') list = [];
  return { access: access as Access, logins: list };
}

export function effectiveAccess(row: AccessRow): Access {
  const a = String(row.access ?? '');
  return (ACCESS_VALUES as readonly string[]).includes(a) ? (a as Access) : 'admin'; // 坏值按最严
}

export function loginsOf(row: AccessRow): string[] {
  const raw = row.access_logins;
  if (Array.isArray(raw)) return raw.map(normalizeLogin).filter((s) => s !== '');
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.map(normalizeLogin).filter((s) => s !== '') : []; } catch { return []; }
}

/** 口令登录 cookie 绑定了口令指纹（口令一换即失效），持有者证明过知道管理口令，门户按管理员对待 */
export function viewerIsAdmin(v: Viewer | null): boolean {
  return !!v && (v.admin || v.via === 'cookie');
}

export type Decision = { allow: true } | { allow: false; reason: 'anonymous' | 'not-admin' | 'not-listed' };

export function decide(row: AccessRow, viewer: Viewer | null): Decision {
  if (isInternalTarget(row.url)) return { allow: true };
  const access = effectiveAccess(row);
  if (access === 'all') return { allow: true }; // 身份要求交给登录门（与旧行为一致）
  if (!viewer) return { allow: false, reason: 'anonymous' };
  if (viewerIsAdmin(viewer)) return { allow: true };
  if (access === 'admin') return { allow: false, reason: 'not-admin' };
  const who = viewer.via === 'odoo' && viewer.login ? normalizeLogin(viewer.login) : '';
  return who !== '' && loginsOf(row).includes(who) ? { allow: true } : { allow: false, reason: 'not-listed' };
}

export function viewerLabel(v: Viewer | null): string {
  if (!v) return 'anonymous';
  if (v.via === 'odoo') return `odoo:${String(v.login ?? '').toLowerCase()}`;
  return v.via === 'token' ? 'admin-token' : v.via === 'cookie' ? 'admin-cookie' : 'cli';
}

/** 审计：受限台的放行按（人, 台）10 分钟记一行，拒绝每次都记但同一来源每分钟最多 20 行；只记身份标签、台 id、结论，不记 URL 与凭据 */
export function createAccessAudit(log: (row: object) => void = (r) => console.log(JSON.stringify(r))) {
  const seen = new Map<string, number>();
  const denies = new Map<string, number[]>();
  return (id: number, viewer: Viewer | null, d: Decision, req: IncomingMessage, channel: 'http' | 'ws'): void => {
    const who = viewerLabel(viewer);
    const now = Date.now();
    if (d.allow) {
      const k = `${who}|${id}`;
      if ((seen.get(k) ?? 0) > now - 600_000) return;
      if (seen.size > 5000) seen.clear();
      seen.set(k, now);
    } else {
      const k = `${who}|${String(req.socket?.remoteAddress ?? '')}`;
      const hits = (denies.get(k) ?? []).filter((t) => t > now - 60_000);
      if (hits.length >= 20) return;
      hits.push(now);
      if (denies.size > 5000) denies.clear();
      denies.set(k, hits);
    }
    log({ source: 'portal-access', workbench: id, who, verdict: d.allow ? 'allow' : 'deny', reason: d.allow ? null : d.reason, channel, at: new Date(now).toISOString() });
  };
}
