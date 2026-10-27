#!/usr/bin/env node
/** SOP Runner 远程写面冒烟（#T1 裁定 A 执行件 · 判据先红后绿）。
 *  背景：远程写中间件（server/src/index.ts REMOTE_ALLOW_*）豁免清单漏了 SOP Runner
 *  业务写面——.157 业务同事裸开 Runner 页提交表单 403（主人裁定 A 注释预言的同症状）。
 *  评审裁定（direct-7d8eaa75）：业务写面（建单/存步/完成/附件）入豁免；控制面照旧收口。
 *  六判据：①远程建单 201（红版 403）②远程存步 200（红版 403）③远程完成 200（红版 403）
 *  ④远程控制面（publish）仍 403（护栏）⑤远程 assign 仍 403（护栏·控制面不放松）
 *  ⑥本机建单 201（回归护栏）。隔离实例=VACUUM INTO 主库快照+ADMIN_TOKEN 复刻门态。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9852;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-sopremote-data';
const LAN_IP = process.env.LAN_IP || ''; // 隐私门红线：内网地址只经 env（unset 则跳过远程判据）
const SLUG = 'procurement-task-submit';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// —— 快照主库（WAL 安全）——
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`);
  db.close();
}
// SOP 文件面（版本快照/自产台文件）一并拷入——run 启动要读活跃版本 manifest
for (const dir of ['apps', 'skill-snapshots']) {
  cpSync(`server/data/${dir}`, `${DATA}/${dir}`, { recursive: true });
}

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'sopremote-test-token' },
  stdio: 'ignore',
  detached: false,
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('隔离实例未就绪');
  console.log('隔离实例就绪', BASE);

  // 本机基线：建单 201（回归护栏 ⑥）
  const localStart = await fetch(`${BASE}/api/sop/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, started_by: 'sopremote-smoke-local' }),
  });
  ok('⑥ 本机建单 201', localStart.status === 201, `status=${localStart.status}`);
  const localRun = await localStart.json().catch(() => null);
  ok('⑥b 本机建单返回 run id', typeof localRun?.id === 'number');

  // LAN 可达性（不可达则远程判据跳过——fail-open 不阻断本地跑）
  let lanReachable = false;
  try { const p = await fetch(`http://${LAN_IP}:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) }); lanReachable = p.ok; } catch {}
  if (!lanReachable) {
    console.log(`  · LAN ${LAN_IP}:${PORT} 不可达——远程五项跳过（红版仍以本项为据呈报）`);
  } else {
    // ① 远程建单（红版 403 / 绿版 201）
    const r1 = await fetch(`http://${LAN_IP}:${PORT}/api/sop/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, started_by: 'sopremote-smoke-remote' }),
    });
    ok('① 远程建单 201（业务表单面开放）', r1.status === 201, `status=${r1.status}`);
    const run = await r1.json().catch(() => null);
    const rid = typeof run?.id === 'number' ? run.id : -1;
    // ② 远程存步（红版 403 / 绿版 200）
    const r2 = await fetch(`http://${LAN_IP}:${PORT}/api/sop/runs/${rid}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepKey: 'po_import', value: { poList: ['PO-REMOTE-1'], note: '远程面判据' } }),
    });
    ok('② 远程存步 200', r2.status === 200, `status=${r2.status}`);
    // ③ 远程完成（红版 403 / 绿版 200）
    const r3 = await fetch(`http://${LAN_IP}:${PORT}/api/sop/runs/${rid}/finish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    ok('③ 远程完成 200', r3.status === 200, `status=${r3.status}`);
    // ④ 远程控制面护栏：publish 仍 403
    const r4 = await fetch(`http://${LAN_IP}:${PORT}/api/sops/${SLUG}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    ok('④ 远程控制面 publish 仍 403', r4.status === 403, `status=${r4.status}`);
    // ⑤ 远程 assign 护栏：派单指派仍 403（控制面不放松）
    const r5 = await fetch(`http://${LAN_IP}:${PORT}/api/sop/runs/${rid}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: 'dsh/00000000' }),
    });
    ok('⑤ 远程 assign 仍 403', r5.status === 403, `status=${r5.status}`);
  }
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== SOP 远程写面冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
