#!/usr/bin/env node
/** 管理员口令安全冒烟（评审 #27）：出口剔除哈希 / 加盐存储 / 旧格式兼容 / 鉴权正负例。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeLegacyTokenFixture } from './token-smoke-db.mjs';

const PORT = Number(process.env.TK_PORT) > 0 ? Number(process.env.TK_PORT) : 20000 + Math.floor(Math.random() * 20000); // E2E 内并发避端口撞
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-token-data';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: 'server', env: { ...process.env, ADMIN_TOKEN: '', MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: `../${DATA}` }, stdio: ['ignore', 'pipe', 'pipe'], // 清 ADMIN_TOKEN（外层 E2E 环境继承会致「设置口令」403 假红）
});
if (!(await waitReady(BASE + '/api/health'))) { console.log('  ✗ 实例未就绪'); process.exit(1); }

async function call(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

try {
  const DB = `${DATA}/workbench-market.db`;
  // ① 首次设置口令 → 加盐存储
  let r = await call('PUT', '/api/admin-token', { token: 'abcd-strong-1234' });
  ok('设置口令 200', r.status === 200);
  const readDb = new DatabaseSync(DB, { readOnly: true });
  let row;
  try { row = readDb.prepare("SELECT value FROM settings WHERE key='admin_token_sha256'").get(); }
  finally { readDb.close(); }
  ok('存储为加盐格式 salt$hash', typeof row?.value === 'string' && /^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(row.value), row?.value);
  ok('库内不含明文', !String(row?.value ?? '').includes('abcd-strong-1234'));
  // ② 出口剔除：settings / export 不得出现哈希
  r = await call('GET', '/api/settings');
  ok('settings 无 admin_token_sha256', !('admin_token_sha256' in (r.body ?? {})));
  ok('settings 无哈希值泄漏', !JSON.stringify(r.body).includes(String(row?.value ?? 'xxx')));
  r = await call('GET', '/api/export');
  ok('export 无 admin_token_sha256', !('admin_token_sha256' in ((r.body ?? {}).settings ?? {})));
  // ③ 鉴权正负例
  r = await call('GET', '/api/mcp/tools', null, { 'X-Admin-Token': 'abcd-strong-1234' });
  ok('正确口令 → 200', r.status === 200, String(r.status));
  r = await call('GET', '/api/mcp/tools', null, { 'X-Admin-Token': 'wrong' });
  ok('错误口令 → 403', r.status === 403);
  // ④ 改口令需当前口令
  r = await call('PUT', '/api/admin-token', { token: 'next-token-5678' });
  ok('改口令无当前口令 → 403', r.status === 403);
  r = await call('PUT', '/api/admin-token', { token: 'next-token-5678' }, { 'X-Admin-Token': 'abcd-strong-1234' });
  ok('带当前口令改 → 200', r.status === 200);
  r = await call('GET', '/api/mcp/tools', null, { 'X-Admin-Token': 'next-token-5678' });
  ok('新口令生效', r.status === 200);
  r = await call('GET', '/api/mcp/tools', null, { 'X-Admin-Token': 'abcd-strong-1234' });
  ok('旧口令失效 403', r.status === 403);
  // ⑤ 旧无盐格式兼容（模拟迁移前数据）
  const legacy = createHash('sha256').update('legacy-pass', 'utf8').digest('hex');
  // Test server may be writing concurrently: bounded SQLite wait, never swallow SQLITE_BUSY.
  writeLegacyTokenFixture(DB, legacy);
  r = await call('GET', '/api/mcp/tools', null, { 'X-Admin-Token': 'legacy-pass' });
  ok('旧无盐格式仍可验证（兼容）', r.status === 200, String(r.status));
  // ⑥ 清除需当前口令
  r = await call('DELETE', '/api/admin-token', null, { 'X-Admin-Token': 'wrong' });
  ok('清除无当前口令 → 403', r.status === 403);
  r = await call('DELETE', '/api/admin-token', null, { 'X-Admin-Token': 'legacy-pass' });
  ok('带当前口令清除 → 200', r.status === 200);
  r = await call('GET', '/api/admin-token/state');
  ok('清除后 source=none', r.body?.source === 'none', JSON.stringify(r.body));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 口令安全冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
