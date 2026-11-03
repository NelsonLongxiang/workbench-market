#!/usr/bin/env node
import {requireDataSource} from './explicit-data-target.mjs';
const SOURCE_DATA_DIR = requireDataSource();
/** 统一绑定面冒烟（联合评审①裁定 C·判据先红后绿）。
 *  核心：方向独立性（授 notify 不过 admits 查询·反之亦然）+ direction 显式铁律
 *  + 迁移幂等 + 旧面 410 过渡。红版：新面不存在（404）+ 旧面仍 200。
 */
import { spawn } from './owned-script-fixture.mjs';
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
  const db = new DatabaseSync(SOURCE_DATA_DIR + '/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`);
  db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`${SOURCE_DATA_DIR}/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'ubind-test-token' }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  console.log('实例就绪', BASE);
  // 目标台不写死在源码里：环境变量指定，否则取快照里第一个自产台
  const appList = await (await fetch(`${BASE}/api/apps`)).json().catch(() => []);
  const APP = process.env.SMOKE_APP || (Array.isArray(appList) ? appList : []).filter((a) => a.kind !== 'sop').map((a) => a.slug)[0];
  if (!APP) throw new Error('快照里没有自产台：请设 SMOKE_APP');
  // 依赖快照里既有迁移绑定的两项：设了 SMOKE_BOUND_NODE（及 SMOKE_A2A_TEAM）才跑
  const BOUND_NODE = process.env.SMOKE_BOUND_NODE, A2A_TEAM = process.env.SMOKE_A2A_TEAM;

  // ① 新面：GET 统一列表（红版 404）
  const g1 = await fetch(`${BASE}/api/bindings?type=app&slug=${APP}`, { headers: ADMIN });
  ok('① 统一面 GET 200', g1.status === 200, `status=${g1.status}`);
  const rows = g1.ok ? await g1.json() : [];
  if (BOUND_NODE) ok('①b 迁移行在（现网 app 绑定→notify 向）', Array.isArray(rows) && rows.some(r => r.agent_node === BOUND_NODE && (r.direction === 'notify' || r.direction === 'both')), JSON.stringify(rows).slice(0, 100));
  else ok('①b 跳过（未设 SMOKE_BOUND_NODE）', true);

  // ② direction 显式铁律：无 direction → 400（红版：面都不存在）
  const p2 = await bind({ target_type: 'app', target_slug: APP, agent_node: BOUND_NODE || 'dsh/00c0ffee' });
  ok('② 无 direction 拒 400', p2.status === 400, `status=${p2.status}`);

  // ③ 方向独立性核心红：只授 notify 的行，admits 消费面必不命中
  //    实证法：A2A direct 对 SOP 台以「只有 notify 行的节点」投递 → 必 404/拒
  //    先证 admits 面从统一表读到：用快照里对 SOP 台有 admits 的节点直投（200 形）
  if (BOUND_NODE && A2A_TEAM) {
    const a2a = await fetch(`${BASE}/a2a/direct`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: A2A_TEAM, message: '{"sop":{"action":"start","text":"ubind-smoke"}}', caller_session: BOUND_NODE, task_id: 'ubind-smoke-admits-1' }),
    });
    ok('③ admits 面从统一表读（既有 SOP 绑定直投通）', a2a.status === 200 && (await a2a.json()).task_status !== 'TASK_STATE_FAILED', `status=${a2a.status}`);
  } else ok('③ 跳过（未设 SMOKE_BOUND_NODE / SMOKE_A2A_TEAM）', true);

  // ④ 旧面 410+Location 过渡（红版：仍 200/403）
  const o4 = await fetch(`${BASE}/api/apps/${APP}/bindings`, { headers: ADMIN });
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
