#!/usr/bin/env node
/** #94 P2 冒烟（L5 留3版+L6 冷回读·判据先红后绿）。
 *  L5: 发布 6 版后物化目录 ≤3 且含活跃版；回滚 v2 后仍 ≤3 且含 v2
 *  L6: v1 物化已不在——?version=1 → 200·X-App-Version v1·正文与 v1 发布逐字节同（冷回读经服务）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = 9899;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-p2-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'p2-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const TOKEN = 'p2-lfs-tok';
const store = new Map();
const lfs = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(s)) }); res.end(s); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
  const pm = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(req.url ?? ''); // v1 两级（raw 匹配）
  if (req.method === 'POST' && pm) {
    const p = decodeURIComponent(pm[1]);
    const b = JSON.parse(body || '{}');
    const files = Array.isArray(b.files) ? b.files : [];
    const st = store.get(p) ?? { commits: [], head: null };
    const last = st.head ? st.commits.find((c) => c.id === st.head) : null;
    if (last && JSON.stringify(last.files) === JSON.stringify(files)) return json(200, { commit_id: st.head, changed: false });
    const id = 'c' + randomBytes(6).toString('hex');
    st.commits.push({ id, files }); st.head = id; store.set(p, st);
    return json(200, { commit_id: id, changed: true });
  }
  const cm = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(req.url ?? '');
  if (req.method === 'GET' && cm) {
    const st = store.get(decodeURIComponent(cm[1]));
    const c = st?.commits.find((x) => x.id === cm[3]);
    if (!c) return json(404, { error: 'no such commit' });
    return json(200, { files: c.files });
  }
  return json(404, { error: 'not found' });
});
const LP = await new Promise((r) => lfs.listen(0, '127.0.0.1', () => r(lfs.address().port)));

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
  env: { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p2-tok', LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: TOKEN },
  stdio: 'ignore',
});
const dirsOf = (slug) => (existsSync(DATA + '/apps/' + slug) ? readdirSync(DATA + '/apps/' + slug).filter((d) => /^v\d+$/.test(d)) : []);

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // 发布 6 版（各异内容）
  for (let i = 1; i <= 6; i++) {
    const r = await fetch(`${BASE}/api/apps`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug: 'p2-keep3', title: 'p2', files: [{ path: 'index.html', content: `<h1>v${i}</h1><!-- ${'x'.repeat(40)}` + i + ` -->` }] }) });
    if (i === 1 && r.status !== 201) throw new Error('首发失败 ' + r.status);
  }
  await new Promise((r) => setTimeout(r, 800)); // 影子落地
  const ds = dirsOf('p2-keep3');
  ok('L5a 六版后物化 ≤3', ds.length <= 3, `dirs=${ds.join(',')}`);
  ok('L5b 含活跃版 v6', ds.includes('v6'), ds.join(','));
  // 回滚 v2（S1 门·一步式）
  const act = await fetch(`${BASE}/api/apps/p2-keep3/activate`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ version: 2, reviewed_by: 'p2-smoke' }) });
  ok('L5c 回滚 v2 200', act.status === 200, `status=${act.status}`);
  const ds2 = dirsOf('p2-keep3');
  ok('L5d 回滚后 ≤3 且含 v2', ds2.length <= 3 && ds2.includes('v2'), ds2.join(','));
  // L6：v1 冷回读（v1 目录应已不在——两轮 prune 后）
  const v1Missing = !existsSync(DATA + '/apps/p2-keep3/v1');
  const cold = await fetch(`${BASE}/apps/p2-keep3/?version=1`);
  const coldBody = await cold.text();
  ok('L6a 冷回读 200（v1 目录' + (v1Missing ? '已不在' : '仍在（暖）') + '）', cold.status === 200, `status=${cold.status}`);
  ok('L6b X-App-Version=v1', (cold.headers.get('x-app-version') ?? '') === 'v1', cold.headers.get('x-app-version') ?? '');
  ok('L6c 正文与 v1 发布逐字节同', coldBody.includes('<h1>v1</h1>'), coldBody.slice(0, 60));
} finally {
  child.kill(); lfs.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== P2 留3版+冷回读冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
