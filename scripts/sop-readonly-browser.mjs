/** One browser, intercepted synthetic origin; no TCP listener or production DB/home. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {renderReadonlySopRun} from '../server/src/sop-readonly-assembly.ts';
const out=resolve('tmp/sop-readonly-browser-'+Date.now());mkdirSync(out,{recursive:true});
const marketOrigin='http://127.0.0.1:21916';
const source={targetId:4,slug:'inspection-sop',version:3,yaml:readFileSync(new URL('./fixtures/sop-readonly/typed-v3.yaml',import.meta.url),'utf8')};
const run={id:12,sop_slug:source.slug,sop_version:3,status:'running',data:{inspect:{note:'saved text',count:4,ok:true,tags:['a']},release:{private_note:'OTHER_STEP_VALUE'}}};
const html=renderReadonlySopRun(source,run,'inspect',7,marketOrigin);
writeFileSync(join(out,'rendered.html'),html);
const seedSource={targetId:8,slug:'demo-rack-sop',version:2,yaml:readFileSync(new URL('./fixtures/sop-readonly/demo-rack-v2.yaml',import.meta.url),'utf8')};
const seedRun={id:30,sop_slug:seedSource.slug,sop_version:2,status:'finished',data:{prepare:{配件数:'6',外观:'无'}}};
writeFileSync(join(out,'seed.html'),renderReadonlySopRun(seedSource,seedRun,'prepare',0,marketOrigin));
const config=join(out,'config.json');writeFileSync(config,JSON.stringify({url:marketOrigin+'/preview',html:join(out,'rendered.html'),seedHtml:join(out,'seed.html'),result:join(out,'browser.json'),screenshot:join(out,'preview.png')}));
const env={PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
let code=null;const p=spawn(process.env.PYTHON||'python',['scripts/sop-readonly-browser.py',config],{env,stdio:'inherit'});
const timer=setTimeout(()=>{console.error('owned SOP browser deadline exceeded');p.kill()},25000);
try{code=await new Promise((r,j)=>{p.once('exit',r);p.once('error',j)})}finally{clearTimeout(timer);writeFileSync(join(out,'result.json'),JSON.stringify({code,production:false,tcp_connections:0,scope:'Playwright request interception; actual Chromium opaque srcdoc/CSP; not HTTP transport or mounted Runner'},null,2));console.log({out,code})}
process.exitCode=code??1;
