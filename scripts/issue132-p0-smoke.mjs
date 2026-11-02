#!/usr/bin/env node
/** #132 P0 冒烟（files note 全链+软删·判据先红后绿·监督席 direct-13dfb0d1）。
 *  ①上传带 note → 列表返 note（原「收了不存」灭）
 *  ②PATCH note → 列表反映
 *  ③软删 → 列表不见+原行在（DB deleted_at 置位）
 *  ④data 软删同
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 9993;
const DATA = 'tmp/e2e-132-' + Date.now().toString(36);
const ADMIN = { 'X-Admin-Token': 'p132' };
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
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p132' }, stdio: 'ignore',
});
try {
  await waitReady(`${B}/api/health`);
  await fetch(`${B}/api/apps`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify({ slug: 'p132', title: 'p', files: [{ path: 'index.html', content: '<h1>x</h1>' }] }) });
  // ① 上传带 note
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('a,b\n1,2')], { type: 'text/csv' }), 'n.csv');
  fd.append('note', '十月对账差异【重点】');
  fd.append('created_by', 'expert:p132');
  const up = await fetch(`${B}/api/apps/p132/files`, { method: 'POST', body: fd, headers: ADMIN });
  const upj = await up.json().catch(() => ({}));
  const fileId = upj.id;
  ok('①a 上传 201（带 note）', up.status === 201, `status=${up.status}`);
  let list = await (await fetch(`${B}/api/apps/p132/files`)).json();
  ok('①b 列表返 note（原收了不存灭）', list.items?.[0]?.note === '十月对账差异【重点】', JSON.stringify(list.items?.[0]).slice(0, 120));
  ok('①c 列表含 created_by/created_at', list.items?.[0]?.created_by === 'expert:p132' && !!list.items?.[0]?.created_at, '');
  // ② PATCH note
  const pat = await fetch(`${B}/api/apps/p132/files/${fileId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify({ note: '已复核' }) });
  ok('②a PATCH note 200', pat.status === 200, `status=${pat.status}`);
  list = await (await fetch(`${B}/api/apps/p132/files`)).json();
  ok('②b 列表反映新 note', list.items?.[0]?.note === '已复核', list.items?.[0]?.note);
  // ③ 软删
  const del = await fetch(`${B}/api/apps/p132/files/${fileId}`, { method: 'DELETE', headers: ADMIN });
  ok('③a 软删 200', del.status === 200, `status=${del.status}`);
  list = await (await fetch(`${B}/api/apps/p132/files`)).json();
  ok('③b 列表不见', (list.items ?? []).every((x) => x.id !== fileId), JSON.stringify(list.items));
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DATA + '/workbench-market.db', { readOnly: true });
    const row = db.prepare('SELECT id, deleted_at FROM app_files WHERE id = ?').get(fileId);
    db.close();
    ok('③c 原行在（deleted_at 置位·审计留痕）', !!row && String(row.deleted_at) !== '', JSON.stringify(row));
  }
  // ④ data 软删
  const dins = await fetch(`${B}/api/apps/p132/data`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { k: 1 } }) });
  const did = (await dins.json().catch(() => ({}))).id;
  await fetch(`${B}/api/apps/p132/data/${did}`, { method: 'DELETE', headers: ADMIN });
  const dlist = await (await fetch(`${B}/api/apps/p132/data`)).json();
  ok('④ data 软删后列表不见', (dlist.items ?? []).every((x) => x.id !== did), JSON.stringify(dlist.items).slice(0, 80));
} finally { child.kill(); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== #132 P0 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
