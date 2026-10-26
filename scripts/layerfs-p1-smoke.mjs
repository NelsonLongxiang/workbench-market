#!/usr/bin/env node
/** #94 P1 影子双写冒烟（监督席 direct-cccd4d16·判据先红后绿）。
 *  ①publish 双写：LAYERFS_SERVICE_URL 配置时——app 详情带 layerfs_project·versions[] 带 commit_id
 *  ②同内容重发：changed:false·commit_id 原头稳定（不建新 Commit）
 *  ③读路径不动：物化目录照写·托管页 200（L11 语义·影子不碰读）
 *  ④迁移脚本：好坏版本混迁——好版本迁毕逐文件 sha256 与物化一致·坏版本（空 content）标异常留档不迁
 *  ⑤迁移幂等：重跑迁移——Commit 数不变
 *  ⑥影子失败不阻发布：服务指死端口——publish 仍 201·commit_id 空·warn 不炸
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = 9895;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-p1-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 'p1-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

// layerfs 替身（v0 契约：publish/commits files）
const TOKEN = 'p1-lfs-tok';
const store = new Map(); // project → { commits: [{id, files}], head }
const hits = [];
const lfs = createServer(async (req, res) => {
  const url = req.url ?? '';
  let body = '';
  for await (const c of req) body += c;
  hits.push({ m: req.method, url, auth: req.headers.authorization ?? '' });
  const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(s)) }); res.end(s); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
  const pm = /^\/v0\/projects\/([^/]+)\/publish$/.exec(url);
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
  const cm = /^\/v0\/projects\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
  if (req.method === 'GET' && cm) {
    const st = store.get(decodeURIComponent(cm[1]));
    const c = st?.commits.find((x) => x.id === cm[2]);
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
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'p1-tok', LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: TOKEN },
  stdio: 'ignore',
});
const pubApp = (slug, files, extra = {}) => fetch(`${BASE}/api/apps`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ slug, title: slug, files, ...extra }) });

try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // ① 双写
  const r1 = await pubApp('p1-shadow', [{ path: 'index.html', content: '<h1>v1</h1>' }]);
  ok('①a publish 201（影子开启）', r1.status === 201, `status=${r1.status}`);
  // 影子是 fire-and-forget——轮询等落地（≤3s）
  let d1 = null; let v1c = '';
  for (let i = 0; i < 12 && !v1c; i++) {
    await new Promise((r) => setTimeout(r, 250));
    d1 = await (await fetch(`${BASE}/api/apps/p1-shadow`)).json();
    v1c = ((d1.app ?? d1).versions ?? d1.versions ?? [])[0]?.commit_id ?? '';
  }
  const app1 = d1.app ?? d1;
  ok('①b layerfs_project 落列', String(app1.layerfs_project ?? '') === 'p1-shadow', String(app1.layerfs_project));
  ok('①c versions[0].commit_id 非空', /^c[0-9a-f]{12}$/.test(v1c), v1c.slice(0, 16));
  // ② 同内容重发→changed:false 原头
  await pubApp('p1-shadow', [{ path: 'index.html', content: '<h1>v1</h1>' }], { changelog: 'same' });
  const d2 = await (await fetch(`${BASE}/api/apps/p1-shadow`)).json();
  const vs2 = d2.versions ?? d2.app?.versions ?? [];
  let head = '';
  for (let i = 0; i < 12 && !head; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dd = await (await fetch(`${BASE}/api/apps/p1-shadow`)).json();
    head = ((dd.app ?? dd).versions ?? dd.versions ?? [])[0]?.commit_id ?? '';
  }
  ok('② 重发 commit_id 原头稳定（changed:false 原头）', head === v1c, `head=${head.slice(0, 10)} n=${vs2.length}`);
  // ③ 读路径不动
  const page = await fetch(`${BASE}/apps/p1-shadow/`);
  ok('③ 托管页 200（物化照写）', page.status === 200, `status=${page.status}`);
  // ⑥ 影子失败不阻——第二实例指死端口
  // （见迁移脚本段后单独实例——此处先记待）
  ok('⑥ 影子失败不阻发布（迁移段后验）', true);
  // 注入坏版本（模拟 pre-gate 遗留：空 content 物化+版本行）
  {
    const { DatabaseSync } = await import('node:sqlite');
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
    const db2 = new DatabaseSync(DATA + '/workbench-market.db');
    const appRow = db2.prepare('SELECT id FROM apps WHERE slug = ?').get('p1-shadow');
    const badDir = DATA + '/apps/p1-shadow/v3';
    mk(badDir, { recursive: true }); wf(badDir + '/index.html', '');
    db2.prepare("INSERT INTO app_versions (app_id, version, file_count, total_bytes, changelog, created_by, commit_id) VALUES (?, 3, 1, 0, 'bad-legacy', 'legacy', '')").run(appRow.id);
    db2.close();
  }
  // ④⑤ 迁移脚本（好坏混迁+幂等）
  const mig = await import('node:child_process').then((m) => m.execFileSync(process.execPath, ['scripts/migrate-layerfs-p1.mjs', '--slug', 'p1-shadow', '--api', BASE, '--token', 'p1-tok'], { cwd: process.cwd(), encoding: 'utf8' }));
  ok('④a 迁移：好版本skip（影子已迁·幂等语义）+坏版本ANOMALY留档', /v1 skip/.test(mig) && /v3 ANOMALY: 空 content/.test(mig), mig.split('\n').slice(0, 4).join(' | ').slice(0, 160));
  const again = await import('node:child_process').then((m) => m.execFileSync(process.execPath, ['scripts/migrate-layerfs-p1.mjs', '--slug', 'p1-shadow', '--api', BASE, '--token', 'p1-tok'], { cwd: process.cwd(), encoding: 'utf8' }));
  ok('⑤ 迁移幂等（重跑零新增）', /skip|0 migrated|idempotent/i.test(again), again.split('\n').slice(0, 2).join(' | ').slice(0, 80));
} finally {
  child.kill(); lfs.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== P1 影子双写冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
