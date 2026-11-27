/**
 * #309 phase2：run 私有读授权（cap + 主体 grant 统一判定）。
 *
 * 两条正路：创建时一次性签发的 run 级读能力（服务端只存 sha256 摘要，缺省 30 天，可撤销）；
 * 或新鲜 Odoo 内部会话／已验证 MCP 会话主体在 sop_run_read_grants 有有效授权。
 * 旧 run 无 cap/grant 一律拒私有值——不按 started_by/created_by/A2A caller 推权（#309 判据）。
 * 管理员口令等价授权（受控导出通路，经 adminGuard 的路由才传入 adminOk）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { insertRunReadCap, insertRunReadGrant, latestRunGrant, revokeRunReadCaps, revokeRunReadGrants, runReadCapByDigest } from './services/sop-read-grants.ts';
import { identity } from './identity.ts';
import { defineConfig, loadConfig } from './config.ts';

/** run 读能力的有效天数：缺省 30，非数字回落缺省 */
export const Config = defineConfig((env) => ({ readCapTtlDays: Number(env.SOP_READ_CAP_TTL_DAYS) || 30 }));
const config = loadConfig(Config);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 签发 run 读能力：明文仅创建/重签响应出现一次，库内只存摘要。 */
export function issueRunReadCap(runId: number, ttlDays = config.readCapTtlDays): string {
  const cap = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + ttlDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  insertRunReadCap(runId, sha256(cap), expires);
  return cap;
}

function notExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  return new Date(String(expiresAt).replace(' ', 'T') + 'Z') > new Date();
}

export function runGrantActive(runId: number, subject: string): boolean {
  const row = latestRunGrant(runId, subject);
  return !!row && notExpired(row.expires_at);
}

export interface RunReadContext {
  adminOk?: boolean;
  cap?: string;
  cookieHeader?: string;
  /** 已验证 MCP 会话主体（形如 mcp:<会话名>）；工具 grant 不等于 run grant */
  mcpSubject?: string;
}

/** 统一读授权判定：admin > cap > MCP 会话 grant > Odoo 会话 grant；都不中即拒。 */
export async function authorizeRunRead(ctx: RunReadContext, runId: number): Promise<{ authorized: boolean; via: string }> {
  if (ctx.adminOk) return { authorized: true, via: 'admin' };
  if (ctx.cap) {
    const row = runReadCapByDigest(sha256(ctx.cap));
    if (row && row.run_id === runId && !row.revoked_at && notExpired(row.expires_at)) return { authorized: true, via: 'cap' };
  }
  if (ctx.mcpSubject) {
    if (runGrantActive(runId, ctx.mcpSubject)) return { authorized: true, via: 'mcp-grant' };
    return { authorized: false, via: 'none' };
  }
  if (ctx.cookieHeader) {
    const viewer = await identity().resolveViewer(String(ctx.cookieHeader));
    if (viewer.ok && runGrantActive(runId, viewer.viewer.sub)) return { authorized: true, via: 'session-grant' }; // 按主体标识查授权，不拿登录名去拼
  }
  return { authorized: false, via: 'none' };
}

/** 管理面（adminGuard 路由专用） */
export function runReadGrantCreate(runId: number, subject: string, role: string, expiresAt: string | null, grantedBy: string): void {
  insertRunReadGrant(runId, subject, role, expiresAt, grantedBy);
}
export function runReadGrantRevoke(runId: number, subject: string): number {
  return revokeRunReadGrants(runId, subject);
}
export function runReadCapRevokeAll(runId: number): number {
  return revokeRunReadCaps(runId);
}
