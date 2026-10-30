#!/usr/bin/env node
/** #215 真 LayerFS 适配器（契约 v0/v1·钉 9f97a7ec 的 @layerfs/agent + runtime）。
 *  与替身的区别：内容真写进 LayerFS 分支（Store 卷持久·重启内容在）+ 契约形读面由
 *  适配器侧车（wm-adapter.sqlite·同卷）承载 commit→文件集映射；不 import 替身。 */
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

import { LayerFS } from '@layerfs/agent';
console.log('[layerfs-svc] agent entry: @layerfs/agent');

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
// 裁决 #021：每台一 docker 卷（label layerfs.role=store·删台卷随走）——经 /var/run/docker.sock HTTP API
const DOCKER_SOCK = '/var/run/docker.sock';
const VOLUMES_DIR = process.env.LAYERFS_VOLUMES_DIR ?? '/var/lib/docker/volumes'; // compose 已 rw 挂
function dockerCall(method, path, body) {
  
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = httpRequest({ socketPath: DOCKER_SOCK, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}, timeout: 4000 }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); }); });
    req.on('error', () => resolve({ status: 0, body: null }));
    if (data) req.write(data);
    req.end();
  });
}
const volName = (project) => 'wm-' + project + '-store';
async function ensureVolume(project) {
  const r = await dockerCall('POST', '/v1.41/volumes/create', { Name: volName(project), Labels: { 'layerfs.role': 'store', 'layerfs.project': project } });
  if (r.status === 0) return VOLUMES_DIR + '/' + volName(project) + '/_data'; // 无 socket 面：目录模式（X7 形差告警）
  return VOLUMES_DIR + '/' + volName(project) + '/_data';
}
async function dropVolume(project) {
  const r = await dockerCall('DELETE', '/v1.41/volumes/' + volName(project));
  return r.status === 204 || r.status === 404;
}

// 侧车（契约形读面·同卷持久）
const sidecar = new DatabaseSync(`${storeRoot}/wm-adapter.sqlite`);
sidecar.exec('CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, files TEXT NOT NULL, message TEXT DEFAULT \'\', at TEXT DEFAULT (datetime(\'now\')))')
sidecar.exec('CREATE TABLE IF NOT EXISTS branches (project TEXT NOT NULL, branch TEXT NOT NULL, head TEXT, PRIMARY KEY (project, branch))')
sidecar.exec('CREATE TABLE IF NOT EXISTS engine_refs (project TEXT NOT NULL, branch TEXT NOT NULL, native TEXT NOT NULL, PRIMARY KEY (project, branch))');
sidecar.exec('CREATE TABLE IF NOT EXISTS drafts (project TEXT NOT NULL, draft TEXT NOT NULL, target TEXT NOT NULL, base TEXT NOT NULL, PRIMARY KEY (project, draft))');

process.env.LAYERFS_STORE_PATH = process.env.LAYERFS_STORE_PATH ?? `${homeDir}/global/store.sqlite`; // 勿预触文件（init 自建·0B 毒）

const clients = new Map(); // R8：一进程一份 agent·一项目一 client（共享全局 store）
async function clientOf(project) {
  if (clients.has(project)) return clients.get(project);
    if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(project)) throw refusal('InvalidInput','invalid project name');
    const srcDir = `${storeRoot}/sources/${project}`;
  try { mkdirSync(srcDir, { recursive: true, mode: 0o755 }); } catch { /* 已在 */ }
  // 裁决 #021：每项目一卷·storePath 指卷内 global（SDK 创建时读 env·进程内多项目切换安全）
  // 裁决 #022 A 混合：卷=生命周期账本（建/删已实证）·store=共享具名卷 storeRoot 下 per-project 子目录（X6 绿路径·fs 卫兵过）
  await ensureVolume(project); // 生命周期账本（label layerfs.role=store）
  const storeDir = `${storeRoot}/stores/${project}/global`;
  try { mkdirSync(storeDir, { recursive: true, mode: 0o755 }); } catch { /* 已在 */ }
  process.env.LAYERFS_STORE_PATH = `${storeDir}/store.sqlite`;  let c;
  try { c = await LayerFS.open(project); }
  catch {
    try { c = await LayerFS.init(project, srcDir); }
    catch (initErr) {
      const m2 = String(initErr?.message ?? initErr);
      if (/already initialized|Exists/i.test(m2)) c = await LayerFS.open(project);
      else throw initErr;
    }
  }
  clients.set(project, c);
  return c;
}


