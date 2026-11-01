import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createContentAccess,contentSurfaceFence,contentLaunchPage} from '../server/src/content-access.ts';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../server/package.json',import.meta.url));const express=require('express');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
const a='http://w-1-test.internal:18080',b='http://w-2-test.internal:18080',market='http://market.invalid:9800';
let at=1000000,epoch='rev1';
const access=createContentAccess([{id:1,origin:a},{id:2,origin:b}],market,s=>s==='user:fixture'?epoch:null,()=>at);
const viewer={subject:'user:fixture',internal:true,epoch:'rev1'};
function req(host='w-1-test.internal:18080',path='/go/1/',headers={},method='GET'){
 const h={host,...headers};return {url:path,method,headers:h,rawHeaders:Object.entries(h).flatMap(([k,v])=>[k,v])};
}
const launch=(target=1)=>{
 const t=access.issueLaunch(target,viewer);const host=target===1?'w-1-test.internal:18080':'w-2-test.internal:18080';
 const result=access.exchange(req(host,'/__wm/launch',{origin:market},'POST'),t);assert.ok(result);return {ticket:t,result,cookie:result.cookie.split(';')[0]};
};
check('config duplicate target fail closed',()=>assert.throws(()=>createContentAccess([{id:1,origin:a},{id:1,origin:b}],market,()=>epoch)));
check('config wrong target hostname',()=>assert.throws(()=>createContentAccess([{id:3,origin:a}],market,()=>epoch)));
for(const host of ['127.0.0.1:18080','unknown.internal:18080','w-1-test.internal:18081','w-1.gray.internal:18080','w-1-test.internal:18080@x'])check('reject Host '+host,()=>assert.equal(access.resolve(req(host)),null));
check('ignore forged forwarded authority',()=>assert.equal(access.resolve(req('unknown.internal:18080','/go/1/',{'x-forwarded-host':'w-1-test.internal:18080'})),null));
check('duplicate raw Host rejected',()=>{const q=req();q.rawHeaders.push('Host',q.headers.host);assert.equal(access.resolve(q),null)});
for(const path of ['http://w-1-test.internal:18080/go/1/','//evil/go/1/','/go/2/','/go/1/../2/','/go/%31/','/go/1/%2e%2e/'])check('reject ambiguous path '+path,()=>assert.equal(access.resolve(req(undefined,path)),null));
for(const path of ['/go/1/%E4%B8%AD%E6%96%87%20file.html','/go/1/a%20b'])check('allow encoded resource '+path,()=>assert.equal(access.resolve(req(undefined,path)).id,1));
for(const path of ['/go/1/%2fapi','/go/1/%5capi','/go/1/%252e%252e','/go/1/%00','/go/1/%zz'])check('reject encoded boundary '+path,()=>assert.equal(access.resolve(req(undefined,path)),null));
check('bounce must be a committed 200 document',()=>{const p=contentLaunchPage('/go/1/');assert.equal(p.status,200);assert.equal(p.headers.location,undefined);assert.match(p.html,/location.replace/);assert.throws(()=>contentLaunchPage('//evil'))});
check('uppercase and terminal dot normalized',()=>assert.equal(access.resolve(req('W-1-TEST.INTERNAL.:18080')).id,1));
check('anonymous context cannot be minted',()=>assert.throws(()=>access.issueLaunch(1,{...viewer,internal:false})));
check('revoked viewer cannot mint',()=>assert.throws(()=>access.issueLaunch(1,{...viewer,epoch:'old'})));
const t=access.issueLaunch(1,viewer);
check('wrong launch Origin denied without consuming',()=>assert.equal(access.exchange(req(undefined,'/__wm/launch',{origin:b},'POST'),t),null));
check('cross-target launch denied without consuming',()=>assert.equal(access.exchange(req('w-2-test.internal:18080','/__wm/launch',{origin:market},'POST'),t),null));
const x=access.exchange(req(undefined,'/__wm/launch',{origin:market},'POST'),t);assert.ok(x);const cookie=x.cookie.split(';')[0];
check('launch cookie strict host-only HttpOnly',()=>{assert.match(x.cookie,/HttpOnly; SameSite=Strict/);assert.equal(/Domain=/i.test(x.cookie),false)});
check('launch is single use',()=>assert.equal(access.exchange(req(undefined,'/__wm/launch',{origin:market},'POST'),t),null));
check('own valid GET without Origin or Fetch Metadata allowed',()=>assert.equal(access.admit(req(undefined,undefined,{cookie})).target.id,1));
check('own Origin allowed',()=>assert.equal(access.admit(req(undefined,undefined,{cookie,origin:a})).subject,'user:fixture'));
for(const origin of [b,market,'null',a+'/path','https://w-1-test.internal:18080'])check('reject Origin '+origin,()=>assert.equal(access.admit(req(undefined,undefined,{cookie,origin})),null));
check('cross-target cookie rejected',()=>assert.equal(access.admit(req('w-2-test.internal:18080','/go/2/',{cookie})),null));
check('duplicate context cookie rejected',()=>assert.equal(access.admit(req(undefined,undefined,{cookie:cookie+'; '+cookie})),null));
check('tampered signature rejected',()=>assert.equal(access.admit(req(undefined,undefined,{cookie:cookie.slice(0,-1)+(cookie.endsWith('A')?'B':'A')})),null));
check('expiry rejected',()=>{at+=300001;assert.equal(access.admit(req(undefined,undefined,{cookie})),null)});
const live=launch();check('immediate revocation callback',()=>{epoch='rev2';assert.equal(access.admit(req(undefined,undefined,{cookie:live.cookie})),null);epoch='rev1'});
check('restart invalidates previous context',()=>assert.equal(createContentAccess([{id:1,origin:a}],market,()=>epoch).admit(req(undefined,undefined,{cookie:live.cookie})),null));
// Real HTTP + WS ingress fixture. Successful admission is the only path to the
// counted fake credential lookup/upstream side effect; production registers no sink.
let credentialsRead=0,upstream=0;
const allowed=()=>{credentialsRead++;upstream++};
const app=express();app.use(contentSurfaceFence(access));app.use((q,s)=>{if(!access.admit(q)){s.status(403).type('text').send('Forbidden');return}allowed();s.end('ok')});const server=createServer(app);
server.on('upgrade',(q,s)=>{if(!access.admit(q)){s.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return}allowed();s.end('HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const get=(headers,method='GET',path='/go/1/')=>new Promise((resolve,reject)=>{const q=httpRequest({host:'127.0.0.1',port,path,method,headers},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))});q.on('error',reject);q.end()});
try {
 const good=launch().cookie;
 for(const p of ['/api/workbenches','/API/workbenches','/mcp','/MCP','/sop/any/','/apps/any/','/','/go/2/']){assert.equal(await get({Host:'w-1-test.internal:18080',Cookie:good},'GET',p),404);checks++;console.log('PASS content shared-app fence '+p)}
 assert.equal(await get({Host:'w-1-test.internal:18080',Cookie:good}),200);checks++;console.log('PASS real own HTTP positive');
 for(const [headers,status] of [[{Host:'w-1-test.internal:18080'},403],[{Host:'w-1-test.internal:18080',Cookie:good,Origin:b},403],[{Host:'127.0.0.1:'+port,Cookie:good},404],[{Host:'w-2-test.internal:18080',Cookie:good},404]]){assert.equal(await get(headers,'POST'),status);checks++;console.log('PASS simple POST denied before fake credentials '+status)}
 const badWs=await new Promise((resolve,reject)=>{const s=connect(port,'127.0.0.1');let out='';s.on('connect',()=>s.write('GET /go/1/ HTTP/1.1\r\nHost: w-1-test.internal:18080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: '+b+'\r\nCookie: '+good+'\r\n\r\n'));s.on('data',x=>out+=x);s.on('end',()=>resolve(out));s.on('error',reject)});
 check('real cross-site WS denied',()=>assert.match(badWs,/403 Forbidden/));
 check('all denials zero credential/upstream increments',()=>{assert.equal(credentialsRead,1);assert.equal(upstream,1)});
}finally{await new Promise(r=>server.close(r))}
console.log(checks+' content gate checks passed; no production wiring or secrets');
