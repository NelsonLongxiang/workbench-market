/** Synthetic full index integration: explicit content listener, fresh Odoo adapter, real Chromium. */
import {createServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const out=resolve('tmp/content-index-browser-'+Date.now());mkdirSync(out,{recursive:true});
const free=async()=>{const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
let revoked=false,upstreamHits=0,identityChecks=0,leaked=false,wsOpened=0,wsMessages=0;
const wsSockets=new Set();
const odoo=createServer((q,s)=>{if(q.url==='/revoke'){revoked=true;s.end('ok');return}identityChecks++;s.setHeader('Content-Type','application/json');s.end(JSON.stringify({result:revoked?{uid:false}:{uid:1,username:'synthetic',name:'Synthetic',is_internal_user:true}}))});
const upstream=createServer((q,s)=>{if(q.url==='/__probe'){s.end('health');return}upstreamHits++;if(q.headers.cookie||q.headers['x-admin-token']||q.headers.authorization!=='Bearer synthetic-target')leaked=true;s.setHeader('Content-Type','text/html');s.end('<!doctype html><title>Synthetic content</title><h1>content-ok</h1>')});
upstream.on('upgrade',(q,s)=>{
 wsOpened++;wsSockets.add(s);if(q.headers.cookie||q.headers['x-admin-token']||q.headers.authorization!=='Bearer synthetic-target')leaked=true;
 const accept=createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 s.write(['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Accept: '+accept,'',''].join(String.fromCharCode(13,10)));
 const tick=()=>s.write(Buffer.from([0x81,4,116,105,99,107]));tick();const timer=setInterval(tick,50);
 s.on('data',()=>wsMessages++);s.on('error',()=>{});s.once('close',()=>{clearInterval(timer);wsSockets.delete(s)});
});
await new Promise(r=>odoo.listen(0,'127.0.0.1',r));await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const mp=await free(),cp=await free(),market='http://127.0.0.1:'+mp,content='http://w-2-test.internal:'+cp,odooOrigin='http://127.0.0.1:'+odoo.address().port,target='http://127.0.0.1:'+upstream.address().port;
const env={PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
const pre='import net from "node:net";const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==="number"&&typeof a[1]!=="string")a.splice(1,0,"127.0.0.1");return l.apply(this,a)};';
const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(pre),'--disable-warning=ExperimentalWarning','server/src/index.ts'],{env:{...env,PORT:String(mp),WM_CONTROL_PORT:'0',DATA_DIR:out+'/data',YGL_HOME:out+'/home',ADMIN_TOKEN:'synthetic-admin',MCP_GATEWAY:'on',WM_CONTENT_PORT:String(cp),WM_CONTENT_IP:'127.0.0.1',WM_CONTENT_MARKET_ORIGIN:market,WM_CONTENT_TARGETS:JSON.stringify([{id:2,origin:content,upstreamUrl:target,migrateBrowser:true}]),WM_CONTENT_ODOO_ORIGIN:odooOrigin,WM_ODOO_ORIGINS:odooOrigin},stdio:['ignore','ignore','pipe']});
const exited=once(child,'exit');let stderr='';child.stderr.on('data',b=>stderr+=b);
let code=1;
try{
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(market+'/api/health')).ok){ready=true;break}}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100))}if(!ready)throw Error('synthetic index not ready');
 const created=await fetch(market+'/api/workbenches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'synthetic-content',url:target,type:'web',health_path:'/__probe',auth:{type:'bearer',value:'synthetic-target'}})});const row=await created.json();if(created.status!==201||row.id!==2)throw Error('synthetic target fixture mismatch');
 const oldMachine=await fetch(market+'/go/2/__probe',{headers:{'User-Agent':'synthetic-node-probe'}});if(oldMachine.status!==200||await oldMachine.text()!=='health')throw Error('non-browser legacy path changed');
 const config=join(out,'config.json');writeFileSync(config,JSON.stringify({market,content,odoo:odooOrigin,result:join(out,'browser.json')}));
 const py=spawn(process.env.PYTHON||'python3',['scripts/content-index-browser.py',config],{env,stdio:'inherit'});code=await new Promise((r,j)=>{py.on('exit',r);py.on('error',j)});
 if(upstreamHits!==1||leaked||identityChecks<5||wsOpened!==1||wsMessages<1||wsSockets.size!==0){code=1;throw Error('upstream isolation/count invariant');}
}finally{
 if(child.exitCode===null&&child.signalCode===null){child.kill();await exited}
 for(const s of wsSockets)s.destroy();
 await Promise.all([new Promise(r=>odoo.close(r)),new Promise(r=>upstream.close(r))]);
 writeFileSync(join(out,'server.stderr.log'),stderr);writeFileSync(join(out,'result.json'),JSON.stringify({code,upstreamHits,identityChecks,leaked,wsOpened,wsMessages,wsRemaining:wsSockets.size,production:false,scope:'full index with fake Odoo+upstream; not real identity/network'},null,2));console.log(JSON.stringify({out,code,upstreamHits,identityChecks,leaked}));
}
process.exitCode=code??1;
