#!/usr/bin/env node
// Exercise actual deleteProject with isolated paths, in-memory SQLite and Docker fault injection.
import { mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,renameSync as fsRenameSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source=readFileSync('deploy/layerfs-svc.mjs','utf8');
const start=source.indexOf('async function deleteProject(proj)');
const end=source.indexOf('// Serialize adapter calls',start);
assert.ok(start>=0&&end>start,'deleteProject helper exists');
const parent=mkdtempSync(join(tmpdir(),'layerfs-delete-rollback-'));
let sequence=0;
function fixture(options={}) {
  const root=join(parent,'case-'+(++sequence));mkdirSync(root);
  const storeRoot=join(root,'store'),homeDir=join(root,'home');mkdirSync(storeRoot);mkdirSync(homeDir);
  const sidecar=new DatabaseSync(':memory:');
  sidecar.exec('CREATE TABLE branches(project TEXT, branch TEXT, head TEXT, PRIMARY KEY(project,branch)); CREATE TABLE commits(id TEXT, project TEXT, branch TEXT, files TEXT, message TEXT, at TEXT, PRIMARY KEY(project,id)); CREATE TABLE drafts(project TEXT, draft TEXT, target TEXT, base TEXT, PRIMARY KEY(project,draft)); CREATE TABLE engine_refs(project TEXT, branch TEXT, native TEXT, PRIMARY KEY(project,branch));');
  sidecar.prepare('INSERT INTO branches VALUES (?,?,?)').run('alpha','release','c1');
  sidecar.prepare('INSERT INTO commits VALUES (?,?,?,?,?,?)').run('c1','alpha','release','[]','fixture','2026-01-01');
  sidecar.prepare('INSERT INTO drafts VALUES (?,?,?,?)').run('alpha','draft1','release','c1');
  sidecar.prepare('INSERT INTO engine_refs VALUES (?,?,?)').run('alpha','release','native1');
  const nativePrepare=sidecar.prepare.bind(sidecar);
  sidecar.prepare=(sql)=>options.failRowsRestore&&/^INSERT INTO branches/.test(sql)?{run(){throw new Error('injected sidecar row restoration failure')}}:nativePrepare(sql);
  const clients=new Map([['alpha',{close:async()=>{}}]]),volumes=new Set(['alpha']);
  const originalRename=(a,b)=>{if(options.failRestore&&String(b)===options.failRestore)throw new Error('injected path restoration failure');return fsRenameSync(a,b);};
  const ctx=vm.createContext({sidecar,clients,storeRoot,homeDir,projectBackupRoot:p=>storeRoot+'/backups/'+p,projectRows:(t,p)=>sidecar.prepare('SELECT * FROM '+t+' WHERE project=?').all(p),randomBytes:()=>Buffer.from('0011223344556677','hex'),existsSync,readdirSync,renameSync:originalRename,rmSync,ensureVolume:async p=>{if(options.failEnsure)throw new Error('injected volume compensation failure');volumes.add(p)},dropVolume:async p=>{if(options.dropMode==='status0'){volumes.delete(p);return false}if(options.dropMode==='failure')return false;if(options.dropMode==='404'){volumes.delete(p);return true;}volumes.delete(p);return true},refusal:(code,message)=>Object.assign(new Error(message),{code})});
  vm.runInContext(source.slice(start,end)+'\nthis.runDelete=deleteProject;',ctx);
  for(const p of [homeDir+'/alpha',storeRoot+'/sources/alpha',storeRoot+'/stores/alpha',storeRoot+'/backups/alpha']){mkdirSync(p,{recursive:true});writeFileSync(join(p,'marker'),'preserve-me');}
  const rowsPresent=()=>['branches','commits','drafts','engine_refs'].every(t=>sidecar.prepare('SELECT count(*) AS n FROM '+t+' WHERE project=?').get('alpha').n===1);
  const treesPresent=()=>[homeDir+'/alpha',storeRoot+'/sources/alpha',storeRoot+'/stores/alpha',storeRoot+'/backups/alpha'].every(p=>existsSync(p)&&readFileSync(join(p,'marker'),'utf8')==='preserve-me');
  return {ctx,sidecar,clients,volumes,rowsPresent,treesPresent,root,homeDir,storeRoot};
}
try {
  for(const mode of ['failure','status0']){
    const f=fixture({dropMode:mode});
    await assert.rejects(()=>f.ctx.runDelete('alpha'),/Docker project volume deletion failed/);
    assert(f.rowsPresent(),mode+' must preserve every sidecar row');assert(f.treesPresent(),mode+' must restore all quarantined trees');assert(f.volumes.has('alpha'),mode+' must leave lifecycle volume present');
    console.log('PASS '+mode+' Docker failure restores metadata, trees and volume');f.sidecar.close();
  }
  for(const mode of ['success','404']){
    const f=fixture({dropMode:mode});const result=await f.ctx.runDelete('alpha');
    assert.equal(result.removed,true);assert.equal(f.rowsPresent(),false);assert.equal(f.treesPresent(),false);assert.equal(f.volumes.has('alpha'),false);
    console.log('PASS '+mode+' Docker removal commits deletion and cleans tombstones');f.sidecar.close();
  }
  {
    const f=fixture({dropMode:'status0',failEnsure:true});
    await assert.rejects(()=>f.ctx.runDelete('alpha'),/compensation needs recovery/);
    assert(f.rowsPresent(),'rows should restore even if volume compensation fails');
    assert(f.treesPresent(),'paths should restore even if volume compensation fails');
    assert(!f.volumes.has('alpha'),'fault injection should leave remote volume absent');
    console.log('PASS failed volume compensation restores local state and fails loudly');f.sidecar.close();
  }
  {
    const f=fixture({dropMode:'status0',failEnsure:true,failRowsRestore:true});
    await assert.rejects(()=>f.ctx.runDelete('alpha'),/compensation needs recovery/);
    assert.equal(f.rowsPresent(),false,'injected row restoration failure leaves the explicit residual database state');
    assert(f.treesPresent(),'path rollback should still run after row restoration failure');
    assert(!f.volumes.has('alpha'),'ambiguous Docker delete remains missing when volume recreation fails');
    console.log('PASS failed sidecar row restoration is loud while tombstones restore');f.sidecar.close();
  }
  {
    const homePath=join(parent,'case-'+(sequence+1),'home','alpha');
    const f=fixture({dropMode:'failure',failRestore:homePath});
    await assert.rejects(()=>f.ctx.runDelete('alpha'),/compensation needs recovery/);
    assert(f.rowsPresent(),'rows retained when path restoration fails');
    assert(readdirSync(f.homeDir).some(n=>n.startsWith('alpha.deleting-')),'unrestored home tombstone retained for recovery');
    console.log('PASS failed path compensation preserves tombstone and reports recovery');f.sidecar.close();
  }
} finally {rmSync(parent,{recursive:true,force:true});}
console.log('LayerFS delete rollback: 7 scenarios passed; fixtures removed');
