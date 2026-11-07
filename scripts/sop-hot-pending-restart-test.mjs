/** #448: restart → Redis down → save another step must not orphan a hot-only acknowledged write. Synthetic DB + persistent fake Redis only. */
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
const root=resolve('.'),out=resolve('tmp/sop-hot-pending-'+Date.now()),data=join(out,'data'),home=join(out,'home');mkdirSync(data,{recursive:true});mkdirSync(home,{recursive:true});
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));assert(![3080,9800,9801].includes(port));
const gh=await startFakeGithub();
const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];Object.assign(env,{WM_GITHUB_API:gh.api,PORT:String(port),WM_CONTROL_PORT:'0',MCP_GATEWAY:'on',ADMIN_TOKEN:'synthetic-448-admin',NODE_ENV:'test',DATA_DIR:data,YGL_HOME:home,REDIS_URL:'redis://127.0.0.1:1',SYNTHETIC_REDIS_MODULE:pathToFileURL(join(root,'scripts/fixtures/sop-state-redis.mjs')).href,SYNTHETIC_REDIS_STATE:join(out,'redis.json')});
const preload="import net from'node:net';import{registerHooks}from'node:module';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&typeof a[1]!=='string')a.splice(1,0,'127.0.0.1');return listen.apply(this,a)};registerHooks({resolve(s,c,next){return s==='redis'?{url:process.env.SYNTHETIC_REDIS_MODULE,shortCircuit:true}:next(s,c)}});";
let child,ended,serial=0,checks=0;
function http(path,method='GET',body){return new Promise((resolve,reject)=>{const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));const q=request({host:'127.0.0.1',port,path,method,agent:false,headers:{connection:'close','X-Admin-Token':env.ADMIN_TOKEN,...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})}},r=>{let text='';r.setEncoding('utf8');r.on('data',b=>text+=b);r.on('end',()=>{let j;try{j=JSON.parse(text)}catch{}resolve({status:r.statusCode,j,retry:r.headers['retry-after']})})});q.on('error',reject);q.setTimeout(6000,()=>q.destroy(Error('synthetic HTTP deadline')));if(bytes)q.write(bytes);q.end()})}
async function start(){child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server/src/index.ts'],{cwd:root,env,stdio:['ignore','ignore','pipe','ipc']});ended=once(child,'exit');let stderr='';child.stderr.on('data',b=>{stderr+=b});const deadline=Date.now()+90_000;while(Date.now()<deadline){try{if((await http('/api/health')).status===200)return;}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}assert.fail('owned server ready deadline: '+stderr.slice(-300));}
const control=(action,extra={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{child.off('message',on);reject(Error('synthetic IPC deadline'))},3000);function on(m){if(m?.kind==='synthetic-redis-receipt'&&m.id===id){clearTimeout(timer);child.off('message',on);resolve(m)}}child.on('message',on);child.send({kind:'synthetic-redis',id,action,...extra})});
async function crash(){child.kill('SIGKILL');await ended;} // no graceful flush: acknowledged hot writes stay only in Redis
const check=(name,pass,detail='')=>{assert.ok(pass,name+' '+detail);checks++;console.log('PASS '+name)};
const put=(id,stepKey,value)=>http('/api/sop/runs/'+id,'PUT',{stepKey,value});
const save=async(id,value)=>{const r=await put(id,'field',value);assert.equal(r.status,200,JSON.stringify(r.j));return r};
const row=id=>{const d=new DatabaseSync(join(data,'workbench-market.db'),{readOnly:true});try{const r=d.prepare('SELECT data,status,hot_pending FROM sop_runs WHERE id=?').get(id);const j=JSON.parse(r.data);return {...r,field:j.field,other:j.other}}finally{d.close()}};
const yaml=t=>[{path:'sop.yaml',content:['title: '+t,'steps:','  - key: inspect','    title: Inspect'].join(String.fromCharCode(10))}];
const unavailable=(r,kind)=>r.status===503&&r.j?.redis===kind&&r.j?.retryable===true&&r.retry==='5';
try{
 await start();await control('online');
 let r=await ghPublish('http://127.0.0.1:'+port,gh,{slug:'s448',kind:'sop',title:'Synthetic 448',changelog:'v1',files:yaml('Synthetic 448')},{'X-Admin-Token':env.ADMIN_TOKEN});assert.equal(r.status,201);assert.equal((await http('/api/sops/s448/publish','POST',{})).status,200);
 const runs={};for(const k of ['pending','clean']){const n=await http('/api/sop/runs','POST',{slug:'s448',started_by:'synthetic-448'});assert.equal(n.status,201);runs[k]=n.j.id;await save(runs[k],'DURABLE_BASE');}
 const hot=await save(runs.pending,'HOT_ACK');assert.equal(hot.j.persisted,'redis+checkpoint');
 check('hot-only write is flagged in SQLite, durable-only run is not',row(runs.pending).field==='DURABLE_BASE'&&row(runs.pending).hot_pending===1&&row(runs.clean).hot_pending===0,JSON.stringify([row(runs.pending),row(runs.clean)]));
 await crash();await start();await control('offline');
 r=await put(runs.pending,'other','AFTER_RESTART');check('restart + redis down: save on a run with a hot-only write answers 503',unavailable(r,'down'),JSON.stringify(r.j));
 const p=row(runs.pending);check('restart + redis down: nothing written, flag kept',p.field==='DURABLE_BASE'&&p.other===undefined&&p.hot_pending===1,JSON.stringify(p));
 r=await put(runs.clean,'other','DEGRADED_OK');check('restart + redis down: run without hot-only writes still saves degraded to SQLite',r.status===200&&r.j.persisted==='sqlite'&&row(runs.clean).other==='DEGRADED_OK',JSON.stringify(r.j));
 await control('online');
 r=await put(runs.pending,'other','AFTER_RESTART');check('redis back: save succeeds',r.status===200,JSON.stringify(r.j));
 r=await http('/api/sop/runs/'+runs.pending+'/finish','POST');const f=row(runs.pending);
 check('redis back: finish keeps the earlier hot write and the new step, flag cleared',r.status===200&&f.status==='finished'&&f.field==='HOT_ACK'&&f.other==='AFTER_RESTART'&&f.hot_pending===0,JSON.stringify(f));
 child.kill('SIGTERM');await ended;
 writeFileSync(join(out,'result.json'),JSON.stringify({checks,productionRequests:0,networkRedis:false},null,2));console.log(JSON.stringify({out,checks,failures:0}));
}finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}await gh.close();}
