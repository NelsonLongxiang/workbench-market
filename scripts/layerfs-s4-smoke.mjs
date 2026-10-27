#!/usr/bin/env node
/** #94 S4 删除与清除冒烟（K16+L10 五步+D4 月度重建·判据先红后绿）。
 *  K16: 技能删除经 S1 批准链——批准后技能立即下线（404）+快照清
 *  L10: 删台五步——批准后市场行清+托管 404+服务收 DELETE /v1/projects/{slug}+物化清
 *  D4: 月度整库重建——admin 触发→服务收 wm-skills 项目 DELETE+活技能重发布（已删技能分支不复生）
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const PORT = 9930;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = 'tmp/e2e-s4-data';
const ADMIN = { 'Content-Type': 'application/json', 'X-Admin-Token': 's4-tok' };
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
async function waitReady(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
const mcp = async (id, name, args) => {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await res.text();
  const line = (raw.split('\n').find((l) => l.startsWith('data:')) ?? raw).replace(/^data:\s*/, '');
  try { return JSON.parse(line); } catch { return { raw: line.slice(0, 200) }; }
};
// 替身 v1（publish/commits/DELETE 项目记录）
const TOKEN = 's4-lfs-tok';
const dels = [];
const pubAfterDel = [];
const projs = new Map(); // project → Map(branch → state)
const lfs = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const json = (code, b) => { const s = JSON.stringify(b); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
  const raw = req.url ?? '';
  const delM = /^\/v1\/projects\/([^/]+)$/.exec(raw);
  if (req.method === 'DELETE' && delM) {
    const p = decodeURIComponent(delM[1]);
    dels.push(p);
    projs.delete(p);
    return json(200, { removed: true, project: p });
  }
  const pb = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(raw);
  if (req.method === 'POST' && pb) {
    const proj = decodeURIComponent(pb[1]); const br = decodeURIComponent(pb[2]);
    const m = projs.get(proj) ?? new Map(); projs.set(proj, m);
    const st = m.get(br) ?? { commits: [], head: null }; m.set(br, st);
    const b = JSON.parse(body || '{}');
    const id = 'c' + createHash('sha256').update(proj + br + st.commits.length).digest('hex').slice(0, 12);
    st.commits.push({ id, files: b.files ?? [] }); st.head = id;
    if (dels.includes('wm-skills')) pubAfterDel.push(proj + '/' + br);
    return json(200, { commit_id: id, changed: true });
  }
  return json(404, { error: 'nf' });
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
  env: { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 's4-tok', LAYERFS_SERVICE_URL: `http://127.0.0.1:${LP}`, LAYERFS_SERVICE_TOKEN: TOKEN },
  stdio: 'ignore',
});
try {
  if (!(await waitReady(`${BASE}/api/health`))) throw new Error('实例未就绪');
  // K16：技能删除经批准链
  const skills = await (await fetch(`${BASE}/api/skills`)).json();
  const victim = (Array.isArray(skills) ? skills : []).find((s) => s.versions >= 1);
  const vslug = victim?.slug ?? 'jf:taste';
  const snapDir = DATA + '/skill-snapshots/' + encodeURIComponent(vslug);
  const req1 = await mcp(1, 'change_request_create', { kind: 'skill', slug: vslug, op: 'delete', reason: 's4-k16' });
  const t1 = req1?.result?.content?.[0]?.text ?? '';
  const rid = /"id":\s*(\d+)/.exec(String(t1))?.[1];
  ok('K16a 删技能请求建', !!rid, String(t1).slice(0, 80));
  if (rid) {
    const stillThere = await (await fetch(`${BASE}/api/skills/${encodeURIComponent(vslug)}/versions`)).json();
    ok('K16b 批准前仍在（versions 可读）', !stillThere.error, '');
    const ap = await fetch(`${BASE}/api/change-requests/${rid}/approve`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ reviewed_by: 's4-审' }) });
    ok('K16c 批准 200', ap.status === 200, `status=${ap.status}`);
    const gone = await fetch(`${BASE}/api/skills/${encodeURIComponent(vslug)}/versions`);
    ok('K16d 批准后立即下线（404）', gone.status === 404, `status=${gone.status}`);
    ok('K16e 快照目录清', !existsSync(snapDir), snapDir.slice(-40));
  }
  // L10：删台五步（app 经批准）
  const apps = await (await fetch(`${BASE}/api/apps`)).json();
  const app = (Array.isArray(apps) ? apps : []).find((a) => a.slug);
  const aslug = app?.slug ?? 'procurement-workbench';
  const appDir = DATA + '/apps/' + aslug;
  dels.length = 0;
  const req2 = await mcp(2, 'change_request_create', { kind: 'app', slug: aslug, op: 'delete', reason: 's4-l10' });
  const rid2 = /"id":\s*(\d+)/.exec(String(req2?.result?.content?.[0]?.text ?? ''))?.[1];
  ok('L10a 删台请求建', !!rid2);
  if (rid2) {
    const ap2 = await fetch(`${BASE}/api/change-requests/${rid2}/approve`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ reviewed_by: 's4-审' }) });
    ok('L10b 批准 200', ap2.status === 200, `status=${ap2.status}`);
    const host = await fetch(`${BASE}/apps/${aslug}/`);
    ok('L10c 托管 404（市场行清）', host.status === 404, `status=${host.status}`);
    ok('L10d 服务收 DELETE /v1/projects/{slug}', dels.includes(aslug), JSON.stringify(dels));
    ok('L10e 物化目录清', !existsSync(appDir), appDir.slice(-30));
  }
  // D4：月度重建（admin 触发）
  dels.length = 0; pubAfterDel.length = 0;
  const rb = await fetch(`${BASE}/api/admin/rebuild-wm-skills`, { method: 'POST', headers: ADMIN });
  ok('D4a 重建触发 200', rb.status === 200, `status=${rb.status}`);
  await new Promise((r) => setTimeout(r, 800));
  ok('D4b 服务收 wm-skills 项目 DELETE', dels.includes('wm-skills'), JSON.stringify(dels));
  ok('D4c 活技能分支重发布（≥1 且不含已删 vslug）', pubAfterDel.length >= 1 && !pubAfterDel.some((p) => p.includes(vslug)), `n=${pubAfterDel.length} 样=${pubAfterDel[0]?.slice(0, 40) ?? '(无)'}`);
} finally {
  child.kill(); lfs.close();
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n===== S4 删除与清除冒烟 ${pass + fail} 项：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
