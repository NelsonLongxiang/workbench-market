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
const ROOT=resolve('.');if(!existsSync(join(ROOT,'web/dist/index.html')))throw Error('先构建现有web产物');
mkdirSync('tmp',{recursive:true});const OUT=mkdtempSync(resolve('tmp/bench-table-browser-'));
const token='synthetic-table-admin';let child,log='',base='',python;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stop=async p=>{if(!p||p.exitCode!==null||p.signalCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),sleep(3000)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await new Promise(r=>p.once('exit',r));}};
const request=async(method,path,{body,raw,session,headers={}}={})=>{const h={...headers};if(session)h.cookie=`session_id=${session}`;if(body!==undefined||raw!==undefined)h['content-type']='application/json';const r=await fetch(base+path,{method,headers:h,body:raw??(body===undefined?undefined:JSON.stringify(body)),signal:AbortSignal.timeout(60000),redirect:'manual'});const text=await r.text();let json=null;try{json=JSON.parse(text)}catch{}return{status:r.status,text,json,headers:Object.fromEntries(r.headers)}};
try{
 await startWithEnvironmentRetry(async i=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));base=`http://127.0.0.1:${port}`;
  const home=join(OUT,'home-'+i),data=join(OUT,'data-'+i),ext=join(OUT,'ext-'+i);for(const d of[home,data,ext])mkdirSync(d,{recursive:true});
  const env={};for(const k of['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];Object.assign(env,{HOME:home,PORT:String(port),DATA_DIR:data,NODE_ENV:'test',MCP_GATEWAY:'off',ADMIN_TOKEN:token,REDIS_URL:'',WM_CONTROL_PORT:'0',WM_EXTENSIONS_DIR:ext,IDENTITY_SEAM_ROOT:ROOT,IDENTITY_FAKE_ADMIN_GRANT:'admin',WM_BENCH_VIEWS:'on'});
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',pathToFileURL(join(ROOT,'scripts/identity-fake-preload.mjs')).href,'server/src/index.ts'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const end=Date.now()+60000;
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
 const cfg=join(OUT,'browser.json');writeFileSync(cfg,JSON.stringify({base,card:card.json.id,session:SESSIONS.alpha,out:OUT}));
 python=spawnProcess(pythonBin(),['scripts/bench-table-browser.py',cfg],{cwd:ROOT,stdio:'inherit'});const code=await new Promise((r,j)=>{python.once('error',j);python.once('exit',r)});if(code!==0)throw Error('native table browser failed');
 const revoke=await request('POST',`/api/grants/${grant.json.grant.id}/revoke`,{body:{reason:'synthetic access revocation'}});assert.equal(revoke.status,200);assert.equal((await request('POST',B+'/table/export',{...manager,body:target})).status,403);assert.equal((await request('POST',B+'/table/row',{...manager,body:{target,index:0,row:rendered.json.blocks[1].data.rows[0]}})).status,403);console.log('PASS revoked grant immediately denies both read operations');
}finally{await stop(python);await stop(child);if(child?.exitCode&&!log.includes('ready'))console.error(log.slice(-3500));rmSync(OUT,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
