/** Unmounted editable SOP protocol preview. No upload, finish or existing Runner integration. */
import {createHash} from 'node:crypto';
import {validateReadonlySop,type ReadonlySop} from './sop-readonly-channel.ts';
import {SOP_FIELD_SAVE_PATH} from './sop-field-save.ts';
// Serialized on both sides. No dynamic schema registration, URL or HTTP-method fields.
function validValues(fields:any[],values:any,complete=false) {
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>100)return false;
  if(complete&&fields.some(f=>f.required&&(!Object.hasOwn(values,f.key)||values[f.key]===''||Array.isArray(values[f.key])&&!values[f.key].length)))return false;
  return Object.entries(values).every(([key,v])=>{const f=fields.find(f=>f.key===key);if(!f)return false;
    if(f.type==='text')return typeof v==='string'&&v.length<=(f.maxLength??4096);
    if(f.type==='number')return typeof v==='number'&&Number.isFinite(v);
    if(f.type==='boolean')return typeof v==='boolean';
    return Array.isArray(v)&&v.length<=(f.maxItems??50)&&new Set(v).size===v.length&&v.every(x=>f.options.includes(x));});
}
function frameRuntime(boot:any,valid:typeof validValues) {
  let port:MessagePort|null=null,nonce='',closed=false,locked=true,rx=0,tx=0;
  const keys=['protocol','targetId','runId','version','step','nonce'];
  const exact=(m:any,extras:string[])=>m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).length===keys.length+extras.length&&[...keys,...extras].every(k=>Object.hasOwn(m,k));
  const match=(m:any)=>m&&keys.every(k=>m[k]===(k==='nonce'?nonce:k==='protocol'?1:boot[k]));
  const controls=()=>Array.from(document.querySelectorAll('[data-field]')) as any[];
  const lock=()=>{locked=true;for(const e of Array.from(document.querySelectorAll('input,textarea,select,button,[contenteditable]')) as any[]){e.disabled=true;if(e.hasAttribute('contenteditable'))e.setAttribute('contenteditable','false');}};
  const apply=(values:any)=>{for(const e of controls()){const f=boot.fields.find((f:any)=>f.key===e.getAttribute('data-field')),v=values[f?.key];if(!f||v===undefined)continue;if(f.type==='boolean')e.checked=v;else if(f.type==='multi')for(const o of e.options)o.selected=v.includes(o.value);else e.value=String(v);}};
  const collect=()=>Object.fromEntries(controls().map(e=>{const f=boot.fields.find((f:any)=>f.key===e.getAttribute('data-field'));return [f.key,f.type==='boolean'?e.checked:f.type==='multi'?Array.from(e.selectedOptions,(o:any)=>o.value):f.type==='number'?(e.value===''?null:Number(e.value)):e.value];}));
  const send=(type:string,extra:any={})=>port?.postMessage({protocol:1,targetId:boot.targetId,runId:boot.runId,version:boot.version,step:boot.step,nonce,type,seq:++tx,...extra});
  const end=()=>{closed=true;lock();port?.close();port=null;window.removeEventListener('message',handshake);};
  const change=(event:Event)=>{if(closed||locked||!port)return;const e=event.target as any,f=boot.fields.find((f:any)=>f.key===e?.getAttribute?.('data-field'));if(!f||!f.operations.includes('save'))return;const values=collect();send('CHANGE',{field:f.key,value:values[f.key]});};
  const handshake=(event:MessageEvent)=>{const m=event.data;if(closed||event.source!==parent||event.origin!==boot.marketOrigin)return;
    if(!nonce&&m?.type==='PROBE'&&exact(m,['type'])&&typeof m.nonce==='string'&&/^[a-f0-9]{48}$/.test(m.nonce)&&['targetId','runId','version','step'].every(k=>m[k]===boot[k])&&m.protocol===1){nonce=m.nonce;parent.postMessage({...m,type:'READY',field_keys:controls().map(e=>e.getAttribute('data-field')).sort()},boot.marketOrigin);return;}
    if(m?.type!=='INIT'||!nonce||!match(m)||!exact(m,['type','values','field_schema','revision','readOnly'])||m.readOnly!==false||m.revision!==boot.revision||JSON.stringify(m.field_schema)!==JSON.stringify(boot.fields)||event.ports.length!==1||!valid(boot.fields,m.values)){end();return;}
    port=event.ports[0];window.removeEventListener('message',handshake);apply(m.values);lock();locked=false;
    for(const e of controls()){const f=boot.fields.find((f:any)=>f.key===e.getAttribute('data-field'));if(f?.operations.includes('save')&&['INPUT','SELECT','TEXTAREA'].includes(e.tagName)&&e.type!=='file')e.disabled=false;}
    port.onmessage=event=>{const m=event.data;if(closed||!match(m)||!Number.isSafeInteger(m.seq)||m.seq!==rx+1){end();return;}rx=m.seq;
      if(m.type==='COLLECT'&&exact(m,['type','seq','request_id'])&&typeof m.request_id==='string'){send('VALUES',{request_id:m.request_id,values:collect()});}
      else if(m.type==='VALIDATE_RESULT'&&exact(m,['type','seq','ok','revision','code'])&&typeof m.ok==='boolean'&&Number.isSafeInteger(m.revision)&&typeof m.code==='string'){document.documentElement.setAttribute('data-validation',m.ok?'saved':m.code);}
      else if(m.type==='HYDRATE'&&exact(m,['type','seq','values'])&&valid(boot.fields,m.values)){apply(m.values);send('ACK');}
      else if(m.type==='LOCK'&&exact(m,['type','seq'])){lock();send('LOCK_ACK');}
      else if(m.type==='TEARDOWN'&&exact(m,['type','seq']))end();else end();};
    port.onmessageerror=end;port.start();send('ACK');
  };
  lock();window.addEventListener('message',handshake);document.addEventListener('input',change);document.addEventListener('change',change);window.addEventListener('pagehide',end);
}
function hostRuntime(boot:any,html:string,capability:string,endpoint:string,valid:typeof validValues) {
  const frame=document.getElementById('body-frame') as HTMLIFrameElement,state=document.getElementById('channel-state')!;
  const nonce=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join(''),binding={protocol:1,targetId:boot.targetId,runId:boot.runId,version:boot.version,step:boot.step,nonce};
  let port:MessagePort|null=null,frameWindow:Window|null=null,loaded=false,closed=false,consumed=false,rx=0,tx=0,revision=boot.revision,pending:any={},saving=false,collectId='',locked=false,ready=false,invalid=false;
  let deadline:any,timer:any,controller:AbortController|null=null;
  const current=()=>frame.isConnected&&frame.contentWindow===frameWindow;
  const set=(value:string)=>{state.textContent=value;state.setAttribute('data-state',value);};
  const stop=(reason='closed')=>{if(closed)return;closed=true;ready=false;clearTimeout(deadline);clearTimeout(timer);controller?.abort();port?.close();port=null;window.removeEventListener('message',handshake);frame.remove();set(reason);};
  const bound=(m:any)=>m&&Object.keys(binding).every(k=>m[k]===(binding as any)[k]);
  const exact=(m:any,extras:string[])=>m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).length===Object.keys(binding).length+extras.length&&[...Object.keys(binding),...extras].every(k=>Object.hasOwn(m,k));
  const send=(type:string,extra:any={})=>{if(closed||!port||!current()){stop('replaced');return;}port.postMessage({...binding,type,seq:++tx,...extra});};
  const arm=()=>{clearTimeout(deadline);deadline=setTimeout(()=>stop('timeout'),3000);};
  const result=(ok:boolean,code:string)=>send('VALIDATE_RESULT',{ok,revision,code});
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void flush(),400);};
  async function flush(){if(closed||locked||saving||collectId||!Object.keys(pending).length)return;if(!current()){stop('replaced');return;}const values=pending;pending={};saving=true;set('saving');controller=new AbortController();const timeout=setTimeout(()=>controller?.abort(),5000);
    try {const response=await fetch(endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Sop-Run-Capability':capability},signal:controller.signal,body:JSON.stringify({targetId:boot.targetId,runId:boot.runId,step:boot.step,version:boot.version,expected_revision:revision,values})});
      if(closed||locked||!current())return;if(!response.ok){pending={...values,...pending};result(false,response.status===409?'conflict':'save_failed');stop(response.status===409?'conflict':'save_failed');return;}
      const saved=await response.json();if(closed||locked||!current())return;if(!saved||Object.keys(saved).sort().join(',')!=='ok,revision'||saved.ok!==true||saved.revision!==revision+1){stop('invalid_response');return;}revision=saved.revision;result(!invalid,invalid?'invalid_field_values':'saved');set(invalid?'invalid':Object.keys(pending).length?'dirty':'saved');
    }catch{if(!closed&&!locked){result(false,'save_failed');stop('save_failed');}}finally{clearTimeout(timeout);saving=false;if(!closed&&Object.keys(pending).length)schedule();}
  }
  const handshake=(event:MessageEvent)=>{if(closed||consumed||!loaded||!current()||event.source!==frameWindow||event.origin!=='null')return;const m=event.data;
    if(!bound(m)||!exact(m,['type','field_keys'])||m.type!=='READY'||JSON.stringify(m.field_keys)!==JSON.stringify(boot.fields.map((f:any)=>f.key).sort())){stop('rejected');return;}
    consumed=true;window.removeEventListener('message',handshake);const channel=new MessageChannel();port=channel.port1;
    port.onmessage=event=>{const m=event.data;if(closed)return;if(!current()||!bound(m)||!Number.isSafeInteger(m.seq)||m.seq!==rx+1){stop('rejected');return;}rx=m.seq;
      if(!ready){if(m.type!=='ACK'||!exact(m,['type','seq'])){stop('rejected');return;}ready=true;clearTimeout(deadline);set('ready');return;}
      if(m.type==='CHANGE'&&exact(m,['type','seq','field','value'])&&!locked){const field=boot.fields.find((f:any)=>f.key===m.field);if(!field?.operations.includes('save')||!valid(boot.fields,{[m.field]:m.value})){invalid=true;clearTimeout(timer);pending={};result(false,'invalid_field_values');set('invalid');return;}invalid=false;pending[m.field]=m.value;set('dirty');schedule();}
      else if(m.type==='VALUES'&&exact(m,['type','seq','request_id','values'])&&collectId&&m.request_id===collectId&&!locked){clearTimeout(deadline);collectId='';if(!valid(boot.fields,m.values,true)){invalid=true;pending={};result(false,'invalid_field_values');set('invalid');return;}invalid=false;pending={...pending,...Object.fromEntries(Object.entries(m.values).filter(([key])=>boot.fields.find((f:any)=>f.key===key)?.operations.includes('save')))};set('collected');schedule();}
      else if(m.type==='LOCK_ACK'&&locked&&exact(m,['type','seq'])){clearTimeout(deadline);set(m.type==='LOCK_ACK'?'locked':'ready');}
      else stop('rejected');};
    port.onmessageerror=()=>stop('rejected');port.start();frameWindow!.postMessage({...binding,type:'INIT',values:boot.values,field_schema:boot.fields,revision,readOnly:false},'*',[channel.port2]);arm();};
  window.addEventListener('message',handshake);frame.addEventListener('load',()=>{if(closed)return;if(loaded){stop('reloaded');return;}loaded=true;frameWindow=frame.contentWindow;frameWindow!.postMessage({...binding,type:'PROBE'},'*');arm();});
  document.getElementById('collect')!.addEventListener('click',()=>{if(!ready||closed||locked||collectId||saving)return;clearTimeout(timer);collectId=crypto.randomUUID();send('COLLECT',{request_id:collectId});set('collecting');arm();});
  document.getElementById('lock')!.addEventListener('click',()=>{if(!ready||closed)return;locked=true;pending={};clearTimeout(timer);controller?.abort();send('LOCK');arm();});
  document.getElementById('teardown')!.addEventListener('click',()=>{if(port)send('TEARDOWN');stop();});window.addEventListener('pagehide',()=>stop());arm();frame.srcdoc=html;
}
const normalize=(s:string)=>s.split(String.fromCharCode(13,10)).join(String.fromCharCode(10)).split(String.fromCharCode(13)).join(String.fromCharCode(10));
const json=(v:unknown)=>JSON.stringify(v).replace(/</g,String.fromCharCode(92)+'u003c');
const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const hash=(s:string)=>"'sha256-"+createHash('sha256').update(s).digest('base64')+"'";
export function renderEditableSopPreview(input:ReadonlySop,capability:string):string {
  const config=validateReadonlySop(input,true);if(!/^[A-Za-z0-9_-]{43}[.][A-Za-z0-9_-]{43}$/.test(capability))throw Error('Shell capability required');
  const {body,values,...childConfig}=config,child=normalize('('+frameRuntime.toString()+')('+json(childConfig)+','+validValues.toString()+');');
  const policy="default-src 'none'; script-src "+hash(child)+"; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
  const html='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+escape(policy)+'"><body>'+body+'<script>'+child+'</script>';
  const host=normalize('('+hostRuntime.toString()+')('+json({...config,body:undefined})+','+json(html)+','+json(capability)+','+json(SOP_FIELD_SAVE_PATH)+','+validValues.toString()+');');
  const hostPolicy="default-src 'none'; script-src "+hash(host)+' '+hash(child)+"; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'";
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+escape(hostPolicy)+'"><h1>SOP字段通道候选（未切流）</h1><p id="channel-state" data-state="loading" role="status">loading</p><button id="collect">收集当前步骤</button><button id="lock">锁定</button><button id="teardown">销毁</button><iframe id="body-frame" title="隔离步骤字段" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>'+host+'</script>';
}
