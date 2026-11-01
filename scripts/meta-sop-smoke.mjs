#!/usr/bin/env node
/** 元 SOP 台 A 面冒烟（#19②b 裁 A·治理时间线·判据先红后绿）。
 *  裁定 direct-2ff2ed21：轻内嵌——Sops 页管理面抽屉加「治理时间线」（版本链+run 历史+验收链合一面）。
 *  判据：①GET /api/sops/:slug/timeline 200（红版 404）②含版本链条目（versions[]）③含 run 历史（runs[]）
 *        ④含验收链（receipts[]·dispatched runs 的回执态）⑤时间倒序（护栏）⑥非 SOP slug 404（护栏）。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9862;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-meta-sop-data';
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
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  const r = await fetch(`${BASE}/api/sops/procurement-task-submit/timeline`);
  ok('① timeline 面 200（红版 404）', r.status === 200, `status=${r.status}`);
  const j = r.ok ? await r.json() : {};
  ok('② 含版本链 versions[]', Array.isArray(j.versions) && j.versions.length >= 1, `got=${j.versions?.length ?? 'x'}`);
  ok('③ 含 run 历史 runs[]', Array.isArray(j.runs), `type=${typeof j.runs}`);
  ok('④ 含验收链 receipts[]', Array.isArray(j.receipts), `type=${typeof j.receipts}`);
  if (Array.isArray(j.versions) && j.versions.length >= 2) {
    ok('⑤ 版本倒序（最新在前）', j.versions[0].version >= j.versions[j.versions.length - 1].version, `first=${j.versions[0].version} last=${j.versions.at(-1).version}`);
  } else ok('⑤ 跳过（版本不足 2）', true);
  const r6 = await fetch(`${BASE}/api/sops/nonexistent-sop-xyz/timeline`);
  ok('⑥ 非 SOP slug 404（不泄露）', r6.status === 404, `status=${r6.status}`);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 元SOP A 面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
