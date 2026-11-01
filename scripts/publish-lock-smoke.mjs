#!/usr/bin/env node
/** #164 P1③ 发布锁冒烟：异会话 60s 内 409（hint 带 served_version 指引）·同会话续发放行·force 越锁。
 *  PUBLISH_LOCK_MS 可经 env 覆盖（测试加速）。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 10041;
const DATA = 'tmp/e2e-lock-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'lk' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const mk = (slug, content, by, extra = {}) => JSON.stringify({ slug, title: 't', created_by: by, files: [{ path: 'index.html', content }], ...extra });
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'lk', PUBLISH_LOCK_MS: '1500' }, stdio: 'ignore',
});
const B = `http://127.0.0.1:${PORT}`;
const pub = async (body) => { const r = await fetch(`${B}/api/apps`, { method: 'POST', headers: H, body, signal: AbortSignal.timeout(5000) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
try {
  await waitReady(`${B}/api/health`);
  console.log('    [stage] server ready');
  // 基线首发布（空锁）
  let r = await pub(mk('lk1', 'v1', 'sessA'));
  ok('① 首发布 201（无锁）', r.status === 201, `status=${r.status}`);
  // 异会话 1.5s 内 → 409 + hint
  r = await pub(mk('lk1', 'v2', 'sessB'));
  ok('② 异会话窗口内 409', r.status === 409, `status=${r.status}`);
  ok('②b hint 含 served/diff 指引', /served|diff|解锁/.test(String(r.j.error)), String(r.j.error).slice(0, 60));
  // 同会话续发 → 放行
  r = await pub(mk('lk1', 'v3', 'sessA'));
  ok('③ 同会话续发 200/201', r.status === 200 || r.status === 201, `status=${r.status}`);
  // force 越锁（异会话）
  r = await pub(mk('lk1', 'v4', 'sessB', { force: true }));
  ok('④ force 越锁放行', r.status === 200 || r.status === 201, `status=${r.status}`);
  // 窗口过 → 异会话放行
  await new Promise((x) => setTimeout(x, 1700));
  r = await pub(mk('lk1', 'v5', 'sessC'));
  ok('⑤ 窗口过后异会话放行', r.status === 200 || r.status === 201, `status=${r.status}`);
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log(`\n===== 发布锁冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
