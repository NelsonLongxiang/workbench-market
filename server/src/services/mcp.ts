/** MCP 网关域（mcp_sessions ×9 + mcp_calls ×2）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { root } from '../root-context.ts';
import { HttpError } from '../errors.ts';
import type { PrincipalService } from './principal.ts';
import { seatOfSubject, seatResponsiblePrincipal } from './seat-tokens.ts';

type SessionRow = { id: number; name: string; grants: string; revoked_at: string; created_by: string; responsible_principal: string | null; is_system: number };
function eligiblePerson(id: string): boolean {
  const p = (root.get('principals') as unknown as PrincipalService).get(id);
  return p?.kind === 'person' && p.status === 'active';
}
function responsibilityError(status: number, code: string, message: string): never {
  throw new HttpError(status, message, { code });
}

/** skill_search 的审计行（显式写 at，与 McpService.callInsert 不是同一句） */
export function insertSkillSearchAudit(needDigest: string): void {
  db.prepare("INSERT INTO mcp_calls (at, session_name, method, tool, ok, error, duration_ms, args_sha256) VALUES (datetime('now'), ?, 'tools/call', 'skill_search', 1, '', 0, ?)").run('skill_search', needDigest);
}

/** MCP 权限申请的写事务：BEGIN IMMEDIATE，fn 成功提交，抛错回滚并原样抛出（fn 必须同步） */
export function inAccessRequestTx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export class McpService extends Service {
  constructor(ctx: any) {
    super(ctx, 'mcp');
  }

  sessionByToken(sha: string) {
    return db.prepare('SELECT id, name, grants FROM mcp_sessions WHERE token_sha256 = ? AND revoked_at = ?').get(sha, '');
  }
  sessionByName(name: string) {
    return db.prepare('SELECT id FROM mcp_sessions WHERE name = ?').get(name);
  }
  /** 上传票用票时复核：这个名字的会话还在（没吊销），连同它此刻的 grants */
  sessionActiveByName(name: string) {
    const row = db.prepare('SELECT id, name, grants FROM mcp_sessions WHERE name = ? AND revoked_at = ?').get(name, '') as
      Pick<SessionRow, 'id' | 'name' | 'grants'> | undefined;
    return row && this.sessionOwnerEnabled(row.id) ? row : undefined;
  }
  callInsertStmt() {
    return db.prepare('INSERT INTO mcp_calls (session_name, method, tool, ok, error, duration_ms, args_sha256, channel, seat, claimed_seat, token_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  }
  createSession(name: string, sha: string, principal: string | null, by: string) {
    return this.responsibilityTx(() => {
      if (principal !== null && !eligiblePerson(principal)) responsibilityError(422, 'mcp_responsible_invalid', '责任人必须是启用的站内个人主体');
      if (this.sessionByName(name)) responsibilityError(400, 'mcp_session_name_used', '会话名已存在: ' + name);
      const row = db.prepare('INSERT INTO mcp_sessions (name, token_sha256, created_by, responsible_principal, is_system) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .get(name, sha, by, principal, Number(principal === null)) as { id: number };
      return row.id;
    });
  }
  sessions() {
    return db.prepare(`SELECT id, name, grants, revoked_at, last_used_at, created_at, responsible_principal,
      CASE WHEN is_system = 1 THEN 'system'
        WHEN EXISTS (SELECT 1 FROM a2a_seat_subjects s WHERE s.session_id = mcp_sessions.id) THEN 'seat'
        WHEN responsible_principal IS NOT NULL THEN 'named' ELSE 'legacy' END AS responsibility_kind
      FROM mcp_sessions ORDER BY id DESC`).all();
  }
  sessionById(id: number) {
    return db.prepare('SELECT id, grants FROM mcp_sessions WHERE id = ?').get(id);  // #379：grants 用于识别会话已持有的旧授权
  }
  sessionRevoke(id: number) {
    return db.prepare("UPDATE mcp_sessions SET revoked_at = datetime('now') WHERE id = ?").run(id);
  }
  sessionGrants(id: number, grants: string) {
    return db.prepare('UPDATE mcp_sessions SET grants = ? WHERE id = ?').run(grants, id);
  }
  sessionTouched(id: number) {
    return db.prepare("UPDATE mcp_sessions SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }
  callInsert(name: string, method: string, tool: string, ok: number, error: string, durationMs: number, argsSha: string) {
    return db.prepare('INSERT INTO mcp_calls (session_name, method, tool, ok, error, duration_ms, args_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, method, tool, ok, error, durationMs, argsSha);
  }
  // ── 大结果给引用（渐进开放第 5 步）──
  /** 存一份结果：先清掉过期的，存进去，再把这个会话超出 keep 份的旧结果删掉。同一个事务 */
  resultPut(r: { id: string; sessionId: number; tool: string; bench: string; target: number | null; sha256: string; bytes: number; body: string; createdAt: number; expiresAt: number }, keep: number) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM mcp_result_refs WHERE expires_at <= ?').run(r.createdAt);
      db.prepare('INSERT INTO mcp_result_refs (id, session_id, tool, bench, target, sha256, bytes, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.id, r.sessionId, r.tool, r.bench, r.target, r.sha256, r.bytes, r.body, r.createdAt, r.expiresAt);
      db.prepare('DELETE FROM mcp_result_refs WHERE session_id = ? AND id NOT IN (SELECT id FROM mcp_result_refs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)').run(r.sessionId, r.sessionId, keep);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  /** 取一份：只认没过期的；会话对不对由调用方核 */
  resultGet(id: string, now: number) {
    return db.prepare('SELECT id, session_id, tool, bench, target, sha256, bytes, body, created_at, expires_at FROM mcp_result_refs WHERE id = ? AND expires_at > ?').get(id, now) as
      { id: string; session_id: number; tool: string; bench: string; target: number | null; sha256: string; bytes: number; body: string; created_at: number; expires_at: number } | undefined;
  }
  calls(limit: number) {
    return db.prepare('SELECT * FROM mcp_calls ORDER BY id DESC LIMIT ?').all(limit);
  }
  // ── 权限自助申请（access_request）与授权审计 ──
  sessionFull(id: number) {
    return db.prepare('SELECT id, name, grants, revoked_at, created_by, responsible_principal, is_system FROM mcp_sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }
  /** 席位归属经当前名册与市场分配查询，命名会话只认正式绑定。 */
  areaAccessPrincipal(sessionId: number, now = Date.now()): string | null {
    const row = this.sessionFull(sessionId);
    if (!row || row.is_system || row.revoked_at) return null;
    return seatOfSubject(sessionId) ? seatResponsiblePrincipal(sessionId, now) : row.responsible_principal;
  }
  sessionOwnerEnabled(sessionId: number): boolean {
    const principal = this.areaAccessPrincipal(sessionId);
    return principal === null || eligiblePerson(principal);
  }

  private responsibilityTx<T>(fn: () => T): T {
    this.accessTxBegin();
    try { const value = fn(); this.accessTxCommit(); return value; }
    catch (error) { this.accessTxRollback(); throw error; }
  }
  private legacySession(sessionId: number) {
    const row = this.sessionFull(sessionId);
    if (!row) responsibilityError(404, 'mcp_session_missing', '会话不存在');
    if (row.responsible_principal || row.is_system || row.revoked_at || seatOfSubject(sessionId)) {
      responsibilityError(409, 'mcp_responsibility_not_legacy', '只可为未吊销、仍无归属的存量命名会话提出归属');
    }
    return row;
  }
  proposeResponsibility(sessionId: number, principal: string, by: string, now = Date.now()) {
    return this.responsibilityTx(() => {
      this.legacySession(sessionId);
      if (!eligiblePerson(principal)) responsibilityError(422, 'mcp_responsible_invalid', '责任人必须是启用的站内个人主体');
      const row = db.prepare('INSERT INTO mcp_responsibility_proposals (session_id, principal_id, proposed_by, created_at) VALUES (?, ?, ?, ?) RETURNING id')
        .get(sessionId, principal, by, now) as { id: number };
      return row.id;
    });
  }
  pendingResponsibilities(principal: string) {
    return db.prepare("SELECT p.id, s.name AS session, p.proposed_by, p.created_at FROM mcp_responsibility_proposals p JOIN mcp_sessions s ON s.id = p.session_id WHERE p.principal_id = ? AND p.confirmed_at IS NULL AND s.responsible_principal IS NULL AND s.is_system = 0 AND s.revoked_at = '' AND p.id = (SELECT MAX(q.id) FROM mcp_responsibility_proposals q WHERE q.session_id = p.session_id) ORDER BY p.id DESC LIMIT 100").all(principal);
  }
  confirmResponsibility(id: number, principal: string, now = Date.now()) {
    return this.responsibilityTx(() => {
      if (!eligiblePerson(principal)) responsibilityError(403, 'mcp_responsible_invalid', '责任人必须是启用的站内个人主体');
      const row = db.prepare('SELECT session_id FROM mcp_responsibility_proposals WHERE id = ? AND principal_id = ? AND confirmed_at IS NULL AND id = (SELECT MAX(q.id) FROM mcp_responsibility_proposals q WHERE q.session_id = mcp_responsibility_proposals.session_id)')
        .get(id, principal) as { session_id: number } | undefined;
      if (!row) responsibilityError(404, 'mcp_responsibility_missing', '没有这条待你确认的归属提议');
      this.legacySession(row.session_id);
      db.prepare('UPDATE mcp_sessions SET responsible_principal = ? WHERE id = ?').run(principal, row.session_id);
      db.prepare('UPDATE mcp_responsibility_proposals SET confirmed_at = ? WHERE id = ?').run(now, id);
      return { session_id: row.session_id, responsible_principal: principal };
    });
  }
  accessRequestsBySession(sessionId: number, limit = 50) {
    return db.prepare('SELECT id, tools, reason, status, note, decided_at, created_at FROM mcp_access_requests WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit);
  }
  accessRequestPendingSame(sessionId: number, tools: string) {
    return db.prepare("SELECT id, tools, reason, status, note, decided_at, created_at FROM mcp_access_requests WHERE session_id = ? AND tools = ? AND status = 'pending' ORDER BY id LIMIT 1").get(sessionId, tools);
  }
  accessRequestCountLastHour(sessionId: number) {
    return (db.prepare("SELECT COUNT(*) AS n FROM mcp_access_requests WHERE session_id = ? AND created_at > datetime('now', '-1 hour')").get(sessionId) as { n: number }).n;
  }
  accessRequestInsert(sessionId: number, tools: string, reason: string) {
    return db.prepare('INSERT INTO mcp_access_requests (session_id, tools, reason) VALUES (?, ?, ?)').run(sessionId, tools, reason);
  }
  accessRequestById(id: number) {
    return db.prepare('SELECT * FROM mcp_access_requests WHERE id = ?').get(id);
  }
  accessRequests(status: string, limit: number) {
    const sql = 'SELECT r.*, s.name AS session_name, s.revoked_at AS session_revoked_at FROM mcp_access_requests r LEFT JOIN mcp_sessions s ON s.id = r.session_id';
    return status
      ? db.prepare(`${sql} WHERE r.status = ? ORDER BY r.id DESC LIMIT ?`).all(status, limit)
      : db.prepare(`${sql} ORDER BY r.id DESC LIMIT ?`).all(limit);
  }
  accessRequestDecide(id: number, status: 'approved' | 'rejected', by: string, note: string) {
    return db.prepare("UPDATE mcp_access_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ? AND status = 'pending'").run(status, by, note, id);
  }
  grantAuditInsert(sessionId: number, requestId: number | null, action: string, actor: string, before: string, after: string, note: string) {
    return db.prepare('INSERT INTO mcp_grant_audit (session_id, request_id, action, actor, grants_before, grants_after, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sessionId, requestId, action, actor, before, after, note);
  }

  // ---- 以下原文自 index.ts 的 /api/mcp/access-requests/:id/approve、reject 搬入：批准、驳回各自的事务语句（两处相同，合成一组） ----
  accessTxBegin() {
    db.exec('BEGIN IMMEDIATE');
  }
  accessTxCommit() {
    db.exec('COMMIT');
  }
  accessTxRollback() {
    db.exec('ROLLBACK');
  }
}
