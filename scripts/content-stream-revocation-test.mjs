/** Actual open HTTP/upgrade transport revocation; synthetic identity/upstream only. */
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import {createServer,request} from 'node:http';
import {connect,createServer as netServer} from 'node:net';
import {once} from 'node:events';
import {createContentSurface,mountContentSurface,listenContentSurface,watchContentConnection} from '../server/src/content-surface.ts';
import {registerSurface} from '../server/src/surfaces.ts';
let checks=0;const check=(n,p)=>{assert.ok(p,n);checks++;console.log('PASS '+n)};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const within=async(p,ms,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' deadline')),ms)})])}finally{clearTimeout(timer)}};
const free=async()=>{const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
let mode='valid',now=1000,upstreamMessages=0,identityChecks=0,activeHttp=0,activeWs=0;
const sockets=new Set();
const upstream=createServer((q,s)=>{activeHttp++;s.writeHead(200,{'content-type':'text/plain'});s.write('ready');const timer=setInterval(()=>s.write('tick'),40);s.once('close',()=>{clearInterval(timer);activeHttp--})});
upstream.on('upgrade',(q,s,head)=>{activeWs++;sockets.add(s);s.write(['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade','',''].join(String.fromCharCode(13,10)));const timer=setInterval(()=>s.write('tick'),40);s.on('data',b=>{upstreamMessages++;s.write(b)});if(head.length){upstreamMessages++;s.write(head)}s.on('error',()=>{});s.once('close',()=>{clearInterval(timer);sockets.delete(s);activeWs--})});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const mp=await free(),cp=await free(),origin='http://w-1-test.internal:'+cp,market='http://127.0.0.1:'+mp;
const config={host:'127.0.0.1',port:cp,marketOrigin:market,targets:[{id:1,origin,upstreamUrl:'http://127.0.0.1:'+upstream.address().port}]};
const runtime=createContentSurface(config,{now:()=>now,viewer:async()=>{identityChecks++;if(mode==='throw')throw Error('synthetic unavailable');if(mode==='hang')return new Promise(()=>{});return mode==='valid'?{subject:'user:synthetic',internal:true}:null},upstream:()=>({url:config.targets[0].upstreamUrl})});
const app=express();mountContentSurface(app,runtime);app.use((q,s,n)=>runtime.launch(q,s,n));
const marketServer=registerSurface(app,'market',mp,undefined,'127.0.0.1'),contentServer=listenContentSurface(app,config,runtime);
const send=(p,path,headers={},method='GET',body)=>new Promise((resolve,reject)=>{const q=request({host:'127.0.0.1',port:p,path,method,headers},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>resolve({status:s.statusCode,text,headers:s.headers}))});q.on('error',reject);q.end(body)});
const launch=async()=>{mode='valid';const p=await send(mp,'/content/open/1',{Cookie:'session_id=synthetic1234567890'});const ticket=/name="ticket" value="([^"]+)"/.exec(p.text)[1];const x=await send(cp,'/__wm/launch',{Host:new URL(origin).host,Origin:market,'Content-Type':'application/x-www-form-urlencoded'},'POST','ticket='+ticket);assert.equal(x.status,200);return x.headers['set-cookie'][0].split(';')[0]};
const openHttp=cookie=>new Promise((resolve,reject)=>{const q=request({host:'127.0.0.1',port:cp,path:'/go/1/stream',headers:{Host:new URL(origin).host,Cookie:cookie}},s=>{const state={q,s,bytes:0,closed:false};s.on('data',b=>state.bytes+=b.length);s.on('error',()=>{});state.done=new Promise(r=>s.once('close',()=>{state.closed=true;r()}));s.once('data',()=>resolve(state))});q.on('error',reject);q.end()});
const openWs=cookie=>new Promise((resolve,reject)=>{const s=connect(cp,'127.0.0.1');let header='';const state={s,bytes:0,closed:false};state.done=new Promise(r=>s.once('close',()=>{state.closed=true;r()}));s.on('error',()=>{});s.once('error',reject);s.on('connect',()=>s.write(['GET /go/1/socket HTTP/1.1','Host: '+new URL(origin).host,'Cookie: '+cookie,'Origin: '+origin,'Connection: Upgrade','Upgrade: websocket','',''].join(String.fromCharCode(13,10))));s.on('data',b=>{state.bytes+=b.length;if(header!==null){header+=b.toString();if(header.includes(String.fromCharCode(13,10,13,10))){assert.ok(header.startsWith('HTTP/1.1 101'));header=null;resolve(state)}}})});
const results=[];
try{
 for(const reason of ['revoked','throw','hang','hard-expiry']){
  const cookie=await launch(),http=await openHttp(cookie),ws=await openWs(cookie);
  ws.s.write('pre-revocation-probe');await delay(80);check(reason+' open transports receive before revocation',http.bytes>5&&ws.bytes>0&&upstreamMessages>0);
  const started=Date.now();if(reason==='hard-expiry')now+=300001;else mode=reason;
  await within(Promise.all([http.done,ws.done]),12000,reason);const ms=Date.now()-started;
  check(reason+' old HTTP/upgrade both disconnected',http.closed&&ws.closed&&ms<11000);
  const bytes=[http.bytes,ws.bytes],messages=upstreamMessages;await delay(100);
  check(reason+' old connection receives nothing after disconnect',http.bytes===bytes[0]&&ws.bytes===bytes[1]);
  ws.s.write('post-revocation-probe',()=>{});await delay(60);check(reason+' old connection sends nothing upstream',upstreamMessages===messages);
  await within((async()=>{while(activeHttp||activeWs)await delay(10)})(),1000,'upstream cleanup');check(reason+' both upstream transports closed',activeHttp===0&&activeWs===0);
  results.push({reason,disconnect_ms:ms});mode='valid';
 }
 let disconnected=0;await within(new Promise(resolve=>{watchContentConnection(()=>new Promise(()=>{}),Date.now()+40,()=>{disconnected++;resolve()},{intervalMs:10,timeoutMs:200})}),200,'independent hard expiry');check('hard expiry preempts hanging recheck',disconnected===1);
 let calls=0;const stop=watchContentConnection(async()=>{calls++;return true},Date.now()+1000,()=>assert.fail('cancelled monitor disconnected'),{intervalMs:10,timeoutMs:20});stop();await delay(40);check('finished connection cancels pending timers',calls===0);
 console.log(JSON.stringify({checks,results,identityChecks,scope:'real HTTP streams and raw HTTP101 duplex; fake identity, not browser frame parser',production:false}));
}finally{mode='revoked';for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>marketServer.close(r)),new Promise(r=>contentServer.close(r)),new Promise(r=>upstream.close(r))])}
