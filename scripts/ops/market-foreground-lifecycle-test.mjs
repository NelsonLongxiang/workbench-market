/** One synthetic worker and one short-lived synthetic launch parent. Never touches production. */
import assert from'node:assert/strict';import{spawn}from'node:child_process';import{once}from'node:events';import{createServer}from'node:net';import{DatabaseSync}from'node:sqlite';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync}from'node:fs';import{resolve,join}from'node:path';import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';
import{runForeground,verifyPackage,FIXED_SOURCE}from'./market-foreground.mjs';
if(process.argv[2]==='--supervisor'){
 const c=JSON.parse(readFileSync(process.argv[3],'utf8'));const result=await runForeground(c.config,{manifestSha:c.pin,...(process.platform!=='win32'?{identity:async pid=>({pid,createdTicks:'synthetic-nonwindows-not-os-fingerprint',executable:process.execPath})}:{})});writeFileSync(c.result,JSON.stringify(result));process.exitCode=result.ok?0:1;
}else if(process.argv[2]==='--launch-parent'){
 const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 const p=spawn(process.execPath,[resolve(process.argv[1]),'--supervisor',process.argv[3]],{env,detached:true,stdio:'ignore'});await once(p,'spawn');writeFileSync(process.argv[4],JSON.stringify({launch_parent_pid:process.pid,supervisor_pid:p.pid}));p.unref();setInterval(()=>{},1000); // Independent observer ends only this synthetic launch parent.
}else{
 mkdirSync('tmp',{recursive:true});const out=mkdtempSync(resolve('tmp/foreground-lifecycle-'));for(const d of ['package/server/src','data','home','logs'])mkdirSync(join(out,d),{recursive:true});const entry=join(out,'package/server/src/index.ts'),stopFile=join(out,'data','worker-exit');
 // Synthetic protocol endpoints only. No real password, target, database records or session.
 writeFileSync(entry,"import{createServer}from'node:http';import{existsSync}from'node:fs';const s=createServer((q,r)=>{r.setHeader('Content-Type','application/json');if(q.url==='/mcp'){r.writeHead(401);r.end('{}')}else if(q.url==='/api/health')r.end('{\"ok\":true}');else r.end('{\"source\":\"db\",\"settable\":false}')});s.listen(Number(process.env.PORT),'127.0.0.1');const t=setInterval(()=>{if(existsSync(process.env.DATA_DIR+'/worker-exit')){clearInterval(t);s.close(()=>process.exit(7));}},100);console.log('synthetic-sensitive-worker-line');");
 const hash=b=>createHash('sha256').update(b).digest('hex');const manifest=join(out,'package.json');writeFileSync(manifest,JSON.stringify({source:FIXED_SOURCE,root:join(out,'package'),files:{'server/src/index.ts':hash(readFileSync(entry))}}));const pin=hash(readFileSync(manifest));
 const db=new DatabaseSync(join(out,'data/workbench-market.db'));db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);INSERT INTO settings VALUES('admin_token_sha256','synthetic-not-a-real-hash');");db.close();
 const holder=createServer();await new Promise(r=>holder.listen(0,'127.0.0.1',r));const port=holder.address().port;await new Promise(r=>holder.close(r));assert.notEqual(port,9800);assert.notEqual(port,9801);
 const config={packageManifest:manifest,dataDirectory:join(out,'data'),homeDirectory:join(out,'home'),eventLog:join(out,'logs/events.jsonl'),port,bindHost:'127.0.0.1',readyTimeoutMs:15000};const input=join(out,'config.json'),resultFile=join(out,'supervisor-result.json'),receipt=join(out,'parent.json');writeFileSync(input,JSON.stringify({config,pin,result:resultFile}));
 const rows=[];const check=(name,pass)=>{assert.ok(pass,name);rows.push({name,pass});console.log('PASS '+name)};const waitFor=async(fn,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,100))}throw Error('fixture deadline')};
 const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 let supervisorPid,workerPid,parent,parentEnded;
 try{
  const foreign=createServer();await new Promise(r=>foreign.listen(port,'127.0.0.1',r));let spawned=false;
  try{await assert.rejects(()=>runForeground({...config,eventLog:join(out,'logs/occupied.jsonl')},{manifestSha:pin,spawn:()=>{spawned=true}}),/port_occupied/);check('real occupied foreign port rejected without spawn',!spawned&&foreign.listening);}finally{await new Promise(r=>foreign.close(r))}
  parent=spawn(process.execPath,[resolve(process.argv[1]),'--launch-parent',input,receipt],{env,stdio:['ignore','pipe','pipe']});parentEnded=once(parent,'exit');let error='';parent.stderr.on('data',b=>error+=b);await waitFor(()=>existsSync(receipt));const identity=JSON.parse(readFileSync(receipt));supervisorPid=identity.supervisor_pid;check('observer holds exact synthetic parent process handle',parent.pid===identity.launch_parent_pid);
  await waitFor(()=>existsSync(config.eventLog)&&readFileSync(config.eventLog,'utf8').includes('worker_ready'));
  const events=readFileSync(config.eventLog,'utf8').trim().split('\n').map(JSON.parse);const ready=events.find(e=>e.event==='worker_ready');workerPid=ready.worker_pid;
  parent.kill();await parentEnded;
  check('supervisor and worker survive launch-parent exit',events.some(e=>e.event==='worker_started')&&ready&&supervisorPid!==identity.launch_parent_pid&&workerPid!==identity.launch_parent_pid);check('ready journal contains creation identity',!!ready.created_ticks&&!!ready.executable);
  const response=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(2000)});check('one synthetic worker responds after parent exit',response.status===200);
  writeFileSync(stopFile,'exit7');await waitFor(()=>existsSync(resultFile));const result=JSON.parse(readFileSync(resultFile));const text=readFileSync(config.eventLog,'utf8');
  check('worker exit code7 propagated as failure',result.workerExitCode===7&&!result.ok);check('default restart remains disabled',result.restarts===0);check('controlled journal omits arbitrary worker output',!text.includes('synthetic-sensitive-worker-line'));check('exit event persisted',text.includes('worker_exit')&&text.includes('supervisor_exit'));check('own lock released after exit',!existsSync(join(out,'data','.market-foreground-'+port+'.lock')));
 }finally{
  // Normal cleanup is the fixture's explicit exit marker, not a name/PID-wide termination.
  if(!existsSync(stopFile))writeFileSync(stopFile,'cleanup-exit7');
  if(parent&&parent.exitCode===null&&parent.signalCode===null){parent.kill();await parentEnded;}
  writeFileSync(join(out,'result.json'),JSON.stringify({rows,passed:rows.filter(r=>r.pass).length,production:false,worker_processes:workerPid?1:0,supervisor_pid:supervisorPid,worker_pid:workerPid,port,scope:'independent observer terminated exact synthetic parent; no DSH Job/SCM/VM restart proof; Windows actual identity otherwise marked synthetic'},null,2));
 }
 console.log(JSON.stringify({out,checks:rows.length}));
}
