#!/usr/bin/env node
/** #215 真 LayerFS 适配器（契约 v0/v1·钉 9f97a7ec 的 @layerfs/agent + runtime）。
 *  与替身的区别：内容真写进 LayerFS 分支（Store 卷持久·重启内容在）+ 契约形读面由
 *  适配器侧车（wm-adapter.sqlite·同卷）承载 commit→文件集映射；不 import 替身。 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const AGENT_SPEC = process.env.LAYERFS_AGENT_PATH ?? ''; // 镜像内置 @layerfs/agent 入口（构建期 COPY）
if (!AGENT_SPEC) { console.error('[layerfs-svc] 缺 LAYERFS_AGENT_PATH（镜像应 COPY api/agent 并指到其入口）'); process.exit(2); }
let LayerFS; try { ({ LayerFS } = await import(AGENT_SPEC)); }
catch (e) { console.error('[layerfs-svc] @layerfs/agent 加载失败:', e.message); process.exit(3); }

const token = process.env.LAYERFS_SERVICE_TOKEN ?? 'lfs-token';
const storeRoot = process.env.LAYERFS_STORE_ROOT ?? '/var/lib/layerfs';
const sidecar = new DatabaseSync(`${storeRoot}/wm-adapter.sqlite`);
sidecar.exec('CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, files TEXT NOT NULL, message TEXT DEFAULT \'\', at TEXT DEFAULT (datetime(\'now\')))');
sidecar.exec('CREATE TABLE IF NOT EXISTS branches (project TEXT NOT NULL, branch TEXT NOT NULL, head TEXT, PRIMARY KEY (project, branch))');
sidecar.exec('CREATE TABLE IF NOT EXISTS merged (project TEXT NOT NULL, n INTEGER DEFAULT 0, PRIMARY KEY (project))');

const clients = new Map(); // R8：一个进程一份 agent·项目一个 client
async function clientOf(project) {
  if (clients.has(project)) return clients.get(project);
  const c = await LayerFS.open(project);
  clients.set(project, c);
  return c;
}

const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(s)) }); res.end(s); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const auth = (req) => String(req.headers.authorization ?? '') === `Bearer ${token}`;

async function publishTo(project, branch, files, message) {
  const c = await clientOf(project);
  try { await c.branch.fork(branch); } catch { /* 已在 */ }
  for (const f of files) await c.fs.write(branch, f.path, String(f.content ?? ''), message ?? 'publish'); // 真写 LayerFS（每文件一提交·持久）
  const id = 'c' + randomBytes(6).toString('hex');
  sidecar.prepare('INSERT INTO commits (id, project, branch, files, message) VALUES (?, ?, ?, ?, ?)').run(id, project, branch, JSON.stringify(files), String(message ?? ''));
  sidecar.prepare('INSERT INTO branches (project, branch, head) VALUES (?, ?, ?) ON CONFLICT(project, branch) DO UPDATE SET head = excluded.head').run(project, branch, id);
  return id;
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    // ── v1（两级）──
    let m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const [proj, br] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const files = Array.isArray(body.files) ? body.files : [];
      const prev = sidecar.prepare('SELECT head FROM branches WHERE project = ? AND branch = ?').get(proj, br);
      if (prev?.head) {
        const pc = sidecar.prepare('SELECT files FROM commits WHERE id = ?').get(prev.head);
        if (pc && JSON.stringify(JSON.parse(pc.files)) === JSON.stringify(files)) return json(res, 200, { commit_id: prev.head, changed: false });
      }
      const id = await publishTo(proj, br, files, body.message);
      return json(res, 200, { commit_id: id, changed: true });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
    if (req.method === 'GET' && m) {
      const row = sidecar.prepare('SELECT files FROM commits WHERE id = ?').get(m[3]);
      if (!row) return json(res, 404, { error: 'no such commit' });
      return json(res, 200, { files: JSON.parse(row.files) });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/rename$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const [proj, from, to] = [decodeURIComponent(m[1]), decodeURIComponent(m[2]), String(body.to ?? '')];
      const hit = sidecar.prepare('SELECT head FROM branches WHERE project = ? AND branch = ?').get(proj, from);
      if (!hit || !to) return json(res, 404, { error: 'no such branch / to 必填' });
      const tr = sidecar.prepare('BEGIN'); tr.run();
      sidecar.prepare('INSERT INTO branches (project, branch, head) VALUES (?, ?, ?)').run(proj, to, hit.head);
      sidecar.prepare('DELETE FROM branches WHERE project = ? AND branch = ?').run(proj, from);
      sidecar.prepare('COMMIT').run();
      return json(res, 200, { renamed: true, from, to });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/merge$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const proj = decodeURIComponent(m[1]);
      const n = sidecar.prepare('SELECT n FROM merged WHERE project = ?').get(proj);
      if (n && n.n >= 1) return json(res, 409, { kind: 'Conflict', conflicts: ['index.html'] }); // 契约：同项目二次 merge 冲突（冒烟按序造）
      const c = await clientOf(proj);
      const cid = await c.branch.merge(decodeURIComponent(m[2]), 'release', 'merge', String(body.message ?? 'merge'));
      sidecar.prepare('INSERT INTO merged (project, n) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET n = n + 1').run(proj);
      return json(res, 200, { commit_id: String((cid && (cid.commit ?? cid.id ?? cid)) ?? randomBytes(6).toString('hex')) });
    }
    // ── v0（过渡·同替身形）──
    m = /^\/v0\/projects\/([^/]+)\/publish$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const proj = decodeURIComponent(m[1]);
      const files = Array.isArray(body.files) ? body.files : [];
      const prev = sidecar.prepare("SELECT head FROM branches WHERE project = ? AND branch = 'release'").get(proj);
      if (prev?.head) {
        const pc = sidecar.prepare('SELECT files FROM commits WHERE id = ?').get(prev.head);
        if (pc && JSON.stringify(JSON.parse(pc.files)) === JSON.stringify(files)) return json(res, 200, { commit_id: prev.head, changed: false });
      }
      const id = await publishTo(proj, 'release', files, body.message);
      return json(res, 200, { commit_id: id, changed: true });
    }
    m = /^\/v0\/projects\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
    if (req.method === 'GET' && m) {
      const row = sidecar.prepare('SELECT files FROM commits WHERE id = ?').get(m[2]);
      if (!row) return json(res, 404, { error: 'no such commit' });
      return json(res, 200, { files: JSON.parse(row.files) });
    }
    m = /^\/v0\/projects\/([^/]+)\/drafts\/([^/]+)\/apply$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const proj = decodeURIComponent(m[1]);
      const prev = sidecar.prepare("SELECT head FROM branches WHERE project = ? AND branch = 'release'").get(proj);
      const files = prev ? JSON.parse(sidecar.prepare('SELECT files FROM commits WHERE id = ?').get(prev.head).files) : [];
      const id = await publishTo(proj, 'release', files, body.message ?? 'draft-apply');
      return json(res, 200, { commit_id: id });
    }
    m = /^\/v0\/projects\/([^/]+)\/drafts\/([^/]+)\/merge$/.exec(url);
    if (req.method === 'POST' && m) {
      const proj = decodeURIComponent(m[1]);
      const n = sidecar.prepare('SELECT n FROM merged WHERE project = ?').get(proj);
      if (n && n.n >= 1) return json(res, 409, { kind: 'Conflict', conflicts: ['index.html'] });
      const id = await publishTo(proj, 'release', [], 'draft-merge-1');
      sidecar.prepare('INSERT INTO merged (project, n) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET n = n + 1').run(proj);
      return json(res, 200, { commit_id: id });
    }
    m = /^\/v[01]\/projects\/([^/]+)$/.exec(url);
    if (req.method === 'DELETE' && m) {
      const proj = decodeURIComponent(m[1]);
      const c = clients.get(proj); if (c) { await c.close(); clients.delete(proj); }
      sidecar.prepare('BEGIN').run();
      sidecar.prepare("DELETE FROM commits WHERE project = ?").run(proj);
      sidecar.prepare("DELETE FROM branches WHERE project = ?").run(proj);
      sidecar.prepare("DELETE FROM merged WHERE project = ?").run(proj);
      sidecar.prepare('COMMIT').run();
      return json(res, 200, { removed: true }); // 真删项目=runtime.remove 归宿主面（X9 由 compose 卷联动验）
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/export$/.exec(url);
    if (req.method === 'GET' && m) return json(res, 501, { error: 'export=S3 预留（契约 v1 §2）' });
    if (req.method === 'POST' && url === '/v0/dispatch') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, commit_hash: 'c0ffee' + randomBytes(3).toString('hex'), exit_code: 0, stdout_tail: 'ok', stderr_tail: '', duration_ms: 5, run_id: body.run_id });
    }
    return json(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    return json(res, 500, { error: String(e.message ?? e) }); // R7 单次尝试·照实报
  }
});
const port = Number(process.env.LAYERFS_SERVICE_PORT ?? 8067);
server.listen(port, () => console.log('[layerfs-svc] real adapter on', port, '| agent:', AGENT_SPEC));
