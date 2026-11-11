/** #326 real index tests. Fresh synthetic data/home and reserved loopback ports only. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const root=resolve('.'),out=resolve('tmp/startup-self-probe-http-'+Date.now());
mkdirSync(out,{recursive:true});let checks=0;
const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS '+name)};
const spare=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));assert(![3080,9800,9801].includes(p));return p;};
const websocket=port=>new Promise((resolve,reject)=>{
 const s=connect(port,'127.0.0.1');let bytes=0;
 const timer=setTimeout(()=>{s.destroy();reject(Error('owned WS fixture timed out'))},500);
 s.once('connect',()=>s.write('GET /go/999/socket HTTP/1.1\r\nHost: untrusted.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
 s.on('data',b=>bytes+=b.length);s.on('error',e=>{if(e.code!=='ECONNRESET')reject(e)});
 s.once('close',()=>{clearTimeout(timer);resolve(bytes)});
});
const preload=String.raw`import net from'node:net';import{registerHooks}from'node:module';
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'){if(typeof a[1]==='string')a[1]='127.0.0.1';else a.splice(1,0,'127.0.0.1')}return listen.apply(this,a)};
const mutation=process.env.WM_SYNTHETIC_PROBE_MUTATION;
registerHooks({load(url,ctx,next){const loaded=next(url,ctx);if(!mutation||!url.endsWith(mutation==='handler-error'?'/server/src/routes/workbenches.ts':mutation==='export-reveal'?'/server/src/routes/export-import.ts':mutation==='mcp-timeout'||mutation==='hold-probe'?'/server/src/routes/mcp-protocol.ts':'/server/src/index.ts'))return loaded;let s=String(loaded.source);
const replace=(from,to)=>{if(!s.includes(from))throw Error('mutation anchor missing: '+mutation);s=s.replace(from,to);};
if(mutation==='login-gate')replace('app.use(loginGate.middleware);','app.use((_q,_s,n)=>n());');
if(mutation==='login-gate-apps')replace('app.use(loginGate.middleware);',"app.use((q,s,n)=>q.path.startsWith('/apps/')?n():loginGate.middleware(q,s,n));");
if(mutation==='a2a-direct-unsigned')replace("  if (A2A_DIRECT_SIG !== 'off') {","  if (false) {");
if(mutation==='mcp-auth')replace('  if (!MCP_GATEWAY_ON) return null;','  if (true || !MCP_GATEWAY_ON) return null;');
if(mutation==='browser-write')replace("  if (p.startsWith('/api/')) {","  if (false && p.startsWith('/api/')) {");
if(mutation==='export-reveal')replace("      if (!adminGuard(req, res)) return;\n      res.set('Cache-Control', 'no-store');","      res.set('Cache-Control', 'no-store');");
if(mutation==='grants-admin-read')replace("registerGrantRoutes(http, { markOdooAdmin, adminGuard, adminActor });","registerGrantRoutes(http, { markOdooAdmin, adminGuard: () => true, adminActor });");
if(mutation==='app-data-read')replace('  cliOk: (req) => !browserMarked(req) && rawLoopback(req),','  cliOk: () => true,');
if(mutation==='unsigned-login-event')replace('registerLoginEventRoutes(http);',"app.post('/login/:flow/events', (_q, s) => s.status(200).json({}));");
if(mutation==='forged-login-callback')replace('registerLoginFlowRoutes(http, { publicUrl: marketPublicUrl, sessionTtlMs: SESSION_TTL_MIN * 60_000 });',"app.get('/login/:flow/callback', (_q, s) => s.redirect(302, '/tasks'));");
if(mutation==='principals-admin-read')replace('registerPrincipalRoutes(http, { markOdooAdmin, adminGuard, adminActor });','registerPrincipalRoutes(http, { markOdooAdmin, adminGuard: () => true, adminActor });');
if(mutation==='mcp-timeout'||mutation==='hold-probe'){const a="app.post('/mcp', { action: 'mcp.rpc', kind: 'write' }, async (req, res) => {";replace(a,a+(mutation==='mcp-timeout'?"if(req.headers['x-wm-self-probe'])return;":"if(req.headers['x-wm-self-probe'])await new Promise(r=>setTimeout(r,500));"));}
if(mutation==='handler-error'){const a="app.post('/api/workbenches', { action: 'workbench.create', kind: 'admin', statusNotVerdict: 'URL 准入：地址不许登记时回 403，是登记规则不是授权' }, (req, res) => {";replace(a,a+"if(req.headers['x-wm-self-probe'])throw Error(process.env.ADMIN_TOKEN);");}
return{...loaded,source:s};}});`;
async function runCase(label,{off=false,control=false,occupied=false,unset=false,mutation='',expectFailure=false,nodeEnv='production',gate=''}={}){
 const dir=join(out,label);mkdirSync(dir,{recursive:true});const port=await spare();let cp=control?await spare():0;
 while(cp===port)cp=await spare();
 let foreign,foreignRequests=0;
 if(occupied){foreign=httpServer((_q,r)=>{foreignRequests++;r.statusCode=403;r.end()});await new Promise(r=>foreign.listen(0,'127.0.0.1',r));cp=foreign.address().port;}
 const env={};for(const k of['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{PORT:String(port),DATA_DIR:join(dir,'data'),YGL_HOME:join(dir,'home'),WM_CONTROL_PORT:String(cp),MCP_GATEWAY:off?'off':'on',ADMIN_TOKEN:'DO_NOT_LOG_SYNTHETIC_CREDENTIAL',REDIS_URL:'',NODE_ENV:nodeEnv,WM_SYNTHETIC_PROBE_MUTATION:mutation,WM_LOGIN_GATE:gate});
 if(unset)delete env.MCP_GATEWAY;
 if(nodeEnv===null)delete env.NODE_ENV;
 const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'server/src/index.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 const ended=once(child,'exit');let so='',se='',health=null,status=null,pendingChecked=false;
 child.stdout.on('data',b=>so+=b);child.stderr.on('data',b=>se+=b);
 try{
  for(let i=0;i<160;i++){
   if(child.exitCode!==null)break;
   try{const r=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(400)});status=r.status;health=await r.json();}catch{}
   if(mutation==='hold-probe'&&status===503&&!pendingChecked){
    check('pending real health never claims readiness',health.self_probe.passed===false&&health.self_probe.at===null);
    const r=await fetch('http://127.0.0.1:'+port+'/api/workbenches',{method:'POST',headers:{'content-type':'application/json','x-wm-self-probe':'forged',Origin:'http://untrusted.invalid'},body:JSON.stringify({name:'MUST_NOT_BE_CREATED',url:'http://127.0.0.1:9/'})});
    check('real startup gate blocks forged browser write before handling',r.status===503);
    check('real startup gate blocks WebSocket before portal handling',await websocket(port)===0);pendingChecked=true;
   }
   if(status===200)break;
   await new Promise(r=>setTimeout(r,75));
  }
  if(expectFailure){
   let wait;const finish=await Promise.race([ended,new Promise(r=>{wait=setTimeout(()=>r(null),3000)})]);clearTimeout(wait);
   check(label+' unsafe startup exits nonzero',finish!==null&&finish[0]!==0);
   check(label+' log identifies failed self-probe row',so.includes('"source":"self-probe"')&&so.includes('"verdict":"fail"'));
   if(mutation==='login-gate')check(label+' every login-gate row is named failed',['page','app','api'].every(k=>so.includes('"id":"market.login-gate.'+k+'","surface":"market","method":"GET","path":"'+({page:'/',app:'/apps/wm-self-probe/',api:'/api/apps'})[k]+'","verdict":"fail"')));
   if(mutation==='login-gate-apps')check(label+' only the leaking /apps row fails',so.includes('"id":"market.login-gate.app","surface":"market","method":"GET","path":"/apps/wm-self-probe/","verdict":"fail"')&&so.includes('"id":"market.login-gate.page","surface":"market","method":"GET","path":"/","verdict":"pass"'));
   if(mutation==='export-reveal')check(label+' only the export reveal row fails',so.includes('"id":"market.export.reveal-anonymous"')&&so.split('"verdict":"fail"').length===2);
   if(mutation==='grants-admin-read')check(label+' only the grant list row fails',so.includes('"id":"market.grants.admin-read"')&&so.split('"verdict":"fail"').length===2);
   if(mutation==='app-data-read')check(label+' only the app data read row fails',so.includes('"id":"market.app-data.anonymous-read"')&&so.split('"verdict":"fail"').length===2);
   if(mutation==='unsigned-login-event')check(label+' only the unsigned login event row fails',so.includes('"id":"market.login-flow.unsigned-event"')&&so.split('"verdict":"fail"').length===2);
   if(mutation==='forged-login-callback')check(label+' only the forged login callback row fails',so.includes('"id":"market.login-flow.forged-callback"')&&so.split('"verdict":"fail"').length===2);
   if(mutation==='principals-admin-read')check(label+' only the principal list row fails',so.includes('"id":"market.principals.admin-read","surface":"market","method":"GET","path":"/api/principals","verdict":"fail"')&&so.split('"verdict":"fail"').length===2);
   let closed=false;try{await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(300)})}catch{closed=true}
   check(label+' failure closes only the owned listener',closed);
   if(off&&nodeEnv!=='development'&&nodeEnv!=='test')check(label+' forbidden gateway mode has named failure and never healthy',so.includes('"reason":"gateway-off-forbidden"')&&so.includes('market.mcp.initialize')&&status!==200);
  }else{
   check(label+' health reports completed pass',status===200&&health?.self_probe?.passed===true&&health.self_probe.at!==null);
   check(label+' table has explicit control skip/pass',health.self_probe.rows.some(x=>x.id==='control.admin-read'&&x.verdict===(control&&!occupied?'pass':'skip')));
   if(off&&gate!=='enforce')check('explicit gateway off reports exactly two warnings',health.self_probe.rows.filter(x=>x.verdict==='warn').length===2);
   if(off&&gate==='enforce')check(label+' gateway forced on: MCP rows pass, no warnings, override logged',health.self_probe.rows.filter(x=>x.id.startsWith('market.mcp.')&&x.verdict==='pass').length===2&&!health.self_probe.rows.some(x=>x.verdict==='warn')&&se.includes('WM_LOGIN_GATE=enforce'));
   if(occupied)check('occupied control skips without probing the foreign process',foreignRequests===0&&health.self_probe.rows.some(x=>x.id==='control.admin-read'&&x.reason==='control-not-listening'));
   if(mutation==='hold-probe')check('real pending ingress checks ran before readiness',pendingChecked);
   if(gate==='enforce')check(label+' login-gate rows all pass',['page','app','api'].every(k=>health.self_probe.rows.some(x=>x.id==='market.login-gate.'+k&&x.verdict==='pass'))&&health.self_probe.rows.some(x=>x.id==='market.a2a-direct.unsigned'&&x.verdict==='pass')&&health.login_gate==='enforce');
   if(gate!=='enforce')check(label+' no login-gate rows when gate is off',!health.self_probe.rows.some(x=>x.id.startsWith('market.login-gate.')||x.id.startsWith('market.a2a-direct.')));
   check(label+' ordinary request works after successful startup',(await fetch('http://127.0.0.1:'+port+'/api/workbenches')).status===200);
  }
  const db=new DatabaseSync(join(dir,'data','workbench-market.db'),{readOnly:true});
  try{db.exec('PRAGMA query_only=ON');
   check(label+' probe creates no workbench business object',db.prepare("SELECT COUNT(*) n FROM workbenches WHERE url<>'/sop/task-center/'").get().n===0&&db.prepare("SELECT COUNT(*) n FROM workbenches WHERE url='/sop/task-center/'").get().n===1);
   check(label+' probe never invokes/audits a business MCP tool',db.prepare("SELECT COUNT(*) n FROM mcp_calls WHERE tool<>''").get().n===0);
   check(label+' self-probe does not increase write adoption stats',db.prepare("SELECT COUNT(*) n FROM endpoint_stats WHERE endpoint='/api/workbenches'").get().n===0);
  }finally{db.close();}
  check(label+' logs never contain admin credential or private request header',!(so+se).includes(env.ADMIN_TOKEN)&&!so.includes('x-wm-self-probe'));
 }finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill();await ended;}
  if(foreign){foreign.closeAllConnections();await new Promise(r=>foreign.close(r));}
  writeFileSync(join(dir,'stdout.log'),so);writeFileSync(join(dir,'stderr.log'),se);
 }
}
await runCase('production-off',{off:true,expectFailure:true});
await runCase('unset-environment-off',{off:true,nodeEnv:null,expectFailure:true});
await runCase('empty-environment-off',{off:true,nodeEnv:'',expectFailure:true});
await runCase('unknown-environment-off',{off:true,nodeEnv:'staging',expectFailure:true});
await runCase('normal-control',{control:true});
await runCase('normal-control-off');
await runCase('gateway-unset',{unset:true});
await runCase('occupied-control',{control:true,occupied:true});
await runCase('development-off',{off:true,nodeEnv:'development'});
await runCase('test-off',{off:true,nodeEnv:'test'});
await runCase('development-off-broken-write',{off:true,nodeEnv:'development',mutation:'browser-write',expectFailure:true});
await runCase('startup-ingress',{mutation:'hold-probe'});
await runCase('mcp-auth-regression',{mutation:'mcp-auth',expectFailure:true});
await runCase('browser-write-regression',{mutation:'browser-write',expectFailure:true});
await runCase('principals-admin-read-regression',{mutation:'principals-admin-read',expectFailure:true});
await runCase('forged-login-callback-regression',{mutation:'forged-login-callback',expectFailure:true});
await runCase('unsigned-login-event-regression',{mutation:'unsigned-login-event',expectFailure:true});
await runCase('export-reveal-regression',{mutation:'export-reveal',expectFailure:true});
await runCase('grants-admin-read-regression',{mutation:'grants-admin-read',expectFailure:true});
await runCase('app-data-read-regression',{mutation:'app-data-read',expectFailure:true});
await runCase('probe-timeout',{mutation:'mcp-timeout',expectFailure:true});
await runCase('probe-handler-error',{mutation:'handler-error',expectFailure:true});
await runCase('login-gate-enforce',{gate:'enforce',control:true});
await runCase('login-gate-enforce-gateway-off-ignored',{gate:'enforce',off:true});
await runCase('login-gate-bypassed',{gate:'enforce',mutation:'login-gate',expectFailure:true});
await runCase('login-gate-apps-leak',{gate:'enforce',mutation:'login-gate-apps',expectFailure:true});
await runCase('a2a-direct-unsigned-leak',{gate:'enforce',mutation:'a2a-direct-unsigned',expectFailure:true});
writeFileSync(join(out,'result.json'),JSON.stringify({checks,production_requests:0,personal_home_access:false},null,2));
console.log(JSON.stringify({out,checks}));
