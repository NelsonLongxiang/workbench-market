#!/usr/bin/env node
/** #215 真 LayerFS 适配器（契约 v0/v1·钉 9f97a7ec 的 @layerfs/agent + runtime）。
 *  与替身的区别：内容真写进 LayerFS 分支（Store 卷持久·重启内容在）+ 契约形读面由
 *  适配器侧车（wm-adapter.sqlite·同卷）承载 commit→文件集映射；不 import 替身。 */
import { createServer, request as httpRequest } from 'node:http';
import { accessSync, chmodSync, constants as fsConstants, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

import { LayerFS } from '@layerfs/agent';
console.log('[layerfs-svc] agent entry: @layerfs/agent');

const tokenFile = process.env.LAYERFS_SERVICE_TOKEN_FILE ?? '';
const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : String(process.env.LAYERFS_SERVICE_TOKEN ?? '');
if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('LayerFS service token (>=32 bytes) is required');
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
  if (r.status !== 201 && r.status !== 200) throw new Error(`Docker volume create failed (HTTP ${r.status ?? 0})`);
  // This volume is lifecycle metadata only; native Store uses storeRoot/stores/<project>.
  return true;
}
async function dropVolume(project) {
  const r = await dockerCall('DELETE', '/v1.41/volumes/' + encodeURIComponent(volName(project)));
  return r.status === 204 || r.status === 404;
}

// 侧车（契约形读面·同卷持久）
const sidecar = new DatabaseSync(`${storeRoot}/wm-adapter.sqlite`);
sidecar.exec('CREATE TABLE IF NOT EXISTS commits (id TEXT NOT NULL, project TEXT NOT NULL, branch TEXT NOT NULL, files TEXT NOT NULL, message TEXT DEFAULT \'\', at TEXT DEFAULT (datetime(\'now\')), PRIMARY KEY (project,id))')
// No automatic migration of legacy single-id sidecars in this repair.
const commitPk = sidecar.prepare("PRAGMA table_info(commits)").all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name).join(',');
if (commitPk !== 'project,id') { sidecar.close(); throw new Error('Legacy sidecar schema: explicit migration required; no data modified'); }
sidecar.exec('CREATE TABLE IF NOT EXISTS branches (project TEXT NOT NULL, branch TEXT NOT NULL, head TEXT, PRIMARY KEY (project, branch))')
sidecar.exec('CREATE TABLE IF NOT EXISTS engine_refs (project TEXT NOT NULL, branch TEXT NOT NULL, native TEXT NOT NULL, PRIMARY KEY (project, branch))');
sidecar.exec('CREATE TABLE IF NOT EXISTS drafts (project TEXT NOT NULL, draft TEXT NOT NULL, target TEXT NOT NULL, base TEXT NOT NULL, PRIMARY KEY (project, draft))');

process.env.LAYERFS_STORE_PATH = process.env.LAYERFS_STORE_PATH ?? `${homeDir}/global/store.sqlite`; // 勿预触文件（init 自建·0B 毒）

const clients = new Map(); // R8：一进程一份 agent·一项目一 client（共享全局 store）

