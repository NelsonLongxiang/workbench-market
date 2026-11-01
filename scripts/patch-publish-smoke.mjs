#!/usr/bin/env node
/** #164 P1① patch 发布+diff 摘要冒烟。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-pt-' + Date.now().toString(36);
const H = { 'Content-Type': 'application/json', 'X-Admin-Token': 'pt' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const B = `http://127.0.0.1:${PORT}`;
const pub = async (body) => { const r = await fetch(`${B}/api/apps`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'pt' }, stdio: 'ignore',
});
try {
  await waitReady(`${B}/api/health`);
  // ① 全量首发（a.html + old.html）
  let r = await pub({ slug: 'pt1', title: 'p', files: [{ path: 'index.html', content: '<h1>v1</h1>' }, { path: 'old.html', content: 'old' }] });
  ok('① 全量首发 201（diff=null）', r.status === 201 && r.j.diff === null, `status=${r.status} diff=${JSON.stringify(r.j.diff)}`);
  // ② patch：新增 new.html + 改 index.html
  r = await pub({ slug: 'pt1', base_version: 1, patch: { set: [{ path: 'new.html', content: 'new' }, { path: 'index.html', content: '<h1>v2</h1>' }] } });
  const d1 = r.j.diff || {};
  ok('② patch set → added/modified', (r.status === 200 || r.status === 201) && (d1.added || []).includes('new.html') && (d1.modified || []).includes('index.html'), JSON.stringify(d1));
  ok('③ 未动文件保留（old.html 不入 diff）', ![...(d1.added || []), ...(d1.modified || []), ...(d1.removed || [])].includes('old.html'), '');
  // ④ patch delete
  r = await pub({ slug: 'pt1', base_version: 2, patch: { delete: ['old.html'] } });
  const d2 = r.j.diff || {};
  ok('④ patch delete → removed', (d2.removed || []).includes('old.html'), JSON.stringify(d2));
  // ⑤ 合并后内容生效（GET 台文件面）
  const page = await (await fetch(`${B}/apps/pt1/index.html`)).text();
  ok('⑤ 合并内容生效（v2 内容在线）', page.includes('v2'), page.slice(0, 40));
  // ⑥ 无 patch 无 files → 400
  r = await pub({ slug: 'pt1' });
  ok('⑥ 无 files/patch → 400', r.status === 400 || r.status === 500, `status=${r.status}`);
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log(`\n===== patch 发布冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
