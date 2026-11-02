/** #349: real a2aSendOutbound + actual finish/outbox HTTP; synthetic DB/home, owned loopback only. */
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createPublicKey,verify} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
mkdirSync('tmp',{recursive:true});
const root=resolve('.'),out=mkdtempSync(resolve('tmp/a2a-redirect-')),data=join(out,'data'),home=join(out,'home');mkdirSync(data);mkdirSync(home);
const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{DATA_DIR:data,YGL_HOME:home,ADMIN_TOKEN:'synthetic-redirect-admin',MCP_GATEWAY:'on',WM_CONTROL_PORT:'0',NODE_ENV:'test',REDIS_URL:'',A2A_OUTBOX_BACKOFF_SCALE:'10000'});
for(const[k,v]of Object.entries(env))process.env[k]=v;
const {db}=await import(pathToFileURL(join(root,'server/src/db.ts')).href);
const cases=[];for(const kind of ['direct','outbox'])for(const code of [302,303,307,308])for(const target of ['same-origin','cross-origin'])cases.push({id:cases.length+1,kind,code,target});
for(const c of cases.filter(x=>x.kind==='outbox')){db.prepare("INSERT INTO sop_runs(id,sop_slug,sop_version,started_by,data) VALUES(?,'redirect-probe',1,'synthetic',?)").run(c.id,JSON.stringify({inspect:'SYNTHETIC_OUTBOX_DATA'}));}
db.prepare("INSERT INTO sop_runs(id,sop_slug,sop_version,started_by) VALUES(100,'redirect-probe',1,'synthetic')").run();
const ctx=db.prepare('INSERT INTO a2a_run_ctx(context_id,run_id,task_id,caller,team,callback_url) VALUES(?,?,?,?,?,?)');
const observed=new Map(),sinks=[];let originA,originB;
const delivered=(res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({routed:true,delivered:true,task_status:'TASK_STATE_DELIVERED',task_id:'synthetic-peer',context_id:'synthetic-context'}));};
const receive=(role)=>(req,res)=>{let body='';req.setEncoding('utf8');req.on('data',b=>body+=b);req.on('end',()=>{
 if(role==='sink'||req.url.startsWith('/relay/')){sinks.push({path:req.url,method:req.method,bodyBytes:Buffer.byteLength(body),claimHeaderCount:Object.keys(req.headers).filter(k=>k.startsWith('x-a2a-caller')).length});return delivered(res);}
 const match=/^\/(?:case\/(\d+)|success)\/a2a\/direct$/.exec(req.url);if(!match){res.writeHead(404).end();return;}
 const id=match[1]?Number(match[1]):0,seen=observed.get(id)??[];seen.push({url:req.url,method:req.method,headers:req.headers,body});observed.set(id,seen);
 if(id===0)return delivered(res);
 const c=cases.find(x=>x.id===id);res.writeHead(c.code,{location:(c.target==='same-origin'?originA:originB)+'/relay/'+id,'content-type':'application/json'});res.end('{"error":"synthetic_redirect"}');
 });};
