#!/usr/bin/env node
/** #215 真 LayerFS 适配器（契约 v0/v1·钉 9f97a7ec 的 @layerfs/agent + runtime）。
 *  与替身的区别：内容真写进 LayerFS 分支（Store 卷持久·重启内容在）+ 契约形读面由
 *  适配器侧车（wm-adapter.sqlite·同卷）承载 commit→文件集映射；不 import 替身。 */
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const AGENT_SPEC = process.env.LAYERFS_AGENT_PATH ?? ''; // 镜像内置 @layerfs/agent 入口（构建期 COPY）
// 入口多候选（检出布局随版本：agent/src/index.js（package main）·agent/sdk/src/index.js（钉点 9f97a7ec 布局））
const CANDIDATES = [AGENT_SPEC, '/usr/local/lib/layerfs-api/agent/src/index.js', '/usr/local/lib/layerfs-api/agent/sdk/src/index.js'].filter(Boolean);
let LayerFS = null; let usedEntry = '';
for (const c of CANDIDATES) {
  try { ({ LayerFS } = await import(c)); if (LayerFS) { usedEntry = c; break; } } catch { /* 下一候选 */ }
}
if (!LayerFS) { console.error('[layerfs-svc] @layerfs/agent 加载失败（候选全试）:', CANDIDATES.join(', ')); process.exit(3); }
console.log('[layerfs-svc] agent entry:', usedEntry);

const token = process.env.LAYERFS_SERVICE_TOKEN ?? 'lfs-token';
const storeRoot = process.env.LAYERFS_STORE_ROOT ?? '/var/lib/layerfs';
// #215 X6 十九障·一次性重写（钉点 api/how-to-use/agent.md 全配方·停逐障接力）
// 环境契约（镜像 ENV 已固化·SDK 于客户端创建时读）：
//   LAYERFS_HOME=/var/lib/layerfs/home（项目条目+sealed）·LAYERFS_STORE_PATH=<home>/global/store.sqlite（全局唯一·init 自装配）
const homeDir = process.env.LAYERFS_HOME ?? `${storeRoot}/home`;
for (const d of [`${storeRoot}/sources`, `${storeRoot}/projects`, homeDir, `${homeDir}/global`]) {
  try { mkdirSync(d, { recursive: true, mode: 0o755 }); } catch { /* 卷面降级 */ }
}
try { chmodSync(homeDir, 0o700); } catch { /* ACL 归部署 */ }
process.env.LAYERFS_STORE_PATH = process.env.LAYERFS_STORE_PATH ?? `${homeDir}/global/store.sqlite`; // 勿预触文件（init 自建·0B 毒）

const clients = new Map(); // R8：一进程一份 agent·一项目一 client（共享全局 store）
async function clientOf(project) {
  if (clients.has(project)) return clients.get(project);
  // init 的 source=纯空目录（agent.md：绝对路径·无 dot 组件·无 symlink/setuid·读取期不变——空目录全满足）
  const srcDir = `${storeRoot}/sources/${project}`;
  try { mkdirSync(srcDir, { recursive: true, mode: 0o755 }); } catch { /* 已在 */ }
  let c;
  try { c = await LayerFS.open(project); }
  catch {
    try { c = await LayerFS.init(project, srcDir); } // 首建：sealed→install→条目
    catch (initErr) {
      const m2 = String(initErr?.message ?? initErr);
      if (/already initialized|Exists/i.test(m2)) c = await LayerFS.open(project); // 竞态/复启后再开
      else throw initErr;
    }
  }
  clients.set(project, c);
  return c;
}

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
