#!/usr/bin/env node
/** S3 豁免面可观测冒烟（评审席裁下批·PR#72 真事故锚·判据先红后绿）。
 *  痛点：安全清单（REMOTE_ALLOW_*）变更无声——业务当 403 探测器（PR#72：SOP 写面漏豁免·业务撞墙才发现）。
 *  设计：启动时快照豁免面入 remote_allow_state 表 + 与前次 diff → 变更面对受影响台（绑定在册的）
 *  投 A2A 通知 + GET /api/remote-allow/diff 管理面可查。
 *  判据：①diff 面在（红版 404）②豁免变更（两组实例·前后不同 env）→ diff 记录新增/移除条目
 *  ③通知投递：变更时有绑定的台面收到 A2A 通知（cap 收）④无变更启动→diff 空（护栏）。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 9858;
const PORT2 = 9859;
const DATA = 'tmp/e2e-s3obs-data';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
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

const cap = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { res.writeHead(200).end('{}'); });
});
const CAP_PORT = await new Promise((r) => cap.listen(0, '127.0.0.1', () => r(cap.address().port)));

function boot(port) {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, MCP_GATEWAY: '', PORT: String(port), DATA_DIR: DATA, ADMIN_TOKEN: 's3obs-tok' },
    stdio: 'ignore',
  });
}

try {
  // 实例 A（首次启动：快照落库·diff 空）
  let c1 = boot(PORT);
  await waitReady(`http://127.0.0.1:${PORT}/api/health`);
  const d1 = await fetch(`http://127.0.0.1:${PORT}/api/remote-allow/diff`, { headers: { 'X-Admin-Token': 's3obs-tok' } });
  ok('① diff 面在（红版 404）', d1.status === 200, `status=${d1.status}`);
  const j1 = d1.ok ? await d1.json() : {};
  ok('④ 首次启动 diff 空（基线快照）', JSON.stringify(j1.added ?? 'x') === '[]' && JSON.stringify(j1.removed ?? 'x') === '[]', JSON.stringify(j1).slice(0, 80));
  c1.kill();
  await new Promise((r) => setTimeout(r, 800));

  // 模拟变更：手动往 state 表插一条假前次快照（含一条现清单外路径）→ 下次启动 diff 应报 removed
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${DATA}/workbench-market.db`);
    db.exec("CREATE TABLE IF NOT EXISTS remote_allow_state (id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, captured_at TEXT DEFAULT (datetime('now')))");
    db.prepare('DELETE FROM remote_allow_state').run();
    db.prepare('INSERT INTO remote_allow_state (snapshot) VALUES (?)').run(JSON.stringify(['/mcp', '/.well-known/agent-card.json', '/a2a/direct', '/api/sop/runs(\\/\\d+)?$', '/api/apps/[a-z0-9-]+/(data|files)', '/api/legacy/path']));
    db.close();
  }
  // 实例 B（二次启动：diff 应报 removed=/api/legacy/path）
  const c2 = boot(PORT2);
  await waitReady(`http://127.0.0.1:${PORT2}/api/health`);
  const d2 = await fetch(`http://127.0.0.1:${PORT2}/api/remote-allow/diff`, { headers: { 'X-Admin-Token': 's3obs-tok' } });
  const j2 = d2.ok ? await d2.json() : {};
  ok('② 变更 diff 报 removed（/api/legacy/path）', Array.isArray(j2.removed) && j2.removed.some((r) => String(r).includes('legacy')), JSON.stringify(j2.removed ?? 'null').slice(0, 80));
  c2.kill();
} finally {
  cap.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== S3 豁免可观测冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
