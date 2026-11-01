#!/usr/bin/env node
/** 统一绑定面冒烟（联合评审①裁定 C·判据先红后绿）。
 *  核心：方向独立性（授 notify 不过 admits 查询·反之亦然）+ direction 显式铁律
 *  + 迁移幂等 + 旧面 410 过渡。红版：新面不存在（404）+ 旧面仍 200。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9856;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-ubind-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'ubind-test-token' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

async function waitReady(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const bind = (body) => fetch(`${BASE}/api/bindings`, { method: 'POST', headers: ADMIN, body: JSON.stringify(body) });

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
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ubind-test-token' }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  console.log('实例就绪', BASE);

  // ① 新面：GET 统一列表（红版 404）
  const g1 = await fetch(`${BASE}/api/bindings?type=app&slug=procurement-workbench`, { headers: ADMIN });
  ok('① 统一面 GET 200', g1.status === 200, `status=${g1.status}`);
  const rows = g1.ok ? await g1.json() : [];
  ok('①b 迁移行在（现网 app 绑定→notify 向）', Array.isArray(rows) && rows.some(r => r.agent_node === 'dsh/6de4035c' && (r.direction === 'notify' || r.direction === 'both')), JSON.stringify(rows).slice(0, 100));

  // ② direction 显式铁律：无 direction → 400（红版：面都不存在）
  const p2 = await bind({ target_type: 'app', target_slug: 'procurement-workbench', agent_node: 'dsh/6de4035c' });
  ok('② 无 direction 拒 400', p2.status === 400, `status=${p2.status}`);

  // ③ 方向独立性核心红：只授 notify 的行，admits 消费面必不命中
  //    实证法：A2A direct 对 procurement-task-submit（SOP 台）以「只有 notify 行的节点」投递 → 必 404/拒
  //    现网最稳样例：dsh/6de4035c 对 SOP 台有 admits（迁移自带）——先证 admits 面从统一表读到（直投 200 形）
  const a2a = await fetch(`${BASE}/a2a/direct`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'market/e53dee08', message: '{"sop":{"action":"start","text":"ubind-smoke"}}', caller_session: 'dsh/6de4035c', task_id: 'ubind-smoke-admits-1' }),
  });
  ok('③ admits 面从统一表读（既有 SOP 绑定直投通）', a2a.status === 200 && (await a2a.json()).task_status !== 'TASK_STATE_FAILED', `status=${a2a.status}`);

  // ④ 旧面 410+Location 过渡（红版：仍 200/403）
  const o4 = await fetch(`${BASE}/api/apps/procurement-workbench/bindings`, { headers: ADMIN });
  ok('④ 旧面 410 过渡', o4.status === 410, `status=${o4.status}`);
  ok('④b 410 带 Location 指新面', /\/api\/bindings/.test(o4.headers.get('location') ?? ''), o4.headers.get('location') ?? '(无)');

  // ⑤ 迁移幂等：重启再验行不增（以 GET 计数代——绿版补真重启断言）
  // （绿版追加：spawn 重启实例 → 行数不变）
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== 统一绑定冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
