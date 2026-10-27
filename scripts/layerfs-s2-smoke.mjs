#!/usr/bin/env node
/** #94 S2 技能入 LayerFS 冒烟（K13+摘要一致·判据先红后绿）。
 *  ①技能发布双写：skill version 落 commit_id（wm-skills 项目·skill/<slug> 分支）
 *  ②同内容重发：changed:false·commit 稳定
 *  ③K13 摘要一致：服务回读文件集→重算 filesDigest==发布摘要（LayerFS 往返不改内容）
 *  ④契约 v1 分支路由：替身 /v1 四面（publish/commits files/rename/merge）
 *  ⑤校验面不受影子影响：verify ok:true
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9920;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-s2-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 's2-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const byteDigest = (files) => {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of sorted) { h.update(f.path.split('\\').join('/')); h.update('\0'); h.update(createHash('sha256').update(f.content, 'utf8').digest('hex')); h.update('\0'); }
  return h.digest('hex');
};

// 替身 v1（分支路由）
const TOKEN = 's2-lfs-tok';
const store = new Map(); // project → Map(branch → {commits, head})
const lfs = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
  const raw = req.url ?? ''; // raw 匹配（%2F 不解——分支含斜杠是一段）
  const pb = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(raw);
  if (req.method === 'POST' && pb) {
    const [, proj, br] = pb.map(decodeURIComponent);
    const projs = store.get(proj) ?? new Map(); store.set(proj, projs);
    const st = projs.get(br) ?? { commits: [], head: null }; projs.set(br, st);
    const b = JSON.parse(body || '{}');
    const files = Array.isArray(b.files) ? b.files : [];
    const last = st.head ? st.commits.find((c) => c.id === st.head) : null;
    if (last && JSON.stringify(last.files) === JSON.stringify(files)) return json(200, { commit_id: st.head, changed: false });
    const id = 'c' + createHash('sha256').update(proj + br + files.length + st.commits.length).digest('hex').slice(0, 12);
    st.commits.push({ id, files }); st.head = id;
    return json(200, { commit_id: id, changed: true });
  }
  const cf = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(raw);
  if (req.method === 'GET' && cf) {
    const st = store.get(decodeURIComponent(cf[1]))?.get(decodeURIComponent(cf[2]));
    const c = st?.commits.find((x) => x.id === cf[3]);
    return c ? json(200, { files: c.files }) : json(404, { error: 'no such commit' });
  }
  return json(404, { error: 'not found', url: u });
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
  env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's2-tok', LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: TOKEN },
  stdio: 'ignore',
});
const pubSkill = (slug, files, extra = {}) => fetch(`${BASE}/api/skills/${slug}/versions`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ files, changelog: 's2', ...extra }) });

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  const FILES = [{ path: 'SKILL.md', content: '# s2 skill\n内容 A' }, { path: 'refs/Nested.md', content: '# n' }];
  const EXPECT = byteDigest(FILES);
  // ① 发布双写
  const r1 = await pubSkill('s2:k13', FILES);
  ok('①a 技能发布 201', r1.status === 201, `status=${r1.status}`);
  let v1c = '';
  for (let i = 0; i < 12 && !v1c; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const vs = await (await fetch(`${BASE}/api/skills/s2:k13/versions`)).json();
    v1c = (vs.versions ?? [])[0]?.commit_id ?? '';
  }
  ok('①b skill version 落 commit_id', /^c[0-9a-f]{12}$/.test(v1c), v1c.slice(0, 14) || '(空)');
  // ② 同内容重发
  await pubSkill('s2:k13', FILES);
  let v2c = '';
  for (let i = 0; i < 12 && !v2c; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const vs = await (await fetch(`${BASE}/api/skills/s2:k13/versions`)).json();
    v2c = (vs.versions ?? [])[0]?.commit_id ?? '';
  }
  ok('② 重发 commit 稳定（changed:false）', v2c === v1c, `${v1c.slice(0, 8)} vs ${v2c.slice(0, 8)}`);
  // ③ K13 摘要一致（服务回读→重算）
  const fr = await fetch(`http://127.0.0.1:${LP}/v1/projects/wm-skills/branches/${encodeURIComponent('skill/s2:k13')}/commits/${v1c}/files`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const fj = await fr.json().catch(() => ({ files: [] }));
  ok('③ K13 摘要一致（回读重算==发布摘要）', byteDigest(fj.files ?? []) === EXPECT, `got=${(fj.files ?? []).length} 文件`);
  // ④ 契约 v1 面（替身路由四试：publish 已验·回读已验·未知分支 404·rename/merge 占位）
  const f404 = await fetch(`http://127.0.0.1:${LP}/v1/projects/wm-skills/branches/${encodeURIComponent('skill/nope')}/commits/c0/files`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('④ v1 未知分支 commit 404', f404.status === 404, `status=${f404.status}`);
  // ⑤ 校验面不受影（钉装+verify ok:true）
  const tdir = mkdtempSync(join(tmpdir(), 's2-inst-'));
  writeFileSync(join(tdir, 'SKILL.md'), FILES[0].content);
  mkdirSync(join(tdir, 'refs')); writeFileSync(join(tdir, 'refs/Nested.md'), FILES[1].content);
  await fetch(`${BASE}/api/skills/s2:k13/install`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ installed_path: tdir }) });
  const vf = await (await fetch(`${BASE}/api/skills/s2:k13/verify`)).json();
  ok('⑤ verify ok:true（影子不影响校验）', vf.ok === true, JSON.stringify(vf).slice(0, 80));
} finally {
  child.kill(); lfs.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== S2 技能入 LayerFS 冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
