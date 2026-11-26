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
const GATED=[['GET',/^\/api\/apps$/],['POST',/^\/api\/workbenches$/,'browser'],['GET',/^\/api\/principals$/],['GET',/^\/api\/local-accounts$/],['POST',/^\/api\/local-accounts\/[^/]+\/approve$/],['POST',/^\/api\/attention\/answer$/],['GET',/^\/api\/export$/],['POST',/^\/api\/areas$/],['GET',/^\/api\/apps\/[^/]+\/data$/],['GET',/^\/api\/workbenches\/[^/]+\/vars$/],['PUT',/^\/api\/sop\/runs\/[^/]+$/]];
async function fixture({personalTokenIssueBroken=false,reportDimCreateBroken=false,reportDimTemplateBroken=false,reportDimReadBroken=false,tasksBroken=false,deptWriteBroken=false,decisionCardBroken=false,ticketUploadBroken=false,ticketDownloadBroken=false,resultRefOpen=false,seatTokenBroken=false,accessBroken=false,mcpBroken=false,writeBroken=false,principalsBroken=false,localAccountsBroken=false,approveBroken=false,callbackBroken=false,eventBroken=false,exportBroken=false,creatorBroken=false,listBroken=false,arrangeBroken=false,uploadBroken=false,dueBroken=false,priorityBroken=false,seatReplyBroken=false,seatAskBroken=false,leadReleaseBroken=false,grantsBroken=false,grantApproveBroken=false,knowledgeBroken=false,areaCreateBroken=false,areaSpecBroken=false,areaReadBroken=false,areaAccessBroken=false,responsibilityBroken=false,knowledgeMapBroken=false,rememberBroken=false,teamReassignBroken=false,attentionBroken=false,appDataBroken=false,varsMissingBroken=false,runWriteBroken=false,hang=false,off=false,control=false,hold=false,noChallenge=false,successWrite=false,nodeEnv='test',cockpitBroken=false,gate=false}={}){
 const app=express(),logs=[],db=new DatabaseSync(':memory:');db.exec('CREATE TABLE workbenches(id INTEGER PRIMARY KEY,name TEXT)');let ordinaryHits=0;const requests=[];
 const probe=createStartupSecurityProbe({timeoutMs:hang?50:500,log:row=>logs.push(row)});app.use(probe.middleware);app.use(express.json());let release;const barrier=hold?new Promise(r=>release=r):Promise.resolve();
 const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 let controlServer;if(control){controlServer=createServer(app);await new Promise(r=>controlServer.listen(0,'127.0.0.1',r));}
 app.use((req,_res,next)=>{if(!isStartupProbeRequest(req))ordinaryHits++;requests.push({method:req.method,path:req.path,headers:req.headers,internal:isStartupProbeRequest(req)});next();});
 // gate: a synthetic login gate in front of the routes (WM_LOGIN_GATE=enforce); anonymous pages go to /login, the gated management reads/writes answer 401 before their own guard
 app.use((req,res,next)=>{if(!gate)return next();if(req.method==='GET'&&(req.path==='/'||req.path.startsWith('/apps/')))return res.redirect(302,'/login');if(GATED.some(([m,re,only])=>m===req.method&&re.test(req.path)&&(only!=='browser'||req.headers.origin)))return res.status(401).json({error:'login_required'});next();});
 app.post('/mcp',async(req,res)=>{await barrier;if(hang)return;if(!off&&!mcpBroken){res.status(401);if(!noChallenge)res.set('WWW-Authenticate','Bearer realm="synthetic"');return res.json({error:'denied'});}res.json({result:{}});});
 app.post('/api/workbenches',(req,res)=>{if(req.headers.origin&&successWrite)return res.status(201).json({error:noAuth});if(req.headers.origin&&!writeBroken)return res.status(403).end();if(!req.body?.name||!req.body?.url)return res.status(400).end();if(req.body.access!==undefined&&!accessBroken&&!['all','admin','listed'].includes(req.body.access))return res.status(400).end();if(/\.invalid\//.test(String(req.body.url)))return res.status(403).end();db.prepare('INSERT INTO workbenches(name) VALUES(?)').run(req.body.name);res.status(201).end();});
 app.get('/api/mcp/sessions',(_req,res)=>res.status(403).json({error:'denied'}));
 app.get('/api/work-items',(_req,res)=>listBroken?res.json({items:[],counts:{},total:0,next_cursor:null}):res.status(401).json({error:'work_items_auth_required'}));
 app.get('/api/tasks',(_req,res)=>tasksBroken?res.json({tasks:[{id:'market:synthetic',source:'market',title:'synthetic'}],sources:{}}):res.status(401).json({error:'tasks_auth_required'}));
 app.post('/api/work-items',(_req,res)=>arrangeBroken?res.status(201).json({item_id:'wi_x'}):res.status(401).json({error:'work_items_auth_required'}));
 app.put('/api/cockpits/:id',(_req,res)=>cockpitBroken?res.status(404).json({error:'cockpit not found'}):res.status(401).json({error:'cockpit_auth_required'}));
 app.put('/api/work-items/attachments/:name',(_req,res)=>uploadBroken?res.status(201).json({id:1}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/due',(_req,res)=>dueBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/priority',(_req,res)=>priorityBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/decision',(_req,res)=>creatorBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/release',(_req,res)=>leadReleaseBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/messages/:mid/reply',(_req,res)=>seatReplyBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.post('/api/work-items/:id/asks/:d/answer',(_req,res)=>seatAskBroken?res.status(200).json({ok:true}):res.status(401).json({error:'work_items_auth_required'}));
 app.get('/api/export',(req,res)=>req.query.reveal==='1'&&!exportBroken?res.status(403).json({error:'denied'}):res.json({masked:req.query.reveal==='1'?0:1,workbenches:[]}));
 app.get('/api/grants',(_req,res)=>grantsBroken?res.json({grants:[]}):res.status(401).json({error:'grants_auth_required'}));
 app.post('/api/grants/:id/approve',(_req,res)=>grantApproveBroken?res.status(404).json({error:'grant_missing'}):res.status(401).json({error:'grants_auth_required'}));
 app.delete('/api/departments/:id',(_req,res)=>deptWriteBroken?res.status(404).json({error:'department_missing'}):res.status(410).json({error:'department_write_closed'}));
 app.post('/api/areas',(_req,res)=>areaCreateBroken?res.status(201).json({area:{id:'wm-self-probe'}}):res.status(403).json({error:'denied'}));
 app.post('/api/areas/:id/specs',(_req,res)=>areaSpecBroken?res.status(404).json({error:'area_missing'}):res.status(401).json({error:'areas_auth_required'}));
 app.get('/api/areas',(_req,res)=>areaReadBroken?res.json({areas:[]}):res.status(401).json({error:'areas_auth_required'}));
 app.post('/api/areas/:id/access-requests/:requestId/approve',(_req,res)=>areaAccessBroken?res.status(404).json({error:'area_access_request_missing'}):res.status(401).json({error:'area_access_person_required'}));
 app.post('/api/mcp/responsibilities/:id/confirm',(_req,res)=>responsibilityBroken?res.status(404).end():res.status(401).end());
 app.post('/api/report-dimensions',(_req,res)=>reportDimCreateBroken?res.status(403).json({error:'denied'}):res.status(401).json({error:'report_dimensions_auth_required'}));
 app.post('/api/report-dimensions/:id/templates',(_req,res)=>reportDimTemplateBroken?res.status(404).json({error:'report_dimension_missing'}):res.status(401).json({error:'report_dimensions_auth_required'}));
 app.get('/api/report-dimensions',(_req,res)=>reportDimReadBroken?res.json({dimensions:[]}):res.status(401).json({error:'report_dimensions_auth_required'}));
 app.post('/api/bench-views/:bench/reports/:dimension/binding/stop',(_req,res)=>res.status(401).end());
 app.post('/api/report-governance/inbox/:id/confirm',(_req,res)=>res.status(401).end());
 app.post('/api/report-governance/proposals',(_req,res)=>res.status(403).end());
 app.get('/api/report-governance/review-invites/:id',(_req,res)=>res.status(401).end());
 app.get('/api/knowledge',(_req,res)=>knowledgeBroken?res.status(200).json({items:[],source:'ok'}):res.status(401).json({error:'login_required'}));
 app.put('/api/knowledge/project-depts',(_req,res)=>knowledgeMapBroken?res.status(403).json({error:'need admin'}):res.status(401).json({error:'login_required'}));
 app.post('/api/knowledge/remember',(_req,res)=>rememberBroken?res.status(403).json({error:'need admin'}):res.status(401).json({error:'login_required'}));
 app.post('/api/teams/reassign',(_req,res)=>teamReassignBroken?res.status(404).json({error:'seat_not_in_roster'}):res.status(401).json({error:'teams_auth_required'}));
 app.post('/api/attention/answer',(_req,res)=>attentionBroken?res.status(404).json({error:'attention_item_not_found'}):res.status(403).json({error:'denied'}));
 app.get('/api/apps/:slug/data',(_req,res)=>appDataBroken?res.json({items:[]}):res.status(403).json({error:'app_read_denied'}));
 app.get('/api/workbenches/:id/vars',(_req,res)=>varsMissingBroken?res.status(404).json({error:'workbench not found'}):res.status(403).json({error:'denied'}));
 app.put('/api/sop/runs/:id',(_req,res)=>runWriteBroken?res.status(404).json({error:'run not found'}):res.status(403).json({error:'run_write_denied'}));
 app.get('/api/principals',(_req,res)=>principalsBroken?res.json({principals:[{id:noAuth}]}):res.status(403).json({error:'denied'}));
 app.get('/api/local-accounts',(_req,res)=>localAccountsBroken?res.json({accounts:[{username:noAuth}]}):res.status(403).json({error:'denied'}));
 app.post('/api/local-accounts/:u/approve',(_req,res)=>approveBroken?res.json({account:{username:noAuth}}):res.status(403).json({error:'denied'}));
 app.post('/api/owner/personal-tokens',(_req,res)=>personalTokenIssueBroken?res.status(201).json({issued:true}):res.status(401).json({error:'personal_token_login_required'}));
 app.get('/login/feishu/callback',(_req,res)=>callbackBroken?res.redirect(302,'/work-items'):res.status(400).end());
 app.post('/login/feishu/events',(_req,res)=>eventBroken?res.status(200).json({}):res.status(401).end());
 app.post('/api/a2a/seat-token',(_req,res)=>seatTokenBroken?res.status(200).json({token:'0'.repeat(64)}):res.status(401).json({error:'seat_token_refused'}));
 app.post('/a2a/direct',(_req,res)=>decisionCardBroken?res.status(200).json({ok:true,status:'stored'}):res.status(401).json({ok:false,error:'untrusted-origin'}));
 app.put('/api/mcp-rest/uploads/:ticket',(_req,res)=>ticketUploadBroken?res.status(201).json({id:1,sha256:noAuth}):res.status(404).json({error:'ticket_missing'}));
 app.get('/api/mcp-rest/downloads/:ticket',(_req,res)=>ticketDownloadBroken?res.status(200).send(noAuth):res.status(404).json({error:'ticket_missing'}));
 app.get('/api/mcp-rest/results/:id',(_req,res)=>resultRefOpen?res.status(200).json({leaked:true}):res.status(401).json({error:'denied'}));
 app.post('/api/mcp-rest/capabilities/:target',(_req,res)=>res.status(401).end());
 app.post('/api/mcp-rest/tools/report_template_get',(_req,res)=>res.status(401).end());
 app.get('/api/health',(_req,res)=>res.json({self_probe:probe.snapshot()}));
 app.get('/business',(_req,res)=>res.json({ok:true}));
 return {probe,server,controlServer,port,logs,db,requests,get hits(){return ordinaryHits},release:()=>release?.(),start:()=>probe.run({market:server,control:controlServer,gatewayOn:!off,nodeEnv,loginGate:gate?'enforce':'off'}),close:async()=>{for(const s of [server,controlServer].filter(Boolean)){s.closeAllConnections();await new Promise(r=>s.close(r));}db.close();}};
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
 const rr=await fixture({resultRefOpen:true});try{const r=await rr.start();check('result-ref route that serves an anonymous request fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.mcp-rest.result-ref-anonymous');}finally{await rr.close();}
 const tu=await fixture({ticketUploadBroken:true});try{const r=await tu.start();check('upload-ticket route that accepts a forged ticket fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.mcp-rest.ticket-upload-forged');check('forged-ticket answer is never copied into audit and the gate stays closed',!JSON.stringify(tu.logs).includes(noAuth)&&(await fetch('http://127.0.0.1:'+tu.port+'/business')).status===503);}finally{await tu.close();}
 const td=await fixture({ticketDownloadBroken:true});try{const r=await td.start();check('download-ticket route that serves a forged ticket fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.mcp-rest.ticket-download-forged');check('forged download-ticket answer is never copied into audit',!JSON.stringify(td.logs).includes(noAuth));}finally{await td.close();}
 const f=await fixture({seatTokenBroken:true});try{const r=await f.start();check('seat-token endpoint that issues a token for a forged signature fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.a2a-seat-token.forged');}finally{await f.close();}
}
{
 const fp=await fixture({priorityBroken:true});try{const r=await fp.start();check('priority change that lets a remote anonymous browser edit work fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.priority-set-anonymous');}finally{await fp.close();}
}
{
 const f=await fixture({eventBroken:true});try{const r=await f.start();check('login event endpoint that accepts an unsigned event fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.login-flow.unsigned-event');}finally{await f.close();}
 { const fd=await fixture({decisionCardBroken:true});try{const r=await fd.start();check('decision-card branch that stores an unsigned card fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.a2a-decision-card.unsigned');}finally{await fd.close();} }
 const f2=await fixture({exportBroken:true});try{const r=await f2.start();check('export that reveals real values to a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.export.reveal-anonymous');}finally{await f2.close();}
 const f3=await fixture({creatorBroken:true});try{const r=await f3.start();check('creator decision entry that lets a remote anonymous browser decide fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.creator-decision-anonymous');}finally{await f3.close();}
 const f4=await fixture({seatReplyBroken:true});try{const r=await f4.start();check('seat message reply entry that lets a remote anonymous browser reply fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.seat-reply-anonymous');}finally{await f4.close();}
 const f4r=await fixture({leadReleaseBroken:true});try{const r=await f4r.start();check('lead release entry that lets a remote anonymous browser release fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.lead-release-anonymous');}finally{await f4r.close();}
 { const ft=await fixture({tasksBroken:true});try{const r=await ft.start();check('unified tasks readable by a remote anonymous caller fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.tasks.anonymous');}finally{await ft.close();} }
 // the row must run in every mode the server can boot in, not only the default one: gateway off (dev/test) and login gate on
 for(const [mode,opts] of [['gateway off',{off:true}],['login gate on',{gate:true}]]){
  { const f=await fixture(opts);try{const r=await f.start();const row=r.rows.find(x=>x.id==='market.tasks.anonymous');check('unified tasks row runs and passes with '+mode,r.passed&&row?.verdict==='pass'&&row.status===401);}finally{await f.close();} }
  { const f=await fixture({...opts,tasksBroken:true});try{const r=await f.start();check('with '+mode+' unified tasks readable by a remote anonymous caller fails only its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.tasks.anonymous');}finally{await f.close();} }
 }
 const fl=await fixture({listBroken:true});try{const r=await fl.start();check('work-item list readable by a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.list-anonymous');}finally{await fl.close();}
 const f5=await fixture({arrangeBroken:true});try{const r=await f5.start();check('arrange entry that lets a remote anonymous browser create work fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.arrange-anonymous');}finally{await f5.close();}
 const f6=await fixture({seatAskBroken:true});try{const r=await f6.start();check('seat ask answer entry that lets a remote anonymous browser answer fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.seat-ask-answer-anonymous');}finally{await f6.close();}
 const f5c=await fixture({cockpitBroken:true});try{const r=await f5c.start();check('cockpit write that lets a remote anonymous browser through (404 instead of 401) fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.cockpits.anonymous-write');}finally{await f5c.close();}
 const fu=await fixture({uploadBroken:true});try{const r=await fu.start();check('attachment upload that lets a remote anonymous browser store a file fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.attachment-upload-anonymous');}finally{await fu.close();}
 const fd=await fixture({dueBroken:true});try{const r=await fd.start();check('due date change that lets a remote anonymous browser edit work fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.work-items.due-set-anonymous');}finally{await fd.close();}
 const g=await fixture({grantsBroken:true});try{const r=await g.start();check('grant list readable by a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.grants.admin-read');}finally{await g.close();}
 const ga=await fixture({grantApproveBroken:true});try{const r=await ga.start();check('grant approve entry that answers a remote anonymous browser past the sign-in check fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.grants.approve-anonymous');}finally{await ga.close();}
 {const fx=await fixture({deptWriteBroken:true});try{const r=await fx.start();check('department write that the closed gate lets through (404 = it looked the department up) fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.departments.write-closed');}finally{await fx.close();}}
 for(const [flag,row,what] of [['areaCreateBroken','market.areas.anonymous-create','area creation that a remote anonymous browser gets past the write gate'],['areaSpecBroken','market.areas.anonymous-spec-set','area spec write that answers a remote anonymous browser past the sign-in check (even with 404)'],['areaReadBroken','market.areas.anonymous-read','area list that answers a remote anonymous browser'],['areaAccessBroken','market.area-access.anonymous-approve','area approval that looks up a request before checking the signed-in person'],['responsibilityBroken','market.mcp-responsibility.anonymous-confirm','responsibility confirmation that does not require an active natural person'],['reportDimCreateBroken','market.report-dimensions.anonymous-create','report dimension creation that a remote anonymous browser hits the admin write gate instead of the route sign-in (403, not 401)'],['reportDimTemplateBroken','market.report-dimensions.anonymous-template-add','report template publish that answers a remote anonymous browser past the sign-in check (even with 404)'],['reportDimReadBroken','market.report-dimensions.anonymous-read','report dimension list that answers a remote anonymous browser']]){const fx=await fixture({[flag]:true});try{const r=await fx.start();check(what+' fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]===row);}finally{await fx.close();}}
 const kn=await fixture({knowledgeBroken:true});try{const r=await kn.start();check('knowledge list that answers a remote anonymous browser past the sign-in check fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.knowledge.anonymous-read');}finally{await kn.close();}
 const knm=await fixture({knowledgeMapBroken:true});try{const r=await knm.start();check('knowledge project-department write that lets the admin write gate answer a remote anonymous browser (403 instead of 401) fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.knowledge.project-depts-anonymous-write');}finally{await knm.close();}
 const krm=await fixture({rememberBroken:true});try{const r=await krm.start();check('knowledge remember that lets the admin write gate answer a remote anonymous browser (403 instead of 401) fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.knowledge.remember-anonymous');}finally{await krm.close();}
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
 const la=await fixture({localAccountsBroken:true});try{const r=await la.start();check('local account list readable by a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.local-accounts.admin-read');check('leaked local account list is never copied into audit and the gate stays closed',!JSON.stringify(la.logs).includes(noAuth)&&(await fetch('http://127.0.0.1:'+la.port+'/business')).status===503);}finally{await la.close();}
 const pt=await fixture({personalTokenIssueBroken:true});try{const r=await pt.start();check('anonymous personal token issuance fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.owner-personal-token.anonymous-issue');}finally{await pt.close();}
 const ap=await fixture({approveBroken:true});try{const r=await ap.start();check('local account approval open to a remote anonymous browser fails its named row',!r.passed&&r.failed.length===1&&r.failed[0]==='market.local-accounts.approve-anonymous');check('leaked approval answer is never copied into audit and the gate stays closed',!JSON.stringify(ap.logs).includes(noAuth)&&(await fetch('http://127.0.0.1:'+ap.port+'/business')).status===503);}finally{await ap.close();}
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
 app.get('/api/local-accounts',(_req,res)=>res.status(403).end());
 app.post('/api/local-accounts/:u/approve',(_req,res)=>res.status(403).end());
 app.get('/api/export',(_req,res)=>res.status(403).end());
 app.get('/api/grants',(_req,res)=>res.status(401).end());
 app.post('/api/grants/:id/approve',(_req,res)=>res.status(401).end());
 app.get('/api/knowledge',(_req,res)=>res.status(401).end());
 app.put('/api/knowledge/project-depts',(_req,res)=>res.status(401).end());
 app.post('/api/knowledge/remember',(_req,res)=>res.status(401).end());
 app.post('/api/teams/reassign',(_req,res)=>res.status(401).end());
 app.post('/api/attention/answer',(_req,res)=>res.status(403).end());
 app.get('/api/apps/:slug/data',(_req,res)=>res.status(403).end());
 app.get('/api/workbenches/:id/vars',(_req,res)=>res.status(403).end());
 app.put('/api/sop/runs/:id',(_req,res)=>res.status(403).end());
 app.get('/login/feishu/callback',(_req,res)=>res.status(400).end());
 app.post('/login/feishu/events',(_req,res)=>res.status(401).end());
 app.post('/api/a2a/seat-token',(_req,res)=>res.status(401).end());
 app.post('/a2a/direct',(_req,res)=>res.status(401).end());
 app.put('/api/mcp-rest/uploads/:ticket',(_req,res)=>res.status(404).end());
 app.get('/api/mcp-rest/downloads/:ticket',(_req,res)=>res.status(404).end());
 app.get('/api/mcp-rest/results/:id',(_req,res)=>res.status(401).end());
 app.post('/api/mcp-rest/capabilities/:target',(_req,res)=>res.status(401).end());
 app.post('/api/mcp-rest/tools/report_template_get',(_req,res)=>res.status(401).end());
 app.get('/api/work-items',(_req,res)=>res.status(401).end());
 app.get('/api/tasks',(_req,res)=>res.status(401).end());
 app.post('/api/work-items',(_req,res)=>res.status(401).end());
 app.put('/api/cockpits/:id',(_req,res)=>res.status(401).end());
 app.put('/api/work-items/attachments/:name',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/due',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/priority',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/decision',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/messages/:mid/reply',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/release',(_req,res)=>res.status(401).end());
 app.post('/api/work-items/:id/asks/:d/answer',(_req,res)=>res.status(401).end());
 app.delete('/api/departments/:id',(_req,res)=>res.status(410).end());
 app.post('/api/areas',(_req,res)=>res.status(403).end());
 app.post('/api/areas/:id/specs',(_req,res)=>res.status(401).end());
 app.get('/api/areas',(_req,res)=>res.status(401).end());
 app.post('/api/areas/:id/access-requests/:requestId/approve',(_req,res)=>res.status(401).end());
 app.post('/api/mcp/responsibilities/:id/confirm',(_req,res)=>res.status(401).end());
 app.post('/api/owner/personal-tokens',(_req,res)=>res.status(401).end());
 app.post('/api/report-dimensions',(_req,res)=>res.status(401).end());
 app.post('/api/report-dimensions/:id/templates',(_req,res)=>res.status(401).end());
 app.get('/api/report-dimensions',(_req,res)=>res.status(401).end());
 app.post('/api/bench-views/:bench/reports/:dimension/binding/stop',(_req,res)=>res.status(401).end());
 app.post('/api/report-governance/inbox/:id/confirm',(_req,res)=>res.status(401).end());
 app.post('/api/report-governance/proposals',(_req,res)=>res.status(403).end());
 app.get('/api/report-governance/review-invites/:id',(_req,res)=>res.status(401).end());
 const server=createServer(app);const running=probe.run({market:server,gatewayOn:true,nodeEnv:'test'});
 await new Promise(r=>setTimeout(r,900));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await running;check('market surface that starts listening after the request timeout still passes',r.passed===true&&r.rows.some(x=>x.surface==='market')&&r.rows.filter(x=>x.surface==='market').every(x=>x.verdict==='pass'));}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
{
 const app=express(),probe=createStartupSecurityProbe({timeoutMs:50,log:()=>{}});const server=createServer(app);
 const t0=Date.now(),r=await probe.run({market:server,gatewayOn:true,nodeEnv:'test'});
 check('a market surface that never listens still fails closed (bounded wait)',r.passed===false&&r.rows.some(x=>x.surface==='market')&&r.rows.filter(x=>x.surface==='market').every(x=>x.reason==='surface-not-listening')&&Date.now()-t0<15000);
}
{
 // The actual session_id strip is exercised by the real-index positive/mutation test; this fixture stays memory-only.
 const f=await fixture();try{const r=await f.probe.run({market:f.server,gatewayOn:true,nodeEnv:'test',portalSessionStrip:()=>({ok:true,reason:null})});check('portal session_id strip check is a named local startup row',r.passed&&r.rows.filter(x=>x.id==='market.portal.session-id-stripped').length===1&&r.rows.find(x=>x.id==='market.portal.session-id-stripped').verdict==='pass'&&!f.requests.some(x=>x.path.startsWith('/go/')));}finally{await f.close();}
 for(const callback of[()=>({ok:false,reason:noAuth}),()=>{throw Error(noAuth)}]){const f=await fixture();try{const r=await f.probe.run({market:f.server,gatewayOn:true,nodeEnv:'test',portalSessionStrip:callback});check('failed or throwing session_id strip check keeps ingress closed and exposes only a fixed reason',!r.passed&&r.failed.length===1&&r.failed[0]==='market.portal.session-id-stripped'&&r.rows.find(x=>x.id==='market.portal.session-id-stripped').reason==='session-id-forwarded'&&!JSON.stringify(f.logs).includes(noAuth)&&(await fetch('http://127.0.0.1:'+f.port+'/business')).status===503);}finally{await f.close();}}
 // 只增表（留痕）的触发器：一行本地检查 market.db.append-only-guarded，通过照常开门；不通过照传检查给的代号（缺了哪条触发器、覆盖被接受），抛错只记 error、不带原话
 {const f=await fixture();try{const r=await f.probe.run({market:f.server,gatewayOn:true,nodeEnv:'test',appendOnly:()=>({ok:true,reason:null})});const row=r.rows.find(x=>x.id==='market.db.append-only-guarded');check('append-only trigger check is a named local startup row and passes',r.passed&&r.rows.filter(x=>x.id==='market.db.append-only-guarded').length===1&&row.verdict==='pass'&&row.method==='LOCAL'&&row.reason===null);}finally{await f.close();}}
 {const f=await fixture();try{const r=await f.probe.run({market:f.server,gatewayOn:true,nodeEnv:'test',appendOnly:()=>({ok:false,reason:'missing:wbe_log_no_replace'})});check('missing append-only trigger keeps ingress closed and names the missing trigger',!r.passed&&r.failed.length===1&&r.failed[0]==='market.db.append-only-guarded'&&r.rows.find(x=>x.id==='market.db.append-only-guarded').reason==='missing:wbe_log_no_replace'&&(await fetch('http://127.0.0.1:'+f.port+'/business')).status===503);}finally{await f.close();}}
 {const f=await fixture();try{const r=await f.probe.run({market:f.server,gatewayOn:true,nodeEnv:'test',appendOnly:()=>({ok:true,warn:true,reason:'write-test-skipped:busy'})});const row=r.rows.find(x=>x.id==='market.db.append-only-guarded');check('append-only write test that could not run (db busy) is a warn row and does not block startup',r.passed&&row.verdict==='warn'&&row.reason==='write-test-skipped:busy'&&(await fetch('http://127.0.0.1:'+f.port+'/business')).status!==503);}finally{await f.close();}}
 {const f=await fixture();try{const r=await f.probe.run({market:f.server,gatewayOn:true,nodeEnv:'test',appendOnly:()=>{throw Error(noAuth)}});check('throwing append-only check keeps ingress closed with a fixed reason and no raw error in logs',!r.passed&&r.failed[0]==='market.db.append-only-guarded'&&r.rows.find(x=>x.id==='market.db.append-only-guarded').reason==='error'&&!JSON.stringify(f.logs).includes(noAuth)&&(await fetch('http://127.0.0.1:'+f.port+'/business')).status===503);}finally{await f.close();}}
}
{const f=await fixture({accessBroken:true});try{const r=await f.start();check('access policy validation cannot be bypassed by URL rejection and writes no business row',!r.passed&&r.failed.includes('market.workbench-access-validate')&&f.db.prepare('SELECT COUNT(*) n FROM workbenches').get().n===0);}finally{await f.close();}}
console.log(JSON.stringify({checks,production_requests:0,personal_home_access:false}));
