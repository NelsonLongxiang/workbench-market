#!/usr/bin/env node
/** #159 M3 B3 冒烟：①C2 冻结+同录入只发一次 ②C11 已发布不可再写 ③撤回 ④agent 派发开关默认关+翻转 ⑤C21 actor human: 前缀。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-159b3-' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'b3' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:' + PORT;
try {
  await waitReady(B + '/api/health');
  const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'b3' };
  const mk = async (title) => (await (await fetch(B + '/api/task-center/tasks', { method: 'POST', headers: H, body: JSON.stringify({ title, payload: { t: title } }) })).json());
  const pub = (id) => fetch(B + '/api/task-center/tasks/' + id + '/publish', { method: 'POST', headers: H });
  const a = await mk('任务甲');
  const b = await mk('任务乙（同 payload）');
  await fetch(B + '/api/task-center/tasks', { method: 'POST', headers: H, body: JSON.stringify({ title: '任务丙', payload: { t: '任务甲' } }) }); // 与甲同 payload
  const _c = await (await fetch(B + '/api/task-center/tasks')).json();
  const c = Array.isArray(_c) ? _c : (_c.items ?? []);
  const idA = c.find((x) => x.title.includes('任务甲')).id, idB = c.find((x) => x.title.includes('任务乙')).id, idC = c.find((x) => x.title.includes('任务丙')).id;
  // ① 发布成功 + 冻结
  const p1 = await pub(idA);
  const j1 = await p1.json().catch(() => ({}));
  ok('① 发布 200 + material_sha256 冻结', p1.status === 200 && /^[0-9a-f]{64}$/.test(String(j1.material_sha256 ?? '')), p1.status + '/' + String(j1.material_sha256).slice(0, 8));
  // ② C2 同录入（同 payload）只发一次 → 409
  const p2 = await pub(idC);
  ok('② C2 同录入只发一次 409', p2.status === 409, String(p2.status));
  // ③ C11 已发布不可再写 → 409
  const p3 = await pub(idA);
  ok('③ C11 已发布不可再写 409', p3.status === 409, String(p3.status));
  // ④ agent 派发开关默认关 + 翻转
  const rowB = c.find((x) => x.title.includes('任务乙'));
  ok('④ agent_dispatch_enabled 默认关', rowB.agent_dispatch_enabled === 0 || rowB.agent_dispatch_enabled === false, String(rowB.agent_dispatch_enabled));
  const sw = await fetch(B + '/api/task-center/tasks/' + idB + '/agent-dispatch', { method: 'PATCH', headers: H });
  const jsw = await sw.json().catch(() => ({}));
  ok('④b 翻转 on', sw.status === 200 && jsw.agent_dispatch_enabled === true, JSON.stringify(jsw));
  // ⑤ 撤回 + C21 human: 前缀
  const w = await fetch(B + '/api/task-center/tasks/' + idA + '/withdraw', { method: 'POST', headers: H });
  ok('⑤ 撤回 200', w.status === 200, String(w.status));
  const det = await (await fetch(B + '/api/task-center/tasks/' + idA)).json();
  const actors = (det.events ?? []).map((e) => String(e.actor));
  ok('⑤b C21 actor human: 前缀', actors.length > 0 && actors.every((a2) => a2.startsWith('human:')), JSON.stringify(actors));
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #159 B3 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
