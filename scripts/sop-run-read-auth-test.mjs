/** #309 phase2: anonymous private-read denial (RED first) + cap/grant authorization on actual synthetic index. */
import assert from'node:assert/strict';import{createHash}from'node:crypto';import{mkdirSync,writeFileSync}from'node:fs';import{resolve,join}from'node:path';import{pathToFileURL}from'node:url';import{spawn}from'node:child_process';import{once}from'node:events';import{createServer}from'node:net';
const root=resolve('.'),source=root,out=resolve('tmp/sop309-phase2-auth-'+Date.now());mkdirSync(out,{recursive:true});
const data=join(out,'data'),home=join(out,'home');mkdirSync(join(data,'run-files','12'),{recursive:true});
writeFileSync(join(data,'run-files','12','synthetic.txt'),'SYNTHETIC_FILE_CONTENT');
mkdirSync(join(data,'apps','audit-sop','v1'),{recursive:true});
writeFileSync(join(data,'apps','audit-sop','v1','sop.yaml'),'title: Synthetic Audit'+String.fromCharCode(10)+'steps:'+String.fromCharCode(10)+'  - key: inspect'+String.fromCharCode(10)+'    title: Inspect');
const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));assert.ok(![9800,9801,3080].includes(port));
const env={};for(const k of['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{DATA_DIR:data,YGL_HOME:home,PORT:String(port),WM_CONTROL_PORT:'0',MCP_GATEWAY:'on',ADMIN_TOKEN:'synthetic-admin',REDIS_URL:''});
// Seed directly in this process: import db.ts with DATA_DIR set, insert rows, close. No generated code.
for(const[k,v]of Object.entries(env))process.env[k]=v;
const dbMod=await import(pathToFileURL(join(source,'server/src/db.ts')).href);
const tcMod=await import(pathToFileURL(join(source,'server/src/task-center.ts')).href);
const {db}=dbMod;
db.exec('PRAGMA busy_timeout=5000');
db.prepare('INSERT INTO apps(id,slug,title,kind,status,active_version) VALUES(1,?,?,?,?,1)').run('audit-sop','Synthetic Audit','sop','published');
db.prepare('INSERT INTO app_versions(app_id,version) VALUES(1,1)').run();
db.prepare('INSERT INTO sop_runs(id,sop_slug,sop_version,status,started_by,data,upload_token) VALUES(?,?,1,?,?,?,?)').run(12,'audit-sop','finished','SYNTHETIC_ACTOR',JSON.stringify({inspect:{note:'SYNTHETIC_CURRENT_STEP'},review:{note:'SYNTHETIC_OTHER_STEP'}}),'OLD_SYNTHETIC');
db.prepare('INSERT INTO sop_run_files(id,run_id,original_name,mime,size,storage_path,created_by) VALUES(1,12,?,?,?,?,?)').run('synthetic.txt','text/plain',22,'run-files/12/synthetic.txt','SYNTHETIC_ACTOR');
db.prepare('INSERT INTO sop_runs(id,sop_slug,sop_version,status,data) VALUES(?,?,?,?,?)').run(14,'task-center',1,'finished',JSON.stringify({title:{value:'SYNTHETIC_TITLE'},intent:{value:'SYNTHETIC_PRIVATE_INTENT'},deliverable:{value:'SYNTHETIC_DELIVERABLE'},target:{value:'audit-sop'},due:{value:''}}));
try{tcMod.initializeTaskCenter(join(data,'apps'));tcMod.publishTaskIntake({intake_run_id:14,published_by:'synthetic-role'});}catch(e){assert.fail('task-center seed failed: '+e.message);}
const token='a'.repeat(64),sha=createHash('sha256').update(token).digest('hex');
db.prepare('INSERT INTO mcp_sessions(name,token_sha256,grants) VALUES(?,?,?)').run('synthetic-reader',sha,'["sop_run_get","sop_run_start"]');
db.close();
const pre='import net from "node:net";const native=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==="number"&&typeof a[1]!=="string")a.splice(1,0,"127.0.0.1");return native.apply(this,a)};';
const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(pre),'server/src/index.ts'],{cwd:source,env,stdio:['ignore','pipe','pipe']}),exited=once(child,'exit');
let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
const base='http://127.0.0.1:'+port,H={'X-Admin-Token':'synthetic-admin'};
let checks=0;const check=(n,cond)=>{assert.ok(cond,n);checks++;console.log('PASS '+n)};
try{for(let i=0;i<120;i++){try{if((await fetch(base+'/api/health')).ok)break}catch{}if(child.exitCode!==null)throw Error('synthetic index exited');await new Promise(r=>setTimeout(r,50));}
// ---- RED set: anonymous private reads must be denied ----
const single=await(await fetch(base+'/api/sop/runs/12')).json();
check('anonymous single run omits data',single.status==='finished'&&!Object.hasOwn(single,'data'));
check('anonymous single keeps metadata+receipt',single.id===12&&single.sop_slug==='audit-sop'&&typeof single.receipt==='string');
check('anonymous file list denied',(await fetch(base+'/api/sop/runs/12/files')).status===403);
const dl=await fetch(base+'/api/sop/runs/12/files/1');
check('anonymous file download denied',dl.status===403&&dl.headers.get('cache-control')==='no-store');
check('anonymous file HEAD denied',(await fetch(base+'/api/sop/runs/12/files/1',{method:'HEAD'})).status===403);
const detail=await(await fetch(base+'/api/task-center/tasks/1')).json();
check('anonymous task detail omits payload copy',!Object.hasOwn(detail,'payload_json')&&!JSON.stringify(detail).includes('SYNTHETIC_PRIVATE_INTENT')&&Array.isArray(detail.events));
const mcpNoGrant=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sop_run_get',arguments:{run_id:12}}})})).json();
check('MCP without run grant omits data',!!mcpNoGrant.result&&!JSON.stringify(mcpNoGrant).includes('SYNTHETIC_OTHER_STEP'));
// ---- creation issues one-time read capability ----
const created=await fetch(base+'/api/sop/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:'audit-sop',started_by:'synthetic-fresh'})});
const cj=await created.json();
check('run creation issues read capability',created.status===201&&typeof cj.read_capability==='string'&&cj.read_capability.length>=64);
const cap=cj.read_capability,fresh=cj.id;
const capGet=await fetch(base+'/api/sop/runs/'+fresh,{headers:{'X-Run-Read-Capability':cap}});const capJson=await capGet.json();
check('cap holder reads own run data',capGet.status===200&&Object.hasOwn(capJson,'data'));
const upForm=new FormData();upForm.append('file',new Blob(['CAP_FILE_BYTES'],{type:'text/plain'}),'cap.txt');
const upRes=await(await fetch(base+'/api/sop/runs/'+fresh+'/files',{method:'POST',body:upForm})).json();
const flRes=await fetch(base+'/api/sop/runs/'+fresh+'/files',{headers:{'X-Run-Read-Capability':cap}});
const dlBody=await(await fetch(base+'/api/sop/runs/'+fresh+'/files/'+upRes.id,{headers:{'X-Run-Read-Capability':cap}})).text();
check('cap holder lists+downloads files',flRes.status===200&&dlBody==='CAP_FILE_BYTES');
const cross=await(await fetch(base+'/api/sop/runs/12',{headers:{'X-Run-Read-Capability':cap}})).json();
check('cap cannot cross runs',!Object.hasOwn(cross,'data'));
const wrong=await(await fetch(base+'/api/sop/runs/'+fresh,{headers:{'X-Run-Read-Capability':'x'.repeat(64)}})).json();
check('wrong cap denied data',wrong.data===undefined);
check('admin token reads full data',(await(await fetch(base+'/api/sop/runs/12',{headers:H})).json()).data?.inspect?.note==='SYNTHETIC_CURRENT_STEP');
// ---- admin reissue + revoke on old run ----
const re=await(await fetch(base+'/api/sop/runs/12/read-caps',{method:'POST',headers:H,body:'{}'})).json();
check('admin reissues cap for old run',typeof re.read_capability==='string');
const reRead=await(await fetch(base+'/api/sop/runs/12',{headers:{'X-Run-Read-Capability':re.read_capability}})).json();
check('reissued cap unlocks old run data',reRead.data?.inspect?.note==='SYNTHETIC_CURRENT_STEP');
// MCP arg-cap machine migration path (before revocation)
const mcpCap=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'sop_run_get',arguments:{run_id:12,read_capability:re.read_capability}}})})).json();
check('MCP arg cap path yields full data',JSON.stringify(mcpCap).includes('SYNTHETIC_OTHER_STEP'));
// tools/list 声明核验：schema 必须声明 read_capability（否则 MCP 客户端按 additionalProperties:false 剥参）
const tl=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list',params:{}})})).json();
const getDecl=tl.result?.tools?.find((t)=>t.name==='sop_run_get');
check('tools/list declares sop_run_get read_capability',!!getDecl&&!!getDecl.inputSchema?.properties?.read_capability&&getDecl.inputSchema.additionalProperties===false);
// 完整 MCP 机器往返：sop_run_start 返回 read_capability → sop_run_get 带它读全量
const startJ=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'sop_run_start',arguments:{slug:'audit-sop',started_by:'synthetic-mcp'}}})})).json();
const startTxt=startJ.result?.content?.[0]?.text??'';const startObj=JSON.parse(startTxt);check('MCP sop_run_start issues read_capability',typeof startObj.read_capability==='string'&&startObj.read_capability.length>=64);
const rt=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'sop_run_get',arguments:{run_id:startObj.id,read_capability:startObj.read_capability}}})})).json();
const rtObj=JSON.parse(rt.result?.content?.[0]?.text??'{}');check('MCP full round-trip start->get with cap yields data',Object.hasOwn(rtObj,'data')&&rtObj.id===startObj.id);
await fetch(base+'/api/sop/runs/12/read-caps/revoke',{method:'POST',headers:H,body:JSON.stringify({all:true})});
const afterRevoke=await(await fetch(base+'/api/sop/runs/12',{headers:{'X-Run-Read-Capability':re.read_capability}})).json();
check('revoked cap denied',!Object.hasOwn(afterRevoke,'data'));
// ---- task detail authorized via admin ----
const td=await(await fetch(base+'/api/task-center/tasks/1',{headers:H})).json();
check('authorized task detail includes payload copy',Object.hasOwn(td,'payload_json')&&td.payload_json.includes('SYNTHETIC_PRIVATE_INTENT'));
// ---- grants admin api ----
const g=await fetch(base+'/api/sop/runs/12/read-grants',{method:'PUT',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({subject:'user:synthetic-owner'})});
check('admin seeds run grant',g.status===201);
await fetch(base+'/api/sop/runs/12/read-grants/revoke',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({subject:'user:synthetic-owner'})});
// ---- MCP 会话 grant 三态（正/过期/撤销）：监督席要求的逐例实测 ----
const mcpGet=async()=>{const r=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'sop_run_get',arguments:{run_id:12}}})})).json();return JSON.parse(r.result?.content?.[0]?.text??'{}');};
const future=new Date(Date.now()+7*86400000).toISOString().slice(0,19).replace('T',' ');
await fetch(base+'/api/sop/runs/12/read-grants',{method:'PUT',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({subject:'mcp:synthetic-reader',expires_at:future})});
const granted=await mcpGet();
check('MCP session grant yields data',Object.hasOwn(granted,'data')&&JSON.stringify(granted.data).includes('SYNTHETIC_OTHER_STEP'));
await fetch(base+'/api/sop/runs/12/read-grants/revoke',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({subject:'mcp:synthetic-reader'})});
check('revoked MCP session grant omits data',!Object.hasOwn(await mcpGet(),'data'));
const past=new Date(Date.now()-86400000).toISOString().slice(0,19).replace('T',' ');
await fetch(base+'/api/sop/runs/12/read-grants',{method:'PUT',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({subject:'mcp:synthetic-reader',expires_at:past})});
check('expired MCP session grant omits data',!Object.hasOwn(await mcpGet(),'data'));
await fetch(base+'/api/sop/runs/12/read-grants/revoke',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({subject:'mcp:synthetic-reader'})});
// cap 撤销后 MCP 工具面（带旧 cap）也只回元数据
const freshCap=await(await fetch(base+'/api/sop/runs/12/read-caps',{method:'POST',headers:H})).json();
await fetch(base+'/api/sop/runs/12/read-caps/revoke',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({all:true})});
const mcpRevokedCap=await(await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'sop_run_get',arguments:{run_id:12,read_capability:freshCap.read_capability}}})})).json();
const mcpRevokedObj=JSON.parse(mcpRevokedCap.result?.content?.[0]?.text??'{}');
check('revoked cap on MCP face omits data',!Object.hasOwn(mcpRevokedObj,'data'));
writeFileSync(join(out,'result.json'),JSON.stringify({checks,production_requests:0,scope:'actual synthetic index; session-grant path unit-tested separately'},null,2));
console.log(JSON.stringify({out,checks}));
}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}writeFileSync(join(out,'stdout.log'),stdout);writeFileSync(join(out,'stderr.log'),stderr);}
