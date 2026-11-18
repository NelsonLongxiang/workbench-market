#!/usr/bin/env node
// #159 B1: true HTTP flows on an isolated DATA_DIR; no production requests.
// 录入发布（POST /api/task-center/tasks）、按编号发布已退役（任务只经「安排一件事」建）：发布入口回 404。
// 这里照旧守任务中心的种子台（模板、REST/MCP 改不动、冒名的 meta 拒）、录入 run 完成后不可写、总开关和任务级派发开关、
// 撤回、任务事件只增不改、重启后持久。要一件已发布的任务时，按旧发布写的两行（tasks、task_events）直接造一件存量的录入任务。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';
mkdirSync('tmp', {recursive:true});
const data=mkdtempSync(resolve('tmp','tc-intake-'));
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const base='http://127.0.0.1:'+port;
const gh=await startFakeGithub();
const env={...process.env,WM_GITHUB_API:gh.api,PORT:String(port),WM_CONTROL_PORT:'0',DATA_DIR:data,ADMIN_TOKEN:'tc-test',MCP_GATEWAY: 'off', NODE_ENV: 'test',REDIS_URL:'',LAYERFS_SERVICE_URL:''};
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
 const CAPS={}; // #309 phase2：录入 run 读能力（创建响应即得，详情授权用）
 const RC=id=>({'X-Run-Read-Capability':CAPS[id]||''});
 async function intake(){const r=await call('/api/sop/runs',{slug:'task-center'});assert.equal(r.status,201);CAPS[r.j.id]=String(r.j.read_capability||'');for(const [k,v]of Object.entries(values)){const s=await call('/api/sop/runs/'+r.j.id,{stepKey:k,value:v},'PUT');assert.equal(s.status,200);}return r.j.id;}
 const taskGet=async id=>(await fetch(base+'/api/task-center/tasks/'+id,{headers:RC(id)})).json();
 const id=await intake();
 await call('/api/sop/runs/'+id+'/finish',{});
 const retired=await call('/api/task-center/tasks',{intake_run_id:id,published_by:'fixture'});
 const retiredById=await call('/api/task-center/tasks/1/publish',{});
 check('录入发布、按编号发布已退役：管理口令来也是 404',()=>{assert.equal(retired.status,404);assert.equal(retiredById.status,404);});
 const seedLegacyTask=(runId,by,dispatch=false)=>{const db=new DatabaseSync(resolve(data,'workbench-market.db'),{timeout:5000});try{const run=db.prepare('SELECT * FROM sop_runs WHERE id=?').get(runId);const actor='human:'+by;const tid=Number(db.prepare("INSERT INTO tasks(title,kind,payload_json,status,intake_run_id,template_version,material_sha256,published_at,published_by,created_by,agent_dispatch_enabled) VALUES(?,'录入',?,'published',?,?,?,datetime('now'),?,?,?)").run(values.title,run.data,runId,run.sop_version,createHash('sha256').update(canonical(values)).digest('hex'),actor,actor,dispatch?1:0).lastInsertRowid);db.prepare("INSERT INTO task_events(task_id,type,actor,actor_kind,payload_json) VALUES(?,'published',?,'human',?)").run(tid,actor,JSON.stringify({intake_run_id:runId}));return tid;}finally{db.close();}};
 const pub={j:{id:seedLegacyTask(id,'fixture')}};
 const task=await taskGet(pub.j.id);
 check('C6 task switch defaults off',()=>{assert.equal(task.agent_dispatch,false);assert.equal(task.agent_dispatch_effective,false);});
 const policy=await (await fetch(base+'/api/task-center/policy')).json();
 check('C7 center policy defaults off',()=>assert.equal(policy.agent_dispatch_enabled,false));
 const frozen=await call('/api/sop/runs/'+id,{stepKey:'title',value:'changed'},'PUT');
 check('C5 finished/published intake cannot write',()=>assert.equal(frozen.status,409));
 const mutate=await call('/api/sops/task-center/deprecate',{},'POST',{'X-Admin-Token':''});
 check('C14 seed deprecate without admin rejected',()=>assert.ok([400,401,403].includes(mutate.status)));
 const seedYaml=JSON.stringify({title:'task-center',meta:'task-center',steps:template.steps});
 const unauthorized=await call('/api/apps',{slug:'task-center',kind:'sop',files:[{path:'sop.yaml',content:seedYaml}],changelog:'not allowed'},'POST',{'X-Admin-Token':''});
 check('C14 REST republish without admin rejected',()=>assert.ok([400,401,403].includes(unauthorized.status)));
 const spoofRes=await ghPublish(base,gh,{slug:'tc-spoof',title:'spoof',kind:'sop',files:[{path:'sop.yaml',content:seedYaml}],changelog:'spoof'},{'X-Admin-Token':''});const spoof={status:spoofRes.status,j:await spoofRes.json().catch(()=>({}))};
 check('C15 non-seed meta rejected',()=>{assert.equal(spoof.status,400,JSON.stringify(spoof.j));assert.match(String(spoof.j.error),/meta/);});
 for(const tool of ['app_sync','app_activate','sop_publish']){
   const r=await call('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{slug:' TASK-CENTER ',kind:'sop',version:1,files:[{path:'sop.yaml',content:seedYaml}],changelog:'mcp blocked'}}});
   check('C14 MCP '+tool+' rejects normalized meta slug',()=>assert.ok(r.j.error||r.j.result?.isError,JSON.stringify(r.j)));
 }
 const direct=await taskGet(pub.j.id);
 check('a published task carries exactly one human event',()=>{assert.equal(direct.events.length,1);assert.equal(direct.events[0].actor,'human:fixture');});
 check('C18 seed versions have changelog',()=>assert.ok(initial.versions.every(v=>v.changelog)));
 for(const [path,body,method] of [
   ['/api/task-center/tasks/'+pub.j.id+'/agent-dispatch',{enabled:true},'PATCH'],
   ['/api/task-center/policy',{agent_dispatch_enabled:true},'PUT'],
   ['/api/task-center/tasks/'+pub.j.id+'/withdraw',{},'POST'],
 ]) {
   const denied=await call(path,body,method,{'X-Admin-Token':''});
   check('C11 human-only '+path.split('/').at(-1),()=>assert.ok([401,403].includes(denied.status)));
 }
 const on=await call('/api/task-center/tasks/'+pub.j.id+'/agent-dispatch',{enabled:true},'PATCH');
 check('C8 task on center off is ineffective',()=>{assert.equal(on.status,200);assert.equal(on.j.agent_dispatch,true);assert.equal(on.j.agent_dispatch_effective,false);});
 const both=await call('/api/task-center/policy',{agent_dispatch_enabled:true},'PUT');
 const bothTask=await taskGet(pub.j.id);
 check('both locks on effective',()=>{assert.equal(both.status,200);assert.equal(bothTask.agent_dispatch_effective,true);assert.equal(bothTask.events.length,2);});
 await call('/api/task-center/tasks/'+pub.j.id+'/agent-dispatch',{enabled:true},'PATCH');
 const unchanged=await taskGet(pub.j.id);
 check('idempotent same switch does not create event',()=>assert.equal(unchanged.events.length,2));
 await call('/api/task-center/policy',{agent_dispatch_enabled:false},'PUT');
 const centerOff=await taskGet(pub.j.id);
 check('center off kills effective without task event',()=>{assert.equal(centerOff.agent_dispatch_effective,false);assert.equal(centerOff.events.length,2);});
 const invalidPolicy=await call('/api/task-center/policy',{agent_dispatch_enabled:'true'},'PUT');
 check('invalid policy boolean rejected400',()=>assert.equal(invalidPolicy.status,400));
 await call('/api/task-center/tasks/'+pub.j.id+'/withdraw',{});
 const withdrawn=await taskGet(pub.j.id);
 check('C20 publish/toggle/withdraw exactly one event each',()=>{assert.equal(withdrawn.status,'withdrawn');assert.equal(withdrawn.events.length,3);assert.deepEqual(withdrawn.events.map(e=>e.action),['published','toggled','withdrawn']);});
 check('C21 all human actors',()=>assert.ok(withdrawn.events.every(e=>e.actor.startsWith('human:'))));
 const eid=withdrawn.events[0].id;
 await call('/api/task-center/tasks/'+pub.j.id+'/events/'+eid,{actor:'tamper'},'PUT');
 await call('/api/task-center/tasks/'+pub.j.id+'/events/'+eid,{},'DELETE');
 const afterTamper=await taskGet(pub.j.id);
 check('C22 event mutation routes do not alter log',()=>assert.deepEqual(afterTamper.events,withdrawn.events));
 const blockedToggle=await call('/api/task-center/tasks/'+pub.j.id+'/agent-dispatch',{enabled:false},'PATCH');
 check('withdrawn switch rejected',()=>assert.equal(blockedToggle.status,409));
 await call('/api/task-center/policy',{agent_dispatch_enabled:true},'PUT');
 const withdrawnEffective=await taskGet(pub.j.id);
 check('withdrawn task never effective even with both flags',()=>assert.equal(withdrawnEffective.agent_dispatch_effective,false));
 const dbConn=new DatabaseSync(resolve(data,'workbench-market.db'), { timeout: 5000 });
 try {
   check('DB event UPDATE trigger blocks',()=>assert.throws(()=>dbConn.prepare('UPDATE task_events SET actor=? WHERE id=?').run('tamper',eid),/append only/));
   check('DB event DELETE trigger blocks',()=>assert.throws(()=>dbConn.prepare('DELETE FROM task_events WHERE id=?').run(eid),/append only/));
 }finally {dbConn.close();}
 const after=await (await fetch(base+'/api/apps/task-center')).json();
 check('C16 rejected mutation preserves seed',()=>{assert.equal(after.active_version,initial.active_version);assert.equal(after.versions.length,initial.versions.length);assert.equal(after.status,initial.status);});
 await stop();await start();
 const persistedPolicy=await (await fetch(base+'/api/task-center/policy')).json();
 check('center policy survives restart',()=>assert.equal(persistedPolicy.agent_dispatch_enabled,true));
 const reboot=await (await fetch(base+'/api/apps/task-center')).json();
 check('restart seed idempotent/persistent',()=>{assert.equal(reboot.versions.length,initial.versions.length);assert.equal(reboot.active_version,initial.active_version);});
 console.log('Taskcenter B1 '+pass+'/'+pass+'; independent frozen-spec verification still required; DATA_DIR='+data);
}finally{await stop();await gh.close();}
