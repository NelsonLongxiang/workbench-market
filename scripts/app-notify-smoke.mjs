#!/usr/bin/env node
/** 自产台提交推送冒烟（属主裁 C · 判据先红后绿）。
 *  诉求：业务同事在自产台提交表单后，市场应把提交件 A2A 推送到绑定 agent
 *  （页面承诺「采购 agent 将出件」此前无机制承载——数据面是哑存储，纯拉模式）。
 *  设计：app_bindings（slug×node×base_url，管理面 CRUD）+ data 201 后异步 a2aSendOutbound。
 *  判据：①绑定创建 201（红版 404）②提交 201 且 cap 收到 1 发推送（team=node·含 slug/id/字段）
 *  ③撤销后新提交不再推 ④无绑定 slug 提交不推不炸（护栏）⑤远程 LAN 面提交同样触发（裁定 A 面×推送）。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 9853;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-appnotify-data';
const LAN_IP = process.env.LAN_IP || ''; // 隐私门红线：内网地址只经 env（unset 则跳过远程判据）
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'appnotify-test-token' };
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

// cap：接收市场推送的假对端（记录 /a2a/direct 投递体）
const pushes = [];
const cap = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try { pushes.push({ url: req.url, body: JSON.parse(body || '{}') }); } catch { pushes.push({ url: req.url, body: { raw: body.slice(0, 200) } }); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ routed: true, delivered: true, task_status: 'TASK_STATE_DELIVERED' }));
  });
});
const CAP_PORT = await new Promise((resolve) => cap.listen(0, '127.0.0.1', () => resolve(cap.address().port)));

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
  cwd: process.cwd(),
  env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'appnotify-test-token' },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('隔离实例未就绪');
  console.log('隔离实例就绪', BASE, '| cap@', CAP_PORT);

  // ① 绑定创建（统一面）：先撤销同 node 旧行（现网迁移行已在·UNIQUE natural key 撞）——测试隔离性
  const old = await (await fetch(`${BASE}/api/bindings?type=app&slug=procurement-workbench`, { headers: ADMIN })).json().catch(() => []);
  for (const row of Array.isArray(old) ? old : []) if (row.agent_node === 'dsh/6de4035c' && !row.revoked_at) await fetch(`${BASE}/api/bindings/${row.id}`, { method: 'DELETE', headers: ADMIN });
  const b1 = await fetch(`${BASE}/api/bindings`, {
    method: 'POST', headers: ADMIN,
    body: JSON.stringify({ target_type: 'app', target_slug: 'procurement-workbench', agent_node: 'dsh/6de4035c', direction: 'notify', notify_url: `http://127.0.0.1:${CAP_PORT}` }),
  });
  ok('① 绑定创建 201', b1.status === 201, `status=${b1.status}`);
  const binding = await b1.json().catch(() => null);
  ok('①b 返回 id/node', typeof binding?.id === 'number' && binding?.agent_node === 'dsh/6de4035c');

  // ② 提交 → 推送
  pushes.length = 0;
  const s1 = await fetch(`${BASE}/api/apps/procurement-workbench/data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ form: 'contract_task', 'PO号列表': 'PO-NOTIFY-1', '提交人': 'notify-smoke' }),
  });
  ok('② 提交 201', s1.status === 201, `status=${s1.status}`);
  const item = await s1.json().catch(() => null);
  await sleep(1200);
  ok('②b cap 收到推送 ×1', pushes.length === 1, `got=${pushes.length}`);
  if (pushes.length > 0) {
    const p = pushes[0];
    ok('②c 推送 team=绑定 node', p.body?.team === 'dsh/6de4035c', JSON.stringify(p.body?.team));
    ok('②c2 推送 caller=区限定句柄 market/<8hex>（裸 zone 对端永不可准入）', /^market\/[0-9a-f]{8}$/.test(String(p.body?.caller_session ?? '')), String(p.body?.caller_session));
    const msg = typeof p.body?.message === 'string' ? p.body.message : '';
    ok('②d 推送含 slug/id/字段', msg.includes('procurement-workbench') && msg.includes(String(item?.id)) && msg.includes('PO-NOTIFY-1'), msg.slice(0, 80));
  }

  // ③ 撤销 → 不再推
  if (binding?.id) {
    await fetch(`${BASE}/api/bindings/${binding.id}`, { method: 'DELETE', headers: ADMIN });
    pushes.length = 0;
    await fetch(`${BASE}/api/apps/procurement-workbench/data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'PO号列表': 'PO-NOTIFY-2', '提交人': 'notify-smoke' }),
    });
    await sleep(1000);
    ok('③ 撤销后不推', pushes.length === 0, `got=${pushes.length}`);
  }

  // ④ 无绑定 slug：不推不炸（procurement-task-submit 是 SOP 台非自产台——用 factory-report-library）
  pushes.length = 0;
  const s4 = await fetch(`${BASE}/api/apps/factory-report-library/data`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ probe: 'no-binding' }),
  });
  await sleep(800);
  ok('④ 无绑定提交 201 不推不炸', s4.status === 201 && pushes.length === 0, `status=${s4.status} pushes=${pushes.length}`);

  // ⑥ 回归 #76：SOP 绑定删除路由必须响应（PR#74 曾把 res.json 挪丢→永不响应挂起）
  {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const d = await fetch(`${BASE}/api/bindings/999999`, { method: 'DELETE', headers: ADMIN, signal: ctrl.signal });
      clearTimeout(timer);
      ok('⑥ SOP 绑定删除路由有响应（404=正常拒绝·不再挂起）', d.status === 404 || d.status === 200, `status=${d.status}`);
    } catch (err) {
      clearTimeout(timer);
      ok('⑥ SOP 绑定删除路由有响应（404=正常拒绝·不再挂起）', false, `挂起/超时: ${String(err).slice(0, 60)}`);
    }
  }

  // ⑤ 远程 LAN 面提交同样触发（裁定 A 面 × 推送）
  let lanReachable = false;
  try { const p = await fetch(`http://${LAN_IP}:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) }); lanReachable = p.ok; } catch {}
  if (!lanReachable) {
    console.log('  · LAN 不可达，⑤ 跳过');
  } else {
    // 重挂绑定（③ 已撤销）
    const b5 = await fetch(`${BASE}/api/bindings`, {
      method: 'POST', headers: ADMIN,
      body: JSON.stringify({ target_type: 'app', target_slug: 'procurement-workbench', agent_node: 'dsh/6de4035c', direction: 'notify', notify_url: `http://127.0.0.1:${CAP_PORT}` }),
    });
    pushes.length = 0;
    await fetch(`http://${LAN_IP}:${PORT}/api/apps/procurement-workbench/data`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'PO号列表': 'PO-NOTIFY-LAN', '提交人': 'notify-smoke-lan' }),
    });
    await sleep(1200);
    ok('⑤ 远程面提交同样触发推送', pushes.length === 1, `got=${pushes.length}`);
  }
} finally {
  child.kill();
  cap.close();
  await sleep(500);
}
console.log(`\n===== 自产台推送冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
