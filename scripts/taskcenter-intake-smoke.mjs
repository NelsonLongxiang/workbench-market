#!/usr/bin/env node
// #159 B1: true HTTP flows on an isolated DATA_DIR; no production requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
mkdirSync('tmp', {recursive:true});
const data=mkdtempSync(resolve('tmp','tc-intake-'));
const port=21000+Math.floor(Math.random()*20000);
const base='http://127.0.0.1:'+port;
const env={...process.env,PORT:String(port),DATA_DIR:data,ADMIN_TOKEN:'tc-test',MCP_GATEWAY:'',REDIS_URL:'',LAYERFS_SERVICE_URL:''};
let child,logs='',pass=0;
async function start(){
 child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,150));}
 throw new Error('fixture boot failed '+logs.slice(-800));
}
async function stop(){if(child?.exitCode===null){const closed=once(child,'close');child.kill();await closed;}}
async function call(path,body,method='POST',headers={}){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Admin-Token':'tc-test',...headers},body:body===undefined?undefined:JSON.stringify(body)});let j;try{j=await r.json();}catch{j={};}return {status:r.status,j};}
const check=(name,fn)=>{fn();pass++;console.log('PASS '+name);};
const canonical=x=>JSON.stringify(sort(x));
function sort(x){if(Array.isArray(x))return x.map(sort);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])]));return x;}
try{
 await start();
 const sops=await (await fetch(base+'/api/sops')).json();
 check('C13 seed task-center published',()=>assert.ok(sops.some(a=>a.slug==='task-center'&&a.status==='published')));
 const initial=await (await fetch(base+'/api/apps/task-center')).json();
 const template=await (await fetch(base+'/api/task-center/template')).json();
 check('C17 six fixed keys + version',()=>{assert.ok(template.version>0);for(const k of ['title','intent','references','deliverable','target','due'])assert.ok(template.steps.some(s=>s.key===k));});
 const values={title:'isolate test',intent:{z:2,a:'intent'},references:[],deliverable:'report',target:'',due:''};
 async function intake(){const r=await call('/api/sop/runs',{slug:'task-center'});assert.equal(r.status,201);for(const [k,v]of Object.entries(values)){const s=await call('/api/sop/runs/'+r.j.id,{stepKey:k,value:v},'PUT');assert.equal(s.status,200);}return r.j.id;}
 const id=await intake();
 const unfinished=await call('/api/task-center/tasks',{intake_run_id:id,published_by:'fixture'});
 check('C3 unfinished run rejected400',()=>assert.equal(unfinished.status,400));
 await call('/api/sop/runs/'+id+'/finish',{});
 const noAdmin=await call('/api/task-center/tasks',{intake_run_id:id,published_by:'fixture'},'POST',{'X-Admin-Token':''});
 check('C9 no admin rejected',()=>assert.ok([401,403].includes(noAdmin.status)));
 const foreign=await call('/api/task-center/tasks',{intake_run_id:id,published_by:'fixture'},'POST',{Origin:'https://evil.example'});
 check('C10 foreign origin rejected',()=>assert.equal(foreign.status,403));
 const pub=await call('/api/task-center/tasks',{intake_run_id:id,published_by:'fixture'});
 check('C1 completed run published201',()=>assert.equal(pub.status,201,JSON.stringify(pub.j)));
 const task=await (await fetch(base+'/api/task-center/tasks/'+pub.j.id)).json();
 check('C19 pinned run/template',()=>{assert.equal(task.intake_run_id,id);assert.equal(task.template_version,template.version);});
 check('C2 canonical run hash',()=>assert.equal(task.material_sha256,createHash('sha256').update(canonical(values)).digest('hex')));
 const dup=await call('/api/task-center/tasks',{intake_run_id:id,published_by:'fixture'});
 check('C4 same run conflicts409',()=>assert.equal(dup.status,409));
 const frozen=await call('/api/sop/runs/'+id,{stepKey:'title',value:'changed'},'PUT');
 check('C5 finished/published intake cannot write',()=>assert.equal(frozen.status,409));
 const other=await intake();await call('/api/sop/runs/'+other+'/finish',{});
 const same=await call('/api/task-center/tasks',{intake_run_id:other,published_by:'fixture'});
 check('different runs with same material both publish',()=>assert.equal(same.status,201,JSON.stringify(same.j)));
 const mutate=await call('/api/sops/task-center/deprecate',{},'POST',{'X-Admin-Token':''});
 check('C14 seed deprecate without admin rejected',()=>assert.ok([400,401,403].includes(mutate.status)));
 const seedYaml=JSON.stringify({title:'task-center',meta:'task-center',steps:template.steps});
 const unauthorized=await call('/api/apps',{slug:'task-center',kind:'sop',files:[{path:'sop.yaml',content:seedYaml}],changelog:'not allowed'},'POST',{'X-Admin-Token':''});
 check('C14 REST republish without admin rejected',()=>assert.ok([400,401,403].includes(unauthorized.status)));
 const spoof=await call('/api/apps',{slug:'tc-spoof',title:'spoof',kind:'sop',files:[{path:'sop.yaml',content:seedYaml}],changelog:'spoof'},'POST',{'X-Admin-Token':''});
 check('C15 non-seed meta rejected',()=>assert.equal(spoof.status,400));
 for(const tool of ['app_publish','app_activate','sop_publish']){
   const r=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{slug:' TASK-CENTER ',kind:'sop',version:1,files:[{path:'sop.yaml',content:seedYaml}],changelog:'mcp blocked'}}});
   check('C14 MCP '+tool+' rejects normalized meta slug',()=>assert.ok(r.j.error||r.j.result?.isError,JSON.stringify(r.j)));
 }
 const missing=await call('/api/task-center/tasks',{intake_run_id:999999,published_by:'fixture'});
 check('missing intake rejected400',()=>assert.equal(missing.status,400));
 const empty=await call('/api/sop/runs',{slug:'task-center'});await call('/api/sop/runs/'+empty.j.id+'/finish',{});
 const invalid=await call('/api/task-center/tasks',{intake_run_id:empty.j.id,published_by:'fixture'});
 check('completed but empty intake rejected400',()=>assert.equal(invalid.status,400));
 const raced=await intake();await call('/api/sop/runs/'+raced+'/finish',{});
 const pair=await Promise.all([call('/api/task-center/tasks',{intake_run_id:raced,published_by:'fixture'}),call('/api/task-center/tasks',{intake_run_id:raced,published_by:'fixture'})]);
 check('concurrent same run yields one publish one conflict',()=>assert.deepEqual(pair.map(r=>r.status).sort(),[201,409]));
 const direct=await (await fetch(base+'/api/task-center/tasks/'+pub.j.id)).json();
 check('publication appends exactly one human event',()=>{assert.equal(direct.events.length,1);assert.equal(direct.events[0].actor,'human:fixture');});
 const shape=await call('/api/sop/runs',{slug:'task-center'});
 for(const key of ['title','intent','deliverable'])await call('/api/sop/runs/'+shape.j.id,{stepKey:key,value:{value:key==='title'?'Runner title':key}},'PUT');
 await call('/api/sop/runs/'+shape.j.id+'/finish',{});
 const shaped=await call('/api/task-center/tasks',{intake_run_id:shape.j.id,published_by:'fixture'});
 const shapedTask=await (await fetch(base+'/api/task-center/tasks/'+shaped.j.id)).json();
 check('Runner field object produces actual title',()=>{assert.equal(shaped.status,201);assert.equal(shapedTask.title,'Runner title');});
 check('C18 seed versions have changelog',()=>assert.ok(initial.versions.every(v=>v.changelog)));
 const after=await (await fetch(base+'/api/apps/task-center')).json();
 check('C16 rejected mutation preserves seed',()=>{assert.equal(after.active_version,initial.active_version);assert.equal(after.versions.length,initial.versions.length);assert.equal(after.status,initial.status);});
 await stop();await start();
 const reboot=await (await fetch(base+'/api/apps/task-center')).json();
 check('restart seed idempotent/persistent',()=>{assert.equal(reboot.versions.length,initial.versions.length);assert.equal(reboot.active_version,initial.active_version);});
 console.log('Taskcenter B1 '+pass+'/'+pass+'; independent frozen-spec verification still required; DATA_DIR='+data);
}finally{await stop();}
