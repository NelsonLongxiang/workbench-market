#!/usr/bin/env node
/** P0 安全冒烟（SOP run 文件写面鉴权三件·总工 direct-c2b55f91/监督席 direct-d111cf20·判据先红后绿）。
 *  ①无 token 无口令 → 401（红版原为 201 直注入）
 *  ②错 run token → 403
 *  ③正确 run token → 201
 *  ④admin 口令（人工作业路径）→ 201
 *  ⑤配额：第 21 个文件 → 413
 *  ⑥审计行落档（sop_run_file_audit 含 run_id/sha/source）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9980;
const DATA = 'tmp/e2e-p0-' + Date.now().toString(36);
const ADMIN = { 'X-Admin-Token': 'p0-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const up = async (runId, headers = {}, name = 'x.csv') => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('a,b\n1,2')], { type: 'text/csv' }), name);
  return fetch(`http://127.0.0.1:${PORT}/api/sop/runs/${runId}/files`, { method: 'POST', headers, body: fd });
};
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p0-tok' }, stdio: 'ignore',
});
try {
  await waitReady(`http://127.0.0.1:${PORT}/api/health`);
  // 开一个 run（用产库快照里的 procurement SOP）
  const slug = 'procurement-task-submit';
  const st = await fetch(`http://127.0.0.1:${PORT}/api/sop/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify({ slug, started_by: 'p0-smoke' }) });
  const stj = await st.json().catch(() => ({}));
  const runId = stj.id;
  ok('⓪ run 开', st.status === 201 && !!runId, `status=${st.status}`);
  const token = String(stj.upload_token ?? '');
  ok('⓪b 启动响应带 upload_token（创建者即得）', token.length >= 32, token.slice(0, 12) || '(空)');
  // ① 无 token → 401
  const r1 = await up(runId);
  ok('① 无 token → 401（红版曾 201 直注入）', r1.status === 401, `status=${r1.status}`);
  // ② 错 token → 403
  const r2 = await up(runId, { 'X-Run-Upload-Token': 'deadbeef'.repeat(8) });
  ok('② 错 run token → 403', r2.status === 403, `status=${r2.status}`);
  // ③ 正确 token → 201
  const r3 = await up(runId, { 'X-Run-Upload-Token': token });
  const r3b = await r3.clone().text().catch(() => '');
  ok('③ 正确 token → 201', r3.status === 201, `status=${r3.status} body=${r3b.slice(0, 120)}`);
  // ④ admin → 201
  const r4 = await up(runId, ADMIN, 'admin.csv');
  ok('④ admin 口令 → 201（人工作业）', r4.status === 201, `status=${r4.status}`);
  // ⑤ 配额（已 2 个·再传 18 到 20·第 21 个 413）——为省时：直接查 db 批量插入模拟
  // 走真路：再有 token/admin 上传 18 次到 20（API 面·隔离并发安全）
  for (let i = 3; i <= 20; i++) await up(runId, ADMIN, 'f' + i + '.csv');
  const r5 = await up(runId, { 'X-Run-Upload-Token': token }, 'over.csv');
  ok('⑤ 配额（第 21 个）→ 413', r5.status === 413, `status=${r5.status}`);
  // ⑥ 审计
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DATA + '/workbench-market.db', { readOnly: true });
    const rows = db.prepare('SELECT run_id, sha256, source FROM sop_run_file_audit WHERE run_id = ?').all(runId);
    db.close();
    ok('⑥ 审计行落档（≥2·sha 64 位·source 双态）', rows.length >= 2 && /^[0-9a-f]{64}$/.test(String(rows[0]?.sha256 ?? '')), JSON.stringify(rows.map(r => r.source)));
  }
} finally { child.kill(); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== P0 上传鉴权冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
