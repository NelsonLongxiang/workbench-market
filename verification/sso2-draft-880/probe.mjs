// Draft: real isolated HTTP observations. Unimplemented groups remain NEEDS-MATERIAL.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
const root=dirname(new URL(import.meta.url).pathname.replace(/^[/]([A-Za-z]:)/,'$1'));
const target=resolve(root,'target');
const expected='d90f81abca809a48a893544d0bdd4c409be78526';
const coverage=JSON.parse(readFileSync(join(root,'coverage.json'),'utf8'));
const dbfile=join(root,'observations.sqlite');
const db=new DatabaseSync(dbfile);
db.exec('DROP TABLE IF EXISTS sso2_probes;DROP TABLE IF EXISTS sso2_deferred;CREATE TABLE sso2_probes(probe_id TEXT PRIMARY KEY,value INTEGER,status TEXT,evidence_json TEXT);CREATE TABLE sso2_deferred(probe_id TEXT,value INTEGER)');
const findings=new Map();
const secret=['sso-fixture-admin','fixture-password-1234'];
function safe(x){let s=JSON.stringify(x);for(const v of secret)s=s.replaceAll(v,'<fixture-secret>');return JSON.parse(s);}
function put(id,value,status,evidence){findings.set(id,{probe_id:id,value,status,evidence:safe(evidence)});}
for(const u of coverage.units)if(!u.id.startsWith('deferred_'))put(u.id,null,'NEEDS-MATERIAL',{reason:'draft handler/fixture not yet implemented; scope retained',authority:u.ref});
const runtimes=[];
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));assert.notEqual(p,9800);return p;}
async function boot(extra={},acceptExit=false){
 const p=await port(),base='http://127.0.0.1:'+p;
 const dir=mkdtempSync(join(root,'data-'));
 const env={...process.env,PORT:String(p),DATA_DIR:dir,ADMIN_TOKEN:secret[0],MCP_GATEWAY:'',REDIS_URL:'',LAYERFS_SERVICE_URL:'',WM_SSO:'on',MARKET_PUBLIC_URL:base,...extra};
 // Explicit unset, not inherited configuration.
 for(const [k,v]of Object.entries(env))if(v===null)delete env[k];
 let log='';const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{cwd:target,env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
 const entry={child,port:p,base,dir,command:[process.execPath,'--disable-warning=ExperimentalWarning','server/src/index.ts'],cwd:target,config:safe({...extra,ADMIN_TOKEN_configured:true}),get log(){return safe({log}).log}};runtimes.push(entry);
 let ready=false;
 for(let i=0;i<80;i++){if(child.exitCode!==null)break;try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 entry.ready=ready;
 if(!ready&&!acceptExit)throw new Error('boot failed '+entry.log.slice(-500));return entry;
}
async function stop(r){if(r.stopped)return;r.stopped=true;if(r.child.exitCode===null&&r.child.signalCode===null){const close=once(r.child,'close');r.child.kill();await close;}}
async function req(r,path,{method='GET',body,admin=false,origin=true,cookie,headers={}}={}){
 const h={...(body!==undefined?{'content-type':'application/json'}:{}),...(admin?{'x-admin-token':secret[0]}:{}),...(origin?{Origin:r.base}:{}),...(cookie?{Cookie:cookie}:{}),...headers};
 const res=await fetch(r.base+path,{method,headers:h,redirect:'manual',body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
 const text=await res.text();let json;try{json=JSON.parse(text)}catch{}
 return {status:res.status,text,json,headers:Object.fromEntries([...res.headers].filter(([k])=>!['set-cookie'].includes(k))),cookie:res.headers.get('set-cookie')};
}
function publicResponse(x){return {status:x.status,json:x.json,text:x.json?undefined:x.text.slice(0,200),headers:x.headers,cookie_present:!!x.cookie};}
async function group(id,fn){const results=[];const test=(name,condition,observed)=>{results.push({name,ok:!!condition,observed:safe(observed)});};try{await fn(test);put(id,results.every(x=>x.ok)?null:0,results.every(x=>x.ok)?'NEEDS-MATERIAL':'FAIL',{assertions:results,remaining:results.every(x=>x.ok)?'group not yet complete; remaining controls require implementation':undefined});}catch(e){put(id,null,'NEEDS-MATERIAL',{assertions:results,error:e.message});}}
let r;
try{
 r=await boot();
 const hashes=['server/src/index.ts','server/src/task-center.ts','server/src/db.ts'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(join(target,path))).digest('hex')}));
 // Target was exported from fixed API tarball; no checkout/ref switched.
 const listener=process.platform==='win32'?execFileSync('pwsh',['-NoProfile','-Command','Get-NetTCPConnection -LocalPort '+r.port+' -State Listen | Select-Object -ExpandProperty OwningProcess'],{encoding:'utf8'}).trim().split(/\s+/).map(Number):[];
 assert.ok(listener.length&&listener.every(pid=>pid===r.child.pid),'listener ownership evidence missing');
 put('boot',1,'PASS',{listener_owners:listener,target_sha:expected,archive_sha256:createHash('sha256').update(readFileSync(join(root,'target.tar.gz'))).digest('hex'),hashes,command:r.command,cwd:r.cwd,pid:r.child.pid,port:r.port,data_dir:r.dir,health:(await req(r,'/api/health')).status,source:'pinned archive; listener owner verified; dependencies shared read-only by test junction'});
 await group('register_guard',async check=>{
  for(const c of [{admin:false,origin:true},{admin:true,origin:false},{admin:true,origin:true,headers:{Origin:'null'}},{admin:true,origin:true,headers:{Origin:'https://evil.example'}}]){
   const x=await req(r,'/api/auth/register',{...c,method:'POST',body:{username:'fixture-user',password:secret[1]}});check('admin+origin guard',x.status===403,publicResponse(x));
  }
 });
 await group('register_schema',async check=>{
  const role=await req(r,'/api/auth/register',{method:'POST',admin:true,body:{username:'fixture-user',password:secret[1],role:'admin'}});check('role escalation rejected400',role.status===400,publicResponse(role));
  const create=await req(r,'/api/auth/register',{method:'POST',admin:true,body:{username:' Fixture-User ',password:secret[1]}});check('ordinary account201 normalized',create.status===201&&create.json?.user?.username==='fixture-user',publicResponse(create));
  const duplicate=await req(r,'/api/auth/register',{method:'POST',admin:true,body:{username:'fixture-user',password:secret[1]}});check('duplicate409',duplicate.status===409,publicResponse(duplicate));
 });
 await group('register_ui',async check=>{
  const login=await req(r,'/login');check('real login form not SPA fallback',login.status===200&&/<form[ >]/i.test(login.text)&&/type=["']password/.test(login.text),publicResponse(login));
  const register=await req(r,'/register');check('admin opening notice',register.status===200&&/管理员/.test(register.text)&&!/<input[^>]*type=["']password/.test(register.text),publicResponse(register));
 });
 await group('me_invalid',async check=>{
  for(const cookie of [undefined,'wm_session=forged']){const x=await req(r,'/api/auth/me',{cookie});check('missing/forged cookie401',x.status===401&&x.json?.error==='unauthenticated',publicResponse(x));}
 });
 let session,sessionB,user;
 const login=await req(r,'/api/auth/login',{method:'POST',body:{username:'fixture-user',password:secret[1]}});
 await group('login_session',async check=>{
  check('login shape/cookie',login.status===200&&login.json?.user?.id&&typeof login.json.expires_at==='string'&&login.json.redirect_to==='/'&&/wm_session=/.test(login.cookie??''),publicResponse(login));
  check('cookie attributes',/HttpOnly/i.test(login.cookie??'')&&/SameSite=Lax/i.test(login.cookie??'')&&/Path=[/]/i.test(login.cookie??'')&&!/Domain=/i.test(login.cookie??''),{cookie_present:!!login.cookie});
  check('no-store',login.headers['cache-control']?.includes('no-store'),{cache_control:login.headers['cache-control']});
 });
 if(login.status===200&&login.cookie){session=login.cookie.split(';')[0];user=login.json.user;secret.push(session);const b=await req(r,'/api/auth/login',{method:'POST',body:{username:'fixture-user',password:secret[1]}});if(b.cookie){sessionB=b.cookie.split(';')[0];secret.push(sessionB);}}
 await group('failure_same_bytes',async check=>{
  const xs=[];for(const username of ['fixture-user','never-existed'])xs.push(await req(r,'/api/auth/login',{method:'POST',body:{username,password:'wrong-password-1234'}}));
  check('wrong/unknown401samebytes',xs.every(x=>x.status===401&&x.text==='{"error":"invalid_credentials"}')&&xs[0].text===xs[1].text,xs.map(publicResponse));
  // Full locked/disabled controls remain required; no partial success on a green implementation.
  if(xs.every(x=>x.status===401))throw new Error('locked/disabled same-body subcases pending TEST fixture; do not count partial PASS');
 });
 await group('audit_read',async check=>{const x=await req(r,'/api/auth/audit');check('anonymous audit403',x.status===403,publicResponse(x));if(x.status===403)throw new Error('admin paging/ordinary-session/fields controls pending');});
 await group('users_paging',async check=>{const x=await req(r,'/api/auth/users');check('anonymous users403',x.status===403,publicResponse(x));if(x.status===403)throw new Error('admin paging/field allowlist controls pending');});
 const wb=await req(r,'/api/workbenches',{method:'POST',admin:true,body:{name:'sso-probe-target',url:'http://127.0.0.1:9/'}});
 if(wb.status===201&&wb.json?.id){
  const path='/api/workbenches/'+wb.json.id+'/sso';
  await group('machine_unavailable',async check=>{for(const machine_auth of ['app-token','mcp-session','target-validator']){const x=await req(r,path,{method:'PUT',admin:true,body:{enabled:true,mode:'none',machine_auth}});check('non-none409',x.status===409&&x.json?.error==='machine_auth_unavailable',publicResponse(x));}});
  await group('config_guard',async check=>{const a=await req(r,path);const b=await req(r,path,{method:'PUT',body:{enabled:true,mode:'none',machine_auth:'none'}});check('config read/write admin403',a.status===403&&b.status===403,[publicResponse(a),publicResponse(b)]);if(a.status===403&&b.status===403)throw new Error('full schema/order/no-write matrix pending TEST');});
 }
 if(session&&sessionB){
  await group('next_validation',async check=>{for(const next of [undefined,'//evil.example','https://evil.example','/%2f%2fevil','/%5cevil']){const x=await req(r,'/api/auth/login',{method:'POST',body:{username:'fixture-user',password:secret[1],...(next===undefined?{}:{next})}});check('missing/evil next root',x.status===200&&x.json.redirect_to==='/',publicResponse(x));}throw new Error('legal next/final redirect control+remaining encoded/control cases pending; no partial PASS');});
  await group('multi_device_logout',async check=>{const out=await req(r,'/api/auth/logout',{method:'POST',cookie:session,body:{}});const old=await req(r,'/api/auth/me',{cookie:session});const other=await req(r,'/api/auth/me',{cookie:sessionB});check('A revoked B remains',out.status===200&&/Max-Age=0/i.test(out.cookie??'')&&old.status===401&&other.status===200,[publicResponse(out),publicResponse(old),publicResponse(other)]);throw new Error('restart/HTTP/WS replay/invalid logout remaining; no partial PASS');});
 }
 await stop(r);
 // Representative config-negative probes: all cases must exit nonzero before listen.
 await group('invalid_config',async check=>{
  for(const extra of [{WM_SSO:'garbage'},{WM_AUTH_MAX_FAILURES:'0'},{WM_AUTH_FAILURE_WINDOW:'-1s'},{WM_AUTH_LOCK_TTL:''},{WM_TRUSTED_PROXIES:'invalid/CIDR'}]){const inst=await boot(extra,true);check('invalid config refuses startup',!inst.ready&&inst.child.exitCode!==null&&inst.child.exitCode!==0,{config:extra,ready:inst.ready,exit:inst.child.exitCode});await stop(inst);}
  if([...findings.values()].some(x=>x.probe_id==='invalid_config'&&x.value===1))throw new Error('full invalid-value matrix pending');
 });
 await group('canonical_origin',async check=>{
  for(const extra of [{WM_SSO:'on',MARKET_PUBLIC_URL:null},{MARKET_PUBLIC_URL:'https://user:pass@example.test'},{MARKET_PUBLIC_URL:'https://example.test/path'},{MARKET_PUBLIC_URL:'https://example.test?x=1'}]){const inst=await boot(extra,true);check('bad/missing canonical refuses startup',!inst.ready&&inst.child.exitCode!==null&&inst.child.exitCode!==0,{config:extra,ready:inst.ready,exit:inst.child.exitCode});await stop(inst);}
  // The off/loopback and advertised-base/Host/XFH positive controls remain unimplemented.
  if(!findings.has('canonical_origin'))throw new Error('positive canonical controls pending');
 });
}finally{
 for(const inst of runtimes)await stop(inst);
 for(const u of coverage.units){
  db.exec('DROP TABLE IF EXISTS sso2_eval_'+u.id+';CREATE TABLE sso2_eval_'+u.id+'(probe_id TEXT PRIMARY KEY,value INTEGER)');
  if(u.id.startsWith('deferred_'))continue;
  const f=findings.get(u.id);db.prepare('INSERT INTO sso2_probes VALUES(?,?,?,?)').run(u.id,f.value,f.status,JSON.stringify(f.evidence));
  if(f.value!==null)db.prepare('INSERT INTO sso2_eval_'+u.id+' VALUES(?,?)').run(u.id,f.value);
 }
 db.close();
 const metadata=runtimes.map(x=>({pid:x.child.pid,port:x.port,dir:x.dir,cwd:x.cwd,command:x.command,config:x.config,ready:x.ready,exit:x.child.exitCode,signal:x.child.signalCode,log:x.log.slice(-1500)}));
 const report={target:expected,observations:[...findings.values()],metadata,coverage_state:'DRAFT; full handlers not complete; no independent review/spec freeze'};
 writeFileSync(join(root,'probe-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({target:expected,counts:[...findings.values()].reduce((a,x)=>(a[x.status]=(a[x.status]??0)+1,a),{}),deferred:2,report:join(root,'probe-report.json')}));
}
