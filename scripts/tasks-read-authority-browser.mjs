/** #324 actual TasksView, intercepted synthetic origin only; no server or personal workspace. */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const out=resolve('tmp/tasks-read-browser-'+Date.now());mkdirSync(out,{recursive:true});
const req=createRequire(resolve('web/package.json'));const {build}=createRequire(req.resolve('vite'))('esbuild');
await build({entryPoints:['scripts/tasks-read-authority-fixture.tsx'],bundle:true,outfile:join(out,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',nodePaths:[resolve('web/node_modules')],define:{'process.env.NODE_ENV':'"test"'}});
const config=join(out,'config.json');writeFileSync(config,JSON.stringify({bundle:join(out,'fixture.js'),result:join(out,'result.json'),screenshot:join(out,'tasks-authority.png')}));
const env={PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'};for(const k of['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
const child=spawn(process.env.PYTHON||'python',['scripts/tasks-read-authority-browser.py',config],{env,stdio:'inherit'}),timer=setTimeout(()=>{console.error('owned browser test deadline exceeded');child.kill()},45000);
let code;try{code=await new Promise((r,j)=>{child.once('exit',r);child.once('error',j)})}finally{clearTimeout(timer)}console.log(JSON.stringify({out,code,production:false,tcp_listeners:0}));process.exitCode=code??1;
