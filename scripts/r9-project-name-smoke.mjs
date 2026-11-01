#!/usr/bin/env node
/** #94 ② R9 项目名冒烟（>63 slug 折叠 wm-<52>-<hash8>·判据先红后绿）。
 *  ①64 字符 slug 发布（带服务）→ apps.layerfs_project 为 63 内安全形（wm- 前缀）
 *  ②替身收到的 project 与 layerfs_project 一致
 *  ③短 slug → project == slug 原样
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = 9955;
const DATA = 'tmp/e2e-r9-' + Date.now().toString(36);
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'r9-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const seenProjects = [];
const lfs = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };
  const raw = req.url ?? '';
  const pb = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(raw);
  if (req.method === 'POST' && pb) {
    seenProjects.push(decodeURIComponent(pb[1]));
    return json(200, { commit_id: 'c' + createHash('sha256').update(String(seenProjects.length)).digest('hex').slice(0, 12), changed: true });
  }
  return json(404, {});
});
const LP = await new Promise((r) => lfs.listen(0, '127.0.0.1', () => r(lfs.address().port)));
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${DATA}/workbench-market.db'`); db.close();
}
for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${DATA}/${d}`, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'r9-tok', LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: 'r9' }, stdio: 'ignore',
});
try {
  await waitReady(`http://127.0.0.1:${PORT}/api/health`);
  const LONG = 'a'.repeat(64); // SLUG_RE 上限 64
  const rLong = await fetch(`http://127.0.0.1:${PORT}/api/apps`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug: LONG, title: 'long', files: [{ path: 'index.html', content: '<h1>x</h1>' }] }) });
  console.log('    [dbg] long publish:', rLong.status, (await rLong.text()).slice(0, 80));
  await fetch(`http://127.0.0.1:${PORT}/api/apps`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug: 'r9-short', title: 's', files: [{ path: 'index.html', content: '<h1>y</h1>' }] }) });
  let d1 = null;
  for (let i = 0; i < 12 && !(d1?.app ?? d1)?.layerfs_project; i++) { await new Promise((r) => setTimeout(r, 250)); d1 = await (await fetch(`http://127.0.0.1:${PORT}/api/apps/${LONG}`)).json(); }
  const proj = String((d1?.app ?? d1)?.layerfs_project ?? '');
  ok('① 长 slug → layerfs_project 63 内 wm- 形', /^wm-/.test(proj) && proj.length <= 63, `${proj.slice(0, 30)}… len=${proj.length}`);
  ok('② 替身收同项目名', seenProjects.includes(proj), seenProjects.join(',').slice(0, 60));
  const d2 = await (await fetch(`http://127.0.0.1:${PORT}/api/apps/r9-short`)).json();
  let sp = String((d2?.app ?? d2)?.layerfs_project ?? '');
  for (let i = 0; i < 12 && !sp; i++) { await new Promise((r) => setTimeout(r, 250)); const dd = await (await fetch(`http://127.0.0.1:${PORT}/api/apps/r9-short`)).json(); sp = String((dd?.app ?? dd)?.layerfs_project ?? ''); }
  ok('③ 短 slug → project == slug', sp === 'r9-short', sp);
} finally { child.kill(); lfs.close(); await new Promise((r) => setTimeout(r, 400)); }
console.log(`\n===== ② R9 项目名冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