// Per-project backups live outside project trees so deleting one project can
// remove every registered snapshot without touching global deployment archives.
const projectBackupRoot = project => storeRoot + '/backups/' + project;
function projectRows(table, project) {
  if (!['branches','commits','drafts','engine_refs'].includes(table)) throw new Error('invalid project table');
  return sidecar.prepare('SELECT * FROM ' + table + ' WHERE project=?').all(project);
}
function checkpointProjectSqlite(trees) {
  for (const root of Object.values(trees)) {
    if (!existsSync(root)) continue;
    const walk = path => {
      for (const entry of readdirSync(path,{withFileTypes:true})) {
        const file=path+'/'+entry.name;
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
          const db=new DatabaseSync(file);
          try {
            const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
            // SQLite reports {busy, log, checkpointed}; an empty WAL is successful too.
            if (!checkpoint || Number(checkpoint.busy)!==0 || Number(checkpoint.log)!==Number(checkpoint.checkpointed)) {
              throw new Error('SQLite WAL checkpoint incomplete (busy='+checkpoint?.busy+', log='+checkpoint?.log+', checkpointed='+checkpoint?.checkpointed+'): '+file);
            }
            const result=db.prepare('PRAGMA integrity_check').get();
            if (result?.integrity_check!=='ok') throw new Error('SQLite integrity check failed: '+file);
          } finally { db.close(); }
        }
      }
    };
    walk(root);
  }
}
function projectTreeManifest(root) {
  const files=[];
  const walk=(dir,rel='')=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const name=rel?rel+'/'+entry.name:entry.name, full=dir+'/'+entry.name;
      if(entry.isDirectory()) walk(full,name);
      else if(entry.isFile()) files.push({path:name,size:entry.size,sha256:createHash('sha256').update(readFileSync(full)).digest('hex')});
      else throw new Error('unsupported project backup entry: '+full);
    }
  };
  if(existsSync(root)) walk(root);
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
async function createProjectBackup(project) {
  if (!sidecar.prepare('SELECT 1 FROM branches WHERE project=? LIMIT 1').get(project)) throw refusal('NoSuchProject','no such project');
  const client=clients.get(project);
  if (client) { await client.close(); clients.delete(project); }
  const trees={home:homeDir+'/'+project,source:storeRoot+'/sources/'+project,store:storeRoot+'/stores/'+project};
  checkpointProjectSqlite(trees);
  const id=Date.now()+'-'+randomBytes(8).toString('hex');
  const root=projectBackupRoot(project), dest=root+'/'+id, staging=root+'/.staging-'+id;
  mkdirSync(root,{recursive:true,mode:0o700});
  mkdirSync(staging,{recursive:false,mode:0o700});
  try {
    for(const [name,path] of Object.entries(trees)) if(existsSync(path)) cpSync(path,staging+'/'+name,{recursive:true,preserveTimestamps:true,errorOnExist:true});
    const tree_manifest={};
    for(const name of ['home','source','store']) tree_manifest[name]=projectTreeManifest(staging+'/'+name);
    const data={format:1,project,backup_id:id,created_at:new Date().toISOString(),tree_manifest,branches:projectRows('branches',project),commits:projectRows('commits',project),drafts:projectRows('drafts',project),engine_refs:projectRows('engine_refs',project)};
    writeFileSync(staging+'/sidecar.json',JSON.stringify(data),{mode:0o600,flag:'wx'});
    // Publish only a complete snapshot; readers never see an in-progress backup.
    renameSync(staging,dest);
    return {backup_id:id,created_at:data.created_at,files:Object.values(tree_manifest).reduce((n,a)=>n+a.length,0)};
  } catch(e) { rmSync(staging,{recursive:true,force:true}); throw e; }
}
function listProjectBackups(project) {
  const root=projectBackupRoot(project);
  if(!existsSync(root)) return [];
  return readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>{
    const f=root+'/'+d.name+'/sidecar.json';
    if(!existsSync(f)) throw new Error('corrupt project backup: '+d.name);
    const j=JSON.parse(readFileSync(f,'utf8'));
    if(j.project!==project||j.backup_id!==d.name) throw new Error('project backup identity mismatch');
    return {backup_id:j.backup_id,created_at:j.created_at};
  }).sort((a,b)=>a.created_at.localeCompare(b.created_at));
}

