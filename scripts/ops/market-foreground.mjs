/** Foreground adapter, not a Windows service installer. Import never starts a worker. */
import {spawn, execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {openSync,closeSync,writeSync,readFileSync,statSync,realpathSync,lstatSync,existsSync,fstatSync,unlinkSync} from 'node:fs';
import {resolve,dirname,basename,sep,join,isAbsolute,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
export const FIXED_SOURCE='d9080a61cd5c6ca7e070cfa64971ffdb342f6f58';
const PIN='2a3c7070be89d11d989afb75a948ec74c7940fda9de6a47c7b8c3ed496c68e6c';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>{const p=relative(root,file);return p!==''&&!p.startsWith('..'+sep)&&p!=='..'&&!isAbsolute(p)};
export function verifyPackage(file,expected=PIN){
 const bytes=readFileSync(file);if(digest(bytes)!==expected)throw Error('package_manifest_mismatch');
 const m=JSON.parse(bytes);if(m.source!==FIXED_SOURCE||!isAbsolute(m.root)||!m.files||!Object.keys(m.files).length)throw Error('package_binding_invalid');
 const root=realpathSync(m.root);
 for(const [name,hash] of Object.entries(m.files)){
  const p=resolve(root,name);if(!inside(root,p)||realpathSync(p)!==p||digest(readFileSync(p))!==hash)throw Error('package_file_mismatch');
 }
 if(!m.files['server/src/index.ts'])throw Error('entry_not_bound');
 return {root,source:FIXED_SOURCE};
}
export function validateConfig(raw){
 const allowed=['packageManifest','dataDirectory','homeDirectory','port','bindHost','eventLog','maxRestarts','restartDelaysMs','readyTimeoutMs'];
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k)))throw Error('config_invalid');
 for(const key of ['packageManifest','dataDirectory','homeDirectory','eventLog'])if(typeof raw[key]!=='string'||!isAbsolute(raw[key]))throw Error('absolute_paths_required');
 const c={...raw,port:raw.port??9800,bindHost:raw.bindHost??'127.0.0.1',maxRestarts:raw.maxRestarts??0,restartDelaysMs:raw.restartDelaysMs??[30000,120000,600000],readyTimeoutMs:raw.readyTimeoutMs??15000};
 if(!Number.isSafeInteger(c.port)||c.port<1||c.port>65534||!['127.0.0.1','0.0.0.0'].includes(c.bindHost)||!Number.isSafeInteger(c.maxRestarts)||c.maxRestarts<0||c.maxRestarts>3||!Array.isArray(c.restartDelaysMs)||c.restartDelaysMs.length!==3||c.restartDelaysMs.some(n=>!Number.isSafeInteger(n)||n<10000||n>600000)||!Number.isSafeInteger(c.readyTimeoutMs)||c.readyTimeoutMs<1000||c.readyTimeoutMs>60000)throw Error('config_limits_invalid');
 for(const key of ['dataDirectory','homeDirectory']){if(!statSync(c[key]).isDirectory())throw Error('directory_missing');c[key]=realpathSync(c[key]);}
 if(!statSync(dirname(c.eventLog)).isDirectory())throw Error('log_directory_missing');
 c.eventLog=join(realpathSync(dirname(c.eventLog)),basename(c.eventLog));
 for(const dir of [c.dataDirectory,c.homeDirectory])if(c.eventLog===dir||inside(dir,c.eventLog))throw Error('log_must_be_separate');
 return Object.freeze(c);
}
async function emptyPort(port,host){
 const server=createServer();try{await new Promise((r,j)=>{server.once('error',j);server.listen({port,host,exclusive:true},r)});}catch{throw Error('port_occupied_or_unavailable');}finally{if(server.listening)await new Promise(r=>server.close(r));}
}
function adminPresent(data){
 const db=new DatabaseSync(join(data,'workbench-market.db'),{readOnly:true});
 try{db.exec('PRAGMA query_only=ON');return !!db.prepare("SELECT 1 FROM settings WHERE key='admin_token_sha256' AND length(value)>0").get();}finally{db.close();}
}
async function healthy(port){
 const base='http://127.0.0.1:'+port;
 const h=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)});if(!h.ok||!(await h.json()).ok)return false;
 const s=await fetch(base+'/api/admin-token/state',{headers:{Origin:base},signal:AbortSignal.timeout(1000)});const state=await s.json();if(!s.ok||state.source!=='db'||state.settable!==false)return false;
 const denied=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"__nonexistent_readonly_probe__","arguments":{}}}',signal:AbortSignal.timeout(1000)});
 await denied.arrayBuffer();return denied.status===401;
}
/** Windows process identity and exact port owner, without slow full CIM TCP enumeration. */
async function identity(pid,port){
 if(process.platform!=='win32')throw Error('windows_identity_required');
 const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 const run=(file,args)=>new Promise((r,j)=>execFile(file,args,{env,timeout:10000,maxBuffer:16*1024*1024,windowsHide:true},(e,o)=>e?j(Error('worker_identity_unverified')):r(o)));
 const table=await run('netstat',['-ano','-p','tcp']);
 const owners=table.split(/\r?\n/).map(l=>l.trim().split(/\s+/)).filter(x=>x[0]==='TCP'&&x.length===5&&x[3]==='LISTENING'&&x[1].endsWith(':'+port)).map(x=>Number(x[4]));
 if(!owners.length||owners.some(owner=>owner!==pid))throw Error('worker_identity_unverified');
 const command="$p=Get-Process -Id "+pid+" -ErrorAction Stop;[pscustomobject]@{pid=$p.Id;createdTicks=[string]$p.StartTime.ToUniversalTime().Ticks;executable=$p.Path}|ConvertTo-Json -Compress";
 try{const p=JSON.parse(await run('pwsh',['-NoProfile','-Command',command]));if(p.pid!==pid||p.executable.toLowerCase()!==process.execPath.toLowerCase()||!p.createdTicks)throw Error();return p;}catch{throw Error('worker_identity_unverified');}
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
/** CLI cannot override pin, process command or probes. Module injections support synthetic tests only. */
export async function runForeground(raw,test={}){
 const c=validateConfig(raw),pkg=verifyPackage(c.packageManifest,test.manifestSha??PIN);
 if(c.eventLog===pkg.root||inside(pkg.root,c.eventLog))throw Error('log_must_be_separate');
 const lockPath=join(c.dataDirectory,'.market-foreground-'+c.port+'.lock');
 let log,lock,child=null,exitPromise=null,stopping=false,stopReason='normal',lastCode=null,restarts=0,cleanupIncomplete=false,stopTimer,rejectExit,resumeDelay,exitObserved=false,noProcess=false;
 const lifecycle=(event,detail={})=>{try{const line=Buffer.from(JSON.stringify({at:new Date().toISOString(),source:FIXED_SOURCE,supervisor_pid:process.pid,event,...detail})+String.fromCharCode(10));if(fstatSync(log).size+line.length>16*1024*1024)throw Error();if(writeSync(log,line)!==line.length)throw Error();}catch{throw Error('event_log_failed');}};
 // child is a retained ChildProcess handle; never a PID read from a caller-supplied receipt.
 const stopOwn=()=>{if(child&&!exitObserved&&!noProcess){try{child.kill('SIGTERM');}catch{/* A failed stop is not exit evidence; keep ownership and wait for real exit. */}}};
 const signal=()=>{stopping=true;stopReason='operator_signal';resumeDelay?.();stopOwn();if(child&&!stopTimer)stopTimer=setTimeout(()=>{cleanupIncomplete=true;rejectExit?.(Error('worker_stop_timeout'));},5000);};
 const waitExit=async()=>{let timer;try{return await Promise.race([exitPromise,new Promise((_,j)=>timer=setTimeout(()=>j(Error('worker_stop_timeout')),5000))]);}finally{clearTimeout(timer);}};
 try{
  if(existsSync(c.eventLog)&&(!lstatSync(c.eventLog).isFile()||lstatSync(c.eventLog).isSymbolicLink()||statSync(c.eventLog).size>=16*1024*1024))throw Error('event_log_unavailable');
  log=openSync(c.eventLog,'a',0o600); // Append without truncation. Trusted directory ACL and archival are caller responsibilities.
  try{lock=openSync(lockPath,'wx',0o600);writeSync(lock,JSON.stringify({pid:process.pid,port:c.port}));}catch{throw Error('instance_lock_exists');}
  lifecycle('supervisor_started',{port:c.port,control_port:0,max_restarts:c.maxRestarts});
  process.on('SIGINT',signal);process.on('SIGTERM',signal);
  while(!stopping){
   verifyPackage(c.packageManifest,test.manifestSha??PIN);
   await (test.emptyPort??emptyPort)(c.port,c.bindHost);await (test.emptyPort??emptyPort)(c.port+1,c.bindHost);
   if(!(test.adminPresent??adminPresent)(c.dataDirectory))throw Error('db_admin_missing');
   const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
   Object.assign(env,{PORT:String(c.port),WM_CONTROL_PORT:'0',DATA_DIR:c.dataDirectory,YGL_HOME:c.homeDirectory,MCP_GATEWAY:'on',REDIS_URL:'',NODE_ENV:'production',YGL_NO_UPDATE_CHECK:'1'});
   const bind="import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'){if(typeof a[1]==='string')a[1]='127.0.0.1';else a.splice(1,0,'127.0.0.1')}return l.apply(this,a)};";
   const argv=[...(c.bindHost==='127.0.0.1'?['--import','data:text/javascript,'+encodeURIComponent(bind)]:[]),'--disable-warning=ExperimentalWarning','src/index.ts'];
   child=(test.spawn??spawn)(process.execPath,argv,{cwd:join(pkg.root,'server'),env,detached:false,stdio:['ignore','pipe','pipe']});
   const worker=child;let spawnFailed=false,stdoutBytes=0,stderrBytes=0,rejectWorkerError;
   exitObserved=false;noProcess=false;
   const workerError=new Promise((_,reject)=>{rejectWorkerError=reject;});workerError.catch(()=>{});
   exitPromise=new Promise((resolve,reject)=>{
    rejectExit=reject;
    worker.on('error',()=>{
     spawnFailed=true;
     if(!Number.isSafeInteger(worker.pid)||worker.pid<1){noProcess=true;resolve({code:null,signal:null,error:true});}
     else rejectWorkerError(Error('live_worker_error')); // error is control failure, NEVER exit evidence.
    });
    worker.once('exit',(code,signal)=>{exitObserved=true;clearTimeout(stopTimer);resolve({code,signal,error:spawnFailed});});
   });exitPromise.catch(()=>{});
   // Drain output but persist only byte counts: workers may print secrets in arbitrary lines.
   worker.stdout?.on('data',b=>stdoutBytes+=b.length);worker.stderr?.on('data',b=>stderrBytes+=b.length);
   lifecycle('worker_started',{worker_pid:worker.pid??null,attempt:restarts+1});
   const until=Date.now()+c.readyTimeoutMs;let ready=false;
   while(Date.now()<until&&!stopping&&!spawnFailed&&worker.exitCode===null&&worker.signalCode===null){try{if(await(test.healthy??healthy)(c.port)){ready=true;break;}}catch{}await (test.wait??delay)(200);}
   if(!ready||stopping){stopReason=stopping?stopReason:'startup_verification_failed';stopping=true;stopOwn();}
   else{await(test.emptyPort??emptyPort)(c.port+1,c.bindHost);const id=await(test.identity??identity)(worker.pid,c.port);if(worker.exitCode!==null||worker.signalCode!==null||stopping)throw Error('worker_exited_before_ready');lifecycle('worker_ready',{worker_pid:worker.pid,created_ticks:id.createdTicks,executable:id.executable});}
   // During steady state the only completion is the retained child's exit, not parent exit or polling.
   const result=stopping?await waitExit():await Promise.race([exitPromise,workerError]);
   clearTimeout(stopTimer);lastCode=result.code;
   lifecycle('worker_exit',{worker_pid:worker.pid??null,code:result.code,signal:result.signal,error:result.error,stdout_bytes:stdoutBytes,stderr_bytes:stderrBytes});child=null;
   if(stopping||!ready||result.error)break;
   if(result.code===0){stopReason='worker_clean_exit';break;}
   stopReason='worker_failed';if(restarts>=c.maxRestarts)break;
   const ms=c.restartDelaysMs[restarts++];lifecycle('restart_scheduled',{restart:restarts,delay_ms:ms});
   if(test.wait)await test.wait(ms);else await new Promise(r=>{const t=setTimeout(()=>{resumeDelay=null;r();},ms);resumeDelay=()=>{clearTimeout(t);resumeDelay=null;r();};});if(!stopping)stopReason='normal';
  }
  const ok=!cleanupIncomplete&&stopReason==='worker_clean_exit';lifecycle('supervisor_exit',{reason:stopReason,restarts,worker_exit_code:lastCode});return{ok,restarts,reason:stopReason,workerExitCode:lastCode};
 }catch(e){stopping=true;try{if(log!==undefined)lifecycle('supervisor_error',{reason:['instance_lock_exists','port_occupied_or_unavailable','db_admin_missing','event_log_failed','worker_stop_timeout','worker_identity_unverified','worker_exited_before_ready','live_worker_error'].includes(e.message)?e.message:'preflight_or_runtime_failed'});}catch{}throw e;}
 finally{
  process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);clearTimeout(stopTimer);
  if(child){if(!exitObserved&&!noProcess){stopOwn();try{await waitExit();}catch{cleanupIncomplete=true;}}if(!cleanupIncomplete){try{lifecycle('worker_cleanup_exit',{worker_pid:child.pid??null,code:child.exitCode,signal:child.signalCode});}catch{}}}
  // If the worker cannot be proven exited, preserve its lock/journal and require manual intervention.
  if(!cleanupIncomplete&&lock!==undefined){closeSync(lock);unlinkSync(lockPath);}else if(lock!==undefined)closeSync(lock);
  if(log!==undefined)closeSync(log);
  if(cleanupIncomplete)throw Error('owned_worker_cleanup_incomplete');
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('usage');const raw=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));const result=await runForeground(raw);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}
 catch{console.error('foreground adapter failed closed; inspect restricted lifecycle journal; no fallback');process.exitCode=1;}
}
