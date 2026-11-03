// Project-scoped backup lifecycle tests use temporary trees and in-memory SQLite.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, readdirSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const src=readFileSync('deploy/layerfs-svc.mjs','utf8');
const start=src.indexOf('const projectBackupRoot =');
const end=src.indexOf('async function clientOf(project)',start);
assert.ok(start>=0&&end>start,'project backup helpers exist');
const root=mkdtempSync(join(tmpdir(),'layerfs-project-backup-'));
const storeRoot=join(root,'store'),homeDir=join(root,'home');
mkdirSync(storeRoot,{recursive:true});mkdirSync(homeDir,{recursive:true});
const sidecar=new DatabaseSync(':memory:');
sidecar.exec('CREATE TABLE branches(project TEXT, branch TEXT, head TEXT, PRIMARY KEY(project,branch)); CREATE TABLE commits(id TEXT, project TEXT, branch TEXT, files TEXT, message TEXT, at TEXT, PRIMARY KEY(project,id)); CREATE TABLE drafts(project TEXT,draft TEXT,target TEXT,base TEXT,PRIMARY KEY(project,draft)); CREATE TABLE engine_refs(project TEXT,branch TEXT,native TEXT,PRIMARY KEY(project,branch));');
const dbexec=(sql,...args)=>sidecar.prepare(sql).run(...args);
for(const [sql,args] of [
 ['INSERT INTO branches VALUES (?,?,?)',['alpha','release','c1']],
 ['INSERT INTO commits VALUES (?,?,?,?,?,?)',['c1','alpha','release','[]','test','2026-01-01']],
 ['INSERT INTO engine_refs VALUES (?,?,?)',['alpha','release','native1']],
]) dbexec(sql,...args);
const clients=new Map([['alpha',{close:async()=>{}}]]);
let volumes=new Set();
const ctx=vm.createContext({process:{env:{}},DatabaseSync,storeRoot,homeDir,sidecar,clients,createHash,chmodSync,cpSync,existsSync,readdirSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,randomBytes,Date,JSON,Map,Error,LayerFS:{open:async()=>({})},dockerCall:async(method)=>({status:method==='GET'?404:204}),volName:p=>'wm-'+p+'-store',ensureVolume:async p=>volumes.add(p),dropVolume:async p=>volumes.delete(p),refusal:(code,message)=>Object.assign(new Error(message),{code})});
try {
 vm.runInContext(src.slice(start,end)+'\nthis.testApi={projectBackupRoot,createProjectBackup,listProjectBackups,restoreProjectBackup};',ctx);
 const api=ctx.testApi;
 for(const [dir,contents] of [[join(homeDir,'alpha'),'home-data'],[join(storeRoot,'sources/alpha'),'source-data'],[join(storeRoot,'stores/alpha/global'),'native-data']]) { mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'marker'),contents); }
 const fixtureDb=new DatabaseSync(join(storeRoot,'stores/alpha/global/fixture.sqlite'));
 fixtureDb.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('cold-read')");fixtureDb.close();
 const created=await api.createProjectBackup('alpha');
 assert.equal(clients.has('alpha'),false,'creation closes client for a consistent snapshot');
 assert.equal((await api.listProjectBackups('alpha')).length,1);
 const backupPath=join(api.projectBackupRoot('alpha'),created.backup_id);
 assert.equal(readFileSync(join(backupPath,'store','global','marker'),'utf8'),'native-data');
 assert.equal(JSON.parse(readFileSync(join(backupPath,'sidecar.json'),'utf8')).commits[0].id,'c1');
 console.log('PASS project backup snapshots native trees and project-indexed sidecar rows');
 const external=join(root,'external-backup');cpSync(backupPath,external,{recursive:true});
 // Simulate deletion of all project data/registry rows, retaining an operator-held
 // archive outside the lifecycle-owned registry for the restore test.
 rmSync(join(homeDir,'alpha'),{recursive:true,force:true});rmSync(join(storeRoot,'sources/alpha'),{recursive:true,force:true});rmSync(join(storeRoot,'stores/alpha'),{recursive:true,force:true});rmSync(api.projectBackupRoot('alpha'),{recursive:true,force:true});
 for(const table of ['commits','branches','drafts','engine_refs']) sidecar.prepare('DELETE FROM '+table+' WHERE project=?').run('alpha');
 assert.deepEqual(Array.from(await api.listProjectBackups('alpha')),[],'project deletion must erase all registered snapshots');
 console.log('PASS project deletion removes the complete per-project backup registry');
 // A separately retained, owner-controlled copy can be staged into the restore
 // registry; restore is fail-closed unless every destination is absent.
 const backupId=created.backup_id, staged=join(api.projectBackupRoot('alpha'),backupId);
 cpSync(external,staged,{recursive:true});
 writeFileSync(join(staged,'store','global','marker'),'tampered');
 await assert.rejects(()=>api.restoreProjectBackup('alpha',backupId),e=>e.code==='InvalidInput');
 assert.equal(volumes.has('alpha'),false,'checksum refusal occurs before volume creation');
 writeFileSync(join(staged,'store','global','marker'),'native-data');
 console.log('PASS restore rejects tampered snapshots before allocating Docker volumes');
 const restored=await api.restoreProjectBackup('alpha',backupId);
 assert.equal(restored.restored,true);assert.equal(volumes.has('alpha'),true);
 assert.equal(sidecar.prepare('SELECT head FROM branches WHERE project=?').get('alpha').head,'c1');
 assert.equal(readFileSync(join(storeRoot,'stores/alpha/global/marker'),'utf8'),'native-data');
 assert.equal(clients.has('alpha'),true);
 console.log('PASS staged project restore recreates Store trees, sidecar index and native client');
 await assert.rejects(()=>api.restoreProjectBackup('alpha',backupId),e=>e.code==='Exists');
 console.log('PASS same-name restore refuses an existing project without overwriting it');
} finally {sidecar.close();rmSync(root,{recursive:true,force:true});}
