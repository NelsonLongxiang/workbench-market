#!/usr/bin/env node
/** 直接调用 MCP 服务助手。库由真实 db.ts 在本次测试的临时目录初始化，数据全是合成的。 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const tmpRoot = join(import.meta.dirname, '..', 'tmp');
mkdirSync(tmpRoot, { recursive: true });
const fixture = mkdtempSync(join(tmpRoot, 'mcp-service-sqlite-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fixture;

let db;
try {
  ({ db } = await import('../server/src/db.ts'));
  const { mcpChangeRequestsByStatus } = await import('../server/src/services/change-request.ts');
  const { inAccessRequestTx, McpService } = await import('../server/src/services/mcp.ts');
  const { root } = await import('../server/src/root-context.ts');

  await test('MCP 变更列表：按状态过滤、只投影九列、按 ID 倒序取 50 条', () => {
    const insert = db.prepare(`INSERT INTO change_requests
      (id, kind, slug, op, target_version, reason, source, requested_by, status, reviewed_by, created_at)
      VALUES (?, 'app', ?, 'rollback', ?, ?, 'mcp', ?, ?, 'synthetic-reviewer', ?)`);
    const expected = [];
    for (let id = 1; id <= 120; id++) {
      const status = id % 2 === 0 ? 'approved' : 'pending';
      // 时间与 ID 顺序相反，让误按 created_at 排序的实现也会失败。
      const createdAt = new Date(Date.UTC(2026, 0, 1) - id * 1000).toISOString();
      const row = {
        id, kind: 'app', slug: 'synthetic-' + id, op: 'rollback', target_version: id + 1,
        reason: 'fixture-' + id, status, requested_by: 'synthetic-requester', created_at: createdAt,
      };
      insert.run(id, row.slug, row.target_version, row.reason, row.requested_by, row.status, row.created_at);
      expected.push(row);
    }
    for (const status of ['pending', 'approved']) {
      const actual = mcpChangeRequestsByStatus(status).map(row => ({ ...row }));
      assert.deepEqual(actual, expected.filter(row => row.status === status).reverse().slice(0, 50), status);
    }
    assert.deepEqual(mcpChangeRequestsByStatus('rejected'), []);
  });

  await test('MCP 权限申请事务：提交成功返回，写后异常原样抛出且整笔回滚', () => {
    const mcp = new McpService(root);
    const session = db.prepare("INSERT INTO mcp_sessions (name, token_sha256) VALUES ('fixture-session', 'fixture-digest')").run();
    const sessionId = Number(session.lastInsertRowid);
    const tools = JSON.stringify(['fixture_tool']);
    const committed = inAccessRequestTx(() => mcp.accessRequestInsert(sessionId, tools, 'committed').lastInsertRowid);
    assert.equal(db.isTransaction, false);
    assert.equal(mcp.accessRequestById(Number(committed)).reason, 'committed');

    const failure = new Error('synthetic failure after writes');
    assert.throws(() => inAccessRequestTx(() => {
      mcp.accessRequestInsert(sessionId, tools, 'rollback-first');
      mcp.accessRequestInsert(sessionId, tools, 'rollback-second');
      throw failure;
    }), error => error === failure);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(mcp.accessRequestsBySession(sessionId).map(row => row.reason), ['committed']);
  });
} finally {
  try { db?.close(); } finally { rmSync(fixture, { recursive: true, force: true }); }
}
