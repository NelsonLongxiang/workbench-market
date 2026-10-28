// Test-owned fixtures only. No auth/session implementation is provided here.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as tcpServer,connect} from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync,backup} from 'node:sqlite';
export class MissingFixture extends Error {}
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function allocatePort(){const s=tcpServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));assert.notEqual(port,9800);return port;}
export async function upstream(){
 const requests=[];const sockets=new Set();
 const server=httpServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({method:req.method,path:req.url,headers:{...req.headers},body});
  if(req.url.startsWith('/unauthorized')){res.writeHead(401);res.end('upstream denied');return;}
  if(req.url.startsWith('/forbidden')){res.writeHead(403);res.end('upstream denied');return;}
  res.writeHead(200,{'content-type':req.headers.accept?.includes('text/html')?'text/html':'application/json'});res.end(req.headers.accept?.includes('text/html')?'<html><h1>fixture target</h1></html>':JSON.stringify({ok:true,body}));
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 server.on('upgrade',(req,socket)=>{requests.push({method:'UPGRADE',path:req.url,headers:{...req.headers}});const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',()=>{});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {base:'http://127.0.0.1:'+server.address().port,requests,async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
export function wsHandshake(base,path,headers={}){
 return new Promise((resolve,reject)=>{const u=new URL(base);const socket=connect({host:'127.0.0.1',port:Number(u.port)});let bytes='';let done=false;const timer=setTimeout(()=>{socket.destroy();reject(new MissingFixture('WS handshake timeout'));},3000);
  socket.on('connect',()=>socket.write(['GET '+path+' HTTP/1.1','Host: '+u.host,'Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Key: '+randomBytes(16).toString('base64'),'Sec-WebSocket-Version: 13',...Object.entries(headers).map(([k,v])=>k+': '+v),'',''].join('\r\n')));
  socket.on('data',b=>{bytes+=b.toString();if(!done&&bytes.includes('\r\n\r\n')){done=true;clearTimeout(timer);const status=Number(/^HTTP[/]1[.][01] (\d+)/.exec(bytes)?.[1]);resolve({status,raw_status:bytes.split('\r\n')[0],socket,async frames(){for(let i=0;i<3;i++){const payload=Buffer.from('x');const mask=Buffer.from([1,2,3,4]);socket.write(Buffer.concat([Buffer.from([0x81,0x81]),mask,Buffer.from([payload[0]^mask[0]])]));}await pause(60);},close(){socket.destroy();}});}});
  socket.on('error',e=>{clearTimeout(timer);if(!done)reject(e);});socket.on('end',()=>{if(!done){clearTimeout(timer);reject(new MissingFixture('WS ended before HTTP response'));}});
 });
}
export async function startInstance(root,extra={},options={}){
 const target=join(root,'target'),port=await allocatePort(),base='http://127.0.0.1:'+port;
 const dir=options.dir??mkdtempSync(join(root,'run-'));const admin=options.keyless?undefined:'fixture-control-880';
 const env={...process.env,PORT:String(port),DATA_DIR:dir,MCP_GATEWAY:'',REDIS_URL:'',LAYERFS_SERVICE_URL:'',WM_SSO:'on',MARKET_PUBLIC_URL:base,...extra};
 for(const key of ['PEER','A2A_API_KEY','AI_GATEWAY_API_KEY','SANDBOX_BRIDGE_URL','SANDBOX_BRIDGE_TOKEN','EVAL_GATEWAY_URL'])delete env[key];
 if(admin)env.ADMIN_TOKEN=admin;else delete env.ADMIN_TOKEN;
 for(const [k,v]of Object.entries(env))if(v===null)delete env[k];
 let log='',closed=false;const cmd=[process.execPath,'--disable-warning=ExperimentalWarning','server/src/index.ts'];
 const child=spawn(cmd[0],cmd.slice(1),{cwd:target,env,stdio:['ignore','pipe','pipe']});
 child.on('error',()=>{});child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
 const requests=[];
 const instance={root,target,base,port,dir,admin,env,child,cmd,requests,get log(){return log},ready:false,listenerOwners:[],async close(){if(closed)return;closed=true;if(child.exitCode===null&&child.signalCode===null){const p=once(child,'close');child.kill();await p;}},
  async request(path,{method='GET',body,raw,token=false,cookie,origin=true,headers={},localAddress}={}){
   const hdr={...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...(token&&admin?{'x-admin-token':admin}:{}),...(origin?{origin:env.MARKET_PUBLIC_URL??base}:{}),...(cookie?{cookie}:{})};
   for(const [key,value]of Object.entries(headers))hdr[key.toLowerCase()]=value; // case-insensitive override; never duplicate Origin
   const payload=raw??(body===undefined?undefined:JSON.stringify(body));
   if(localAddress){
    const {request}=await import('node:http');
    return await new Promise((resolve,reject)=>{
     const req=request(base+path,{method,headers:hdr,localAddress},res=>{
      let text='';res.on('data',c=>text+=c);
      res.on('end',()=>{let json;try{json=JSON.parse(text)}catch{}resolve({status:res.statusCode,text,json,headers:res.headers,cookie:String(res.headers['set-cookie']?.[0]??'')});});
     });
     req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('request timeout')));req.end(payload);
    });
   }
   const res=await fetch(base+path,{method,headers:hdr,body:payload,redirect:'manual',signal:AbortSignal.timeout(3500)});const text=await res.text();let json;try{json=JSON.parse(text)}catch{}const response={status:res.status,text,json,headers:Object.fromEntries(res.headers),cookie:res.headers.get('set-cookie')??''};requests.push({method,path,request:redact({headers:hdr,body:body??raw}),response:redact({status:response.status,body:json??text.slice(0,1000),headers:response.headers})});return response;
  }};
 for(let i=0;i<70;i++){if(child.exitCode!==null)break;try{const x=await instance.request('/api/health',{origin:false});if(x.status===200){instance.ready=true;break;}}catch{}await pause(70);}
 if(instance.ready&&process.platform==='win32'){instance.listenerOwners=execFileSync('pwsh',['-NoProfile','-Command','Get-NetTCPConnection -LocalPort '+port+' -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess'],{encoding:'utf8'}).trim().split(/\s+/).map(Number);assert.ok(instance.listenerOwners.length&&instance.listenerOwners.every(p=>p===child.pid),'listener belongs to wrong process');}
 return instance;
}
export async function createUser(i,name='fixture-user',password='fixture-password-880'){
 const r=await i.request('/api/auth/register',{method:'POST',token:true,body:{username:name,password}});
 if(r.status!==201||!r.json?.user?.id)throw new MissingFixture('business prerequisite register unavailable: HTTP '+r.status);return {...r.json.user,password};
}
export async function signIn(i,u,extra={}){
 const r=await i.request('/api/auth/login',{method:'POST',body:{username:u.username,password:u.password},...extra});if(r.status!==200||!r.cookie.includes('wm_session='))throw new MissingFixture('business prerequisite login unavailable: HTTP '+r.status);return {cookie:r.cookie.split(';')[0],response:r,user:u};
}
export async function createWorkbench(i,target,name='fixture-external'){
 const r=await i.request('/api/workbenches',{method:'POST',token:true,body:{name,url:target}});assert.equal(r.status,201);assert.ok(r.json?.id);return r.json;
}
export async function setSso(i,id,body){return i.request('/api/workbenches/'+id+'/sso',{method:'PUT',token:true,body:{enabled:true,mode:'none',machine_auth:'none',...body}});}
export async function audit(i){const r=await i.request('/api/auth/audit?limit=200',{token:true});assert.equal(r.status,200);assert.ok(Array.isArray(r.json?.items));return r.json.items;}
export function snapshot(dbpath){const db=new DatabaseSync(dbpath,{readOnly:true});try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();return tables.map(t=>({table:t.name,rows:db.prepare('SELECT * FROM "'+t.name.replaceAll('"','""')+'" ORDER BY rowid').all()}));}finally{db.close();}}
export async function auditSnapshot(i,output){const source=new DatabaseSync(join(i.dir,'workbench-market.db'),{readOnly:true});try{await backup(source,output);}finally{source.close();}const copy=new DatabaseSync(output);const tables=copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().filter(t=>{const cols=copy.prepare('PRAGMA table_info("'+t.name.replaceAll('"','""')+'")').all().map(c=>c.name);return ['action','outcome','client_ip','subject_id','workbench_id'].every(c=>cols.includes(c));});if(tables.length!==1){copy.close();throw new MissingFixture('audit table identity not uniquely discoverable from public contract; material schema needed');}return {db:copy,table:tables[0].name};}
export const digest=b=>createHash('sha256').update(b).digest('hex');
export function redact(value){const clone=JSON.parse(JSON.stringify(value));function scrub(s){return s.replace(/WM_APP_TOKEN=["'][a-f0-9]+["']/g,'WM_APP_TOKEN=<redacted>').replace(/content=["'][a-f0-9]{64}["']/g,'content=<redacted>').replaceAll('fixture-control-880','<fixture-control>').replaceAll('fixture-password-880','<fixture-password>').replaceAll('fixture-upstream-secret','<fixture-upstream-secret>');}function walk(o){if(!o||typeof o!=='object')return;for(const k of Object.keys(o)){if(/password|cookie|authorization|token|salt|hash/i.test(k)&&!['cookie_present','hashes','source_hashes','token_configured','env_admin_token_present'].includes(k))o[k]='<redacted>';else if(typeof o[k]==='string')o[k]=scrub(o[k]);else walk(o[k]);}}walk(clone);return clone;}
