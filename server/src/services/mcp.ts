/** MCP 网关域（mcp_sessions ×9 + mcp_calls ×2）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

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
  sessionCreateStmt() {
    return db.prepare('INSERT INTO mcp_sessions (name, token_sha256, grants) VALUES (?, ?, ?)');
  }
  callInsertStmt() {
    return db.prepare('INSERT INTO mcp_calls (session_name, method, tool, ok, error, duration_ms, args_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)');
  }
  sessionCreate(name: string, sha: string, grants: string) {
    return db.prepare('INSERT INTO mcp_sessions (name, token_sha256, grants) VALUES (?, ?, ?)').run(name, sha, grants);
  }
  sessions() {
    return db.prepare('SELECT id, name, grants, revoked_at, last_used_at, created_at FROM mcp_sessions ORDER BY id DESC').all();
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
  calls(limit: number) {
    return db.prepare('SELECT * FROM mcp_calls ORDER BY id DESC LIMIT ?').all(limit);
  }
  // ── 权限自助申请（access_request）与授权审计 ──
  sessionFull(id: number) {
    return db.prepare('SELECT id, name, grants, revoked_at FROM mcp_sessions WHERE id = ?').get(id);
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
}
