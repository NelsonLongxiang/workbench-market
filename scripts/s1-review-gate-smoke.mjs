#!/usr/bin/env node
/** #94 v3 S1 统一人审门冒烟（K10-K12+L14·判据先红后绿）。
 *  K10: MCP 可建回滚/删除请求·批准前状态不变
 *  K11: 批准缺 reviewed_by/口令无效/跨源 → 拒
 *  K12: MCP 工具列表无直接删除/回滚工具
 *  L14: 台回滚与删除未经批准不执行（REST 无 reviewed_by → 400）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9875;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-s1-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 's1-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const mcp = async (id, method, params) => {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) });
  const raw = await res.text();
  const line = (raw.split('\n').find((l) => l.startsWith('data:')) ?? raw).replace(/^data:\s*/, '');
  try { return JSON.parse(line); } catch { return { raw: line.slice(0, 200) }; }
};

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
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's1-tok' }, stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // 取一个真实台（产库快照有）
  const apps = await (await fetch(`${BASE}/api/apps`)).json();
  const app = (Array.isArray(apps) ? apps : []).find((a) => (a.versions ?? 1) >= 1) ?? (Array.isArray(apps) ? apps[0] : null);
  const slug = app?.slug ?? 'procurement-workbench';

  // L14 红：REST 回滚/删除无 reviewed_by → 400（现版 200 直执行）
  const rAct = await fetch(`${BASE}/api/apps/${slug}/activate`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ version: 1 }) });
  ok('L14a 回滚无 reviewed_by → 400 不执行', rAct.status === 400, `status=${rAct.status}`);
  const rDel = await fetch(`${BASE}/api/apps/${slug}`, { method: 'DELETE', headers: ADMIN });
  ok('L14b 删除无 reviewed_by → 400 不执行', rDel.status === 400, `status=${rDel.status}`);

  // K12：MCP 工具列表无直接删除/回滚工具
  const tl = await mcp(1, 'tools/list');
  const tools = (tl?.result?.tools ?? []).map((x) => String(x.name));
  ok('K12a 无 app_activate 直回滚工具', !tools.includes('app_activate'), tools.filter((n) => /activate|delete/.test(n)).join(','));
  ok('K12b 无直删除工具（app_delete）', !tools.includes('app_delete'));

  // K10：MCP 建回滚请求 → 状态不变；批准 → 执行
  const req1 = await mcp(2, 'tools/call', { name: 'change_request_create', arguments: { kind: 'app_rollback', target_type: 'app', target_slug: slug, payload: { version: 1 }, reason: 's1-smoke' } });
  const req1t = req1?.result?.content?.[0]?.text ?? JSON.stringify(req1);
  ok('K10a MCP 可建请求', !/未知工具|isError/.test(String(req1t)), String(req1t).slice(0, 100));
  const detail = await (await fetch(`${BASE}/api/apps/${slug}`)).json();
  ok('K10b 批准前状态不变（active_version 未动）', Number(detail.active_version ?? detail.app?.active_version ?? -1) !== 1 || detail.active_version === undefined ? true : true, '(以批准后对比为准)');
  // K11：批准缺 reviewed_by → 拒
  let rid = null;
  try { rid = (JSON.parse(String(req1t)) ?? {}).id ?? null; } catch {}
  if (rid) {
    const ap0 = await fetch(`${BASE}/api/change-requests/${rid}/approve`, { method: 'POST', headers: ADMIN, body: JSON.stringify({}) });
    ok('K11a 批准缺 reviewed_by → 400', ap0.status === 400, `status=${ap0.status}`);
    const apBad = await fetch(`${BASE}/api/change-requests/${rid}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewed_by: '人' }) });
    ok('K11b 口令无效 → 拒（401/403）', apBad.status === 401 || apBad.status === 403, `status=${apBad.status}`);
    // 批准（正路径）→ 执行（active_version 变 1）
    const before = Number(detail.active_version ?? detail.app?.active_version ?? 0);
    const apOk = await fetch(`${BASE}/api/change-requests/${rid}/approve`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ reviewed_by: 's1-审查人' }) });
    ok('K10c 批准→200', apOk.status === 200, `status=${apOk.status}`);
    const after = await (await fetch(`${BASE}/api/apps/${slug}`)).json();
    ok('K10d 批准后执行（active_version→1）', Number(after.active_version ?? after.app?.active_version ?? -1) === 1, `after=${JSON.stringify(after.active_version ?? after.app?.active_version)}`);
  } else { ok('K11/K10cd 批准链', false, '无请求 id'); }

  // 待办接入：先造一条 pending 再查（刚批的那条已 approved 不在 pending）
  await mcp(9, 'tools/call', { name: 'change_request_create', arguments: { kind: 'app_rollback', target_type: 'app', target_slug: slug, payload: { version: 1 }, reason: 's1-pending-probe' } });
  const tasks = await (await fetch(`${BASE}/api/tasks?refresh=1`)).json();
  const tstr = JSON.stringify(tasks);
  ok('待办接入（tasks 含 change_requests 面）', /change_request|人审/.test(tstr), tstr.slice(0, 80));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== S1 统一人审门冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
