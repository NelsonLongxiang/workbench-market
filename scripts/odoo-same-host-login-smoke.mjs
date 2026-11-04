#!/usr/bin/env node
/** Isolated same-host Odoo login relay test: node scripts/odoo-same-host-login-smoke.mjs */
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const tmp = resolve('tmp/odoo-same-host-' + Date.now().toString(36));
const data = join(tmp, 'data');
mkdirSync(data, { recursive: true });
const SID0 = 'anon' + 'a'.repeat(28), SID1 = 'auth' + 'b'.repeat(28);
const seen = [];
const up = createServer((req, res) => {
  let body = ''; req.setEncoding('utf8'); req.on('data', c => body += c); req.on('end', () => {
    seen.push({ method: req.method, path: req.url, headers: req.headers, body });
    const p = new URL(req.url, 'http://upstream');
    if (p.pathname === '/web/login' && req.method === 'GET') {
      res.writeHead(200, {'content-type':'text/html', 'set-cookie': ['session_id='+SID0+'; Path=/; HttpOnly', 'wm_login=must-not-pass; Path=/']});
      return res.end('<form method="post" action="/web/login"><input name="csrf_token"><input name="login"><input name="password"></form>');
    }
    if (p.pathname === '/web/login' && req.method === 'POST') {
      const fields = new URLSearchParams(body);
      if (fields.get('login') === 'fixture-totp') { res.writeHead(302, {'location':'/web/login/totp?redirect=%2Ftasks'}); return res.end(); }
      if (fields.get('login') === 'fixture-foreign') { res.writeHead(302, {'location':'https://evil.invalid'}); return res.end(); }
      if (fields.get('login') === 'fixture' && fields.get('password') === 'fixture-password' && String(req.headers.cookie).includes(SID0)) {
        res.writeHead(303, {'location':fields.get('redirect') || '/tasks', 'set-cookie': ['session_id='+SID1+'; Path=/; HttpOnly']});
      } else res.writeHead(200, {'content-type':'text/html'});
      return res.end();
    }
    if (p.pathname === '/web/login/totp') {
      if (req.method === 'POST') res.writeHead(303, {'location':'/tasks','set-cookie':['session_id='+SID1+'; Path=/; HttpOnly']});
      else res.writeHead(200, {'content-type':'text/html'});
      return res.end('synthetic-totp');
    }
    if (p.pathname === '/web/session/get_session_info') {
      const ok = String(req.headers.cookie).includes(SID1);
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify(ok ? {result:{uid:7,username:'fixture',name:'Fixture',is_internal_user:true}} : {error:{code:100}}));
    }
    if (p.pathname === '/website/translations') {
      if (/^zh/i.test(String(req.headers['accept-language'] ?? ''))) { res.writeHead(303, {location:'/zh_CN/website/translations?hash=&lang='}); return res.end(); }
      res.writeHead(200, {'content-type':'application/json'}); return res.end('{}');
    }
    if (p.pathname.startsWith('/web/assets/')) { res.writeHead(200, {'content-type':'text/css','set-cookie':['session_id=must-not-pass; Path=/']}); return res.end('/* fixture */'); }
    res.writeHead(404).end();
  });
});
await new Promise(r => up.listen(0, '127.0.0.1', r));
const port = 20000 + Math.floor(Math.random() * 20000);
const env = {...process.env, NODE_ENV:'test', MCP_GATEWAY:'off', WM_LOGIN_GATE:'off', WM_ODOO_LOGIN_PROXY:'1', PORT:String(port), DATA_DIR:data, ADMIN_TOKEN:'fixture-only', WM_ODOO_URL:'http://127.0.0.1:' + up.address().port};
for (const k of ['WM_EXTENSIONS_DIR','WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning','server/src/index.ts'], {env,stdio:['ignore','ignore','pipe']});
let errors=''; server.stderr.on('data', c => errors += c);
const http = (method,path,headers={},body='') => new Promise((done,reject) => {
  const q=request({host:'127.0.0.1',port,method,path,headers:{...headers,...(body?{'content-length':Buffer.byteLength(body)}:{})}}, r=>{let text='';r.setEncoding('utf8');r.on('data',c=>text+=c);r.on('end',()=>done({status:r.statusCode,headers:r.headers,text}));});
  q.on('error',reject); if(body)q.write(body); q.end();
});
let pass=0, fail=0;
function check(name, condition) { if (condition) { pass++; console.log('  ✓ '+name); } else { fail++; console.log('  ✗ '+name); } }
/** Browser round-trip with synthetic users and an isolated Chromium profile. */
async function browserLogin(wid) {
  if (!process.env.CHROME_BIN) { console.log('  - browser SKIP (set CHROME_BIN to test Chromium)'); return; }
  const chrome=spawn(process.env.CHROME_BIN,['--headless','--no-sandbox','--disable-gpu','--no-proxy-server','--disable-background-networking','--host-resolver-rules=MAP lan.test 127.0.0.1,MAP public.test 127.0.0.1','--user-data-dir='+tmp+'/chrome','--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
  try {
    const debug=await new Promise((ok,no)=>{let t='';const timer=setTimeout(()=>no(Error('browser timeout')),12000);chrome.stderr.on('data',d=>{t+=d;const m=t.match(/127[.]0[.]0[.]1:(\d+)/);if(m){clearTimeout(timer);ok(Number(m[1]));}});chrome.once('exit',()=>no(Error('browser exited')));});
    for(const host of ['lan.test','public.test']) {
      const target=await(await fetch('http://127.0.0.1:'+debug+'/json/new?about:blank',{method:'PUT'})).json();
      const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});
      let id=0;const pending=new Map(), navEvents=[];const seenAtStart=seen.length;
      ws.onmessage=e=>{const j=JSON.parse(e.data);if(j.id){const p=pending.get(j.id);pending.delete(j.id);j.error?p.reject(Error(j.error.message)):p.resolve(j.result);} else if(j.method==='Network.requestWillBeSent' && j.params.type==='Document') navEvents.push({path:new URL(j.params.request.url).pathname,method:j.params.request.method,redirectStatus:j.params.redirectResponse?.status}); else if(j.method==='Network.responseReceived' && j.params.type==='Document') navEvents.push({path:new URL(j.params.response.url).pathname,status:j.params.response.status});};
      const send=(method,params={})=>new Promise((ok,no)=>{const n=++id;pending.set(n,{resolve:ok,reject:no});ws.send(JSON.stringify({id:n,method,params}));});
      const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
      await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
      await send('Page.navigate',{url:'http://'+host+':'+port+'/go/'+wid+'/?return=%2Ftasks'});
      let login=false;
      for(let n=0;n<80;n++){try{login=!!(await evaluate("location.pathname==='/web/login' && !!document.querySelector('input[name=login]')"));}catch{}if(login)break;await new Promise(q=>setTimeout(q,100));}
      check(host+' browser follows same-host relay',login);
      if(login){
        const anonymous=await evaluate("fetch('/api/auth/viewer').then(r=>r.status===401)");
        check(host+' starts with no authenticated session',anonymous===true);
        await evaluate("document.querySelector('input[name=login]').value='fixture';document.querySelector('input[name=password]').value='fixture-password';document.querySelector('form').requestSubmit();true");
        let who=false;
        for(let n=0;n<80;n++){try{who=!!(await evaluate("fetch('/api/auth/viewer').then(async r=>{const x=await r.json();return r.status===200 && x.ok===true && x.viewer?.login==='fixture'})"));}catch{}if(who)break;await new Promise(q=>setTimeout(q,100));}
        const browserPost=seen.slice(seenAtStart).some(x=>x.method==='POST' && x.path.split('?')[0]==='/web/login' && new URLSearchParams(x.body).get('login')==='fixture' && String(x.headers.cookie).includes(SID0));
        check(host+' browser form reaches Odoo and shares session with whoami',who && browserPost);
        let landed=false;
        for(let n=0;n<80;n++){try{landed=!!(await evaluate("location.hostname === '"+host+"' && location.pathname === '/tasks'"));}catch{}if(landed)break;await new Promise(q=>setTimeout(q,100));}
        if(!landed) { const nav=await evaluate("JSON.stringify({path:location.pathname,document:performance.getEntriesByType('navigation')[0]?.name})"); console.log('    browser navigation:',nav); const last=seen.filter(x=>x.method==='POST' && x.path.startsWith('/web/login')).at(-1); console.log('    submitted fixture:',last ? {redirect:new URLSearchParams(last.body).get('redirect'),loginOk:new URLSearchParams(last.body).get('login')==='fixture',passwordOk:new URLSearchParams(last.body).get('password')==='fixture-password',cookieOk:String(last.headers.cookie).includes(SID0)} : 'no POST', 'navigation:', JSON.stringify(navEvents),'upstream:',JSON.stringify(seen.slice(seenAtStart).map(x=>({method:x.method,path:x.path.split('?')[0],sid0:String(x.headers.cookie).includes(SID0),sid1:String(x.headers.cookie).includes(SID1)})))); }
        check(host+' browser login returns to market host',landed);
      }
      ws.close();
    }
  } finally {if(chrome.exitCode===null && chrome.signalCode===null){chrome.kill();await new Promise(r=>chrome.once('exit',r));}}
}
try {
  const until=Date.now()+30000; let ready=false;
  while(Date.now()<until){try{if((await http('GET','/api/health')).status===200){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  if(!ready)throw Error('fixture server not ready: '+errors.slice(-800));
  const reg=await http('POST','/api/workbenches',{'content-type':'application/json'},JSON.stringify({name:'fixture Odoo',url:env.WM_ODOO_URL+'/web',type:'web'}));
  const wid=JSON.parse(reg.text).id; if(!wid)throw Error('fixture registration failed');
  for (const [label,host,https] of [['LAN','192.0.2.88:9800',false],['public','market.example.test',true]]) {
    const h={host,...(https?{'x-forwarded-proto':'https'}:{})};
    let anon=await http('GET','/api/auth/viewer',h); let login=JSON.parse(anon.text).login_url;
    check(label+' anonymous viewer probe returns relative login URL',anon.status===401 && login==='/go/'+wid+'/?return=%2Ftasks');
    let relay=await http('GET',login,h);
    check(label+' relay stays on current host',relay.status===200 && relay.text.includes('/web/login?redirect=%2Ftasks') && !relay.text.includes(env.WM_ODOO_URL));
    let page=await http('GET','/web/login?redirect=%2Ftasks',h);
    const ck=page.headers['set-cookie']||[];
    check(label+' login proxied and cookie scoped correctly',page.status===200 && page.text.includes('csrf_token') && ck.length===1 && ck[0].includes('Path=/') && ck[0].includes('HttpOnly') && ck[0].includes('SameSite=Lax') && (https ? ck[0].includes('Secure') : !ck[0].includes('Secure')));
    const payload=new URLSearchParams({csrf_token:'fixture-csrf',login:'fixture',password:'fixture-password',redirect:'/tasks'}).toString();
    let post=await http('POST','/web/login', {...h,origin:(https?'https://':'http://')+host, 'sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded',cookie:'session_id='+SID0+'; wm_login=private', 'x-admin-token':'private-token',authorization:'Bearer private-token','x-app-token':'private-app-token'},payload);
    check(label+' login POST succeeds without leaking market credentials',post.status===303 && post.headers.location==='/tasks' && post.headers['set-cookie']?.[0]?.includes(SID1) && seen.at(-1).headers.cookie==='session_id='+SID0 && !seen.at(-1).headers['x-admin-token'] && !seen.at(-1).headers.authorization && !seen.at(-1).headers['x-app-token']);
    let who=await http('GET','/api/auth/viewer',{...h,cookie:'session_id='+SID1});
    check(label+' logged-in whoami succeeds',who.status===200 && JSON.parse(who.text).viewer?.login==='fixture');
  }
  // Plain /go/<id>/ entry (no return): same-host relay, back to this workbench's SSO callback; upstream host never shown.
  let lastSt='';
  for (const [label,host,https] of [['LAN plain','192.0.2.88:9800',false],['public plain','market.example.test',true]]) {
    const h={host,...(https?{'x-forwarded-proto':'https'}:{})};
    const entry=await http('GET','/go/'+wid+'/',h);
    const loc=String(entry.headers.location??''); const entryCookie=String(entry.headers['set-cookie']??''); const st=/wm_sso_\d+=([0-9a-f-]{36})/.exec(entryCookie)?.[1]??'';
    check(label+' entry redirects to same-host login without upstream host',entry.status===302 && loc==='/web/login?redirect='+encodeURIComponent('/go/'+wid+'/?state='+st) && !!st && !loc.includes('127.0.0.1') && !entry.text.includes(env.WM_ODOO_URL));
    check(label+' state cookie is HttpOnly/Lax and Secure only on HTTPS',/HttpOnly/i.test(entryCookie)&&/SameSite=Lax/i.test(entryCookie)&&(https?/Secure(?:;|$)/i.test(entryCookie):!/Secure(?:;|$)/i.test(entryCookie)));
    const page=await http('GET',loc,h);
    check(label+' login page keeps the SSO callback for Odoo',page.status===200 && seen.at(-1).path==='/web/login?redirect='+encodeURIComponent('/go/'+wid+'/?state='+st));
    const post=await http('POST','/web/login',{...h,origin:(https?'https://':'http://')+host,'sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded',cookie:'session_id='+SID0},new URLSearchParams({csrf_token:'fixture-csrf',login:'fixture',password:'fixture-password',redirect:'/go/'+wid+'/?state='+st}).toString());
    check(label+' login returns to the workbench SSO callback',post.status===303 && post.headers.location==='/go/'+wid+'/?state='+st);
    const back=await http('GET',post.headers.location,{...h,cookie:'session_id='+SID1+'; wm_sso_'+wid+'='+st});
    check(label+' callback passes the state check',back.status!==400 && String(back.headers['set-cookie']??'').includes('wm_sso_ok_'+wid+'=1'));
    lastSt=st;
  }
  // Counterexamples (direct-24dd6c02): the callback redirect is honoured only with a ticket the portal issued for a trusted Odoo workbench.
  const H={host:'market.example.test'};
  const relayedRedirect=async (target)=>{ await http('GET','/web/login?redirect='+encodeURIComponent(target),H); return seen.at(-1).path.includes('redirect='); };
  const postedRedirect=async (target)=>{ const p=await http('POST','/web/login',{...H,origin:'http://market.example.test','sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded',cookie:'session_id='+SID0},new URLSearchParams({login:'fixture',password:'fixture-password',redirect:target}).toString()); return {forwarded:new URLSearchParams(seen.at(-1).body).has('redirect'),location:String(p.headers.location??'')}; };
  const other=JSON.parse((await http('POST','/api/workbenches',{'content-type':'application/json'},JSON.stringify({name:'untrusted page',url:'http://127.0.0.1:9/',type:'web'}))).text).id;
  const ticket=async ()=>/wm_sso_\d+=([0-9a-f-]{36})/.exec(String((await http('GET','/go/'+wid+'/',H)).headers['set-cookie']??''))?.[1]??'';
  const fresh=await ticket();
  check('non-Odoo target with a well-formed uuid is not relayed',!(await relayedRedirect('/go/'+other+'/?state=00000000-0000-4000-8000-000000000000')));
  check('a real ticket cannot be moved to a non-Odoo workbench',!(await relayedRedirect('/go/'+other+'/?state='+fresh)));
  let pr=await postedRedirect('/go/'+other+'/?state='+fresh);
  check('login POST never lands on the non-Odoo workbench',!pr.forwarded && !pr.location.includes('/go/'+other+'/'));
  check('forged state for the Odoo workbench is not relayed',!(await relayedRedirect('/go/'+wid+'/?state=00000000-0000-4000-8000-000000000000')));
  check('fresh ticket for the Odoo workbench is relayed',await relayedRedirect('/go/'+wid+'/?state='+fresh));
  check('consumed ticket is not relayed again (replay)',!!lastSt && !(await relayedRedirect('/go/'+wid+'/?state='+lastSt)));
  const pending=await ticket();
  const moved=await http('PUT','/api/workbenches/'+wid,{'content-type':'application/json'},JSON.stringify({name:'fixture Odoo',url:'http://127.0.0.1:9/web',type:'web'}));
  check('workbench moved off the trusted Odoo origin: pending ticket no longer relayed',moved.status<300 && !(await relayedRedirect('/go/'+wid+'/?state='+pending)));
  await http('PUT','/api/workbenches/'+wid,{'content-type':'application/json'},JSON.stringify({name:'fixture Odoo',url:env.WM_ODOO_URL+'/web',type:'web'}));
  check('workbench moved back: ticket checked against the current registry',await relayedRedirect('/go/'+wid+'/?state='+pending));
  // Per-source ticket quota: one source refreshing the anonymous entry cannot crowd out others' tickets.
  const fromSrc=async (ip)=>{ const x=await http('GET','/go/'+wid+'/',{...H,'x-real-ip':ip}); return {status:x.status,st:/wm_sso_\d+=([0-9a-f-]{36})/.exec(String(x.headers['set-cookie']??''))?.[1]??''}; };
  const victim=await fromSrc('198.51.100.20');
  let issued=0, limited=null;
  for(let n=0;n<25;n++){ const x=await fromSrc('198.51.100.66'); if(x.status===302 && x.st) issued++; else { limited=x; break; } }
  check('one source gets at most 20 live tickets, then 429',issued===20 && limited?.status===429);
  check('another source still gets a ticket',(await fromSrc('198.51.100.21')).status===302);
  check('flooding source did not evict the other source\'s ticket',!!victim.st && await relayedRedirect('/go/'+wid+'/?state='+victim.st));
  // Shared store: a second instance on the same DATA_DIR honours tickets issued by the first one.
  const peerPort=port+4;
  const peer=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env:{...env,PORT:String(peerPort)},stdio:'ignore'});
  try {
    const pb='http://127.0.0.1:'+peerPort, until=Date.now()+30000; let up=false;
    while(Date.now()<until){try{if((await fetch(pb+'/api/health')).status===200){up=true;break;}}catch{} await new Promise(q=>setTimeout(q,100));}
    if(!up)throw Error('peer instance not ready');
    const shared=await fromSrc('198.51.100.30');
    await fetch(pb+'/web/login?redirect='+encodeURIComponent('/go/'+wid+'/?state='+shared.st),{headers:{host:'market.example.test'},redirect:'manual'});
    check('ticket issued on one instance is honoured by another on the same data dir',seen.at(-1).path.includes('redirect='));
  } finally {peer.kill(); await new Promise(q=>peer.once('exit',q));}
  for (const bad of ['/go/'+wid+'/?state=x','/go/'+wid+'/?state=00000000-0000-0000-0000-000000000000&x=1','/go/abc/?state=00000000-0000-0000-0000-000000000000','//evil.invalid/go/1/?state=00000000-0000-0000-0000-000000000000']) {
    await http('GET','/web/login?redirect='+encodeURIComponent(bad),{host:'market.example.test'});
    check('relay strips non-callback redirect '+JSON.stringify(bad),!seen.at(-1).path.includes('redirect='));
  }
  const offPort=port+3, offData=join(tmp,'proxy-off'); mkdirSync(offData);
  const off=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env:{...env,PORT:String(offPort),DATA_DIR:offData,WM_ODOO_LOGIN_PROXY:''},stdio:'ignore'});
  try {
    const b='http://127.0.0.1:'+offPort, end=Date.now()+30000; let ok=false;
    while(Date.now()<end){try{if((await fetch(b+'/api/health')).status===200){ok=true;break;}}catch{} await new Promise(q=>setTimeout(q,100));}
    if(!ok)throw Error('proxy-off instance not ready');
    const reg2=await (await fetch(b+'/api/workbenches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'fixture Odoo',url:env.WM_ODOO_URL+'/web',type:'web'})})).json();
    const z=await fetch(b+'/go/'+reg2.id+'/',{redirect:'manual'});
    check('relay off keeps the classic upstream login redirect',z.status===302 && String(z.headers.get('location')).startsWith(env.WM_ODOO_URL+'/web/login?redirect='));
  } finally {off.kill(); await new Promise(q=>off.once('exit',q));}
  let before=seen.length;
  let r=await http('POST','/web/login',{host:'market.example.test',origin:'https://attacker.invalid','sec-fetch-site':'cross-site','content-type':'application/x-www-form-urlencoded'},'login=x');
  check('cross-origin login rejected before upstream',r.status===403 && seen.length===before);
  r=await http('POST','/web/login',{host:'market.example.test','content-type':'application/json'},'{}');
  check('JSON login rejected before upstream',r.status===415 && seen.length===before);
  r=await http('GET','/web/session/get_session_info',{host:'market.example.test'});
  check('arbitrary Odoo API not proxied',seen.length===before && !String(r.headers['content-type']).includes('application/json'));
  r=await http('GET','/web/assets/a/fixture.css',{host:'market.example.test'});
  check('Odoo login assets available without setting a session',r.status===200 && r.text==='/* fixture */' && !r.headers['set-cookie']);
  r=await http('GET','/website/translations',{host:'market.example.test'});
  check('read-only Odoo translations are proxied',r.status===200 && r.text==='{}');
  r=await http('GET','/website/translations?hash=&lang=',{host:'market.example.test','accept-language':'zh-CN,zh;q=0.9,en;q=0.8'});
  check('Chinese browser translations stay JSON instead of language redirect',r.status===200 && r.text==='{}' && seen.at(-1).path==='/website/translations?hash=&lang=' && /^en-US,en/.test(String(seen.at(-1).headers['accept-language'])));
  r=await http('GET','/web/login?redirect=%2F%2Fevil.invalid',{host:'market.example.test'});
  check('untrusted return removed before Odoo',!seen.at(-1).path.includes('evil.invalid'));
  r=await http('POST','/web/login',{host:'market.example.test','content-type':'application/x-www-form-urlencoded',cookie:'session_id='+SID0},new URLSearchParams({login:'fixture',password:'fixture-password',redirect:'//evil.invalid'}).toString());
  check('untrusted form return removed',!r.headers.location?.includes('evil.invalid') && !seen.at(-1).body.includes('evil.invalid'));
  r=await http('POST','/web/login',{host:'market.example.test','content-type':'application/x-www-form-urlencoded'},'login=fixture-totp');
  check('TOTP challenge stays on current host',r.status===302 && r.headers.location==='/web/login/totp?redirect=%2Ftasks');
  r=await http('GET',r.headers.location,{host:'market.example.test'});
  check('TOTP form reaches fixed Odoo',r.status===200 && r.text==='synthetic-totp');
  r=await http('POST','/web/login/totp',{host:'market.example.test','content-type':'application/x-www-form-urlencoded'},'totp_token=123456');
  check('TOTP completes with Odoo session',r.status===303 && r.headers.location==='/tasks' && r.headers['set-cookie']?.[0]?.includes(SID1));
  r=await http('POST','/web/login',{host:'market.example.test','content-type':'application/x-www-form-urlencoded'},'login=fixture-foreign');
  check('foreign upstream redirect rejected',r.status===502 && !r.headers.location);
  r=await http('POST','/web/login',{host:'market.example.test','content-type':'application/x-www-form-urlencoded'},'x='+('a'.repeat(17000)));
  check('large form rejected without contacting Odoo',r.status===413);
  // Exercise the actual enforce gate on a second isolated instance.
  const gatePort=port+1, gateData=join(tmp,'gate-data'); mkdirSync(gateData);
  const gate=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server/src/index.ts'],{env:{...env,PORT:String(gatePort),DATA_DIR:gateData,WM_LOGIN_GATE:'enforce'},stdio:'ignore'});
  try {
    const base='http://127.0.0.1:'+gatePort, end=Date.now()+30000; let isReady=false;
    while(Date.now()<end){try{if((await fetch(base+'/api/health')).status===200){isReady=true;break;}}catch{} await new Promise(q=>setTimeout(q,100));}
    if(!isReady)throw Error('enforce instance not ready');
    const h={'x-forwarded-for':'198.51.100.9','sec-fetch-site':'same-origin'};
    let z=await fetch(base+'/web/login?redirect=%2Flogin',{headers:h,redirect:'manual'});
    check('enforce gate permits only selected Odoo login page',z.status===200 && (await z.text()).includes('csrf_token'));
    z=await fetch(base+'/web/session/get_session_info',{headers:h,redirect:'manual'});
    check('enforce gate rejects unrelated Odoo API',z.status===401);
    z=await fetch(base+'/web/login',{method:'POST',headers:{...h,origin:'https://evil.invalid','content-type':'application/x-www-form-urlencoded'},body:'login=x',redirect:'manual'});
    check('enforce gate cannot bypass cross-origin rejection',z.status===403);
  } finally {gate.kill(); await new Promise(q=>gate.once('exit',q));}
  await browserLogin(wid);
} catch(e) {fail++;console.log('  ✗ fixture error: '+String(e?.stack??e));}
finally {server.kill(); await new Promise(r=>up.close(r)); await new Promise(r=>setTimeout(r,300)); rmSync(tmp,{recursive:true,force:true});}
console.log('odoo-same-host-login-smoke:',pass,'passed /',fail,'failed');
process.exitCode=fail?1:0;
