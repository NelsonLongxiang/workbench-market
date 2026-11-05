/** #442: restart with hot-only acknowledged writes; Redis read error/outage must 503 instead of dropping them. Synthetic DB + persistent fake Redis only. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {startFakeGithub,ghPublish} from './github-fixture.mjs';
const root=resolve('.'),out=resolve('tmp/sop-redis-read-503-'+Date.now()),data=join(out,'data'),home=join(out,'home');mkdirSync(data,{recursive:true});mkdirSync(home,{recursive:true});
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));assert(![3080,9800,9801].includes(port));
const gh=await startFakeGithub();
const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];Object.assign(env,{WM_GITHUB_API:gh.api,PORT:String(port),WM_CONTROL_PORT:'0',MCP_GATEWAY:'on',ADMIN_TOKEN:'synthetic-442-admin',NODE_ENV:'test',DATA_DIR:data,YGL_HOME:home,REDIS_URL:'redis://127.0.0.1:1',SYNTHETIC_REDIS_MODULE:pathToFileURL(join(root,'scripts/fixtures/sop-state-redis.mjs')).href,SYNTHETIC_REDIS_STATE:join(out,'redis.json')});
const preload="import net from'node:net';import{registerHooks}from'node:module';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&typeof a[1]!=='string')a.splice(1,0,'127.0.0.1');return listen.apply(this,a)};registerHooks({resolve(s,c,next){return s==='redis'?{url:process.env.SYNTHETIC_REDIS_MODULE,shortCircuit:true}:next(s,c)}});";
let child,ended,serial=0,checks=0;
function http(path,method='GET',body){return new Promise((resolve,reject)=>{const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));const q=request({host:'127.0.0.1',port,path,method,agent:false,headers:{connection:'close','X-Admin-Token':env.ADMIN_TOKEN,...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})}},r=>{let text='';r.setEncoding('utf8');r.on('data',b=>text+=b);r.on('end',()=>{let j;try{j=JSON.parse(text)}catch{}resolve({status:r.statusCode,j,retry:r.headers['retry-after']})})});q.on('error',reject);q.setTimeout(6000,()=>q.destroy(Error('synthetic HTTP deadline')));if(bytes)q.write(bytes);q.end()})}
async function start(){child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server/src/index.ts'],{cwd:root,env,stdio:['ignore','ignore','pipe','ipc']});ended=once(child,'exit');let stderr='';child.stderr.on('data',b=>{stderr+=b});const deadline=Date.now()+90_000;while(Date.now()<deadline){try{if((await http('/api/health')).status===200)return;}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}assert.fail('owned server ready deadline: '+stderr.slice(-300));}
const control=(action,extra={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{child.off('message',on);reject(Error('synthetic IPC deadline'))},3000);function on(m){if(m?.kind==='synthetic-redis-receipt'&&m.id===id){clearTimeout(timer);child.off('message',on);resolve(m)}}child.on('message',on);child.send({kind:'synthetic-redis',id,action,...extra})});
async function crash(){child.kill('SIGKILL');await ended;} // no graceful flush: acknowledged hot writes stay only in Redis
const check=(name,pass,detail='')=>{assert.ok(pass,name+' '+detail);checks++;console.log('PASS '+name)};
const save=async(id,value)=>{const r=await http('/api/sop/runs/'+id,'PUT',{stepKey:'field',value});assert.equal(r.status,200,JSON.stringify(r.j));return r};
const row=id=>{const d=new DatabaseSync(join(data,'workbench-market.db'),{readOnly:true});try{const r=d.prepare('SELECT data,status,sop_version FROM sop_runs WHERE id=?').get(id);return {...r,field:JSON.parse(r.data).field}}finally{d.close()}};
const yaml=t=>[{path:'sop.yaml',content:['title: '+t,'steps:','  - key: inspect','    title: Inspect'].join(String.fromCharCode(10))}];
const unavailable=(r,kind)=>r.status===503&&r.j?.redis===kind&&r.j?.retryable===true&&r.retry==='5';
try{
 await start();await control('online');
 let r=await ghPublish('http://127.0.0.1:'+port,gh,{slug:'s442',kind:'sop',title:'Synthetic 442',changelog:'v1',files:yaml('Synthetic 442')},{'X-Admin-Token':env.ADMIN_TOKEN});assert.equal(r.status,201);assert.equal((await http('/api/sops/s442/publish','POST',{})).status,200);
 const runs={};for(const k of ['finish','upgrade','down','error']){const n=await http('/api/sop/runs','POST',{slug:'s442',started_by:'synthetic-442'});assert.equal(n.status,201);runs[k]=n.j.id;await save(runs[k],'DURABLE_BASE');const hot=await save(runs[k],'HOT_ACK');assert.equal(hot.j.persisted,'redis+checkpoint');}
 check('acknowledged hot writes are not yet in SQLite',Object.values(runs).every(id=>row(id).field==='DURABLE_BASE'));
 r=await ghPublish('http://127.0.0.1:'+port,gh,{slug:'s442',kind:'sop',title:'Synthetic 442',changelog:'v2',files:yaml('Synthetic 442 v2')},{'X-Admin-Token':env.ADMIN_TOKEN});assert.ok(r.status===200||r.status===201);
 await crash();await start();await control('online');
 // Hot-only after restart, no in-process buffer: finish and upgrade must pick up the Redis state.
 r=await http('/api/sop/runs/'+runs.finish+'/finish','POST');check('restart: finish uses hot-only acknowledged write',r.status===200&&row(runs.finish).status==='finished'&&row(runs.finish).field==='HOT_ACK',JSON.stringify(r.j));
 r=await http('/api/sop/runs/'+runs.upgrade+'/upgrade','POST',{reason:'synthetic 442'});check('restart: upgrade writes hot-only acknowledged write with the new version',r.status===200&&row(runs.upgrade).sop_version===2&&row(runs.upgrade).field==='HOT_ACK',JSON.stringify(r.j));
 // Connected but this read fails: every hot-state reader answers 503 and writes nothing.
 for(const [name,call] of [['finish',()=>http('/api/sop/runs/'+runs.error+'/finish','POST')],['upgrade preflight',()=>http('/api/sop/runs/'+runs.error+'/upgrade-preflight')],['upgrade',()=>http('/api/sop/runs/'+runs.error+'/upgrade','POST',{reason:'synthetic 442'})],['step save',()=>http('/api/sop/runs/'+runs.error,'PUT',{stepKey:'field',value:'MUST_NOT_LAND'})],['get',()=>http('/api/sop/runs/'+runs.error)]]){await control('fail',{operation:'read'});r=await call();check('read error: '+name+' answers 503',unavailable(r,'error'),JSON.stringify(r.j));}
 const e=row(runs.error);check('read error: nothing written, run still running on v1',e.status==='running'&&e.sop_version===1&&e.field==='DURABLE_BASE');
 r=await http('/api/sop/runs/'+runs.error+'/finish','POST');check('read recovers: finish keeps the hot write',r.status===200&&row(runs.error).field==='HOT_ACK',JSON.stringify(r.j));
 // Configured but disconnected: finish and upgrade wait for Redis; routine reads keep the degraded SQLite fallback.
 await control('offline');
 r=await http('/api/sop/runs/'+runs.down+'/finish','POST');check('redis down: finish answers 503',unavailable(r,'down'),JSON.stringify(r.j));
 r=await http('/api/sop/runs/'+runs.down+'/upgrade-preflight');check('redis down: upgrade preflight answers 503',unavailable(r,'down'),JSON.stringify(r.j));
 r=await http('/api/sop/runs/'+runs.down+'/upgrade','POST',{reason:'synthetic 442'});check('redis down: upgrade answers 503',unavailable(r,'down'),JSON.stringify(r.j));
 r=await http('/api/sop/runs/'+runs.down);check('redis down: get still serves SQLite (degraded mode)',r.status===200&&r.j.data.field==='DURABLE_BASE');
 check('redis down: run untouched',row(runs.down).status==='running'&&row(runs.down).sop_version===1&&row(runs.down).field==='DURABLE_BASE');
 await control('online');
 r=await http('/api/sop/runs/'+runs.down+'/finish','POST');check('redis back: finish keeps the hot write',r.status===200&&row(runs.down).field==='HOT_ACK',JSON.stringify(r.j));
 child.kill('SIGTERM');await ended;
 writeFileSync(join(out,'result.json'),JSON.stringify({checks,productionRequests:0,networkRedis:false},null,2));console.log(JSON.stringify({out,checks,failures:0}));
}finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}await gh.close();}
