/** One browser, intercepted synthetic origin; no TCP listener or production DB/home. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {renderReadonlySopPreview} from '../server/src/sop-readonly-channel.ts';
const out=resolve('tmp/sop-readonly-browser-'+Date.now());mkdirSync(out,{recursive:true});
const marketOrigin='http://127.0.0.1:21916';
const html=renderReadonlySopPreview({targetId:4,runId:12,version:3,step:'inspect',revision:0,marketOrigin,fields:[{key:'note',type:'text',maxLength:100},{key:'count',type:'number'},{key:'ok',type:'boolean'},{key:'tags',type:'multi',options:['a','b']}],values:{note:'saved text',count:4,ok:true,tags:['a']},body:'<label>Note<input data-field="note"></label><input type="number" data-field="count"><input type="checkbox" data-field="ok"><select multiple data-field="tags"><option value="a">A</option><option value="b">B</option></select><script>window.untrustedScriptRan=true</script><button onclick="parent.document.body.innerHTML=1">untrusted</button>'});
writeFileSync(join(out,'rendered.html'),html);
const config=join(out,'config.json');writeFileSync(config,JSON.stringify({url:marketOrigin+'/preview',html:join(out,'rendered.html'),result:join(out,'browser.json'),screenshot:join(out,'preview.png')}));
const env={PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
let code=null;const p=spawn(process.env.PYTHON||'python',['scripts/sop-readonly-browser.py',config],{env,stdio:'inherit'});
const timer=setTimeout(()=>{console.error('owned SOP browser deadline exceeded');p.kill()},25000);
try{code=await new Promise((r,j)=>{p.once('exit',r);p.once('error',j)})}finally{clearTimeout(timer);writeFileSync(join(out,'result.json'),JSON.stringify({code,production:false,tcp_connections:0,scope:'Playwright request interception; actual Chromium opaque srcdoc/CSP; not HTTP transport or mounted Runner'},null,2));console.log({out,code})}
process.exitCode=code??1;
