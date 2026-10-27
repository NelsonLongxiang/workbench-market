#!/usr/bin/env node
/** 页面接线冒烟（监督席 direct-c869d6db）：①Runner 页含上传控件+令牌逻辑 ②严格模式创建响应带 token→上传 201→完成 ③无 token 401。
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 10015;
const DATA = 'tmp/e2e-pw-' + Date.now().toString(36);
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'pw-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const B = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'pw-tok' }, stdio: 'ignore',
});
try {
  await waitReady(`${B}/api/health`);
  // 严格开
  await fetch(`${B}/api/settings`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ run_upload_require_token: '1' }) });
  // ① 页面渲染含控件+接线
  const html = await (await fetch(`${B}/sop/procurement-task-submit/`)).text();
  ok('①a 页面含上传控件（upload-input/btn）', html.includes('upload-input') && html.includes('upload-btn'), '');
  ok('①b 页面含令牌接线（upload_token/X-Run-Upload-Token）', html.includes('upload_token') && html.includes('X-Run-Upload-Token'), '');
  // ② 严格全链
  const st = await (await fetch(`${B}/api/sop/runs`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug: 'procurement-task-submit', started_by: 'pw' }) })).json();
  ok('②a 创建响应带 token', String(st.upload_token ?? '').length >= 32, '');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('a,b\n1,2')], { type: 'text/csv' }), 'd.csv');
  const up = await fetch(`${B}/api/sop/runs/${st.id}/files`, { method: 'POST', body: fd, headers: { 'X-Run-Upload-Token': String(st.upload_token) } });
  ok('②b 带 token 上传 201（严格模式）', up.status === 201, `status=${up.status}`);
  const upNo = await fetch(`${B}/api/sop/runs/${st.id}/files`, { method: 'POST', body: (() => { const f2 = new FormData(); f2.append('file', new Blob(['x'], { type: 'text/csv' }), 'n.csv'); return f2; })() });
  ok('②c 无 token 401（严格仍拦）', upNo.status === 401, `status=${upNo.status}`);
  const fin = await fetch(`${B}/api/sop/runs/${st.id}/finish`, { method: 'POST', headers: ADMIN });
  ok('②d 完成 200', fin.status === 200, `status=${fin.status}`);
} finally { child.kill(); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== 页面接线冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
