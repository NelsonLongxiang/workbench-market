import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { portalClientClass, portalTargetId, createPortalObservation } from '../server/src/portal-observation.ts';
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
for(const [headers,want] of [
 [{'sec-fetch-mode':'navigate','sec-fetch-dest':'document'},'browser-top-navigation'],
 [{'sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'},'browser-iframe'],
 [{'sec-fetch-mode':'cors','sec-fetch-dest':'empty'},'browser-fetch'],
 [{'user-agent':'curl/8.0'},'curl'],[{'user-agent':'node'},'node'],
 [{'user-agent':'python-httpx/1'},'python'],[{'user-agent':'example-mcp-client/1'},'mcp-client'],
 [{'user-agent':'Mozilla/5.0'},'other'],[{},'other'],
 [{'sec-fetch-site':'cross-site','user-agent':'curl/8'},'other'],
])check('coarse category '+want,()=>assert.equal(portalClientClass(headers),want));
for(const url of ['/go/0/','/go/01/','/go/-1/','/go/1evil/','/go/9007199254740992/','/api/go/1/'])
 check('reject unbounded/invalid target '+url,()=>assert.equal(portalTargetId(url),null));
const db=new DatabaseSync(':memory:');let clock=new Date('2026-10-30T23:59:59Z');
try {
 const observer=createPortalObservation(db,id=>id===7,()=>clock);
 const req={url:'/go/7/path?token=PRIVATE',headers:{'user-agent':'curl/8 PRIVATE-UA',cookie:'SECRET',authorization:'SECRET'}};
 const original=JSON.stringify(req);
 check('passive first request',()=>assert.equal(observer.observe(req),true));
 check('request entirely unmodified',()=>assert.equal(JSON.stringify(req),original));
 check('no query/path/UA/auth/cookie persisted',()=>assert.deepEqual(Object.keys(observer.counts()[0]).sort(),['client_class','hits','target_id','utc_day']));
 check('aggregate repeated request',()=>{observer.observe(req);assert.equal(observer.counts()[0].hits,2)});
 check('registered target whitelist',()=>{assert.equal(observer.observe({...req,url:'/go/8/'}),false);assert.equal(observer.counts().length,1)});
 check('UTC day separation',()=>{clock=new Date('2026-10-31T00:00:00Z');observer.observe(req);assert.equal(observer.counts().length,2)});
 check('unknown HTTP client remains other',()=>{observer.observe({url:'/go/7/',headers:{'user-agent':'Mozilla/5.0'}});assert.equal(observer.counts().some(r=>r.client_class==='other'),true)});
 check('stored rows contain no secret material',()=>assert.equal(/SECRET|PRIVATE/.test(JSON.stringify(observer.counts())),false));
 check('counts never certify workweek coverage',()=>assert.equal(observer.status().coverageVerified,false));
 check('failure never blocks but invalidates observation',()=>{db.exec('PRAGMA query_only=ON');assert.equal(observer.observe(req),false);assert.equal(observer.status().writesHealthy,false);assert.equal(observer.status().failures,1)});
} finally {db.close()}
console.log(checks+' observation checks passed; no production wiring/DB used');
