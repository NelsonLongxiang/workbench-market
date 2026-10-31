/** Built web app rendering with synthetic intercepted API, no TCP or production. */
import{spawn}from'node:child_process';import{mkdirSync,writeFileSync,existsSync}from'node:fs';import{resolve,join}from'node:path';
const dist=resolve(process.argv[2]??'web/dist');if(!existsSync(join(dist,'index.html')))throw Error('Build web first');
const out=resolve('tmp/sop309-ui-'+Date.now());mkdirSync(out,{recursive:true});const config=join(out,'config.json');writeFileSync(config,JSON.stringify({dist,screenshot:join(out,'metadata-ui.png'),result:join(out,'browser.json')}));
const env={PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'};for(const key of['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];const p=spawn(process.env.PYTHON||'python',['scripts/sop-list-privacy-browser.py',config],{env,stdio:'inherit'}),timer=setTimeout(()=>p.kill(),20000);let code;
try{code=await new Promise((r,j)=>{p.once('exit',r);p.once('error',j)})}finally{clearTimeout(timer);console.log({out,code})}process.exitCode=code??1;
