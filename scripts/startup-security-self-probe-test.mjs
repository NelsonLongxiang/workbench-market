/** #326 RED first: real loopback HTTP, synthetic memory DB; never uses production/home. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const require=createRequire(pathToFileURL(resolve('server/package.json')));
const express=require('express');
const { createStartupSecurityProbe, isStartupProbeRequest }=await import('../server/src/startup-security-self-probe.ts');
let checks=0;const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS '+name);};
const noAuth='DO_NOT_LOG_SYNTHETIC_CREDENTIAL';
async function fixture({mcpBroken=false,writeBroken=false,hang=false,off=false,control=false,hold=false,noChallenge=false,successWrite=false,nodeEnv='test'}={}){
 const app=express(),logs=[],db=new DatabaseSync(':memory:');db.exec('CREATE TABLE workbenches(id INTEGER PRIMARY KEY,name TEXT)');let ordinaryHits=0;const requests=[];
 const probe=createStartupSecurityProbe({timeoutMs:hang?50:500,log:row=>logs.push(row)});app.use(probe.middleware);app.use(express.json());let release;const barrier=hold?new Promise(r=>release=r):Promise.resolve();
 const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 let controlServer;if(control){controlServer=createServer(app);await new Promise(r=>controlServer.listen(0,'127.0.0.1',r));}
 app.use((req,_res,next)=>{if(!isStartupProbeRequest(req))ordinaryHits++;requests.push({method:req.method,path:req.path,headers:req.headers,internal:isStartupProbeRequest(req)});next();});
 app.post('/mcp',async(req,res)=>{await barrier;if(hang)return;if(!off&&!mcpBroken){res.status(401);if(!noChallenge)res.set('WWW-Authenticate','Bearer realm="synthetic"');return res.json({error:'denied'});}res.json({result:{}});});
 app.post('/api/workbenches',(req,res)=>{if(req.headers.origin&&successWrite)return res.status(201).json({error:noAuth});if(req.headers.origin&&!writeBroken)return res.status(403).end();if(!req.body?.name||!req.body?.url)return res.status(400).end();db.prepare('INSERT INTO workbenches(name) VALUES(?)').run(req.body.name);res.status(201).end();});
 app.get('/api/mcp/sessions',(_req,res)=>res.status(403).json({error:'denied'}));app.get('/api/health',(_req,res)=>res.json({self_probe:probe.snapshot()}));app.get('/business',(_req,res)=>res.json({ok:true}));
 return {probe,server,controlServer,port,logs,db,requests,get hits(){return ordinaryHits},release:()=>release?.(),start:()=>probe.run({market:server,control:controlServer,gatewayOn:!off,nodeEnv}),close:async()=>{for(const s of [server,controlServer].filter(Boolean)){s.closeAllConnections();await new Promise(r=>s.close(r));}db.close();}};
}
{
 const f=await fixture({control:true});try{const initial=await(await fetch('http://127.0.0.1:'+f.port+'/api/health')).json();check('pending health does not claim pass',initial.self_probe.passed===false&&initial.self_probe.at===null);const result=await f.start();check('normal surfaces pass all enforced table rows',result.passed===true&&result.failed.length===0&&result.rows.filter(r=>r.verdict==='pass').length===5);check('all probe requests use actual loopback surface ports and fixed paths',f.requests.length===5&&f.requests.every(r=>['/mcp','/api/workbenches','/api/mcp/sessions'].includes(r.path)&&r.internal));check('write refusal probes and no-Origin contrast write zero rows',f.db.prepare('SELECT COUNT(*) n FROM workbenches').get().n===0);check('anonymous probes send no credentials or business args',f.requests.every(r=>!r.headers.authorization&&!r.headers.cookie&&!r.headers['x-admin-token']));check('per-row audit is self-probe and never contains private marker or payload',f.logs.length===5&&f.logs.every(r=>r.source==='self-probe')&&!JSON.stringify(f.logs).includes(noAuth)&&!JSON.stringify(f.logs).includes('x-wm-self-probe'));check('ready service accepts ordinary traffic',(await fetch('http://127.0.0.1:'+f.port+'/business')).status===200);}finally{await f.close();}
}
{
 const f=await fixture({hold:true});try{const running=f.start();const r=await fetch('http://127.0.0.1:'+f.port+'/api/workbenches',{method:'POST',headers:{'Content-Type':'application/json','X-WM-Self-Probe':'forged','X-Internal-Probe':'1'},body:JSON.stringify({name:'must-not-write',url:'http://127.0.0.1/'})});check('startup gate rejects external or forged probes before any business handler',r.status===503&&f.db.prepare('SELECT COUNT(*) n FROM workbenches').get().n===0&&f.hits===0);check('snapshot stays pending while first probe is held',f.probe.snapshot().passed===false&&f.probe.snapshot().at===null);f.release();check('startup gate opens only after probes finish',(await running).passed===true);}finally{f.release();await f.close();}
}
{
 const f=await fixture({mcpBroken:true});try{const r=await f.start();check('MCP authentication regression fails named row',!r.passed&&r.failed.includes('market.mcp.initialize')&&r.failed.includes('market.mcp.tools-list'));check('failed probe never opens external gate',(await fetch('http://127.0.0.1:'+f.port+'/business')).status===503);}finally{await f.close();}
}
{
 const f=await fixture({writeBroken:true});try{const r=await f.start();check('missing browser-write guard fails even though invalid payload only returns400',!r.passed&&r.failed.includes('market.browser-workbench-write'));check('broken-guard negative case still creates no business objects',f.db.prepare('SELECT COUNT(*) n FROM workbenches').get().n===0);}finally{await f.close();}
}
{
 const f=await fixture({off:true});try{const r=await f.start();check('explicit gateway off warns exactly two MCP rows but enforces management guards',r.passed&&r.rows.filter(r=>r.verdict==='warn').length===2&&!f.requests.some(r=>r.path==='/mcp'));check('disabled control surface is explicitly skipped',r.rows.some(r=>r.id==='control.admin-read'&&r.verdict==='skip'));}finally{await f.close();}
}
{
 const f=await fixture({off:true,writeBroken:true});try{check('gateway off cannot disable the mandatory browser-write check',!(await f.start()).passed);}finally{await f.close();}
}
{
 const f=await fixture({hang:true});try{const r=await f.start();check('probe timeout fails closed without a false health pass',!r.passed&&r.failed.includes('market.mcp.initialize')&&r.rows.some(r=>r.reason==='timeout'));}finally{await f.close();}
}
{
 const f=await fixture({noChallenge:true});try{const r=await f.start();check('401 without Bearer challenge fails initialize contract',!r.passed&&r.failed.includes('market.mcp.initialize'));}finally{await f.close();}
}
{
 const f=await fixture({successWrite:true});try{const r=await f.start();check('unexpected 201 fails without accepting response content',!r.passed&&r.failed.includes('market.browser-workbench-write'));check('unexpected successful response body is never copied into audit',!JSON.stringify(f.logs).includes(noAuth)&&f.db.prepare('SELECT COUNT(*) n FROM workbenches').get().n===0);}finally{await f.close();}
}
{
 const f=await fixture();const stopped=createServer();try{const r=await f.probe.run({market:f.server,control:stopped,gatewayOn:true});check('unlistened control is explicitly skipped not authenticated',r.passed&&r.rows.some(x=>x.id==='control.admin-read'&&x.verdict==='skip'&&x.reason==='control-not-listening'));}finally{await f.close();}
}
{
 const f=await fixture({hold:true});try{const running=f.start();for(const method of ['GET','POST','OPTIONS']){const r=await fetch('http://127.0.0.1:'+f.port+'/api/workbenches',{method,headers:{Host:'remote.invalid','X-Forwarded-For':'192.0.2.55'}});check('closed startup gate blocks '+method+' with hostile host and forwarded metadata',r.status===503&&f.hits===0);}f.release();check('hostile ingress never changes fixed probe destination',(await running).passed&&f.requests.every(x=>x.headers.host==='127.0.0.1:'+f.port));}finally{f.release();await f.close();}
}
for(const nodeEnv of ['production',undefined,'','staging','development ','Production']){
 const f=await fixture({off:true,nodeEnv});try{const r=nodeEnv===undefined?await f.probe.run({market:f.server,gatewayOn:false}):await f.start();check('off is forbidden outside explicit dev/test: '+String(nodeEnv),!r.passed&&r.failed.includes('market.mcp.initialize')&&r.failed.includes('market.mcp.tools-list')&&r.rows.filter(x=>x.reason==='gateway-off-forbidden').length===2);check('forbidden off keeps ingress closed: '+String(nodeEnv),(await fetch('http://127.0.0.1:'+f.port+'/business')).status===503);}finally{await f.close();}
}
for(const nodeEnv of ['development','test']){
 const f=await fixture({off:true,nodeEnv});try{const r=await f.start();check('explicit local mode permits two off warnings: '+nodeEnv,r.passed&&r.rows.filter(x=>x.verdict==='warn').length===2);}finally{await f.close();}
}
console.log(JSON.stringify({checks,production_requests:0,personal_home_access:false}));
