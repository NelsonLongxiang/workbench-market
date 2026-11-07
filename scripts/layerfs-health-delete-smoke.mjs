#!/usr/bin/env node
/** LayerFS 存活/就绪与删台兜底冒烟（独立实例 + 本机 LayerFS 替身，合成数据）：
 *  ① /api/health 是存活：不向 LayerFS 发请求；/api/health/ready 是就绪：探测结果缓存，并发与连续请求只打一次 /healthz；
 *     LayerFS 不健康 → 缓存过期后 ready 503，存活仍 200；
 *  ② 影子发布远端已建 Commit 但响应丢失（本地 commit_id 留空）：配了 LayerFS 时删台仍按项目名删远端；
 *     远端删除失败 → 502 且保留本地台，可重试；
 *  ③ 系统保留项目名（wm-skills 技能库）：同步拒收该 slug；历史遗留的同名台删台只删本地，绝不删远端系统项目。 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LayerFS 替身：记录 /healthz 次数与 DELETE；publish 先建项目再「丢响应」（返回 500）
const lf = { healthz: 0, healthy: true, deletes: [], deleteStatus: 200, projects: new Set() };
const lfServer = createServer((req, res) => {
  const u = req.url ?? '';
  if (u === '/healthz') { lf.healthz++; res.writeHead(lf.healthy ? 200 : 503).end(); return; }
  const pub = /^\/v1\/projects\/([^/]+)\/branches\/[^/]+\/publish$/.exec(u);
  if (pub && req.method === 'POST') { req.resume(); req.on('end', () => { lf.projects.add(decodeURIComponent(pub[1])); res.writeHead(500).end(); }); return; }
  const del = /^\/v1\/projects\/([^/]+)$/.exec(u);
  if (del && req.method === 'DELETE') {
    const p = decodeURIComponent(del[1]); lf.deletes.push(p);
    if (lf.deleteStatus === 200) { const had = lf.projects.delete(p); res.writeHead(had ? 200 : 404).end(); } else res.writeHead(lf.deleteStatus).end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => lfServer.listen(0, '127.0.0.1', r));
const LF = `http://127.0.0.1:${lfServer.address().port}`;

const TMP = resolve('tmp/layerfs-health-delete-smoke-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN = 'synthetic-lfhealth-admin';
const gh = await startFakeGithub();
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), WM_CONTROL_PORT: '0', DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: ADMIN, WM_GITHUB_API: gh.api,
  LAYERFS_SERVICE_URL: LF, LAYERFS_SERVICE_TOKEN: 'synthetic-layerfs-token-0123456789abcdef' };
delete env.LAYERFS_SERVICE_TOKEN_FILE;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await sleep(250); }

  // ① 存活 / 就绪
  const before = lf.healthz;
  for (let i = 0; i < 20; i++) await fetch(base + '/api/health');
  ok('存活端点 20 次不向 LayerFS 发请求', lf.healthz === before, `healthz=${lf.healthz - before}`);
  const readyAll = await Promise.all(Array.from({ length: 10 }, () => fetch(base + '/api/health/ready').then((r) => r.status)));
  for (let i = 0; i < 10; i++) await fetch(base + '/api/health/ready');
  ok('就绪端点 20 次（含 10 个并发）只探测 1 次', lf.healthz - before === 1, `healthz=${lf.healthz - before}`);
  ok('LayerFS 健康 → 就绪 200', readyAll.every((s) => s === 200), JSON.stringify(readyAll));
  const live = await call('GET', '/api/health');
  ok('存活端点回缓存的就绪结果', live.body?.layerfs === 'healthy', JSON.stringify(live.body?.layerfs));
  lf.healthy = false;
  ok('缓存期内仍是上次结果（200）', (await fetch(base + '/api/health/ready')).status === 200);
  await sleep(10_500);
  const nr = await call('GET', '/api/health/ready');
  ok('缓存过期后 LayerFS 不健康 → 就绪 503', nr.status === 503 && nr.body?.layerfs === 'unhealthy', JSON.stringify(nr));
  const lv = await call('GET', '/api/health');
  ok('LayerFS 不健康时存活仍 200', lv.status === 200 && lv.body?.ok === true && lv.body?.layerfs === 'unhealthy', JSON.stringify(lv));
  lf.healthy = true;

  // ② 影子发布响应丢失 → 删台仍删远端
  const pub = await ghPublish(base, gh, { slug: 'lf-orphan', title: '孤儿项目探针', files: [{ path: 'index.html', content: '<!doctype html><p>ok</p>' }] }, { 'x-admin-token': ADMIN });
  ok('发布成功（影子写失败不阻发布）', pub.status === 201, `status=${pub.status}`);
  for (let i = 0; i < 40 && !lf.projects.has('lf-orphan'); i++) await sleep(100);
  ok('替身里远端项目已建（响应丢失）', lf.projects.has('lf-orphan'));
  let list = [];
  for (let i = 0; i < 40; i++) { list = (await call('GET', '/api/apps/lf-orphan')).body?.versions ?? []; if (list.some((v) => v.shadow_status === 'failed')) break; await sleep(100); }
  ok('本地未留 commit_id、影子记失败', list.length > 0 && list.every((v) => !v.commit_id && v.shadow_status === 'failed') && !(list[0]?.layerfs_project), JSON.stringify(list).slice(0, 200));

  lf.deleteStatus = 500;
  const refused = await call('DELETE', '/api/apps/lf-orphan', { reviewed_by: 'layerfs-health-delete-smoke' });
  ok('远端删除失败 → 502', refused.status === 502, `status=${refused.status}`);
  ok('失败后保留本地台', (await call('GET', '/api/apps/lf-orphan')).status === 200);
  lf.deleteStatus = 200;
  const deleted = await call('DELETE', '/api/apps/lf-orphan', { reviewed_by: 'layerfs-health-delete-smoke' });
  ok('重试删台成功', deleted.status === 200, `status=${deleted.status}`);
  ok('删台时按项目名删了远端', lf.deletes.filter((p) => p === 'lf-orphan').length === 2 && !lf.projects.has('lf-orphan'), JSON.stringify(lf.deletes));
  ok('本地台已删', (await call('GET', '/api/apps/lf-orphan')).status === 404);

  // ③ 保留名
  lf.projects.add('wm-skills');
  const resv = await ghPublish(base, gh, { slug: 'wm-skills', title: '撞名台', files: [{ path: 'index.html', content: '<!doctype html><p>x</p>' }] }, { 'x-admin-token': ADMIN });
  ok('同步保留名 wm-skills 被拒（400）', resv.status === 400, `status=${resv.status}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(TMP, 'data', 'workbench-market.db'));
  db.prepare("INSERT INTO apps (slug, title, layerfs_project) VALUES ('wm-skills', '历史遗留撞名台', 'wm-skills') ON CONFLICT(slug) DO UPDATE SET layerfs_project = 'wm-skills'").run();
  db.close();
  const delsBefore = lf.deletes.length;
  const dres = await call('DELETE', '/api/apps/wm-skills', { reviewed_by: 'layerfs-health-delete-smoke' });
  ok('历史遗留同名台可删（只删本地）', dres.status === 200 && (await call('GET', '/api/apps/wm-skills')).status === 404, `status=${dres.status}`);
  ok('删台没碰远端技能库项目', lf.deletes.length === delsBefore && lf.projects.has('wm-skills'), JSON.stringify(lf.deletes.slice(delsBefore)));
} catch (e) {
  fail++; console.log('  ✗ 异常', e?.message ?? e, serverErr.slice(-400));
} finally {
  server.kill(); await gh.close(); lfServer.close();
}
console.log(`\nlayerfs-health-delete-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