const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(s)) }); res.end(s); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const auth = (req) => String(req.headers.authorization ?? '') === `Bearer ${token}`;

const refusal = (code, message) => Object.assign(new Error(message), { code });
const headOf = (project, branch) => sidecar.prepare('SELECT head FROM branches WHERE project=? AND branch=?').get(project, branch)?.head;
function snapshot(project, id) {
  const row = sidecar.prepare('SELECT files FROM commits WHERE project=? AND id=?').get(project, id);
  if (!row) throw refusal('NoSuchCommit', 'no such commit');
  return JSON.parse(row.files);
}
function filePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\')) throw refusal('InvalidInput', 'invalid file path');
  const clean = path.replace(/^\//, '');
  if (!clean || clean.split('/').some(p => !p || p === '.' || p === '..')) throw refusal('InvalidInput', 'invalid file path');
  return clean;
}
function fileSet(files) {
  if (!Array.isArray(files)) throw refusal('InvalidInput', 'files must be an array');
  const out = new Map();
  for (const f of files) {
    const path = filePath(f?.path);
    if (typeof f.content !== 'string' || out.has(path)) throw refusal('InvalidInput', 'invalid or duplicate file');
    out.set(path, f.content);
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
}
const sameFiles = (a,b) => JSON.stringify(fileSet(a)) === JSON.stringify(fileSet(b));
function nativeRef(project, branch) {
  const value = sidecar.prepare('SELECT native FROM engine_refs WHERE project=? AND branch=?').get(project, branch)?.native;
  if (!value) throw refusal('NoSuchBranch', 'no such branch');
  return value;
}
function saveHead(project, branch, native, result, files, message) {
  // Only native Store commit identities; never synthesize a commit from random bytes or counters.
  const id = result?.head;
  if (typeof id !== 'string' || !id) throw new Error('native operation returned no commit head');
  sidecar.exec('BEGIN');
  try {
    sidecar.prepare('INSERT OR IGNORE INTO commits (id,project,branch,files,message) VALUES (?,?,?,?,?)').run(id,project,branch,JSON.stringify(fileSet(files)),String(message ?? ''));
    sidecar.prepare('INSERT INTO branches VALUES (?,?,?) ON CONFLICT(project,branch) DO UPDATE SET head=excluded.head').run(project,branch,id);
    sidecar.prepare('INSERT INTO engine_refs VALUES (?,?,?) ON CONFLICT(project,branch) DO UPDATE SET native=excluded.native').run(project,branch,native);
    sidecar.exec('COMMIT');
  } catch(e) { sidecar.exec('ROLLBACK'); throw e; }
  return id;
}
async function publishTo(project, branch, files, message) {
  files = fileSet(files);
  const c = await clientOf(project);
  let native = sidecar.prepare('SELECT native FROM engine_refs WHERE project=? AND branch=?').get(project,branch)?.native;
  if (!native) {
    native = 'wm-' + randomBytes(10).toString('hex'); // random branch name, NOT a commit
    await c.branch.fork(native);
  }
  const prev = headOf(project,branch);
  const before = prev ? snapshot(project,prev) : [];
  const wanted = new Set(files.map(f=>f.path));
  const changes = before.filter(f=>!wanted.has(f.path)).map(f=>({op:'rm',path:'/'+f.path}));
  changes.push(...files.map(f=>({op:'write',path:'/'+f.path,content:f.content})));
  const result = await c.fs.apply(native, changes, message || 'publish');
  return saveHead(project,branch,native,result,files,message);
}
async function createDraft(project, target, from) {
  const files = snapshot(project,from);
  const draft = 'draft-' + randomBytes(10).toString('hex');
  const c = await clientOf(project);
  const result = await c.branch.fork(draft, from);
  saveHead(project,draft,draft,result,files,'draft');
  sidecar.prepare('INSERT INTO drafts VALUES (?,?,?,?)').run(project,draft,target,from);
  return draft;
}
function draftOf(project, target, draft) {
  const row = sidecar.prepare('SELECT * FROM drafts WHERE project=? AND draft=? AND target=?').get(project,draft,target);
  if (!row) throw refusal('NoSuchBranch','no such draft');
  return row;
}
async function applyDraft(project,target,draft,body) {
  draftOf(project,target,draft);
  if (!Array.isArray(body.changes) || !body.changes.length) throw refusal('InvalidInput','changes required');
  const files = new Map(snapshot(project,headOf(project,draft)).map(f=>[f.path,f.content]));
  const changes = body.changes.map(change => {
    const path = filePath(change?.path);
    if (change.op === 'write' && typeof change.content === 'string') { files.set(path,change.content); return {op:'write',path:'/'+path,content:change.content}; }
    if (change.op === 'rm') { files.delete(path); return {op:'rm',path:'/'+path}; }
    if (change.op === 'edit') {
      const text=files.get(path), old=change.old_text, replacement=change.new_text;
      if (typeof text !== 'string' || typeof old !== 'string' || !old || typeof replacement !== 'string' || text.split(old).length !== 2) throw refusal('NoMatch','edit requires exactly one match');
      files.set(path,text.replace(old,()=>replacement));
      return {op:'edit',path:'/'+path,oldText:old,newText:replacement};
    }
    throw refusal('InvalidInput','unsupported change');
  });
  const c=await clientOf(project), native=nativeRef(project,draft);
  const result=await c.fs.apply(native,changes,body.message || 'draft apply');
  return saveHead(project,draft,native,result,[...files].map(([path,content])=>({path,content})),body.message);
}
async function mergeDraft(project,target,draft,body) {
  const row=draftOf(project,target,draft);
  const into=body.into ?? target;
  if (into !== target) throw refusal('InvalidInput','draft target mismatch');
  const base=new Map(snapshot(project,row.base).map(f=>[f.path,f.content]));
  const ours=new Map(snapshot(project,headOf(project,draft)).map(f=>[f.path,f.content]));
  const theirs=new Map(snapshot(project,headOf(project,into)).map(f=>[f.path,f.content]));
  const paths=new Set([...base.keys(),...ours.keys(),...theirs.keys()]);
  const conflicts=[...paths].filter(p=>ours.get(p)!==base.get(p)&&theirs.get(p)!==base.get(p)&&ours.get(p)!==theirs.get(p));
  if(conflicts.length) throw Object.assign(refusal('Conflict','same-path draft conflict'),{detail:{conflicts}});
  for(const p of paths) if(ours.get(p)!==base.get(p)){ if(ours.has(p))theirs.set(p,ours.get(p));else theirs.delete(p); }
  const c=await clientOf(project), merged='merge-'+randomBytes(10).toString('hex');
  const result=await c.branch.merge(nativeRef(project,draft),nativeRef(project,into),merged,body.message || 'merge');
  return saveHead(project,into,merged,result,[...theirs].map(([path,content])=>({path,content})),body.message);
}

// Serialize adapter calls: SDK client creation selects a process-wide Store path,
// and read/modify/publish of the sidecar head must be one lane (no replay).
let lane = Promise.resolve();
const server = createServer(async (req, res) => {
  const prior = lane;
  let release;
  lane = new Promise(resolve => { release = resolve; });
  await prior;
  try { await handle(req,res); } finally { release(); }
});
async function handle(req, res) {
  const url = (req.url ?? '').split('?')[0];
  if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
  try {
    // Draft wire contract: v1 branch-scoped and v0 release alias share native operations.
    let d = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/drafts(?:\/([^/]+)\/(apply|merge))?$/.exec(url);
    const v0d = /^\/v0\/projects\/([^/]+)\/drafts(?:\/([^/]+)\/(apply|merge))?$/.exec(url);
    if (!d && v0d) d = [v0d[0],v0d[1],'release',v0d[2],v0d[3]];
    if (req.method === 'POST' && d) {
      const [project,target,draft] = [d[1],d[2],d[3]].map(x=>x ? decodeURIComponent(x) : x);
      const body=await readBody(req);
      if (!draft) return json(res,200,{draft:await createDraft(project,target,body.from)});
      const id = d[4] === 'apply' ? await applyDraft(project,target,draft,body) : await mergeDraft(project,target,draft,body);
      return json(res,200,{commit_id:id});
    }
    // ── v1（两级）──
    let m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const [proj, br] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const files = Array.isArray(body.files) ? body.files : [];
      const prev = sidecar.prepare('SELECT head FROM branches WHERE project = ? AND branch = ?').get(proj, br);
      if (prev?.head) {
        const pc = sidecar.prepare('SELECT files FROM commits WHERE id = ?').get(prev.head);
        if (pc && sameFiles(JSON.parse(pc.files), files)) return json(res, 200, { commit_id: prev.head, changed: false });
      }
      const id = await publishTo(proj, br, files, body.message);
      return json(res, 200, { commit_id: id, changed: true });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
    if (req.method === 'GET' && m) {
      const row = sidecar.prepare('SELECT files FROM commits WHERE project = ? AND id = ?').get(decodeURIComponent(m[1]),decodeURIComponent(m[3]));
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
      sidecar.prepare('UPDATE engine_refs SET branch=? WHERE project=? AND branch=?').run(to,proj,from);
      sidecar.prepare('UPDATE drafts SET target=? WHERE project=? AND target=?').run(to,proj,from);
      sidecar.prepare('COMMIT').run();
      return json(res, 200, { renamed: true, from, to });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/merge$/.exec(url);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const proj = decodeURIComponent(m[1]);
      const branch = decodeURIComponent(m[2]);
      const draft = sidecar.prepare('SELECT target FROM drafts WHERE project=? AND draft=?').get(proj,branch);
      if (!draft) throw refusal('NoSuchBranch','no such draft branch');
      return json(res,200,{commit_id:await mergeDraft(proj,draft.target,branch,body)});
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
        if (pc && sameFiles(JSON.parse(pc.files), files)) return json(res, 200, { commit_id: prev.head, changed: false });
      }
      const id = await publishTo(proj, 'release', files, body.message);
      return json(res, 200, { commit_id: id, changed: true });
    }
    m = /^\/v0\/projects\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
    if (req.method === 'GET' && m) {
      const row = sidecar.prepare('SELECT files FROM commits WHERE project = ? AND id = ?').get(decodeURIComponent(m[1]),decodeURIComponent(m[2]));
      if (!row) return json(res, 404, { error: 'no such commit' });
      return json(res, 200, { files: JSON.parse(row.files) });
    }
    m = /^\/v[01]\/projects\/([^/]+)$/.exec(url);
    if (req.method === 'DELETE' && m) {
      const proj = decodeURIComponent(m[1]);
      if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(proj)) throw refusal('InvalidInput','invalid project name');
      if (!sidecar.prepare('SELECT 1 FROM branches WHERE project=? LIMIT 1').get(proj)) throw refusal('NoSuchProject','no such project');
      const c = clients.get(proj); if (c) { await c.close(); clients.delete(proj); }
      for (const d of [homeDir + '/' + proj, storeRoot + '/sources/' + proj]) { try { rmSync(d, { recursive: true, force: true }); } catch { } } // 裁决 #021·X9
      sidecar.prepare('BEGIN').run();
      sidecar.prepare("DELETE FROM commits WHERE project = ?").run(proj);
      sidecar.prepare("DELETE FROM branches WHERE project = ?").run(proj);
      sidecar.prepare("DELETE FROM drafts WHERE project = ?").run(proj);
      sidecar.prepare("DELETE FROM engine_refs WHERE project = ?").run(proj);
      sidecar.prepare('COMMIT').run();
      const volGone = await dropVolume(proj); // 裁决 #022：卷=账本消
      let dirRemoved = true;
      try { rmSync(`${storeRoot}/stores/${proj}`, { recursive: true, force: true }); } catch { dirRemoved = false; } // store 子目录清
      return json(res, 200, { removed: true, volume_removed: volGone, dir_removed: dirRemoved });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/export$/.exec(url);
    if (req.method === 'GET' && m) return json(res, 501, { error: 'export=S3 预留（契约 v1 §2）' });
    if (req.method === 'POST' && url === '/v0/dispatch') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, commit_hash: 'c0ffee' + randomBytes(3).toString('hex'), exit_code: 0, stdout_tail: 'ok', stderr_tail: '', duration_ms: 5, run_id: body.run_id });
    }
    return json(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    if (e.code === 'Conflict') return json(res,409,{kind:'Conflict',conflicts:(e.detail?.conflicts ?? []).map(p=>typeof p==='string'?p.replace(/^\//,''):String(p.path ?? '').replace(/^\//,''))});
    const status = ['NoSuchProject','NoSuchBranch','NoSuchCommit','NoSuchPath'].includes(e.code) ? 404 : ['InvalidInput','NoMatch','AmbiguousMatch'].includes(e.code) ? 400 : 500;
    return json(res,status,{error:String(e.message ?? e),kind:e.code}); // R7: no retry, preserve engine refusal
  }
}
const port = Number(process.env.LAYERFS_SERVICE_PORT ?? 8067);
server.listen(port, () => console.log('[layerfs-svc] real adapter on', port, '| agent:', '@layerfs/agent'));
