/** SOP 运行私有读授权的存取（#309）：运行读能力（只存摘要）sop_run_read_caps 与主体授权 sop_run_read_grants。判定口径在 sop-read-auth.ts */
import { db } from '../db.ts';

export function insertRunReadCap(runId: number, capSha256: string, expiresAt: string): void {
  db.prepare('INSERT INTO sop_run_read_caps (run_id, cap_sha256, expires_at) VALUES (?, ?, ?)').run(runId, capSha256, expiresAt);
}

/** 按摘要找读能力 */
export function runReadCapByDigest(capSha256: string): { run_id: number; expires_at: string; revoked_at: string } | undefined {
  return db.prepare('SELECT run_id, expires_at, revoked_at FROM sop_run_read_caps WHERE cap_sha256 = ?').get(capSha256) as { run_id: number; expires_at: string; revoked_at: string } | undefined;
}

/** 某主体在某运行上最新一条没撤的授权（最新一条决定期限） */
export function latestRunGrant(runId: number, subject: string): { expires_at: string | null } | undefined {
  return db.prepare("SELECT expires_at FROM sop_run_read_grants WHERE run_id = ? AND subject = ? AND revoked_at = '' ORDER BY id DESC").get(runId, subject) as { expires_at: string | null } | undefined;
}

export function insertRunReadGrant(runId: number, subject: string, role: string, expiresAt: string | null, grantedBy: string): void {
  db.prepare('INSERT INTO sop_run_read_grants (run_id, subject, role, expires_at, granted_by) VALUES (?, ?, ?, ?, ?)').run(runId, subject, role, expiresAt, grantedBy);
}

/** 撤掉某主体在某运行上的授权，返回撤了几条 */
export function revokeRunReadGrants(runId: number, subject: string): number {
  return Number(db.prepare("UPDATE sop_run_read_grants SET revoked_at = datetime('now') WHERE run_id = ? AND subject = ? AND revoked_at = ''").run(runId, subject).changes);
}

/** 撤掉某运行的全部读能力，返回撤了几条 */
export function revokeRunReadCaps(runId: number): number {
  return Number(db.prepare("UPDATE sop_run_read_caps SET revoked_at = datetime('now') WHERE run_id = ? AND revoked_at = ''").run(runId).changes);
}
