/** Synthetic parameter credential adapter: no real token/registry values. */
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import {createServer,request} from 'node:http';import{createServer as netServer,connect}from'node:net';
import{gzipSync,brotliCompressSync,deflateSync}from'node:zlib';
import{randomBytes}from'node:crypto';
import{createContentSurface,contentConfig,mountContentSurface,listenContentSurface}from'../server/src/content-surface.ts';
import{registerSurface}from'../server/src/surfaces.ts';
const secret=randomBytes(24).toString('hex')+'+/=secret',key='token';
let checks=0,hits=0,reads=0,mode='safe',valid=true;const seen=[];const ok=(n,p)=>{assert.ok(p,n);checks++;console.log('PASS '+n)};
const free=async()=>{const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
const up=createServer((q,s)=>{hits++;const u=new URL(q.url,'http://fixture.invalid');seen.push({has_server_secret:u.searchParams.get(key)===secret,credential_count:u.searchParams.getAll(key).length,ordinary:u.searchParams.get('page')});
 let body=Buffer.from('safe-content');if(mode==='raw')body=Buffer.from(secret);if(mode==='encoded')body=Buffer.from(encodeURIComponent(secret));if(mode==='base64')body=Buffer.from(Buffer.from(secret).toString('base64'));if(mode==='split')body=Buffer.from('before-'+secret+'-after');
 if(mode==='header')s.setHeader('X-Echo',secret);if(mode==='cookie')s.setHeader('Set-Cookie','upstream='+secret);if(mode==='redirect')s.setHeader('Location','/next?token='+encodeURIComponent(secret));if(mode==='cross')s.setHeader('Location','http://different.invalid/');if(mode==='safe-redirect'){s.statusCode=302;s.setHeader('Location','/ok?page=2')}
 if(['gzip','br','deflate'].includes(mode)){body=Buffer.from(secret);body=mode==='gzip'?gzipSync(body):mode==='br'?brotliCompressSync(body):deflateSync(body);s.setHeader('Content-Encoding',mode)}
 if(mode==='safe-gzip'){body=gzipSync(body);s.setHeader('Content-Encoding','gzip')}
 if(mode==='unknown-encoding')s.setHeader('Content-Encoding','unsupported');if(mode==='large')body=Buffer.alloc(2*1024*1024+1,65);
 s.setHeader('Content-Type','text/plain');if(mode==='split'){const mid=Math.floor(body.length/2);s.write(body.subarray(0,mid));s.end(body.subarray(mid));}else s.end(body);
});await new Promise(r=>up.listen(0,'127.0.0.1',r));
const mp=await free(),cp=await free(),market='http://127.0.0.1:'+mp,origin='http://w-1-test.internal:'+cp,pinned='http://127.0.0.1:'+up.address().port+'/';
const cfg={host:'127.0.0.1',port:cp,marketOrigin:market,targets:[{id:1,origin,upstreamUrl:pinned,queryCredentialKeys:[key]}]};let privateUrl=pinned+'?token='+encodeURIComponent(secret);
const runtime=createContentSurface(cfg,{viewer:async()=>valid?{subject:'synthetic',internal:true}:null,upstream:()=>{reads++;return {url:privateUrl}}});
const app=express();mountContentSurface(app,runtime);app.use(runtime.launch);const marketServer=registerSurface(app,'market',mp,undefined,'127.0.0.1'),contentServer=listenContentSurface(app,cfg,runtime);
const send=(port,path,headers={},method='GET',body)=>new Promise((r,j)=>{const q=request({host:'127.0.0.1',port,path,method,headers},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>r({status:s.statusCode,text,headers:s.headers}))});q.on('error',j);q.end(body)});
const get=(path='/go/1/resource?page=1',cookieValue=cookie)=>send(cp,path,{Host:new URL(origin).host,...(cookieValue?{Cookie:cookieValue}:{})});
const denySafe=r=>r.status===502&&!r.text.includes(secret)&&!JSON.stringify(r.headers).includes(secret)&&!r.headers.location;
let cookie='';
try{
 const page=await send(mp,'/content/open/1',{Cookie:'session_id=synthetic1234567890'});ok('launch page has no parameter value',page.status===200&&!page.text.includes(secret));const ticket=/name="ticket" value="([^"]+)"/.exec(page.text)[1];
 const exchange=await send(cp,'/__wm/launch',{Host:new URL(origin).host,Origin:market,'Content-Type':'application/x-www-form-urlencoded'},'POST','ticket='+ticket);cookie=exchange.headers['set-cookie'][0].split(';')[0];ok('exchange document and cookie contain no credential',exchange.status===200&&!exchange.text.includes(secret)&&!cookie.includes(secret));
 const r=await get();ok('safe response succeeds without secret',r.status===200&&r.text==='safe-content'&&!JSON.stringify(r.headers).includes(secret));ok('server injects one private query and preserves ordinary query',seen.at(-1).has_server_secret&&seen.at(-1).credential_count===1&&seen.at(-1).ordinary==='1');
 for(const suffix of ['?token=browser-value','?TOKEN=browser-value','?%74oken=browser-value','?token=one&token=two']){const n=hits,rr=reads;ok('browser cannot supply declared credential '+suffix,(await get('/go/1/'+suffix)).status===400);ok('query denial before private config read',hits===n&&reads===rr)}
 for(const value of ['raw','encoded','base64','split','header','cookie','redirect','cross','gzip','br','deflate','unknown-encoding','large']){mode=value;ok('response fails closed '+value,denySafe(await get()))}
 mode='safe-gzip';const compressed=await get();ok('safe compressed reply decoded within bound',compressed.status===200&&compressed.text==='safe-content'&&!compressed.headers['content-encoding']);
 mode='safe-redirect';const redirect=await get();ok('safe same-target redirect contains no secret',redirect.status===302&&redirect.headers.location==='/go/1/ok?page=2'&&!JSON.stringify(redirect).includes(secret));
 mode='safe';privateUrl=pinned+'?token=one&token=two';const n=hits;ok('duplicate configured parameter denied',(await get()).status===503&&hits===n);privateUrl=pinned+'?token='+encodeURIComponent(secret)+'&unexpected=1';ok('unpinned ordinary query change denied',(await get()).status===503&&hits===n);privateUrl=pinned+'?token='+encodeURIComponent(secret);
 const old=hits;valid=false;ok('revoked viewer never contacts secret target',(await get()).status===401&&hits===old);valid=true;
 const relaunched=await send(mp,'/content/open/1',{Cookie:'session_id=synthetic1234567890'});const newTicket=/name="ticket" value="([^"]+)"/.exec(relaunched.text)[1];const again=await send(cp,'/__wm/launch',{Host:new URL(origin).host,Origin:market,'Content-Type':'application/x-www-form-urlencoded'},'POST','ticket='+newTicket);cookie=again.headers['set-cookie'][0].split(';')[0];
 const before=reads;const ws=await new Promise((r,j)=>{const s=connect(cp,'127.0.0.1');let text='';s.on('connect',()=>s.write(['GET /go/1/socket HTTP/1.1','Host: '+new URL(origin).host,'Cookie: '+cookie,'Connection: Upgrade','Upgrade: websocket','',''].join(String.fromCharCode(13,10))));s.on('data',b=>text+=b);s.on('end',()=>r(text));s.on('error',j)});ok('query credential WS rejected before private config',ws.includes('403 Forbidden')&&reads===before&&hits===old);
 const env={WM_CONTENT_PORT:String(cp),WM_CONTENT_IP:'127.0.0.1',WM_CONTENT_MARKET_ORIGIN:market,WM_CONTENT_TARGETS:JSON.stringify(cfg.targets)};ok('credential key-only configuration accepted',contentConfig(env).targets[0].queryCredentialKeys[0]===key);
 for(const keys of [[],['token','TOKEN'],['bad key'],[1]]){assert.throws(()=>contentConfig({...env,WM_CONTENT_TARGETS:JSON.stringify([{...cfg.targets[0],queryCredentialKeys:keys}])}));checks++}
 assert.throws(()=>contentConfig({...env,WM_CONTENT_TARGETS:JSON.stringify([{...cfg.targets[0],upstreamUrl:privateUrl}])}));checks++;
 console.log(JSON.stringify({checks,hits,private_config_reads:reads,production:false,limits:'known literal/URL/base64 echo guard; arbitrary transformed covert leakage is NOT proven absent'}));
}finally{await Promise.all([new Promise(r=>marketServer.close(r)),new Promise(r=>contentServer.close(r)),new Promise(r=>up.close(r))])}