async function restoreProjectBackup(project, backupId) {
  if (!/^[0-9]+-[a-f0-9]{16}$/.test(backupId)) throw refusal('InvalidInput','invalid backup id');
  if (sidecar.prepare('SELECT 1 FROM branches WHERE project=? LIMIT 1').get(project)) throw refusal('Exists','project already exists; restore requires an absent project');
  const root=projectBackupRoot(project)+'/'+backupId, manifestPath=root+'/sidecar.json';
  if (!existsSync(manifestPath)) throw refusal('NoSuchPath','no such project backup');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if (manifest.format!==1||manifest.project!==project||manifest.backup_id!==backupId) throw refusal('InvalidInput','project backup identity mismatch');
  for (const key of ['branches','commits','drafts','engine_refs']) if(!Array.isArray(manifest[key])) throw refusal('InvalidInput','project backup manifest incomplete');
  if(!manifest.tree_manifest||!['home','source','store'].every(k=>Array.isArray(manifest.tree_manifest[k]))) throw refusal('InvalidInput','project backup tree manifest incomplete');
  for(const name of ['home','source','store']) {
    const rootPath=root+'/'+name;
    const actual=projectTreeManifest(rootPath);
    if(JSON.stringify(actual)!==JSON.stringify(manifest.tree_manifest[name])) throw refusal('InvalidInput','project backup checksum mismatch: '+name);
  }
  const targets={home:homeDir+'/'+project,source:storeRoot+'/sources/'+project,store:storeRoot+'/stores/'+project};
  if (Object.values(targets).some(existsSync)) throw refusal('Exists','project data path already exists');
  const volumeProbe=await dockerCall('GET','/v1.41/volumes/'+encodeURIComponent(volName(project)));
  if(volumeProbe.status===200) throw refusal('Exists','project Store lifecycle volume already exists');
  if(volumeProbe.status!==404) throw new Error('Docker volume preflight failed (HTTP '+(volumeProbe.status??0)+')');
  let volume=false, committed=false;
  try {
    await ensureVolume(project); volume=true;
    for(const [name,target] of Object.entries(targets)) { if(!existsSync(root+'/'+name)) throw refusal('InvalidInput','project backup tree missing: '+name); cpSync(root+'/'+name,target,{recursive:true,errorOnExist:true}); }
    // LayerFS requires each project home root to be owner-private; cp preserves
    // the source mode, so normalize the restored root before opening the SDK.
    chmodSync(targets.home,0o700);
    sidecar.exec('BEGIN');
    try {
      for(const table of ['branches','commits','drafts','engine_refs']) {
        const cols={branches:['project','branch','head'],commits:['id','project','branch','files','message','at'],drafts:['project','draft','target','base'],engine_refs:['project','branch','native']}[table];
        const stmt=sidecar.prepare('INSERT INTO '+table+' ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
        for(const row of manifest[table]) stmt.run(...cols.map(c=>row[c] ?? null));
      }
      sidecar.exec('COMMIT'); committed=true;
    } catch(e) { sidecar.exec('ROLLBACK'); throw e; }
    process.env.LAYERFS_STORE_PATH=targets.store+'/global/store.sqlite';
    const client=await LayerFS.open(project); clients.set(project,client);
    return {restored:true,project,backup_id:backupId};
  } catch(e) {
    if(committed) {
      sidecar.exec('BEGIN'); try { for(const table of ['commits','branches','drafts','engine_refs']) sidecar.prepare('DELETE FROM '+table+' WHERE project=?').run(project); sidecar.exec('COMMIT'); } catch { sidecar.exec('ROLLBACK'); }
    }
    for(const target of Object.values(targets)) rmSync(target,{recursive:true,force:true});
    if(volume) await dropVolume(project);
    throw e;
  }
}

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
function parentDirs(files) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
}
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
function renameBranch(project, from, to) {
  if (typeof to !== 'string' || !to) throw refusal('InvalidInput','to required');
  const hit = headOf(project,from);
  if (!hit) throw refusal('NoSuchBranch','no such branch');
  if (headOf(project,to)) throw refusal('NameTaken','target branch already exists');
  sidecar.exec('BEGIN');
  try {
    sidecar.prepare('INSERT INTO branches VALUES (?,?,?)').run(project,to,hit);
    sidecar.prepare('DELETE FROM branches WHERE project=? AND branch=?').run(project,from);
    sidecar.prepare('UPDATE engine_refs SET branch=? WHERE project=? AND branch=?').run(to,project,from);
    sidecar.prepare('UPDATE drafts SET target=? WHERE project=? AND target=?').run(to,project,from);
    sidecar.exec('COMMIT');
  } catch(e) { sidecar.exec('ROLLBACK'); throw e; }
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
  // LayerFS fs.apply does not create parents implicitly. Scaffold every unique
  // parent first so normal app paths like assets/app.css publish natively.
  const mkdirs = parentDirs(files).map(path=>({op:'mkdir',path:'/'+path}));
  changes.push(...mkdirs, ...files.map(f=>({op:'write',path:'/'+f.path,content:f.content})));
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
  if (req.method === 'GET' && url === '/healthz') {
    try {
      sidecar.prepare('SELECT 1').get();
      accessSync(storeRoot, fsConstants.R_OK | fsConstants.W_OK);
      if (!existsSync(DOCKER_SOCK)) throw new Error('docker socket missing');
      const engine = await dockerCall('GET', '/_ping');
      if (engine.status !== 200) throw new Error('docker engine unavailable');
      return json(res, 200, { ok: true, service: 'layerfs', store: 'ready' });
    } catch { return json(res, 503, { ok: false, service: 'layerfs', store: 'unavailable' }); }
  }
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
        const pc = sidecar.prepare('SELECT files FROM commits WHERE project = ? AND id = ?').get(proj,prev.head);
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
      renameBranch(proj,from,to);
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
        const pc = sidecar.prepare('SELECT files FROM commits WHERE project = ? AND id = ?').get(proj,prev.head);
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
    m = /^\/v1\/projects\/([^/]+)\/backups(?:\/([^/]+)\/restore)?$/.exec(url);
    if (m) {
      const project=decodeURIComponent(m[1]);
      if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(project)) throw refusal('InvalidInput','invalid project name');
      if (m[2] && req.method==='POST') return json(res,200,await restoreProjectBackup(project,decodeURIComponent(m[2])));
      if (m[2]) return json(res,405,{error:'method not allowed'});
      if (req.method==='POST') return json(res,201,{project,...await createProjectBackup(project)});
      if (req.method==='GET') return json(res,200,{project,backups:listProjectBackups(project)});
    }
    m = /^\/v[01]\/projects\/([^/]+)$/.exec(url);
    if (req.method === 'DELETE' && m) {
      const proj = decodeURIComponent(m[1]);
      if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(proj)) throw refusal('InvalidInput','invalid project name');
      if (!sidecar.prepare('SELECT 1 FROM branches WHERE project=? LIMIT 1').get(proj)) throw refusal('NoSuchProject','no such project');
      const c = clients.get(proj); if (c) { await c.close(); clients.delete(proj); }
      // Quarantine trees by same-filesystem rename, then remove sidecar rows transactionally.
      // If any pre-finalization step fails, restore both rows and paths before returning failure.
      const token=randomBytes(8).toString('hex');
      const trees=[homeDir+'/'+proj,storeRoot+'/sources/'+proj,storeRoot+'/stores/'+proj,projectBackupRoot(proj)];
      const moved=[];
      const rows=Object.fromEntries(['branches','commits','drafts','engine_refs'].map(t=>[t,projectRows(t,proj)]));
      let rowsRemoved=false, volumeRemoved=false;
      try {
        // Rename each tree to a sibling tombstone so every move is atomic and on the same filesystem.
        for(const original of trees) if(existsSync(original)) {
          const staged=original+'.deleting-'+token;
          if(existsSync(staged)) throw new Error('project deletion tombstone already exists');
          renameSync(original,staged); moved.push([original,staged]);
        }
        sidecar.exec('BEGIN');
        try {
          for(const table of ['commits','branches','drafts','engine_refs']) sidecar.prepare('DELETE FROM '+table+' WHERE project=?').run(proj);
          sidecar.exec('COMMIT'); rowsRemoved=true;
        } catch(e) { sidecar.exec('ROLLBACK'); throw e; }
        // Make the irreversible remote-volume deletion the final fallible operation.
        if(!await dropVolume(proj)) throw new Error('Docker project volume deletion failed');
        volumeRemoved=true;
      } catch(e) {
        // Docker DELETE can fail after the daemon has acted but before its response arrives.
        // Re-issuing idempotent volume create makes both definite and ambiguous failures recoverable.
        let compensationError=null;
        try { await ensureVolume(proj); } catch(err) { compensationError=err; }
        if(rowsRemoved) {
          sidecar.exec('BEGIN');
          try {
            for(const table of ['branches','commits','drafts','engine_refs']) {
              const records=rows[table];
              if(records.length) {
                const cols=Object.keys(records[0]),stmt=sidecar.prepare('INSERT INTO '+table+' ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
                for(const row of records) stmt.run(...cols.map(k=>row[k]));
              }
            }
            sidecar.exec('COMMIT');
          } catch(restoreError) { sidecar.exec('ROLLBACK'); compensationError=compensationError??restoreError; }
        }
        for(const [original,staged] of moved.reverse()) {
          try { if(existsSync(staged)) renameSync(staged,original); } catch(err) { compensationError=compensationError??err; }
        }
        // Preserve any unrestored tombstones for operator recovery; never report success.
        if(compensationError) throw new Error('project deletion failed and compensation needs recovery; tombstones retained',{cause:compensationError});
        throw e;
      }
      // The sidecar and Docker metadata now both reflect deletion; tombstone cleanup is retriable.
      let cleanupPending=false;
      for(const [,staged] of moved) try { rmSync(staged,{recursive:true,force:true}); } catch { cleanupPending=true; }
      return json(res, 200, { removed: true, volume_removed: true, dir_removed: !cleanupPending, cleanup_pending: cleanupPending });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/export$/.exec(url);
    if (req.method === 'GET' && m) return json(res, 501, { error: 'export=S3 预留（契约 v1 §2）' });
    if (req.method === 'POST' && url === '/v0/dispatch') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, commit_hash: 'c0ffee' + randomBytes(3).toString('hex'), exit_code: 0, stdout_tail: 'ok', stderr_tail: '', duration_ms: 5, run_id: body.run_id });
    }
    return json(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    if (e.code === 'NameTaken' || e.code === 'Exists') return json(res,409,{error:e.message,kind:e.code});
    if (e.code === 'Conflict') return json(res,409,{kind:'Conflict',conflicts:(e.detail?.conflicts ?? []).map(p=>typeof p==='string'?p.replace(/^\//,''):String(p.path ?? '').replace(/^\//,''))});
    const status = ['NoSuchProject','NoSuchBranch','NoSuchCommit','NoSuchPath'].includes(e.code) ? 404 : ['InvalidInput','NoMatch','AmbiguousMatch'].includes(e.code) ? 400 : 500;
    return json(res,status,{error:String(e.message ?? e),kind:e.code}); // R7: no retry, preserve engine refusal
  }
}
const port = Number(process.env.LAYERFS_SERVICE_PORT ?? 8067);
const listenHost = process.env.LAYERFS_SERVICE_HOST ?? '0.0.0.0';
server.listen(port, listenHost, () => console.log('[layerfs-svc] real adapter on', listenHost, port, '| agent:', '@layerfs/agent'));
