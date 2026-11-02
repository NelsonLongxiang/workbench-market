/** #337/#338 RED first: real index, synthetic SQLite/home, in-memory Redis, owned loopback only. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
const which=process.argv[2]??'all';assert(['all','checkpoint','active'].includes(which));
const root=resolve('.'),out=resolve('tmp/sop-state-http-'+Date.now()+'-'+which),data=join(out,'data'),home=join(out,'home');
mkdirSync(join(data,'apps','durability-sop','v1'),{recursive:true});mkdirSync(home,{recursive:true});
writeFileSync(join(data,'apps','durability-sop','v1','sop.yaml'),'title: Synthetic durability\nsteps:\n  - key: inspect\n    title: Inspect\n');
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));assert(![3080,9800,9801].includes(port));
const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PORT:String(port),WM_CONTROL_PORT:'0',MCP_GATEWAY:'on',ADMIN_TOKEN:'synthetic-state-admin',NODE_ENV:'test',DATA_DIR:data,YGL_HOME:home,REDIS_URL:'redis://127.0.0.1:1',SYNTHETIC_REDIS_MODULE:pathToFileURL(join(root,'scripts/fixtures/sop-state-redis.mjs')).href});
for(const[k,v]of Object.entries(env))process.env[k]=v;
const {db}=await import(pathToFileURL(join(root,'server/src/db.ts')).href);
db.prepare("INSERT INTO apps(slug,title,kind,status,active_version) VALUES('durability-sop','Synthetic durability','sop','published',1)").run();
db.prepare('INSERT INTO app_versions(app_id,version) VALUES(?,1)').run(db.prepare("SELECT id FROM apps WHERE slug='durability-sop'").get().id);db.prepare("UPDATE apps SET a2a_node8='12345678' WHERE slug='durability-sop'").run();db.prepare("INSERT INTO bindings(target_type,target_slug,agent_node,direction,mode) VALUES('sop','durability-sop','synthetic/caller','admits','run')").run();db.close();
const preload="import net from'node:net';import{registerHooks}from'node:module';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&typeof a[1]!=='string')a.splice(1,0,'127.0.0.1');return listen.apply(this,a)};registerHooks({resolve(s,c,next){return s==='redis'?{url:process.env.SYNTHETIC_REDIS_MODULE,shortCircuit:true}:next(s,c)}});";
const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server/src/index.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']}),ended=once(child,'exit');
let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
let seq=0;const control=(action,extra={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{child.off('message',on);reject(Error('synthetic Redis IPC deadline'))},2500);function on(m){if(m?.kind==='synthetic-redis-receipt'&&m.id===id){clearTimeout(timer);child.off('message',on);resolve(m)}}child.on('message',on);child.send({kind:'synthetic-redis',id,action,...extra});});
const base='http://127.0.0.1:'+port,H={'X-Admin-Token':env.ADMIN_TOKEN};let checks=0;const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS '+name)};
const http=async(path,method='GET',body,headers=H)=>{const r=await fetch(base+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,j:await r.json()};};
const start=async(slug='durability-sop')=>{const r=await http('/api/sop/runs','POST',{slug,started_by:'synthetic-actor'});assert.equal(r.status,201);return r.j;};
const save=async(id,key,value)=>{const r=await http('/api/sop/runs/'+id,'PUT',{stepKey:key,value});assert.equal(r.status,200);return r.j;};
const stored=id=>{const d=new DatabaseSync(join(data,'workbench-market.db'),{readOnly:true});try{return JSON.parse(d.prepare('SELECT data FROM sop_runs WHERE id=?').get(id).data);}finally{d.close();}};
const active=async()=>{const r=await http('/api/sop/runs/active');assert.equal(r.status,200);return r.j;};
try{
 let ready=false;for(let i=0;i<160;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}if(child.exitCode!==null)throw Error('owned server exited');await new Promise(r=>setTimeout(r,50));}assert(ready,'owned server ready');await control('online');
 if(which==='active'||which==='all'){
  const a=await start();await save(a.id,'inspect',{value:'SYNTHETIC_INDEXED'});const b=await start(),intake=await start('task-center'),finished=await start();await http('/api/sop/runs/'+finished.id+'/finish','POST');await control('active',{ids:[a.id,finished.id,999999]});
  const rows=await active();check('nonempty partial Redis index never hides unsaved or task-center runs',[a.id,b.id,intake.id].every(id=>rows.some(r=>r.id===id))&&!rows.some(r=>[finished.id,999999].includes(r.id)));
  check('active response preserves metadata-only privacy',rows.every(r=>!Object.hasOwn(r,'data')&&!Object.hasOwn(r,'upload_token')));
  await control('clear');check('empty Redis index still returns every SQLite running run',(await active()).length===3);
  await control('offline');check('Redis outage preserves full active list',(await active()).length===3);await control('online');check('Redis recovery without index cannot omit active runs',(await active()).length===3);
 }
 if(which==='checkpoint'||which==='all'){
  const a=await start();await save(a.id,'first',{value:'ACK_FIRST'});check('first acknowledged save reaches initial SQLite checkpoint',stored(a.id).first?.value==='ACK_FIRST');await save(a.id,'second',{value:'ACK_SECOND'});await save(a.id,'third',{value:'ACK_THIRD'});
  const pendingRow=stored(a.id);check('subsequent hot writes keep the original checkpoint window',pendingRow.first?.value==='ACK_FIRST'&&pendingRow.second===undefined);
  await new Promise(r=>setTimeout(r,31_100));
  const durable=stored(a.id);check('idle run checkpoints all acknowledged hot changes without another request',durable.second?.value==='ACK_SECOND'&&durable.third?.value==='ACK_THIRD');
  await control('clear');await control('offline');const recovered=await http('/api/sop/runs/'+a.id);check('loss of Redis after deadline recovers the latest checkpoint',recovered.j.data.second?.value==='ACK_SECOND'&&recovered.j.data.third?.value==='ACK_THIRD');await control('online');
  await save(a.id,'pendingBeforeLoss',{value:'KEEP_PENDING'});await control('clear');await control('offline');await save(a.id,'fallback',{value:'SQLITE_FALLBACK'});const fallback=stored(a.id);check('SQLite fallback merges earlier pending values after Redis loss',fallback.pendingBeforeLoss?.value==='KEEP_PENDING'&&fallback.fallback?.value==='SQLITE_FALLBACK');await control('online');
  await save(a.id,'beforeFinish',{value:'FINISH_PENDING'});await control('clear');const finish=await http('/api/sop/runs/'+a.id+'/finish','POST');check('finish persists pending values even when Redis lost data',finish.status===200&&stored(a.id).beforeFinish?.value==='FINISH_PENDING');
  const direct=(action,task,text='')=>http('/a2a/direct','POST',{team:'market/12345678',caller_session:'synthetic/caller',task_id:task,context_id:'durability-note-context',message:JSON.stringify({sop:{action,text}})});
  const directStart=await direct('start','state-start');const noteRun=directStart.j.sop.run_id;await save(noteRun,'first',{value:'NOTE_BASELINE'});await save(noteRun,'beforeNote',{value:'HOT_BEFORE_NOTE'});const note=await direct('note','state-note','SYNTHETIC_NOTE');check('A2A note response waits for durable merged data',note.j.delivered===true&&stored(noteRun)['a2a-notes']?.[0]?.text==='SYNTHETIC_NOTE'&&stored(noteRun).beforeNote?.value==='HOT_BEFORE_NOTE');await save(noteRun,'afterNote',{value:'HOT_AFTER_NOTE'});await http('/api/sop/runs/'+noteRun+'/finish','POST');check('checkpoint and finish cannot overwrite A2A notes',stored(noteRun)['a2a-notes']?.[0]?.text==='SYNTHETIC_NOTE'&&stored(noteRun).afterNote?.value==='HOT_AFTER_NOTE');
  const b=await start();await Promise.all([save(b.id,'parallelA',{value:'A'}),save(b.id,'parallelB',{value:'B'})]);await http('/api/sop/runs/'+b.id+'/finish','POST');const parallel=stored(b.id);check('concurrent same-run writes cannot overwrite another acknowledged step',parallel.parallelA?.value==='A'&&parallel.parallelB?.value==='B');
 }
 writeFileSync(join(out,'result.json'),JSON.stringify({checks,case:which,production_requests:0,personal_ygl_access:false,redis_network_connections:0},null,2));console.log(JSON.stringify({out,checks,case:which}));
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await ended;}writeFileSync(join(out,'stdout.log'),stdout);writeFileSync(join(out,'stderr.log'),stderr);}
