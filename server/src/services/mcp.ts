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
  sessionCreate(name: string, sha: string, grants: string) {
    return db.prepare('INSERT INTO mcp_sessions (name, token_sha256, grants) VALUES (?, ?, ?)').run(name, sha, grants);
  }
  sessions() {
    return db.prepare('SELECT id, name, grants, revoked_at, last_used_at, created_at FROM mcp_sessions ORDER BY id DESC').all();
  }
  sessionById(id: number) {
    return db.prepare('SELECT id FROM mcp_sessions WHERE id = ?').get(id);
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
}