const peerA=createServer(receive('intended')),peerB=createServer(receive('sink'));await new Promise(r=>peerA.listen(0,'127.0.0.1',r));await new Promise(r=>peerB.listen(0,'127.0.0.1',r));originA='http://127.0.0.1:'+peerA.address().port;originB='http://127.0.0.1:'+peerB.address().port;
for(const c of cases.filter(x=>x.kind==='outbox'))ctx.run('synthetic-context-'+c.id,c.id,'synthetic-task-'+c.id,'synthetic/caller','market/12345678',originA+'/case/'+c.id);ctx.run('synthetic-success-context',100,'synthetic-success-task','synthetic/caller','market/12345678',originA+'/success');db.close();
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));assert(![9800,9801,3080,13080].includes(port));env.PORT=String(port);env.MARKET_PUBLIC_URL='http://127.0.0.1:'+port;
const preload='import net from"node:net";const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(typeof args[0]==="number"&&typeof args[1]!=="string")args.splice(1,0,"127.0.0.1");return original.apply(this,args)};';
const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server/src/index.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
function http(path,method='GET',body){return new Promise((resolve,reject)=>{const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));const q=request({host:'127.0.0.1',port,path,method,agent:false,headers:{connection:'close','X-Admin-Token':env.ADMIN_TOKEN,...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})}},r=>{let text='';r.setEncoding('utf8');r.on('data',b=>text+=b);r.on('end',()=>{let j;try{j=JSON.parse(text)}catch{}resolve({status:r.statusCode,j})})});q.on('error',reject);q.setTimeout(20000,()=>q.destroy(Error('synthetic HTTP deadline')));if(bytes)q.write(bytes);q.end()})}
const outbox=id=>{const d=new DatabaseSync(join(data,'workbench-market.db'),{readOnly:true});try{d.exec('PRAGMA busy_timeout=1000');return d.prepare('SELECT status,attempts,last_error FROM a2a_outbox WHERE run_id=?').get(id)}finally{d.close()}};
const settled=async id=>{const end=Date.now()+5000;for(;;){const row=outbox(id);if(row&&(row.status==='sent'||row.attempts>0))return row;if(Date.now()>end)throw Error('synthetic outbox deadline');await new Promise(r=>setTimeout(r,20))}};
let checks=0,failures=0;const results=[];const check=(name,pass)=>{checks++;if(!pass)failures++;console.log((pass?'PASS ':'FAIL ')+name);};
try{
 let ready=false;for(let i=0;i<120;i++){try{if((await http('/api/health')).status===200){ready=true;break}}catch{}if(child.exitCode!==null)throw Error('owned server exited');await new Promise(r=>setTimeout(r,100));}assert(ready,'owned server ready');
 process.env.MARKET_PUBLIC_URL=env.MARKET_PUBLIC_URL;
 const {a2aSendOutbound}=await import(pathToFileURL(join(root,'server/src/a2a.ts')).href);
 const direct=(target,message)=>a2aSendOutbound(join(data,'a2a-key.pem'),{baseUrl:target,team:'dsh/12345678'},message,'synthetic-context','market/12345678');
 const card=(await http('/.well-known/agent-card.json')).j;const publicKey=createPublicKey({key:Buffer.from(card.publicKey,'base64'),format:'der',type:'spki'});
 const validClaim=req=>{const h=req.headers;const text=JSON.stringify(['a2a-origin-claim/2',h['x-a2a-caller'],h['x-a2a-caller-url'],Number(h['x-a2a-caller-ts']),originA,req.method,new URL(req.url,originA).pathname]);return h['x-a2a-caller-aud']===originA&&!!h['x-a2a-caller-sig']&&verify(null,Buffer.from(text),publicKey,Buffer.from(h['x-a2a-caller-sig2']??'','base64'));};
 for(const c of cases){
  let rejected=false;
  if(c.kind==='direct'){const r=await direct(originA+'/case/'+c.id,'SYNTHETIC_DIRECT_'+c.id);rejected=r?.ok===false;}
  else{const r=await http('/api/sop/runs/'+c.id+'/finish','POST');assert.equal(r.status,200);const row=await settled(c.id);rejected=row.status==='pending'&&row.attempts>=1;}
  const first=observed.get(c.id)??[],redirected=sinks.filter(x=>x.path==='/relay/'+c.id);const prefix=c.kind+' '+c.code+' '+c.target;
  check(prefix+' initial POST body and bound signature valid',first.length>=1&&first.every(x=>x.method==='POST'&&x.body.length>0&&validClaim(x)));
  check(prefix+' redirect produces explicit delivery failure',rejected);
  check(prefix+' zero redirected requests / signed headers / body',redirected.length===0);
  results.push({...c,rejected,initialRequests:first.length,redirectRequests:redirected.length,leakedBodyBytes:redirected.reduce((n,x)=>n+x.bodyBytes,0),leakedClaimHeaders:redirected.reduce((n,x)=>n+x.claimHeaderCount,0)});
 }
 const countBefore=(observed.get(0)??[]).length;const normal=await direct(originA+'/success','SYNTHETIC_NORMAL_DIRECT');check('nonredirect direct still delivers',normal?.ok===true);
 const finish=await http('/api/sop/runs/100/finish','POST');const row=await settled(100);check('nonredirect outbox still marks sent',finish.status===200&&row.status==='sent'&&row.last_error==='');check('nonredirect sends valid bound claims in both paths',(observed.get(0)??[]).length-countBefore===2&&observed.get(0).slice(countBefore).every(validClaim));
 const result={checks,failures,cases:results,productionRequests:0,personalYgl:false,realPeers:false,scope:'actual a2aSendOutbound native fetch and real market finish/outbox HTTP; only synthetic loopback listeners'};writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,checks,failures}));if(failures)process.exitCode=1;
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}peerA.closeAllConnections();peerB.closeAllConnections();await Promise.all([new Promise(r=>peerA.close(r)),new Promise(r=>peerB.close(r))]);writeFileSync(join(out,'stdout.log'),stdout);writeFileSync(join(out,'stderr.log'),stderr);}
