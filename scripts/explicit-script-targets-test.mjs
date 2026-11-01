/** #341: actual script boundaries, intercepted negatives + real owned-loopback positives only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
const root=resolve('.'),out=resolve('tmp/explicit-targets-'+Date.now());mkdirSync(out,{recursive:true});
let checks=0;const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS '+name)};
const osEnv={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])osEnv[k]=process.env[k];
const run=(exe,args,extra={})=>new Promise((resolve,reject)=>{let stdout='',stderr='';const p=spawn(exe,args,{cwd:root,env:{...osEnv,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',...extra},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{p.kill();reject(Error('owned script test deadline'))},15000);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',e=>{clearTimeout(timer);reject(e)});p.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});});
const intercepted=String.raw`globalThis.fetch=async(url,opts={})=>{console.log('HTTP_ATTEMPT '+(opts.method??'GET'));return new Response(JSON.stringify(String(url).endsWith('/api/apps')?[{slug:'synthetic-app'}]:{results:[]}),{status:200,headers:{'content-type':'application/json'}})};`;
const pyIntercept=String.raw`import io,json,runpy,sys,urllib.request
class Reply:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):return False
 def read(self):return json.dumps({'version':1,'active_version':1,'status':'published','workbench_id':1}).encode()
def intercept(*args,**kwargs):
 print('HTTP_ATTEMPT',flush=True)
 return Reply()
urllib.request.urlopen=intercept
urllib.request.OpenerDirector.open=intercept
sys.argv=['scripts/seed-demo-sop.py',*sys.argv[1:]]
runpy.run_path('scripts/seed-demo-sop.py',run_name='__main__')
`;
const python=process.env.PYTHON||(process.platform==='win32'?'python':'python3');
const migrate=(args,stub=true)=>run(process.execPath,[...(stub?['--import','data:text/javascript,'+encodeURIComponent(intercepted)]:[]),'scripts/migrate-layerfs-p1.mjs',...args]);
const seed=(args,env={},stub=true)=>run(python,stub?['-c',pyIntercept,...args]:['scripts/seed-demo-sop.py',...args],env);
const deny=async(name,result)=>{check(name+' nonzero',result.code!==0);check(name+' zero HTTP calls',!result.stdout.includes('HTTP_ATTEMPT'));};
await deny('seed missing explicit target',await seed(['--target-mode','isolated']));
await deny('migration missing explicit target',await migrate(['--target-mode','isolated']));
const forbidden=[
 ['reserved9800','http://127.0.0.1:9800'],['reserved9801','http://127.0.0.1:9801'],['DSH3080','http://127.0.0.1:3080'],
 ['remote','https://production.synthetic.invalid:443'],['default-port','http://127.0.0.1'],['userinfo','http://user:secret@127.0.0.1:21991'],
 ['path','http://127.0.0.1:21991/prefix'],['query','http://127.0.0.1:21991/?key=value'],['fragment','http://127.0.0.1:21991/#x'],
 ['file','file:///tmp/not-http'],['whitespace',' http://127.0.0.1:21991'],['bad-port','http://127.0.0.1:99999'],['alternate-ip','http://2130706433:21991'],
 ];
for(const [name,target]of forbidden){await deny('seed isolated rejects '+name,await seed(['--target-mode','isolated'],{SEED_BASE:target}));await deny('migration isolated rejects '+name,await migrate(['--api',target,'--target-mode','isolated']));}
for(const [label,args]of [['missing-mode',[]],['unknown-mode',['--target-mode','staging']],['prod-no-ack',['--target-mode','production']],['typo-ack',['--target-mode','production','--ack-production-targte']]]){
 await deny('seed '+label,await seed(args,{SEED_BASE:'http://127.0.0.1:21991'}));await deny('migration '+label,await migrate(['--api','http://127.0.0.1:21991',...args]));
}
await deny('migration dry mode still requires target mode',await migrate(['--api','http://127.0.0.1:9800','--dry']));
await deny('seed refuses an unknown CLI argument',await seed(['--target-mode','isolated','--mistyped-flag'],{SEED_BASE:'http://127.0.0.1:21991'}));
await deny('migration refuses duplicate target',await migrate(['--api','http://127.0.0.1:21991','--api','http://127.0.0.1:21992','--target-mode','isolated']));
let received=[],redirectMode=false,foreignHits=0;
const foreign=createServer((_q,r)=>{foreignHits++;r.writeHead(200,{'content-type':'application/json'});r.end('{}')});await new Promise(r=>foreign.listen(0,'127.0.0.1',r));
const server=createServer((q,r)=>{received.push({method:q.method,path:q.url});q.resume();if(redirectMode){r.writeHead(307,{Location:'http://127.0.0.1:'+foreign.address().port+'/redirected'});r.end();return;}r.writeHead(q.method==='POST'&&q.url==='/api/apps'?201:200,{'content-type':'application/json'});r.end(JSON.stringify(q.url==='/api/apps'&&q.method==='GET'?[{slug:'synthetic-app'}]:q.url?.endsWith('/migrate-layerfs')?{results:[{version:1,result:'migrated',sha256_match:true}]}:{version:1,active_version:1,status:'published',workbench_id:1}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;assert(![3080,9800,9801].includes(server.address().port));
try{
 received=[];const localSeed=await seed(['--target-mode','isolated'],{SEED_BASE:base},false);check('explicit isolated seed succeeds',localSeed.code===0);check('seed uses only expected target paths',received.length===3&&received[0].method==='POST'&&received[0].path==='/api/apps'&&received[1].path==='/api/sops/demo-rack-sop/publish'&&received[2].method==='GET');
 received=[];const localMigration=await migrate(['--api',base,'--target-mode','isolated'],false);if(localMigration.code!==0)console.error('isolated migration diagnostic',localMigration);check('explicit isolated migration succeeds',localMigration.code===0);check('migration requests only selected target',received.length===2&&received[0].path==='/api/apps'&&received[1].path==='/api/apps/synthetic-app/migrate-layerfs');
 received=[];const dry=await migrate(['--api',base,'--target-mode','isolated','--dry'],false);check('dry migration reads list but performs zero writes',dry.code===0&&received.length===1&&received[0].method==='GET');
 received=[];check('production-mode seed with explicit ack succeeds only on synthetic target',(await seed(['--target-mode','production','--ack-production-target'],{SEED_BASE:base},false)).code===0&&received.length===3);
 received=[];check('production-mode migration with explicit ack succeeds only on synthetic target',(await migrate(['--api',base,'--target-mode','production','--ack-production-target'],false)).code===0&&received.length===2);
 redirectMode=true;received=[];const seedRedirect=await seed(['--target-mode','isolated'],{SEED_BASE:base},false);check('seed rejects redirect instead of following target changes',seedRedirect.code!==0&&received.length===1&&foreignHits===0);
 received=[];const migrationRedirect=await migrate(['--api',base,'--target-mode','isolated'],false);check('migration rejects redirect instead of following target changes',migrationRedirect.code!==0&&received.length===1&&foreignHits===0);
}finally{for(const s of [server,foreign]){s.closeAllConnections();await new Promise(r=>s.close(r));}}
const summary={checks,production_requests:0,personal_home_access:false,scope:'stubbed all negative HTTP + owned 127.0.0.1 ephemeral positive targets'};writeFileSync(join(out,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({out,...summary}));
