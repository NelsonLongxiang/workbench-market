#!/usr/bin/env node
/** 分拣投递开关冒烟（#19 残件 ②a·判据先红后绿）。
 *  痛点：「agent 分拣投递」的 dispatched 待验收面一直在——「默认关闭」语义未钉。
 *  设计：settings 增 dispatch_sorting_enabled（默认 '0'）——关=GET /api/sop/runs?dispatched=1 空数组；开=正常列。
 *  判据：①默认关→dispatched 列空 ②开（settings 写 1）→dispatched 列正常 ③关回→又空（幂等回切）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9861;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-dispatch-sort-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'dsort-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`);
  db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'dsort-tok' }, stdio: 'ignore',
});

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // 前置：造一条活的 dispatched run（A2A direct start）
  const st = await fetch(`${BASE}/a2a/direct`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'market/e53dee08', message: '{"sop":{"action":"start","text":"dsort-smoke"}}', caller_session: 'dsh/6de4035c', task_id: 'dsort-smoke-1' }),
  });
  ok('⓪ 造 dispatched run', st.status === 200, `status=${st.status}`);
  // ① 默认关 → dispatched 空
  let r = await fetch(`${BASE}/api/sop/runs?dispatched=1`);
  let rows = await r.json();
  // 产库快照带入 dispatched run——开关关时应拦（红版：无开关恒列=红）
  ok('① 默认关→dispatched 空（快照带入 run 被开关拦）', Array.isArray(rows) && rows.length === 0, `got=${rows.length}（红版=开关未实装致恒列）`);
  // ② 开 → dispatched 列正常
  await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ dispatch_sorting_enabled: '1' }) });
  r = await fetch(`${BASE}/api/sop/runs?dispatched=1`);
  rows = await r.json();
  ok('② 开→dispatched 正常列（快照带入条目应现）', Array.isArray(rows) && rows.length >= 1, `got=${rows.length}`);
  // ③ 关回 → 空
  await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ dispatch_sorting_enabled: false }) });
  r = await fetch(`${BASE}/api/sop/runs?dispatched=1`);
  rows = await r.json();
  ok('③ 关回→dispatched 空（幂等回切·条目再隐）', Array.isArray(rows) && rows.length === 0, `got=${rows.length}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 分拣开关冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
