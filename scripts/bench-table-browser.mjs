#!/usr/bin/env node
/** Real backend + real browser synthetic native-table flow. Existing identity fixture, no page.route business mocks. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { spawn as spawnProcess } from 'node:child_process';
import { pythonBin } from './python-bin.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';
import { instanceStartError, startWithEnvironmentRetry } from './lib/self-probe-env.mjs';
const ROOT=resolve('.'),httpOnly=process.argv.includes('--http-only');if(!httpOnly&&!existsSync(join(ROOT,'web/dist/index.html')))throw Error('先构建现有web产物');
mkdirSync('tmp',{recursive:true});const OUT=mkdtempSync(resolve('tmp/bench-table-browser-'));
const token='synthetic-table-admin';let child,log='',base='',python;
const messages=[],waiters=[];
const onMessage=message=>{const i=waiters.findIndex(w=>w.kind===message?.kind);if(i<0)messages.push(message);else waiters.splice(i,1)[0].resolve(message);};
const waitFor=kind=>{const i=messages.findIndex(m=>m?.kind===kind);if(i>=0)return Promise.resolve(messages.splice(i,1)[0]);return new Promise((resolve,reject)=>{const waiter={kind,resolve:m=>{clearTimeout(timer);resolve(m);}},timer=setTimeout(()=>{const n=waiters.indexOf(waiter);if(n>=0)waiters.splice(n,1);reject(Error('test publication barrier did not reach '+kind));},15000);waiters.push(waiter);});};
const arm=async(method,mode)=>{const ready=waitFor('table-test-armed');child.send({kind:'table-test-arm',method,mode});await ready;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stop=async p=>{if(!p||p.exitCode!==null||p.signalCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),sleep(3000)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await new Promise(r=>p.once('exit',r));}};
const request=async(method,path,{body,raw,session,headers={}}={})=>{const h={...headers};if(session)h.cookie=`session_id=${session}`;if(body!==undefined||raw!==undefined)h['content-type']='application/json';const r=await fetch(base+path,{method,headers:h,body:raw??(body===undefined?undefined:JSON.stringify(body)),signal:AbortSignal.timeout(60000),redirect:'manual'});const text=await r.text();let json=null;try{json=JSON.parse(text)}catch{}return{status:r.status,text,json,headers:Object.fromEntries(r.headers)}};
try{
 await startWithEnvironmentRetry(async i=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));base=`http://127.0.0.1:${port}`;
  const home=join(OUT,'home-'+i),data=join(OUT,'data-'+i),ext=join(OUT,'ext-'+i);for(const d of[home,data,ext])mkdirSync(d,{recursive:true});
  const env={};for(const k of['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];Object.assign(env,{HOME:home,PORT:String(port),DATA_DIR:data,NODE_ENV:'test',MCP_GATEWAY:'off',ADMIN_TOKEN:token,REDIS_URL:'',WM_CONTROL_PORT:'0',WM_EXTENSIONS_DIR:ext,IDENTITY_SEAM_ROOT:ROOT,IDENTITY_FAKE_ADMIN_GRANT:'admin',WM_BENCH_VIEWS:'on'});
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',pathToFileURL(join(ROOT,'scripts/identity-fake-preload.mjs')).href,'--import',pathToFileURL(join(ROOT,'scripts/fixtures/bench-table-publication-preload.mjs')).href,'server/src/index.ts'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});child.on('message',onMessage);child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const end=Date.now()+60000;
  while(Date.now()<end&&child.exitCode===null){try{if((await fetch(base+'/api/health')).status===200)return}catch{}await sleep(200)}await stop(child);throw instanceStartError('table fixture failed to listen',log);
 },{label:'native-table synthetic'});
 const admin={headers:{'x-admin-token':token}},manager={session:SESSIONS.alpha,headers:{origin:base,'sec-fetch-site':'same-origin'}};
 for(const session of[SESSIONS.alpha,SESSIONS.beta])assert.equal((await request('GET','/api/auth/viewer',{session})).status,200);
 const grant=await request('POST','/api/grants',{body:{principal:'user:alpha',role:'management',scope:'*',reason:'synthetic table'}});assert.equal((await request('POST',`/api/grants/${grant.json.grant.id}/submit`)).status,200);assert.equal((await request('POST',`/api/grants/${grant.json.grant.id}/approve`)).status,200);
 assert.equal((await request('POST','/api/bench-views',{...manager,body:{slug:'table-demo',title:'合成收货'}})).status,201);
 const card=await request('POST','/api/workbenches',{body:{name:'合成收货',url:'http://127.0.0.1:9/',type:'web'}});assert.equal(card.status,201);assert.equal((await request('PUT','/api/bench-views/table-demo/workbench',{...manager,body:{workbench_id:card.json.id,note:'synthetic'}})).status,200);
 const cols=[{name:'id',type:'integer',label:'编号'},{name:'batch',type:'text',label:'批次'},{name:'source_version',type:'text',label:'来源版本'},{name:'sku',type:'text',label:'商品'},{name:'warehouse',type:'text',label:'仓库'},{name:'qty',type:'decimal',label:'数量'},{name:'source_row',type:'text',label:'来源原行'},{name:'formula',type:'text',label:'来源公式'}];
 const B='/api/bench-views/table-demo';assert.equal((await request('PUT',B+'/datasets/receipts',{...manager,body:{title:'收货',key:['id'],columns:cols}})).status,200);
 const rows=Array.from({length:4833},(_,i)=>({id:i+1,batch:'frozen',source_version:'v68',sku:i<1650?'Sample Cup':'其他',warehouse:i<1650?'TestWest':'Other',qty:i+1,source_row:'SheetA!'+(i+2),formula:i===0?'=SUM(A1:A2)':'原值'}));
 assert.equal((await request('POST',B+'/datasets/receipts/rows?op=replace',{...manager,raw:JSON.stringify([...rows,{...rows[0],id:9000,batch:'other'}])})).status,200);
 const filter=[{col:'batch',op:'=',value:'frozen'},{col:'source_version',op:'=',value:'v68'},{col:'sku',op:'contains',value:'$sku'},{col:'warehouse',op:'contains',value:'$warehouse'}];
 const doc={title:'合成收货',views:[{key:'receipts',title:'收货',blocks:[{type:'filter-bar',fields:[{name:'sku',kind:'search',label:'商品'},{name:'warehouse',kind:'search',label:'仓库'}]},{type:'table',title:'收货记录',query:{dataset:'receipts',select:['id','batch','source_version','sku','warehouse','qty'],filter,sort:[{col:'id'}],limit:50},page_size:50}]}]};assert.equal((await request('PUT',B+'/view',{...manager,body:{doc,base:0,note:'synthetic'}})).status,200);
 const rendered=await request('GET',B+'/render?view=receipts',manager);assert.equal(rendered.status,200);const target=rendered.json.blocks[1].table_context;assert.ok(target);
 for(const endpoint of['table/export','table/row']){
  const body=endpoint.endsWith('row')?{target,index:0,row:rendered.json.blocks[1].data.rows[0]}:target;
  assert.equal((await request('POST',B+'/'+endpoint,{body,headers:{'x-forwarded-for':'192.0.2.61',origin:base,'sec-fetch-site':'same-origin'}})).status,401);
  assert.equal((await request('POST',B+'/'+endpoint,{body,session:SESSIONS.beta,headers:{'x-forwarded-for':'192.0.2.61',origin:base,'sec-fetch-site':'same-origin'}})).status,403);
  assert.equal((await request('POST',B+'/'+endpoint,{body,session:SESSIONS.alpha,headers:{origin:'https://attacker.invalid','sec-fetch-site':'cross-site'}})).status,403);
 }console.log('PASS anonymous/unauthorized/cross-origin export+row endpoints refuse');
 // Independent render/query roles: an authorized result is not authority to request raw fields.
 const reader={session:SESSIONS.beta,headers:{origin:base,'sec-fetch-site':'same-origin'}};
 const grantRole=async role=>{const r=await request('POST','/api/grants',{body:{principal:'user:beta',role,scope:'*',reason:'synthetic table publication'}});assert.equal(r.status,201);const id=r.json.grant.id;assert.equal((await request('POST','/api/grants/'+id+'/submit')).status,200);assert.equal((await request('POST','/api/grants/'+id+'/approve')).status,200);return id;};
 for(const [id,action]of[['table-result-reader','bench-store.render'],['table-original-reader','bench-store.query']]){
  assert.equal((await request('POST','/api/roles/guest/copy',{body:{id,name:id}})).status,201);
  assert.equal((await request('PUT','/api/roles/'+id,{body:{permissions:[{actions:[action]}]}})).status,200);
 }
 const renderGrant=await grantRole('table-result-reader'),detailBody={target,index:0,row:rendered.json.blocks[1].data.rows[0]};
 const noOriginal=detail=>{assert.equal(detail.status,200);assert.equal(detail.json.source_status,'forbidden');assert.equal(detail.json.source_row,null);assert.deepEqual(detail.json.source_rows,[]);assert.deepEqual(detail.json.source_columns,[]);assert.equal(detail.json.source_truncated,false);assert.deepEqual(detail.json.row,detailBody.row);for(const raw of['SheetA!','=SUM(A1:A2)','source_row','formula'])assert.ok(!JSON.stringify({columns:detail.json.source_columns,row:detail.json.source_row,rows:detail.json.source_rows}).includes(raw));assert.ok(!detail.text.includes('SheetA!')&&!detail.text.includes('=SUM(A1:A2)'));};
 await arm('tableRow','observe');const observed=waitFor('table-test-observed'),onlyResult=await request('POST',B+'/table/row',{...reader,body:detailBody}),observation=await observed;
 assert.equal(observation.originalRequested,false,'render-only caller must not cause the real worker to read original fields');assert.equal(observation.originalRows,0);noOriginal(onlyResult);
 console.log('PASS render-only route never requests original fields; response explicitly strips all original data');
 const queryGrant=await grantRole('table-original-reader');
 const allowed=await request('POST',B+'/table/row',{...reader,body:detailBody});assert.equal(allowed.status,200);assert.equal(allowed.json.source_status,'original-row');assert.equal(allowed.json.source_row.source_row,'SheetA!2');
 await arm('tableRow','hold');const heldRow=waitFor('table-test-held'),pendingRow=request('POST',B+'/table/row',{...reader,body:detailBody});const rowRead=await heldRow;
 assert.equal(rowRead.originalRequested,true);assert.equal(rowRead.originalRows,1);let removed;
 try{removed=await request('POST','/api/grants/'+queryGrant+'/revoke',{body:{reason:'synthetic query revoke after real read'}});}finally{child.send({kind:'table-test-release'});}
 const afterQueryRevoke=await pendingRow;assert.equal(removed.status,200);noOriginal(afterQueryRevoke);
 console.log('PASS query grant revoked after real read strips original response while render remains authorized');
 const publishedOnly=await request('POST',B+'/table/export',{...reader,body:target});assert.equal(publishedOnly.status,200);assert.equal(publishedOnly.headers['x-row-count'],'4833');assert.ok(!publishedOnly.text.includes('SheetA!')&&!publishedOnly.text.includes('=SUM(A1:A2)'));
 await arm('tableExport','hold');const heldExport=waitFor('table-test-held'),pendingExport=request('POST',B+'/table/export',{...reader,body:target});await heldExport;
 try{removed=await request('POST','/api/grants/'+renderGrant+'/revoke',{body:{reason:'synthetic render revoke after full export read'}});}finally{child.send({kind:'table-test-release'});}
 const afterReadRevoke=await pendingExport;assert.equal(removed.status,200);assert.equal(afterReadRevoke.status,403,'revoked reader must not receive a previously completed CSV');assert.ok(!afterReadRevoke.headers['content-disposition']);assert.ok(!afterReadRevoke.text.includes('frozen'));assert.equal(afterReadRevoke.headers['cache-control'],'private, no-store');
 const unchanged=await request('POST',B+'/table/export',{...manager,body:target});assert.equal(unchanged.status,200);assert.equal(unchanged.headers['x-row-count'],'4833');
 console.log('PASS export completed before revocation is not published; unrevoked control still reads same context');
 if(!httpOnly){
  const cfg=join(OUT,'browser.json');writeFileSync(cfg,JSON.stringify({base,card:card.json.id,session:SESSIONS.alpha,out:OUT}));
  python=spawnProcess(pythonBin(),['scripts/bench-table-browser.py',cfg],{cwd:ROOT,stdio:'inherit'});const code=await new Promise((r,j)=>{python.once('error',j);python.once('exit',r)});if(code!==0)throw Error('native table browser failed');
 }else console.log('HTTP-only requested: real browser download NOT_RUN; default CI command still includes it');
 const revoke=await request('POST',`/api/grants/${grant.json.grant.id}/revoke`,{body:{reason:'synthetic access revocation'}});assert.equal(revoke.status,200);assert.equal((await request('POST',B+'/table/export',{...manager,body:target})).status,403);assert.equal((await request('POST',B+'/table/row',{...manager,body:{target,index:0,row:rendered.json.blocks[1].data.rows[0]}})).status,403);console.log('PASS revoked grant immediately denies both read operations');
}catch(error){console.error(log.slice(-5000));throw error;}finally{await stop(python);await stop(child);rmSync(OUT,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
