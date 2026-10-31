/** Per-target opt-in only; synthetic shared-app legacy sentinel, no real upstream. */
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import {request} from 'node:http';
import {createServer} from 'node:net';
import {createContentSurface,contentConfig} from '../server/src/content-surface.ts';
import {registerSurface,surfaceOf} from '../server/src/surfaces.ts';
const free=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
let checks=0,legacy=0,credentials=0,viewers=0;const ok=(n,p)=>{assert.ok(p,n);checks++;console.log('PASS '+n)};
const port=await free(),contentPort=await free(),market='http://127.0.0.1:'+port;
const targets=[{id:1,origin:'http://w-1-test.internal:'+contentPort,upstreamUrl:'http://127.0.0.1:9',migrateBrowser:true},{id:2,origin:'http://w-2-test.internal:'+contentPort,upstreamUrl:'http://127.0.0.1:9'},{id:3,origin:'http://w-3-test.internal:'+contentPort,upstreamUrl:'http://127.0.0.1:9',migrateBrowser:false}];
const cfg={host:'127.0.0.1',port:contentPort,marketOrigin:market,targets};
const runtime=createContentSurface(cfg,{viewer:async()=>{viewers++;return null},upstream:()=>{credentials++;return null}});
const app=express();app.use((q,s,n)=>{if(surfaceOf(q)==='market')runtime.migrate(q,s,n);else n()});app.use((q,s)=>{legacy++;s.end('LEGACY-SENTINEL')});
const server=registerSurface(app,'market',port,undefined,'127.0.0.1');
const send=(path,headers={},method='GET')=>new Promise((resolve,reject)=>{const q=request({host:'127.0.0.1',port,path,method,headers},s=>{let text='';s.on('data',b=>text+=b);s.on('end',()=>resolve({status:s.statusCode,headers:s.headers,text}))});q.on('error',reject);q.end()});
const nav={'sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
try {
 const r=await send('/go/1/path?api_key=synthetic-never-forward&return=//evil',nav);
 ok('enabled top-level navigation uses trusted same-target entry',r.status===302&&r.headers.location===market+'/content/open/1');
 ok('redirect drops old path/query and is not cached',!r.headers.location.includes('api_key')&&!r.headers.location.includes('evil')&&r.headers['cache-control']==='no-store');
 ok('HEAD navigation migrates without body',(await send('/go/1/',nav,'HEAD')).headers.location===market+'/content/open/1');
 const frame=await send('/go/1/',{'sec-fetch-mode':'navigate','sec-fetch-dest':'iframe'});
 ok('iframe uses manual noopener top-level link not redirect',frame.status===200&&!frame.headers.location&&frame.text.includes('target="_blank" rel="noopener noreferrer"')&&frame.text.includes(market+'/content/open/1'));
 ok('iframe can render only under configured trusted market',frame.headers['content-security-policy'].includes('frame-ancestors '+market));
 ok('case variant navigations share routing semantics',(await send('/GO/1/x',nav)).headers.location===market+'/content/open/1');
 ok('HTTP browser missing FetchMetadata can migrate with explicit HTML navigation hints',(await send('/go/1/',{'user-agent':'Mozilla/5.0','accept':'text/html'})).text.includes(market+'/content/open/1'));
 for(const [name,path,headers,method]of [
 ['default off','/go/2/',nav,'GET'],['explicit false','/go/3/',nav,'GET'],['unknown target','/go/99/',nav,'GET'],
 ['curl','/go/1/',{'user-agent':'curl/8.0','accept':'text/html'},'GET'],['node fetch','/go/1/',{'user-agent':'node','sec-fetch-mode':'cors'},'GET'],
 ['python','/go/1/',{'user-agent':'python-requests'},'GET'],['MCP client','/go/1/',{'user-agent':'mcp-client'},'GET'],
 ['unmarked unknown','/go/1/',{},'GET'],['browser fetch','/go/1/',{'sec-fetch-mode':'cors','sec-fetch-dest':'empty','user-agent':'Mozilla/5.0','accept':'text/html'},'GET'],
 ['legacy XHR','/go/1/',{'user-agent':'Mozilla/5.0','accept':'text/html','x-requested-with':'XMLHttpRequest'},'GET'],
 ['upgrade never redirected even with forged navigation hints','/go/1/',{...nav,'upgrade':'websocket','connection':'Upgrade'},'GET'],
 ['POST not replayed','/go/1/',nav,'POST'],['websocket hint','/go/1/',{'upgrade':'websocket','connection':'Upgrade'},'GET'],
 ['encoded id is not selected','/go/%31/',nav,'GET'],['leading zero not selected','/go/01/',nav,'GET']]){
  const x=await send(path,headers,method);ok('legacy unchanged '+name,x.status===200&&x.text==='LEGACY-SENTINEL');
 }
 for(const path of ['http://x/go/1/','/go/1/%2e%2e/','/go/1/%2fadmin','/go/1/%252fadmin','/go/1/a'+String.fromCharCode(92)+'b'])ok('enabled ambiguous navigation rejected '+path,(await send(path,nav)).status===404);
 ok('wrong trusted host cannot mint redirect',(await send('/go/1/',{...nav,host:'evil.invalid'})).status===404);
 const env={WM_CONTENT_PORT:String(contentPort),WM_CONTENT_IP:'127.0.0.1',WM_CONTENT_MARKET_ORIGIN:market,WM_CONTENT_TARGETS:JSON.stringify(targets)};
 ok('valid config preserves independent per-target opt-in',contentConfig(env).targets[0].migrateBrowser===true&&contentConfig(env).targets[1].migrateBrowser===undefined);
 for(const value of ['true',1,null]){assert.throws(()=>contentConfig({...env,WM_CONTENT_TARGETS:JSON.stringify([{...targets[0],migrateBrowser:value}])}));checks++;}
 ok('routing performs zero viewer/credential/upstream work',viewers===0&&credentials===0);
 console.log(JSON.stringify({checks,legacy,viewers,credentials,production:false,note:'classification is spoofable, not auth or complete caller inventory'}));
}finally{await new Promise(r=>server.close(r))}
