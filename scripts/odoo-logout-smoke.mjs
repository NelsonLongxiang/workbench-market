#!/usr/bin/env node
/** Isolated Odoo logout regression: node scripts/odoo-logout-smoke.mjs */
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const root=resolve('tmp'),tmp=join(root,'odoo-logout-'+Date.now().toString(36));
const data=join(tmp,'data');
mkdirSync(data,{recursive:true});
const SID='session'+ '1'.repeat(25), OTHER='session'+'2'.repeat(25), INVALID='session'+'3'.repeat(25), PORTAL='session'+'4'.repeat(25), OFF='session'+'5'.repeat(25);
const active=new Set([SID,OTHER,PORTAL]); let mode='ok'; const seen=[];
const upstream=createServer((req,res)=>{let body='';req.setEncoding('utf8');req.on('data',c=>body+=c);req.on('end',()=>{
  const sid=/(?:^|;\s*)session_id=([^;\s]+)/.exec(String(req.headers.cookie??''))?.[1]??'';
  seen.push({path:req.url,method:req.method,sid,headers:req.headers});
  if(req.url==='/web/session/get_session_info'){
    res.writeHead(200,{'content-type':'application/json'});
    return res.end(JSON.stringify(active.has(sid)?{jsonrpc:'2.0',result:{uid:7,username:'fixture',name:'Fixture',is_internal_user:sid!==PORTAL,is_admin:sid!==PORTAL}}:{jsonrpc:'2.0',error:{code:100}}));
  }
  if(req.url==='/web/session/destroy'){
    if(mode==='error'){res.writeHead(503).end();return;}
    if(mode==='redirect'){res.writeHead(302,{location:'http://attacker.invalid/'}).end();return;}
    if(mode==='oversize'){res.writeHead(200,{'content-type':'application/json'}).end('x'.repeat(70000));return;}
    if(mode==='malformed'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',result:{}}));return;}
    res.writeHead(200,{'content-type':'application/json'});
    if(active.has(sid)){active.delete(sid);return res.end(JSON.stringify({jsonrpc:'2.0',result:null}));}
    return res.end(JSON.stringify({jsonrpc:'2.0',error:{code:100}}));
  }
  res.writeHead(404).end();
});});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const port=20000+Math.floor(Math.random()*18000),base='http://127.0.0.1:'+port;
const env={...process.env,NODE_ENV:'test',MCP_GATEWAY:'off',WM_LOGIN_GATE:'enforce',WM_ODOO_LOGIN_PROXY:'1',PORT:String(port),DATA_DIR:data,ADMIN_TOKEN:'logout-fixture-only',WM_ODOO_URL:'http://127.0.0.1:'+upstream.address().port};
for(const k of ['WM_EXTENSIONS_DIR','WM_ODOO_ORIGINS'])delete env[k];
const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
const http=(method,path,headers={},body='')=>new Promise((ok,no)=>{const q=request({host:'127.0.0.1',port,method,path,headers:{...headers,...(body?{'content-length':Buffer.byteLength(body)}:{})}},r=>{let text='';r.on('data',c=>text+=c);r.on('end',()=>{let json;try{json=JSON.parse(text)}catch{}ok({status:r.statusCode,headers:r.headers,json,text})})});q.on('error',no);if(body)q.write(body);q.end()});
const same={origin:base,'sec-fetch-site':'same-origin','content-type':'application/json','x-wm-odoo-logout':'1','x-forwarded-for':'198.51.100.8'};
const cookie=(r,name)=>String(r.headers['set-cookie']??'').includes(name+'=;');
const count=()=>seen.filter(x=>x.path==='/web/session/destroy').length;
let pass=0,fail=0;function check(name,yes){if(yes){pass++;console.log('  ✓ '+name)}else{fail++;console.log('  ✗ '+name)}}
async function browserLogout(browserBase=base, browserSid=SID, label='enforce'){
  if(!process.env.CHROME_BIN){console.log('  - browser SKIP (set CHROME_BIN)');return;}
  active.add(browserSid);
  const browser=spawn(process.env.CHROME_BIN,['--headless','--no-sandbox','--disable-gpu','--no-proxy-server','--disable-background-networking','--user-data-dir='+tmp+'/chrome-'+label,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
  try{
    const debug=await new Promise((ok,no)=>{let t='';const timer=setTimeout(()=>no(Error('browser timeout')),12000);browser.stderr.on('data',d=>{t+=d;const m=t.match(/127[.]0[.]0[.]1:(\d+)/);if(m){clearTimeout(timer);ok(m[1]);}});browser.once('exit',()=>no(Error('browser exited')));});
    const target=await(await fetch('http://127.0.0.1:'+debug+'/json/new?about:blank',{method:'PUT'})).json();
    const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});let seq=0;const pending=new Map();
    ws.onmessage=e=>{const j=JSON.parse(e.data);if(j.id){const p=pending.get(j.id);pending.delete(j.id);j.error?p.no(Error(j.error.message)):p.ok(j.result)}};
    const send=(method,params={})=>new Promise((ok,no)=>{const id=++seq;pending.set(id,{ok,no});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async(expression,gesture=false)=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:gesture})).result.value;
    await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
    await send('Network.setCookie',{name:'session_id',value:browserSid,url:browserBase,httpOnly:true,sameSite:'Lax'});
    await send('Page.navigate',{url:browserBase+'/tasks'});
    let found=false;for(let i=0;i<100;i++){try{found=!!(await evaluate("!!document.querySelector('[title*=fixture]')"));}catch{}if(found)break;await new Promise(r=>setTimeout(r,100));}
    check(label+' browser shows authenticated Odoo identity',found);
    if(found){
      await evaluate("document.querySelector('[title*=fixture]').click();true",true);
      let button=false;for(let i=0;i<50;i++){try{button=!!(await evaluate("[...document.querySelectorAll('button')].some(x=>x.innerText.trim()==='退出 Odoo')"));}catch{}if(button)break;await new Promise(r=>setTimeout(r,100));}
      check(label+' browser exposes explicit Odoo logout control',button);
      if(button){await evaluate("[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='退出 Odoo').click();true",true);let done=false;for(let i=0;i<100;i++){try{done=!(active.has(browserSid)) && !!(await evaluate("location.pathname==='/login'"));}catch{}if(done)break;await new Promise(r=>setTimeout(r,100));}check(label+' browser logout revokes Odoo session and returns to login',done);const c=await send('Network.getCookies',{urls:[browserBase+'/']});check(label+' browser no longer holds root Odoo session cookie',!c.cookies.some(x=>x.name==='session_id'));}
    }
    ws.close();
  }finally{if(browser.exitCode===null&&browser.signalCode===null){browser.kill();await new Promise(r=>browser.once('exit',r));}}
}
try{
  const end=Date.now()+30000;let ready=false;while(Date.now()<end){try{if((await http('GET','/api/health')).status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}if(!ready)throw Error('fixture server not ready');
  const h={cookie:'session_id='+SID,'x-forwarded-for':'198.51.100.8','sec-fetch-site':'same-origin'};
  let r=await http('GET','/api/auth/viewer',h);check('valid Odoo viewer advertises logout',r.status===200 && r.json?.odoo_logout_supported===true);
  r=await http('GET','/api/auth/me',h);check('valid Odoo identity is recognized',r.status===200 && r.json?.via==='odoo');
  r=await http('GET','/api/admin/whoami',h);check('valid Odoo admin identity is recognized',r.status===200 && r.json?.admin===true);
  let n=count();
  for(const [name,headers] of [['cross-origin',{...same,origin:'https://evil.invalid'}],['missing Origin',{...same,origin:undefined}],['wrong protocol',{...same,origin:'https://127.0.0.1:'+port}],['missing explicit header',{...same,'x-wm-odoo-logout':undefined}],['non-JSON',{...same,'content-type':'text/plain'}]]){
    const clean=Object.fromEntries(Object.entries({...headers,cookie:'session_id='+SID}).filter(([,v])=>v!==undefined));
    r=await http('POST','/api/auth/logout',clean,'{}');check(name+' rejected before changing cookies or contacting Odoo',r.status===403&&!cookie(r,'session_id')&&count()===n);
  }
  r=await http('POST','/api/auth/logout',{...same,cookie:'session_id='+SID+'; wm_login=private','x-admin-token':'not-a-token'},'{}');
  const last=seen.filter(x=>x.path==='/web/session/destroy').at(-1);
  check('explicit logout revokes exact Odoo session and clears browser cookies',r.status===200&&r.json?.odoo_session_revoked===true&&r.json?.browser_session_cleared===true&&cookie(r,'session_id')&&cookie(r,'wm_login')&&!active.has(SID));
  check('upstream receives only fixed session cookie and no market credentials',last?.method==='POST'&&last.sid===SID&&last.headers.cookie==='session_id='+SID&&!last.headers['x-admin-token']);
  r=await http('GET','/api/auth/viewer',h);check('revoked session immediately fails fresh whoami',r.status===401);
  r=await http('GET','/api/auth/me',h);check('revoked session is not accepted by identity cache',r.status===200&&r.json?.authenticated===false);
  r=await http('GET','/api/admin/whoami',h);check('revoked session is not accepted by admin cache',r.status===401 || (r.status===200 && r.json?.admin===false));
  const portalHeaders={...h,cookie:'session_id='+PORTAL};
  r=await http('GET','/login',portalHeaders);check('login page offers Odoo logout even for denied user',r.status===200&&r.text.includes('退出当前 Odoo 会话'));
  r=await http('POST','/api/auth/logout',{...same,cookie:'session_id='+PORTAL},'{}');check('denied Odoo account can revoke its session',r.status===200&&r.json?.odoo_session_revoked===true&&!active.has(PORTAL));
  for(const m of ['error','redirect','oversize','malformed']){mode=m;n=count();r=await http('POST','/api/auth/logout',{...same,cookie:'session_id='+OTHER},'{}');check('upstream '+m+' clears browser cookie but reports failure',r.status===502&&r.json?.odoo_session_revoked===false&&cookie(r,'session_id')&&count()===n+1&&active.has(OTHER));}
  mode='ok';n=count();r=await http('POST','/api/auth/logout',{...same,cookie:'session_id='+SID+'; session_id='+OTHER},'{}');check('duplicate Odoo session cookies fail closed',r.status===409&&cookie(r,'session_id')&&count()===n);
  n=count();r=await http('POST','/api/auth/logout',{...same,cookie:'session_id=short'},'{}');check('invalid session cleared without sending upstream',r.status===502&&cookie(r,'session_id')&&count()===n);
  r=await http('POST','/api/auth/logout',same,'{}');check('no Odoo session logout is idempotent',r.status===200&&r.json?.odoo_session===false&&cookie(r,'session_id'));
  const offPort=port+2, offData=join(tmp,'gate-off');mkdirSync(offData);active.add(OFF);
  const off=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env:{...env,PORT:String(offPort),DATA_DIR:offData,WM_LOGIN_GATE:'off'},stdio:'ignore'});
  try{
    const b='http://127.0.0.1:'+offPort, until=Date.now()+30000;let ready=false;
    while(Date.now()<until){try{if((await fetch(b+'/api/health')).status===200){ready=true;break}}catch{}await new Promise(q=>setTimeout(q,100))}if(!ready)throw Error('gate-off instance not ready');
    const h={cookie:'session_id='+OFF,'x-forwarded-for':'198.51.100.8','sec-fetch-site':'same-origin'};
    let x=await fetch(b+'/api/admin/whoami',{headers:h});let j=await x.json();check('gate-off Odoo admin recognized before logout',x.status===200&&j.admin===true);
    x=await fetch(b+'/api/auth/logout',{method:'POST',headers:{...h,origin:b,'content-type':'application/json','x-wm-odoo-logout':'1'},body:'{}'});j=await x.json();check('gate-off logout revokes Odoo session',x.status===200&&j.odoo_session_revoked===true&&!active.has(OFF));
    x=await fetch(b+'/api/admin/whoami',{headers:h});j=await x.json();check('gate-off admin cache cannot restore revoked identity',x.status===200&&j.admin===false);
    await browserLogout(b,OFF,'gate-off');
  }finally{if(off.exitCode===null&&off.signalCode===null){off.kill();await new Promise(q=>off.once('exit',q));}}
  const legacyPort=port+1, legacyData=join(tmp,'legacy');mkdirSync(legacyData);
  const legacy=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env:{...env,PORT:String(legacyPort),DATA_DIR:legacyData,WM_LOGIN_GATE:'off',WM_ODOO_LOGIN_PROXY:'0'},stdio:'ignore'});
  try{
    const b='http://127.0.0.1:'+legacyPort, until=Date.now()+30000;let ready=false;
    while(Date.now()<until){try{if((await fetch(b+'/api/health')).status===200){ready=true;break}}catch{}await new Promise(q=>setTimeout(q,100))}if(!ready)throw Error('legacy instance not ready');
    const x=await fetch(b+'/api/auth/logout',{method:'POST',headers:{cookie:'session_id='+OTHER},redirect:'manual'});const j=await x.json();const cookies=x.headers.getSetCookie();
    check('relay disabled preserves legacy Odoo session behavior',x.status===200&&j.ok===true&&j.odoo_session===true&&!cookies.some(c=>c.startsWith('session_id='))&&active.has(OTHER));
  }finally{if(legacy.exitCode===null&&legacy.signalCode===null){legacy.kill();await new Promise(q=>legacy.once('exit',q));}}
  await browserLogout();
  check('process logs contain no synthetic session values',![SID,OTHER,INVALID,PORTAL,OFF].some(x=>logs.includes(x)));
}catch(e){fail++;console.log('  ✗ fixture error: '+String(e?.stack??e))}
finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await new Promise(r=>upstream.close(r));if(!resolve(tmp).startsWith(root+sep+'odoo-logout-'))throw Error('unsafe test cleanup path');rmSync(tmp,{recursive:true,force:true});}
console.log('odoo-logout-smoke:',pass,'passed /',fail,'failed');process.exitCode=fail?1:0;
