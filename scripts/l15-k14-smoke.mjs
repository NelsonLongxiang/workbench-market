#!/usr/bin/env node
/** #94 收官后复核 ①④ 冒烟（L15 数据丢失+K14 越权读·判据先红后绿·监督席 direct-7eab77a9 加急）。
 *  L15a: 无服务（默认部署）发 5 版——v1/v2 目录**保留**（无 Commit 不删）
 *  L15b: 有服务发 6 版——仅 commit 版可 prune（≤3）
 *  L15c: 服务死后回滚冷版——**拒回滚**（active 不切·4xx/5xx）
 *  K14: resolveSnap 越权形（绝对路径/..）拒——verify 面装 DATA_DIR 外目录不再被读
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'l15-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const mkInst = (port, data, env = {}) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], {
  cwd: process.cwd(), env: { ...process.env, MCP_GATEWAY: '', PORT: String(port), DATA_DIR: data, ADMIN_TOKEN: 'l15-tok', ...env }, stdio: 'ignore',
});
const snapInst = async (data) => {
  rmSync(data, { recursive: true, force: true }); mkdirSync(data, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('server/data/workbench-market.db', { readOnly: true });
  db.exec(`VACUUM INTO '${data}/workbench-market.db'`); db.close();
  for (const d of ['apps', 'skill-snapshots', 'uploads']) cpSync(`server/data/${d}`, `${data}/${d}`, { recursive: true });
};
const pubApp = (base, slug, i) => fetch(`${base}/api/apps`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug, title: slug, files: [{ path: 'index.html', content: `<h1>v${i}</h1><!-- ${'y'.repeat(50)}${i} -->` }] }) });
const dirsOf = (data, slug) => (existsSync(data + '/apps/' + slug) ? readdirSync(data + '/apps/' + slug).filter((d) => /^v\d+$/.test(d)) : []);

// ── L15a：无服务默认部署 ──
{
  const DATA = 'tmp/e2e-l15a-' + Date.now().toString(36);
  await snapInst(DATA);
  const ch = mkInst(9950, DATA);
  try {
    await waitReady('http://127.0.0.1:9950/api/health');
    for (let i = 1; i <= 5; i++) await pubApp('http://127.0.0.1:9950', 'l15-nosvc', i);
    await new Promise((r) => setTimeout(r, 500));
    const ds = dirsOf(DATA, 'l15-nosvc');
    ok('L15a 无服务 5 版——全保留（无 Commit 不删）', ds.length === 5, `dirs=${ds.join(',')}`);
  } finally { ch.kill(); await new Promise((r) => setTimeout(r, 400)); }
}
// ── L15b/c：有服务 ──
{
  const TOKEN = 'l15-tok2';
  let dead = false;
  const projs = new Map();
  const lfs = createServer(async (req, res) => {
    if (dead) { res.writeHead(503); return res.end('{}'); } // L15c：服务死
    let body = ''; for await (const c of req) body += c;
    const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };
    const raw = req.url ?? '';
    const pb = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(raw);
    if (req.method === 'POST' && pb) {
      const m = projs.get(decodeURIComponent(pb[1])) ?? new Map(); projs.set(decodeURIComponent(pb[1]), m);
      const st = m.get('release') ?? { commits: [], head: null }; m.set('release', st);
      const id = 'c' + createHash('sha256').update(String(st.commits.length)).digest('hex').slice(0, 12);
      st.commits.push({ id }); st.head = id;
      return json(200, { commit_id: id, changed: true });
    }
    return json(404, { error: 'nf' });
  });
  const LP = await new Promise((r) => lfs.listen(0, '127.0.0.1', () => r(lfs.address().port)));
  const DATA = 'tmp/e2e-l15bc-' + Date.now().toString(36);
  await snapInst(DATA);
  const ch = mkInst(9951, DATA, { LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: TOKEN });
  try {
    await waitReady('http://127.0.0.1:9951/api/health');
    const sts = [];
    for (let i = 1; i <= 6; i++) { const r = await pubApp('http://127.0.0.1:9951', 'l15-svc', i); sts.push(r.status); }
    console.log('    [dbg] publish sts:', sts.join(','));
    let ds = dirsOf(DATA, 'l15-svc');
    for (let i = 0; i < 12 && ds.length > 3; i++) { await new Promise((r) => setTimeout(r, 300)); ds = dirsOf(DATA, 'l15-svc'); }
    console.log('    [dbg] L15b dirs:', JSON.stringify(ds), 'exists:', existsSync(DATA + '/apps/l15-svc'));
    ok('L15b 有服务 6 版——commit 版 prune ≤3', ds.length <= 3 && ds.includes('v6'), ds.join(','));
    // L15c：服务死→回滚冷版拒
    dead = true;
    const act = await fetch('http://127.0.0.1:9951/api/apps/l15-svc/activate', { method: 'POST', headers: ADMIN, body: JSON.stringify({ version: 1, reviewed_by: 'l15' }) });
    ok('L15c 服务死回滚冷版——拒（4xx/5xx 不切指针）', act.status >= 400, `status=${act.status}`);
    const d2 = await (await fetch('http://127.0.0.1:9951/api/apps/l15-svc')).json();
    ok('L15c2 active 仍 v6（指针未切）', Number((d2.app ?? d2).active_version) === 6, String((d2.app ?? d2).active_version));
  } finally { ch.kill(); lfs.close(); await new Promise((r) => setTimeout(r, 400)); }
}
// ── K14：越权形拒（resolveSnap 绝对/.. 不放行）──
{
  const DATA = 'tmp/e2e-k14-' + Date.now().toString(36);
  await snapInst(DATA);
  const ch = mkInst(9952, DATA);
  try {
    await waitReady('http://127.0.0.1:9952/api/health');
    // 装一个 DATA_DIR 外目录（产库快照路径·绝对形）→verify 应拒读（400/500）而非逐文件读
    const inst = await fetch('http://127.0.0.1:9952/api/skills/jf:taste/install', { method: 'POST', headers: ADMIN, body: JSON.stringify({ installed_path: 'D:/workspace/workbench-market/server/data/skill-snapshots' }) });
    const vf = await fetch('http://127.0.0.1:9952/api/skills/jf:taste/verify');
    const vj = await vf.json().catch(() => ({}));
    ok('K14 越权形拒（verify 不读 DATA_DIR 外·ok 非 true 即拒面）', vj.ok !== true || vf.status >= 400, `status=${vf.status} ok=${vj.ok}`);
  } finally { ch.kill(); await new Promise((r) => setTimeout(r, 400)); }
}
console.log(`\n===== ①④ 加急冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
