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
async function fixture({mcpBroken=false,writeBroken=false,principalsBroken=false,callbackBroken=false,eventBroken=false,exportBroken=false,creatorBroken=false,listBroken=false,arrangeBroken=false,seatReplyBroken=false,seatAskBroken=false,leadReleaseBroken=false,grantsBroken=false,grantApproveBroken=false,teamReassignBroken=false,attentionBroken=false,appDataBroken=false,varsMissingBroken=false,runWriteBroken=false,hang=false,off=false,control=false,hold=false,noChallenge=false,successWrite=false,nodeEnv='test'}={}){
 const app=express(),logs=[],db=new DatabaseSync(':memory:');db.exec('CREATE TABLE workbenches(id INTEGER PRIMARY KEY,name TEXT)');let ordinaryHits=0;const requests=[];
 const probe=createStartupSecurityProbe({timeoutMs:hang?50:500,log:row=>logs.push(row)});app.use(probe.middleware);app.use(express.json());let release;const barrier=hold?new Promise(r=>release=r):Promise.resolve();
 const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 let controlServer;if(control){controlServer=createServer(app);await new Promise(r=>controlServer.listen(0,'127.0.0.1',r));}
 app.use((req,_res,next)=>{if(!isStartupProbeRequest(req))ordinaryHits++;requests.push({method:req.method,path:req.path,headers:req.headers,internal:isStartupProbeRequest(req)});next();});
 app.post('/mcp',async(req,res)=>{await barrier;if(hang)return;if(!off&&!mcpBroken){res.status(401);if(!noChallenge)res.set('WWW-Authenticate','Bearer realm="synthetic"');return res.json({error:'denied'});}res.json({result:{}});});
 app.post('/api/workbenches',(req,res)=>{if(req.headers.origin&&successWrite)return res.status(201).json({error:noAuth});if(req.headers.origin&&!writeBroken)return res.status(403).end();if(!req.body?.name||!req.body?.url)return res.status(400).end();db.prepare('INSERT INTO workbenches(name) VALUES(?)').run(req.body.name);res.status(201).end();});
 app.get('/api/mcp/sessions',(_req,res)=>res.status(403).json({error:'denied'}));
 app.get('/api/work-items',(_req,res)=>listBroken?res.json({items:[],counts:{},total:0,next_cursor:null}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items',(_req,res)=>arrangeBroken?res.status(201).json({item_id:'wi_x'}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/decision',(_req,res)=>creatorBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/release',(_req,res)=>leadReleaseBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/messages/:mid/reply',(_req,res)=>seatReplyBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/asks/:d/answer',(_req,res)=>seatAskBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.get('/api/export',(req,res)=>req.query.reveal==='1'&&!exportBroken?res.status(403).json({error:'denied'}):res.json({masked:req.query.reveal==='1'?0:1,workbenches:[]}));
 app.get('/api/grants',(_req,res)=>grantsBroken?res.json({grants:[]}):res.status(401).json({error:'grants_auth_required'}));
 app.post('/api/grants/:id/approve',(_req,res)=>grantApproveBroken?res.status(404).json({error:'grant_missing'}):res.status(401).json({error:'grants_auth_required'}));
 app.post('/api/teams/reassign',(_req,res)=>teamReassignBroken?res.status(404).json({error:'seat_not_in_roster'}):res.status(401).json({error:'teams_auth_required'}));
 app.post('/api/attention/answer',(_req,res)=>attentionBroken?res.status(404).json({error:'attention_item_not_found'}):res.status(403).json({error:'denied'}));
 app.get('/api/apps/:slug/data',(_req,res)=>appDataBroken?res.json({items:[]}):res.status(403).json({error:'app_read_denied'}));
 app.get('/api/workbenches/:id/vars',(_req,res)=>varsMissingBroken?res.status(404).json({error:'workbench not found'}):res.status(403).json({error:'denied'}));
 app.put('/api/sop/runs/:id',(_req,res)=>runWriteBroken?res.status(404).json({error:'run not found'}):res.status(403).json({error:'run_write_denied'}));
 app.get('/api/principals',(_req,res)=>principalsBroken?res.json({principals:[{id:noAuth}]}):res.status(403).json({error:'denied'}));
 app.get('/login/feishu/callback',(_req,res)=>callbackBroken?res.redirect(302,'/tasks'):res.status(400).end());
 app.post('/login/feishu/events',(_req,res)=>eventBroken?res.status(200).json({}):res.status(401).end());
 app.get('/api/health',(_req,res)=>res.json({self_probe:probe.snapshot()}));
 app.get('/business',(_req,res)=>res.json({ok:true}));
 return {probe,server,controlServer,port,logs,db,requests,get hits(){return ordinaryHits},release:()=>release?.(),start:()=>probe.run({market:server,control:controlServer,gatewayOn:!off,nodeEnv}),close:async()=>{for(const s of [server,controlServer].filter(Boolean)){s.closeAllConnections();await new Promise(r=>s.close(r));}db.close();}};
}
{
 const f=await fixture({control:true});try{const initial=await(await fetch('http://127.0.0.1:'+f.port+'/api/health')).json();check('pending health does not claim pass',initial.self_probe.passed===false&&initial.self_probe.at===null);const result=await f.start();check('normal surfaces pass all enforced table rows',result.passed===true&&result.failed.length===0&&result.rows.length>0&&result.rows.every(r=>r.verdict==='pass'));check('all probe requests use actual loopback surface ports and fixed paths',f.requests.length===result.rows.length&&f.requests.every(r=>result.rows.some(x=>x.path.split('?')[0]===r.path)&&r.internal));check('write refusal probes and no-Origin contrast write zero rows',f.db.prepare('SELECT COUNT(*) n FROM workbenches').get().n===0);check('anonymous probes send no credentials or business args',f.requests.every(r=>!r.headers.authorization&&!r.headers.cookie&&!r.headers['x-admin-token']));check('per-row audit is self-probe and never contains private marker or payload',f.logs.length===result.rows.length&&f.logs.every(r=>r.source==='self-probe')&&!JSON.stringify(f.logs).includes(noAuth)&&!JSON.stringify(f.logs).includes('x-wm-self-probe'));check('ready service accepts ordinary traffic',(await fetch('http://127.0.0.1:'+f.port+'/business')).status===200);}finally{await f.close();}
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
 const f=await fixture({eventBroken:true});try{const r=await f.start();check('login event endpoint that accepts an unsigned event fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.login-flow.unsigned-event');}finally{await f.close();}
 const f2=await fixture({exportBroken:true});try{const r=await f2.start();check('export that reveals real values to a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.export.reveal-anonymous');}finally{await f2.close();}
 const f3=await fixture({creatorBroken:true});try{const r=await f3.start();check('creator decision entry that lets a remote anonymous browser decide fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.creator-decision-anonymous');}finally{await f3.close();}
 const f4=await fixture({seatReplyBroken:true});try{const r=await f4.start();check('seat message reply entry that lets a remote anonymous browser reply fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.seat-reply-anonymous');}finally{await f4.close();}
 const f4r=await fixture({leadReleaseBroken:true});try{const r=await f4r.start();check('lead release entry that lets a remote anonymous browser release fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.lead-release-anonymous');}finally{await f4r.close();}
 const fl=await fixture({listBroken:true});try{const r=await fl.start();check('work-item list readable by a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.list-anonymous');}finally{await fl.close();}
 const f5=await fixture({arrangeBroken:true});try{const r=await f5.start();check('arrange entry that lets a remote anonymous browser create work fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.arrange-anonymous');}finally{await f5.close();}
 const f6=await fixture({seatAskBroken:true});try{const r=await f6.start();check('seat ask answer entry that lets a remote anonymous browser answer fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.seat-ask-answer-anonymous');}finally{await f6.close();}
 const g=await fixture({grantsBroken:true});try{const r=await g.start();check('grant list readable by a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.grants.admin-read');}finally{await g.close();}
 const ga=await fixture({grantApproveBroken:true});try{const r=await ga.start();check('grant approve entry that answers a remote anonymous browser past the sign-in check fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.grants.approve-anonymous');}finally{await ga.close();}
 const tr=await fixture({teamReassignBroken:true});try{const r=await tr.start();check('team reassign entry that answers a remote anonymous browser past the sign-in check fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.teams.reassign-anonymous');}finally{await tr.close();}
 const at=await fixture({attentionBroken:true});try{const r=await at.start();check('attention answer entry that lets a remote anonymous browser past the write gate fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.attention.answer-anonymous');}finally{await at.close();}
 const aw=await fixture({appDataBroken:true});try{const r=await aw.probe.run({market:aw.server,control:aw.controlServer,gatewayOn:true,nodeEnv:'test',appDataRead:'warn'});check('WM_APP_DATA_READ=warn (rollout) skips the app data row instead of refusing startup',r.passed===true&&!r.rows.some(x=>x.id==='market.app-data.anonymous-read'));}finally{await aw.close();}
 const vm=await fixture({varsMissingBroken:true});try{const r=await vm.start();check('workbench vars that answer 404 for a missing bench before checking the caller fail their named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.workbench-vars.anonymous-read-missing');}finally{await vm.close();}
 const ad=await fixture({appDataBroken:true});try{const r=await ad.start();check('app data readable by a remote anonymous request without the app token fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.app-data.anonymous-read');}finally{await ad.close();}
 const rw=await fixture({runWriteBroken:true});try{const r=await rw.start();check('run writable by a remote anonymous request without the run credential fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.sop-run.anonymous-write');}finally{await rw.close();}
 const rww=await fixture({runWriteBroken:true});try{const r=await rww.probe.run({market:rww.server,control:rww.controlServer,gatewayOn:true,nodeEnv:'test',sopRunWrite:'warn'});check('WM_SOP_RUN_WRITE=warn (rollout) skips the run write row instead of refusing startup',r.passed===true&&!r.rows.some(x=>x.id==='market.sop-run.anonymous-write'));}finally{await rww.close();}
}
{
 const f=await fixture({callbackBroken:true});try{const r=await f.start();check('login callback that redirects on a forged state fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.login-flow.forged-callback');}finally{await f.close();}
}
{
 const f=await fixture({principalsBroken:true});try{const r=await f.start();check('principal list readable by a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.principals.admin-read');check('leaked principal list is never copied into audit and the gate stays closed',!JSON.stringify(f.logs).includes(noAuth)&&(await fetch('http://127.0.0.1:'+f.port+'/business')).status===503);}finally{await f.close();}
}
{
 const f=await fixture();try{const r=await f.start();const q=f.requests.find(x=>x.path==='/api/principals');check('principal row impersonates a remote anonymous browser and passes on 403',r.passed&&r.rows.some(x=>x.id==='market.principals.admin-read'&&x.verdict==='pass'&&x.status===403)&&q?.headers['x-forwarded-for']==='192.0.2.1'&&!q.headers.cookie&&!q.headers['x-admin-token']);}finally{await f.close();}
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
{
 // 启动慢：market 面在请求超时（500ms）之后才开始监听，等监听不能套用请求超时，否则四项一起误判 surface-not-listening
 const app=express(),probe=createStartupSecurityProbe({timeoutMs:500,log:()=>{}});app.use(probe.middleware);app.use(express.json());
 app.post('/mcp',(_req,res)=>res.status(401).set('WWW-Authenticate','Bearer realm="synthetic"').json({error:'denied'}));
 app.post('/api/workbenches',(req,res)=>res.status(req.headers.origin?403:400).end());
 app.get('/api/principals',(_req,res)=>res.status(403).end());
 app.get('/api/export',(_req,res)=>res.status(403).end());
 app.get('/api/grants',(_req,res)=>res.status(401).end());
 app.post('/api/grants/:id/approve',(_req,res)=>res.status(401).end());
 app.post('/api/teams/reassign',(_req,res)=>res.status(401).end());
 app.post('/api/attention/answer',(_req,res)=>res.status(403).end());
 app.get('/api/apps/:slug/data',(_req,res)=>res.status(403).end());
 app.get('/api/workbenches/:id/vars',(_req,res)=>res.status(403).end());
 app.put('/api/sop/runs/:id',(_req,res)=>res.status(403).end());
 app.get('/login/feishu/callback',(_req,res)=>res.status(400).end());
 app.post('/login/feishu/events',(_req,res)=>res.status(401).end());
 app.get('/api/work-items',(_req,res)=>res.status(401).end());
 app.post('/api/work-items',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/decision',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/messages/:mid/reply',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/release',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/asks/:d/answer',(_req,res)=>res.status(401).end());
 const server=createServer(app);const running=probe.run({market:server,gatewayOn:true,nodeEnv:'test'});
 await new Promise(r=>setTimeout(r,900));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await running;check('market surface that starts listening after the request timeout still passes',r.passed===true&&r.rows.some(x=>x.surface==='market')&&r.rows.filter(x=>x.surface==='market').every(x=>x.verdict==='pass'));}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
{
 const app=express(),probe=createStartupSecurityProbe({timeoutMs:50,log:()=>{}});const server=createServer(app);
 const t0=Date.now(),r=await probe.run({market:server,gatewayOn:true,nodeEnv:'test'});
 check('a market surface that never listens still fails closed (bounded wait)',r.passed===false&&r.rows.some(x=>x.surface==='market')&&r.rows.filter(x=>x.surface==='market').every(x=>x.reason==='surface-not-listening')&&Date.now()-t0<15000);
}
console.log(JSON.stringify({checks,production_requests:0,personal_home_access:false}));
