#!/usr/bin/env node
/** Run P1/P2/S2/S3/S4 against a fresh, self-cleaning fixture without reading server/data. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const fixture = mkdtempSync(join(tmpdir(), 'workbench-layerfs-smokes-'));
const seed = join(fixture, 'seed');
mkdirSync(seed, { recursive: true });
const portServer = createServer();
const port = await new Promise((resolvePort, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', () => resolvePort(portServer.address().port));
});
await new Promise(resolveClose => portServer.close(resolveClose));
let child;
let gh;
const wait = async (url, ms=25000) => {
  const end=Date.now()+ms;
  while(Date.now()<end){try{const r=await fetch(url);if(r.status<500)return true;}catch{} await new Promise(r=>setTimeout(r,200));}
  return false;
};
try {
  gh=await startFakeGithub();
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{
    cwd:root,
    env:{...process.env,DATA_DIR:seed,MCP_GATEWAY:'off',NODE_ENV:'test',PORT:String(port),ADMIN_TOKEN:'fixture-admin',LAYERFS_SERVICE_URL:'',LAYERFS_SERVICE_TOKEN:'',WM_GITHUB_API:gh.api},
    stdio:['ignore','ignore','inherit'],
  });
  if(!await wait('http://127.0.0.1:'+port+'/api/health')) throw new Error('fixture Workbench did not start');
  const admin={'Content-Type':'application/json','X-Admin-Token':'fixture-admin'};
  const app=await ghPublish('http://127.0.0.1:'+port,gh,{slug:'fixture-app',title:'Fixture App',files:[{path:'index.html',content:'<h1>fixture</h1>'}]},{'X-Admin-Token':'fixture-admin'});
  if(app.status!==201) throw new Error('fixture app publish failed: '+app.status+' '+await app.text());
  const skill=await fetch('http://127.0.0.1:'+port+'/api/skills/fixture:skill/versions',{method:'POST',headers:admin,body:JSON.stringify({files:[{path:'SKILL.md',content:'---\nname: fixture-skill\ndescription: isolated test fixture\n---\n# Fixture Skill\n'}],changelog:'isolated fixture'})});
  if(skill.status!==201) throw new Error('fixture skill publish failed: '+skill.status+' '+await skill.text());
  const survivor=await fetch('http://127.0.0.1:'+port+'/api/skills/fixture:survivor/versions',{method:'POST',headers:admin,body:JSON.stringify({files:[{path:'SKILL.md',content:'---\nname: fixture-survivor\ndescription: retained during S4 rebuild\n---\n# Survivor\n'}],changelog:'survivor fixture'})});
  if(survivor.status!==201) throw new Error('survivor skill publish failed: '+survivor.status+' '+await survivor.text());
  for(const name of ['apps','skill-snapshots','uploads']) mkdirSync(join(seed,name),{recursive:true});
  const fixtureChild=child;
  await new Promise(resolveDone=>{
    if(fixtureChild.exitCode!==null)return resolveDone();
    const timeout=setTimeout(()=>{if(fixtureChild.exitCode===null)fixtureChild.kill('SIGKILL');},5000);
    fixtureChild.once('exit',()=>{clearTimeout(timeout);resolveDone();});
    fixtureChild.kill('SIGTERM');
  });
  child=undefined;
  let failures=0;
  for(const [name,script] of [['P1','layerfs-p1-smoke.mjs'],['P2','layerfs-p2-smoke.mjs'],['S2','layerfs-s2-smoke.mjs'],['S3','layerfs-s3-smoke.mjs'],['S4','layerfs-s4-smoke.mjs']]){
    const data=join(fixture,'clone-'+name.toLowerCase());
    const run=spawnSync(process.execPath,['scripts/'+script],{cwd:root,encoding:'utf8',timeout:120000,env:{...process.env,LAYERFS_SMOKE_SEED:seed,LAYERFS_SMOKE_DATA:data,SCRIPT_TARGET_MODE:'isolated',SCRIPT_ISOLATED_ROOT:fixture,SCRIPT_SOURCE_DATA_DIR:seed}});
    console.log('===== '+name+' exit='+run.status+' =====');
    if(run.stdout)process.stdout.write(run.stdout);
    if(run.stderr)process.stderr.write(run.stderr);
    if(run.error)console.error(run.error);
    if(run.status!==0)failures++;
  }
  if(failures)process.exitCode=1;
} finally {
  await gh?.close();
  if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(r=>setTimeout(r,1000));if(child.exitCode===null)child.kill('SIGKILL');}
  rmSync(fixture,{recursive:true,force:true});
  console.log('DISPOSABLE_FIXTURE_CLEANED '+fixture);
}
