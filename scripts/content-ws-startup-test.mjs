/** Cold vs warm WS experiment. Synthetic direct viewer, not real Odoo or production. */
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import {createServer,request} from 'node:http';
import {createServer as netServer,connect} from 'node:net';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {channel} from 'node:diagnostics_channel';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContentSurface,mountContentSurface,listenContentSurface} from '../server/src/content-surface.ts';
import {registerSurface} from '../server/src/surfaces.ts';
const crlf=String.fromCharCode(13,10);
async function worker(rounds,prelude=false){
 const start=performance.now(),events=[],handshakes=[];let hits=0,reads=0,viewers=0,listenAt=0;
 const event=(name,data={})=>events.push({name,ms:performance.now()-start,...data});
 const dc=channel('http.client.request.start');
 const observe=({request:q})=>{if(q.getHeader('upgrade')!=='websocket')return;event('proxy-request',{reused:q.reusedSocket});q.on('error',e=>event('proxy-error',{code:e.code??'unknown',reused:q.reusedSocket}));q.on('upgrade',r=>event('proxy-upgrade',{status:r.statusCode}));q.on('response',r=>event('proxy-response',{status:r.statusCode}));q.on('socket',s=>{event('proxy-socket',{reused:q.reusedSocket,connecting:s.connecting});s.on('end',()=>event('proxy-socket-end'))})};dc.subscribe(observe);
 const upstream=createServer((q,s)=>{event('upstream-http',{path:q.url});if(q.url==='/base/redirect-local'){s.writeHead(302,{Location:'/base/ok'});s.end();return}if(q.url==='/base/redirect-cross'){s.writeHead(302,{Location:'http://other.invalid/base/ok','Content-Length':'999'});s.end();return}s.end('synthetic')});
 upstream.on('upgrade',(q,s)=>{hits++;event('upstream-upgrade');s.end(['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade','',''].join(crlf))});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));event('upstream-listening');
 const holders=[];let ports;try{for(let i=0;i<2;i++){const s=netServer();holders.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r))}ports=holders.map(s=>s.address().port)}finally{await Promise.all(holders.map(s=>new Promise(r=>s.close(r))))}
 const [mp,cp]=ports,market='http://127.0.0.1:'+mp,origin='http://w-1-test.internal:'+cp;
 const config={host:'127.0.0.1',port:cp,marketOrigin:market,targets:[{id:1,origin,upstreamUrl:'http://127.0.0.1:'+upstream.address().port+'/base'}]};
 event('config-ready');const runtime=createContentSurface(config,{viewer:async()=>{viewers++;event('viewer-begin');event('viewer-end');return{subject:'synthetic',internal:true}},upstream:()=>{reads++;event('credential-read');return{url:config.targets[0].upstreamUrl,authorization:'Bearer synthetic'}}});event('runtime-ready');
 const app=express();mountContentSurface(app,runtime);app.use(runtime.launch);const ms=registerSurface(app,'market',mp,undefined,'127.0.0.1'),cs=listenContentSurface(app,config,runtime);
 cs.prependListener('upgrade',()=>event('content-upgrade'));event('upgrade-handler-registered');
 await Promise.all([ms.listening?Promise.resolve():once(ms,'listening'),cs.listening?Promise.resolve():once(cs,'listening')]);listenAt=performance.now()-start;event('listeners-ready');
 const send=(port,path,headers={},body)=>new Promise((r,j)=>{const q=request({host:'127.0.0.1',port,path,method:body?'POST':'GET',headers:{...headers,...(body?{'Content-Length':Buffer.byteLength(body)}:{})}},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>r({status:s.statusCode,text,headers:s.headers}))});q.on('error',j);q.end(body)});
 try{
  const page=await send(mp,'/content/open/1',{Cookie:'session_id=synthetic1234567890'});assert.equal(page.status,200);const ticket=/name="ticket" value="([^"]+)"/.exec(page.text)[1];
  const exchange=await send(cp,'/__wm/launch',{Host:new URL(origin).host,Origin:market,'Content-Type':'application/x-www-form-urlencoded'},'ticket='+ticket);assert.equal(exchange.status,200);const cookie=exchange.headers['set-cookie'][0].split(';')[0];event('context-ready');
  if(prelude){for(const path of ['/go/1/resource?x=1','/go/1/redirect-local','/go/1/redirect-cross']){const r=await send(cp,path,{Host:new URL(origin).host,Cookie:cookie});event('http-prelude-done',{path,status:r.status})}}
  for(let i=0;i<rounds;i++){
   const elapsed=performance.now()-start;event('client-begin',{round:i+1});
   const result=await new Promise(r=>{const s=connect(cp,'127.0.0.1');let wire='',settled=false;const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);s.destroy();r({status:Number(/^HTTP[/]1[.]1 ([0-9]+)/.exec(wire)?.[1]??0),bytes:Buffer.byteLength(wire),error:error??null})};const timer=setTimeout(()=>done('fixture-timeout'),5000);s.on('connect',()=>s.write(['GET /go/1/socket HTTP/1.1','Host: '+new URL(origin).host,'Connection: Upgrade','Upgrade: websocket','Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version: 13','Origin: '+origin,'Cookie: '+cookie,'',''].join(crlf)));s.on('data',b=>wire+=b);s.on('end',()=>done());s.on('error',e=>done(e.code));});
   handshakes.push({round:i+1,listen_to_request_ms:elapsed-listenAt,elapsed_ms:performance.now()-start-elapsed,...result});event('client-done',{round:i+1,...result});
  }
 }finally{dc.unsubscribe(observe);await Promise.all([new Promise(r=>ms.close(r)),new Promise(r=>cs.close(r)),new Promise(r=>upstream.close(r))]);event('fixture-closed')}
 return{pid:process.pid,handshakes,events,hits,reads,viewers,scope:'real surface register/listen; immediate fake viewer; no external Odoo/DB startup or actual target'};
}
if(process.argv[2]==='--worker')console.log(JSON.stringify(await worker(Number(process.argv[3]??1),process.argv[4]==='prelude')));
else{
 const prelude=process.argv.includes('--prelude');
 const out=resolve('tmp/content-ws-startup-'+Date.now());mkdirSync(out,{recursive:true});const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 const run=async(label,n)=>{const p=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',String(n),prelude?'prelude':'direct'],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>p.kill(),30000);const code=await new Promise((r,j)=>{p.on('exit',r);p.on('error',j)});clearTimeout(timer);writeFileSync(join(out,label+'.stderr.log'),stderr);writeFileSync(join(out,label+'.stdout.log'),stdout);if(code!==0)return {setup_error:true,code,label,error_code:/code: '([^']+)'/.exec(stderr)?.[1]??'unknown'};const j=JSON.parse(stdout);writeFileSync(join(out,label+'.json'),JSON.stringify(j,null,2));return j};
 const cold=[],setupFailures=[];for(let i=0;cold.length<20&&i<40;i++){const r=await run('cold-'+(i+1),1);if(r.setup_error)setupFailures.push(r);else cold.push(r)}if(cold.length!==20)throw Error('Insufficient valid cold processes; inspect preserved setup failures');const warm=await run('warm',20);if(warm.setup_error)throw Error('Warm fixture setup failed; inspect preserved stderr');
 const coldRows=cold.flatMap(x=>x.handshakes),warmRows=warm.handshakes;
 const summary={out,prelude,setupFailures,cold:{processes:20,requests:coldRows.length,failures:coldRows.filter(x=>x.status!==101).length},warm:{processes:1,requests:warmRows.length,failures:warmRows.filter(x=>x.status!==101).length},scope:'synthetic surface only, not real Odoo/index cold startup; rates do not prove cause; mode0 STOP unrelated until evidenced'};
 writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}
