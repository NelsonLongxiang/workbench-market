/** #326 HTTP and content-upgrade startup gate, synthetic only. */
import assert from 'node:assert/strict';
import express from '../server/node_modules/express/index.js';
import { createServer } from 'node:http';
import { createServer as reserve, connect } from 'node:net';
import { listenContentSurface } from '../server/src/content-surface.ts';
import { createStartupSecurityProbe } from '../server/src/startup-security-self-probe.ts';
let checks=0;const check=(name,cond)=>{assert.ok(cond,name);checks++;console.log('PASS '+name)};
const app=express(),probe=createStartupSecurityProbe({log:()=>{}});let held;const hold=new Promise(r=>held=r);
app.use(probe.middleware);app.use(express.json());
app.post('/mcp',async(_q,r)=>{await hold;r.status(401).set('WWW-Authenticate','Bearer').end()});
app.post('/api/workbenches',(q,r)=>r.status(q.headers.origin?403:400).end());
let fallback=0;app.get('/business',(_q,r)=>{fallback++;r.json({ok:true})});
const market=createServer(app);await new Promise(r=>market.listen(0,'127.0.0.1',r));
const reserved=reserve();await new Promise(r=>reserved.listen(0,'127.0.0.1',r));const cp=reserved.address().port;await new Promise(r=>reserved.close(r));
let upgraded=0;const content=listenContentSurface(app,{host:'127.0.0.1',port:cp,marketOrigin:'http://127.0.0.1:'+market.address().port,targets:[]},{upgrade:async(_q,s)=>{upgraded++;s.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')}},()=>probe.snapshot().passed);
const ws=()=>new Promise((resolve,reject)=>{const s=connect(cp,'127.0.0.1');let text='';const timer=setTimeout(()=>{s.destroy();reject(Error('owned WS fixture timeout'))},1500);s.on('connect',()=>s.write('GET /go/1/socket HTTP/1.1\r\nHost: untrusted.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));s.on('data',b=>text+=b);s.once('error',e=>{if(e.code!=='ECONNRESET')reject(e)});s.once('close',()=>{clearTimeout(timer);resolve(text)});});
try{const running=probe.run({market,gatewayOn:true});check('content WebSocket cannot bypass pending HTTP startup gate',(await ws())===''&&upgraded===0);const pending=await fetch('http://127.0.0.1:'+cp+'/business');check('content HTTP has no business effects during probe',pending.status===503&&fallback===0);held();check('mandatory probe passes before upgrade gate opens',(await running).passed);check('content upgrades keep existing behavior after startup pass',(await ws()).includes('101 Switching Protocols')&&upgraded===1);}finally{held();for(const s of[market,content]){s.closeAllConnections();await new Promise(r=>s.close(r));}}
console.log(JSON.stringify({checks,production_requests:0}));
