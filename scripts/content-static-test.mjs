/** Synthetic published static assets; no live db, upstream or credentials. */
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import {request} from 'node:http';import{createServer,connect}from'node:net';
import{mkdtempSync,mkdirSync,writeFileSync,symlinkSync,unlinkSync,existsSync}from'node:fs';import{resolve,join}from'node:path';
import{createContentSurface,contentConfig,mountContentSurface,listenContentSurface}from'../server/src/content-surface.ts';
import{registerSurface}from'../server/src/surfaces.ts';
mkdirSync('tmp',{recursive:true});const out=mkdtempSync(resolve('tmp/content-static-')),root=join(out,'active');mkdirSync(root);mkdirSync(join(root,'assets'));mkdirSync(join(root,'nested'));mkdirSync(join(root,'目录'));
const html='<!doctype html><h1>static-fixture</h1><script src="assets/app.js"></script>';writeFileSync(join(root,'index.html'),html);writeFileSync(join(root,'assets/app.js'),'window.relativeResource=true;');writeFileSync(join(root,'assets/style.css'),'h1{color:navy}');writeFileSync(join(root,'nested/index.html'),'nested-fixture');writeFileSync(join(root,'目录/文件.txt'),'中文静态');writeFileSync(join(out,'outside.txt'),'outside-sentinel');
let checks=0,metadataReads=0,credentialReads=0,allowed=true,currentUrl='/apps/alpha/';const ok=(n,p)=>{assert.ok(p,n);checks++;console.log('PASS '+n)};
const free=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};const mp=await free(),cp=await free(),market='http://127.0.0.1:'+mp,origin='http://w-1-test.internal:'+cp;
const cfg={host:'127.0.0.1',port:cp,marketOrigin:market,targets:[{id:1,origin,upstreamUrl:'/apps/alpha/'},{id:2,origin:'http://w-2-test.internal:'+cp,upstreamUrl:'/apps/beta/'}]};
try {
 const config=contentConfig({WM_CONTENT_PORT:String(cp),WM_CONTENT_IP:'127.0.0.1',WM_CONTENT_MARKET_ORIGIN:market,WM_CONTENT_TARGETS:JSON.stringify(cfg.targets)});
 ok('trusted config accepts pinned local static target',config.targets[0].upstreamUrl==='/apps/alpha/');
 const runtime=createContentSurface(cfg,{viewer:async()=>allowed?{subject:'synthetic',internal:true}:null,upstream:()=>{credentialReads++;throw Error('must never read upstream credential')},staticTarget:id=>{metadataReads++;return {url:currentUrl,root,version:3}}});
 const app=express();mountContentSurface(app,runtime);app.use(runtime.launch);const ms=registerSurface(app,'market',mp,undefined,'127.0.0.1'),cs=listenContentSurface(app,cfg,runtime);
 const send=(port,path,headers={},method='GET')=>new Promise((r,j)=>{const q=request({host:'127.0.0.1',port,path,method,headers},s=>{let body='';s.on('data',b=>body+=b);s.on('end',()=>r({status:s.statusCode,headers:s.headers,body}))});q.on('error',j);q.end()});const get=(path,method='GET',auth=cookie)=>send(cp,path,{Host:new URL(origin).host,...(auth?{Cookie:auth}:{})},method);let cookie='';
 try {
  const start=await send(mp,'/content/open/1',{Cookie:'session_id=synthetic1234567890'}),ticket=/name="ticket" value="([^"]+)"/.exec(start.body)[1];const exchanged=await new Promise((r,j)=>{const body='ticket='+ticket,q=request({host:'127.0.0.1',port:cp,path:'/__wm/launch',method:'POST',headers:{Host:new URL(origin).host,Origin:market,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},s=>{s.resume();s.on('end',()=>r({status:s.statusCode,headers:s.headers}))});q.on('error',j);q.end(body)});assert.equal(exchanged.status,200);cookie=exchanged.headers['set-cookie'][0].split(';')[0];
  ok('launch does not read asset metadata or credentials',metadataReads===0&&credentialReads===0);
  const index=await get('/go/1/');ok('serves only active target index bytes',index.status===200&&index.body===html&&index.headers['x-app-version']==='v3');ok('no app/admin/session token injection',!index.body.includes('WM_APP_TOKEN')&&!index.body.includes('wm-app-token')&&!index.headers['set-cookie']);
  const js=await get('/go/1/assets/app.js');ok('relative JavaScript bytes and type',js.status===200&&js.body==='window.relativeResource=true;'&&/javascript/.test(js.headers['content-type']));
  const css=await get('/GO/1/assets/style.css');ok('case prefix and relative CSS',css.status===200&&/text[/]css/.test(css.headers['content-type']));
  const head=await get('/go/1/assets/app.js','HEAD');ok('HEAD sends metadata not file body',head.status===200&&head.body===''&&Number(head.headers['content-length'])===Buffer.byteLength(js.body));
  ok('nested trailing slash resolves local index',(await get('/go/1/nested/')).body==='nested-fixture');ok('single UTF8 decode supports local resource',(await get('/go/1/'+encodeURIComponent('目录')+'/'+encodeURIComponent('文件.txt'))).body==='中文静态');
  ok('version query never selects old version',(await get('/go/1/?version=1')).headers['x-app-version']==='v3');ok('missing route never falls back SPA',(await get('/go/1/missing-route')).status===404);
  for(const path of ['/go/1/../outside.txt','/go/1/%2e%2e/outside.txt','/go/1/%252e%252e/outside.txt','/go/1/%2fapi','/go/1/assets//app.js','/go/1/C:/outside.txt','/go/1/file.txt:secret','/go/2/','/api/apps/alpha/data','/apps/beta/','/sop/anything/','/mcp'])ok('reject boundary '+path,(await get(path)).status===404);
  const before=metadataReads;for(const method of ['POST','PUT','PATCH','DELETE'])ok('read-only rejects '+method,(await get('/go/1/',method)).status===405);ok('write rejection before asset metadata read',metadataReads===before);
  ok('unauthenticated file request401',(await get('/go/1/assets/app.js','GET','')).status===401);ok('unauthenticated no metadata read',metadataReads===before);
  currentUrl='/apps/beta/';ok('registry target reassignment503',(await get('/go/1/')).status===503);currentUrl='/apps/alpha/';
  symlinkSync(out,join(root,'escape'),'junction');ok('symlink directory cannot escape target',(await get('/go/1/escape/outside.txt')).status===404);
  allowed=false;const prior=metadataReads;ok('revoked viewer401',(await get('/go/1/')).status===401);ok('revocation before file metadata',metadataReads===prior);ok('never called upstream credential adapter',credentialReads===0);
  console.log(JSON.stringify({checks,metadataReads,credentialReads,production:false,scope:'shared-app static asset adapter, synthetic filesystem'}));
 } finally {await Promise.all([new Promise(r=>ms.close(r)),new Promise(r=>cs.close(r))])}
}finally{if(existsSync(join(root,'escape')))unlinkSync(join(root,'escape'));/* keep fixture and evidence under workspace tmp */}
