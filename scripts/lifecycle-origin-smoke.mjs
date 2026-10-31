// Audit harness only. Isolated synthetic data/cookies; approve stays disabled; no grant implementation.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
mkdirSync('tmp',{recursive:true});const dir=mkdtempSync(resolve('tmp/lifecycle-origin-'));
const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base='http://127.0.0.1:'+port;
const payload='<html><head><title>synthetic origin probe</title></head><body><script>(async()=>{window.__originAudit=[];for(const path of ["approve","grant"])for(const mode of ["json","simple"]){try{const r=await fetch('+JSON.stringify(base) +'+"/api/lifecycle/"+path,{method:"POST",credentials:"include",headers:mode==="json"?{"Content-Type":"application/json","X-WM-Lifecycle":"1","X-Origin-Probe":"json"}:{"Content-Type":"text/plain"},body:JSON.stringify({proposal_id:"synthetic",grant:"synthetic",subject:"user:fixture"})});window.__originAudit.push({path,mode,status:r.status});}catch(e){window.__originAudit.push({path,mode,blocked:true});}}})()</script></body></html>';
const upstream=createServer((_q,r)=>{r.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'"});r.end(payload)});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{PORT:String(port),DATA_DIR:join(dir,'data'),YGL_HOME:join(dir,'ygl'),ADMIN_TOKEN:'synthetic-origin-admin',MCP_GATEWAY:'on',REDIS_URL:''});
const preload='import net from "node:net";const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==="number"){if(typeof a[1]==="string")a[1]="127.0.0.1";else a.splice(1,0,"127.0.0.1");}return l.apply(this,a)};';
const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'--disable-warning=ExperimentalWarning','server/src/index.ts'],{env,stdio:['ignore','pipe','pipe']});const ended=once(child,'exit');let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
async function api(method,path,body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Admin-Token':env.ADMIN_TOKEN,Origin:base},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j;}
try{
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,150));}assert.ok(ready,'test server ready');
 const portal=await api('POST','/api/workbenches',{name:'origin-fixture',url:'http://127.0.0.1:'+upstream.address().port+'/',type:'web'});
 await api('POST','/api/apps',{slug:'origin-app',title:'Synthetic',files:[{path:'index.html',content:payload}]});
 await api('POST','/api/apps',{slug:'origin-sop',title:'Synthetic SOP',kind:'sop',changelog:'synthetic origin audit',files:[{path:'sop.yaml',content:JSON.stringify({title:'Synthetic SOP',steps:[{key:'one',title:'One',body:payload}]})},{path:'probe.html',content:payload}]});
 await api('POST','/api/sops/origin-sop/publish',{changelog:'synthetic origin audit'});
 const sopPortal=await api('POST','/api/workbenches',{name:'origin-sop-shortcut',url:'/sop/origin-sop/',type:'web'});
 const appPortal=await api('POST','/api/workbenches',{name:'origin-app-shortcut',url:'/apps/origin-app/',type:'web'});
 const surfaces=[{name:'external portal',url:base+'/go/'+portal.id+'/',opaque:false},{name:'SOP root',url:base+'/sop/origin-sop/',opaque:false},{name:'SOP HTML attachment',url:base+'/sop/origin-sop/probe.html',opaque:false},{name:'SOP portal shortcut',url:base+'/go/'+sopPortal.id+'/',opaque:false},{name:'SOP portal HTML attachment',url:base+'/go/'+sopPortal.id+'/probe.html',opaque:false},{name:'app sandbox',url:base+'/apps/origin-app/',opaque:true},{name:'app portal shortcut',url:base+'/go/'+appPortal.id+'/',opaque:true}];
 const file=new FormData();file.append('file',new Blob([payload],{type:'text/html'}),'probe.html');const upload=await fetch(base+'/api/apps/origin-app/files',{method:'POST',headers:{'X-Admin-Token':env.ADMIN_TOKEN},body:file});const uj=await upload.json();assert.equal(upload.status,201,JSON.stringify(uj));const download=await fetch(base+uj.url);assert.ok(download.headers.get('content-disposition').startsWith('attachment'));assert.equal(download.headers.get('x-content-type-options'),'nosniff');
 const run=await api('POST','/api/sop/runs',{slug:'origin-sop',started_by:'synthetic'});
 const runFile=new FormData();runFile.append('file',new Blob([payload],{type:'text/html'}),'run-probe.html');
 const runUpload=await fetch(base+'/api/sop/runs/'+run.id+'/files',{method:'POST',headers:{'X-Admin-Token':env.ADMIN_TOKEN},body:runFile});const ru=await runUpload.json();assert.equal(runUpload.status,201,JSON.stringify(ru));
 const runDownload=await fetch(base+ru.url);assert.ok(runDownload.headers.get('content-disposition').startsWith('attachment'));assert.equal(runDownload.headers.get('x-content-type-options'),'nosniff');
 writeFileSync(join(dir,'uploads.json'),JSON.stringify({app_html_attachment:true,run_html_attachment:true,nosniff:true},null,2));
 const config=join(dir,'browser-config.json');writeFileSync(config,JSON.stringify({base,surfaces,result:join(dir,'browser-result.json')}));
 const py=spawn('python',['scripts/lifecycle-origin-browser.py',config],{env:{...env},stdio:['ignore','pipe','pipe']});let out='',err='';py.stdout.on('data',x=>out+=x);py.stderr.on('data',x=>err+=x);const code=await new Promise((r,j)=>{py.on('error',j);py.on('exit',r)});writeFileSync(join(dir,'browser.stdout.log'),out);writeFileSync(join(dir,'browser.stderr.log'),err);console.log(out,err);assert.equal(code,0,'browser audit failed');console.log('Evidence: '+dir);
}finally{if(child.exitCode===null){child.kill();await ended;}await new Promise(r=>upstream.close(r));writeFileSync(join(dir,'server.log'),log);}
