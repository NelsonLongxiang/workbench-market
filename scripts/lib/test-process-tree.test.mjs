import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { spawnTestTree, killTestTreeSync, testTreeResult, testProcessOptions } from './test-process-tree.mjs';
const base = resolve('tmp', 'test-process-tree-' + process.pid);
mkdirSync(base, {recursive:true});
const sleep = ms => new Promise(r => setTimeout(r,ms));
const alive = pid => { try { process.kill(pid,0); return true; } catch { return false; } };
async function waitFor(file) { const end=Date.now()+5000; while(!existsSync(file)&&Date.now()<end)await sleep(25);assert.ok(existsSync(file),'fixture ready'); }
function fixture() {
 const dir=mkdtempSync(join(base,'case-')), pidfile=join(dir,'pids.json'), hook=join(dir,'exit-hook');
 writeFileSync(join(dir,'grandchild.mjs'),"setInterval(()=>{},1000);\n");
 const source = [
  "import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';",
  "const grand=spawn(process.execPath,['grandchild.mjs'],{stdio:'ignore',detached:false,windowsHide:true});",
  "process.on('exit',()=>writeFileSync('exit-hook','called'));",
  "writeFileSync('pids.json',JSON.stringify({root:process.pid,grand:grand.pid}));",
  "if(process.argv.includes('--crash'))setTimeout(()=>{throw Error('synthetic crash')},100);else if(process.argv.includes('--hang'))setInterval(()=>{},1000);else setTimeout(()=>{process.exit(7);writeFileSync('after-exit','must not run')},100);"
 ].join(String.fromCharCode(10));
 writeFileSync(join(dir,'suite.mjs'),source);
 return {dir,pidfile,hook};
}
test('identity --help is usage-only and never starts baseline or mutation work',()=>{
 const r=spawnSync(process.execPath,['scripts/identity-seam-mutation.mjs','--help'],{encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(r.status,0);assert.match(r.stdout,/Usage:/);assert.doesNotMatch(r.stdout,/没改过的副本|个变体全部被抓住/);assert.equal(r.stderr,'');
});
test('platform flags preserve POSIX detached behavior and disable Windows detached',()=>{
 assert.deepEqual(testProcessOptions('win32'),{detached:false,windowsHide:true});
 assert.equal(testProcessOptions('linux').detached,true);
});
test('arbitrary executable result is retained by a hidden holding wrapper', {skip:process.platform!=='win32',timeout:15000},async()=>{
 const child=spawnTestTree(join(process.env.SystemRoot||'C:/Windows','System32','where.exe'),['wm-synthetic-definitely-absent-6092'],{stdio:['ignore','pipe','pipe']});
 const result=await new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
 assert.equal(testTreeResult(child,result.code,result.signal).code,1);
 assert.equal(alive(child.pid),false);
});
test('normal suite result retains exit code, runs exit hook and reaps descendants', {skip:process.platform!=='win32',timeout:15000},async()=>{
 const f=fixture(), child=spawnTestTree(process.execPath,['suite.mjs'],{cwd:f.dir,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=String(b));
 const closed=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
 child.once('close',()=>{if(stderr)console.log(stderr)});
 try { await waitFor(f.pidfile);const p=JSON.parse(readFileSync(f.pidfile));const result=await closed;
  assert.equal(testTreeResult(child,result.code,result.signal).code,7);assert.equal(readFileSync(f.hook,'utf8'),'called');assert.equal(existsSync(join(f.dir,'after-exit')),false);
  for(let i=0;i<40&&alive(p.grand);i++)await sleep(25);assert.equal(alive(p.grand),false);assert.equal(alive(p.root),false);
 } finally {killTestTreeSync(child);}
});
test('uncaught suite error preserves failure and reaps its descendants', {skip:process.platform!=='win32',timeout:15000},async()=>{
 const f=fixture(),child=spawnTestTree(process.execPath,['suite.mjs','--crash'],{cwd:f.dir,stdio:['ignore','pipe','pipe']});
 const closed=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
 try{await waitFor(f.pidfile);const p=JSON.parse(readFileSync(f.pidfile));const result=await closed;assert.equal(testTreeResult(child,result.code,result.signal).code,1);
 for(let i=0;i<40&&alive(p.grand);i++)await sleep(25);assert.equal(alive(p.root),false);assert.equal(alive(p.grand),false);
 }finally{killTestTreeSync(child);}
});
test('timeout tree kill ends a running root and its descendants', {skip:process.platform!=='win32'},async()=>{
 const f=fixture(),child=spawnTestTree(process.execPath,['suite.mjs','--hang'],{cwd:f.dir,stdio:['ignore','pipe','pipe']});
 const closed=new Promise(r=>child.once('close',r));
 try{await waitFor(f.pidfile);const p=JSON.parse(readFileSync(f.pidfile));killTestTreeSync(child);await closed;
  for(let i=0;i<40&&alive(p.grand);i++)await sleep(25);assert.equal(alive(p.root),false);assert.equal(alive(p.grand),false);
 }finally{killTestTreeSync(child);}
});
test('owner exit cleanup reaps its active child tree', {skip:process.platform!=='win32'},async()=>{
 const f=fixture();const helper=new URL('./test-process-tree.mjs',import.meta.url).href;
 writeFileSync(join(f.dir,'owner.mjs'),"import{spawnTestTree}from "+JSON.stringify(helper)+";import{existsSync}from'node:fs';spawnTestTree(process.execPath,['suite.mjs','--hang'],{stdio:['ignore','ignore','ignore']});const t=setInterval(()=>{if(existsSync('pids.json')){clearInterval(t);process.exit(0)}},20);");
 const owner=spawn(process.execPath,['owner.mjs'],{cwd:f.dir,stdio:'pipe',windowsHide:true,detached:false});
 const code=await new Promise(r=>owner.once('close',r));assert.equal(code,0);const p=JSON.parse(readFileSync(f.pidfile));
 for(let i=0;i<40&&(alive(p.root)||alive(p.grand));i++)await sleep(25);assert.equal(alive(p.root),false);assert.equal(alive(p.grand),false);
});
