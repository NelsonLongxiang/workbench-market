/** Draft protocol stage 1. Pure preview renderer, NOT mounted in the market/Runner. */
import {createHash} from 'node:crypto';
type Field = { key: string; type: 'text' | 'number' | 'boolean' | 'multi'; required?: boolean; maxLength?: number; options?: string[]; maxItems?: number; operations?: ['read'] };
export type ReadonlySop = { targetId: number; runId: number; version: number; step: string; revision: number; marketOrigin: string; fields: Field[]; values: Record<string, unknown>; body: string };
const key = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v) && !['__proto__','constructor','prototype'].includes(v);
// Seed SOPs use Chinese field names; compare attributes directly, never CSS-interpolate.
const fieldKey = (v: unknown) => typeof v === 'string' && /^[\p{L}][\p{L}\p{N}_-]{0,63}$/u.test(v) && !['__proto__','constructor','prototype'].includes(v);
export function validateReadonlySop(input: ReadonlySop): ReadonlySop {
  if (!input || ['targetId','runId','version'].some(k => !Number.isSafeInteger(input[k]) || input[k] < 1) || !key(input.step) || !Number.isSafeInteger(input.revision) || input.revision < 0) throw Error('Invalid fixed SOP binding');
  const origin = new URL(input.marketOrigin); if (origin.origin !== input.marketOrigin || !['http:','https:'].includes(origin.protocol)) throw Error('Invalid trusted preview origin');
  if (!Array.isArray(input.fields) || input.fields.length > 100 || typeof input.body !== 'string' || Buffer.byteLength(input.body) > 256*1024) throw Error('Invalid SOP preview schema/body');
  const fields = new Map<string, Field>();
  for (const field of input.fields) {
    if (!field || !fieldKey(field.key) || fields.has(field.key) || !['text','number','boolean','multi'].includes(field.type)) throw Error('Unknown/duplicate field declaration');
    if (field.maxLength !== undefined && (!Number.isSafeInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 4096)) throw Error('Invalid field limit');
    if (field.required !== undefined && typeof field.required !== 'boolean' || field.maxItems !== undefined && (!Number.isSafeInteger(field.maxItems) || field.maxItems < 1 || field.maxItems > 50) || field.operations !== undefined && (!Array.isArray(field.operations) || field.operations.length !== 1 || field.operations[0] !== 'read')) throw Error('Invalid read-only field constraints');
    if (field.type === 'multi' && (!Array.isArray(field.options) || field.options.length > 50 || field.options.some(v => typeof v !== 'string' || v.length > 100) || new Set(field.options).size !== field.options.length)) throw Error('Invalid enum declaration');
    fields.set(field.key, field);
  }
  if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw Error('Invalid saved values');
  for (const [name, value] of Object.entries(input.values)) {
    const field = fields.get(name); if (!field) throw Error('Undeclared saved field');
    if (field.type === 'text' && (typeof value !== 'string' || value.length > (field.maxLength ?? 4096)) || field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) || field.type === 'boolean' && typeof value !== 'boolean' || field.type === 'multi' && (!Array.isArray(value) || value.length > (field.maxItems ?? 50) || new Set(value).size !== value.length || value.some(v => !field.options!.includes(v)))) throw Error('Saved value type/limit mismatch');
  }
  return structuredClone(input); // Do not retain a mutable caller-owned schema or values object.
}
const json = (value: unknown) => JSON.stringify(value).replace(/</g, String.fromCharCode(92) + 'u003c');
const escape = (v: string) => v.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// HTML parsing normalizes CRLF/CR before CSP hashing; emit exactly the bytes hashed.
const htmlScript = (source: string) => source.split(String.fromCharCode(13,10)).join(String.fromCharCode(10)).split(String.fromCharCode(13)).join(String.fromCharCode(10));
const scriptPolicy = (script: string) => "'sha256-" + createHash('sha256').update(script).digest('base64') + "'";
// These functions are serialized as browser code. They contain no server secrets/capabilities.
function frameRuntime(boot: any) {
  let nonce = '', port: MessagePort | null = null, closed = false, seq = 0;
  const exact = (m: any, keys: string[]) => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length === keys.length && keys.every(k => Object.hasOwn(m,k));
  const bindingKeys = ['protocol','targetId','runId','version','step','nonce'];
  const validValues = (values: any) => values && typeof values === 'object' && !Array.isArray(values) && Object.entries(values).every(([name,value]) => {
    const f = boot.fields.find((f: any) => f.key === name); if (!f) return false;
    if (f.type === 'text') return typeof value === 'string' && value.length <= (f.maxLength ?? 4096);
    if (f.type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (f.type === 'boolean') return typeof value === 'boolean';
    return Array.isArray(value) && value.length <= (f.maxItems ?? 50) && new Set(value).size === value.length && value.every(v => f.options.includes(v));
  });
  const matches = (m: any) => m && typeof m === 'object' && ['targetId','runId','version','step'].every(k => m[k] === boot[k]) && m.protocol === 1 && m.nonce === nonce;
  const lock = () => document.querySelectorAll('input,textarea,select,button,[contenteditable]').forEach((e: any) => { if (!e.disabled) e.disabled = true; if (e.hasAttribute('contenteditable') && e.getAttribute('contenteditable') !== 'false') e.setAttribute('contenteditable','false'); });
  const hydrate = (values: any) => {
    for (const field of boot.fields) for (const e of Array.from(document.querySelectorAll('[data-field]')) as any[]) {
      if (e.getAttribute('data-field') !== field.key || !['INPUT','SELECT','TEXTAREA'].includes(e.tagName)) continue;
      const value = values[field.key]; if (value === undefined) continue;
      if (field.type === 'boolean' && e.tagName === 'INPUT' && e.type === 'checkbox') e.checked = value;
      else if (field.type === 'multi' && e.tagName === 'SELECT' && e.multiple) for (const o of e.options) o.selected = value.includes(o.value);
      else if (field.type !== 'multi' && field.type !== 'boolean' && !(e.tagName === 'INPUT' && e.type === 'file')) e.value = String(value);
    }
    lock();
  };
  const end = () => { closed = true; lock(); port?.close(); port = null; window.removeEventListener('message', handshake); };
  const handshake = (event: MessageEvent) => {
    const m = event.data;
    if (closed || event.source !== parent || event.origin !== boot.marketOrigin || !m || typeof m !== 'object') return;
    if (m.type === 'PROBE' && exact(m,[...bindingKeys,'type']) && !nonce && typeof m.nonce === 'string' && /^[a-f0-9]{48}$/.test(m.nonce) && m.protocol === 1 && ['targetId','runId','version','step'].every(k => m[k] === boot[k])) {
      nonce = m.nonce; parent.postMessage({type:'READY',protocol:1,targetId:boot.targetId,runId:boot.runId,version:boot.version,step:boot.step,nonce,field_keys:Array.from(document.querySelectorAll('[data-field]'), e => e.getAttribute('data-field')).sort()}, boot.marketOrigin); return;
    }
    if (m.type !== 'INIT' || port || !nonce || !matches(m) || !exact(m,[...bindingKeys,'type','field_schema','readOnly','values','revision']) || event.ports.length !== 1 || m.readOnly !== true || m.revision !== boot.revision || JSON.stringify(m.field_schema) !== JSON.stringify(boot.fields) || !validValues(m.values)) { end(); return; }
    port = event.ports[0]; window.removeEventListener('message',handshake); hydrate(m.values);
    const reply = (type: string) => port?.postMessage({type,protocol:1,targetId:boot.targetId,runId:boot.runId,version:boot.version,step:boot.step,nonce,seq});
    port.onmessage = (event: MessageEvent) => {
      const message = event.data; if (closed || !matches(message) || !exact(message,[...bindingKeys,'type','seq',...(message.type === 'HYDRATE' ? ['values','revision'] : [])]) || !Number.isSafeInteger(message.seq) || message.seq !== seq + 1 || message.type === 'HYDRATE' && (message.revision !== boot.revision || !validValues(message.values))) { end(); return; }
      seq = message.seq;
      if (message.type === 'HYDRATE') { hydrate(message.values); reply('ACK'); }
      else if (message.type === 'LOCK') { lock(); reply('LOCK_ACK'); }
      else if (message.type === 'TEARDOWN') end();
      else end(); // Stage 1 has no CHANGE/UPLOAD/finish/unlock operation.
    };
    port.onmessageerror = end; port.start(); reply('ACK');
  };
  lock(); const observer = new MutationObserver(() => { observer.disconnect(); lock(); observer.observe(document.documentElement,{childList:true,subtree:true}); }); observer.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('message',handshake); window.addEventListener('pagehide',end);
}
function hostRuntime(boot: any, documentHtml: string) {
  const frame = document.getElementById('body-frame') as HTMLIFrameElement, state = document.getElementById('channel-state')!;
  let port: MessagePort | null = null, consumed = false, closed = false, seq = 0, expected = 'ACK', loading = false;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2,'0')).join('');
  const binding = {protocol:1,targetId:boot.targetId,runId:boot.runId,version:boot.version,step:boot.step,nonce};
  let frameWindow: Window | null = null;
  const currentFrame = () => frame.contentWindow === frameWindow && frame.isConnected !== false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (value: string) => { state.textContent = value; state.setAttribute('data-state',value); };
  const stop = (value='closed') => { if (closed) return; closed = true; clearTimeout(timer); window.removeEventListener('message',ready); port?.close(); port = null; set(value); frame.remove(); };
  const deadline = () => { clearTimeout(timer); timer = setTimeout(() => stop('timeout'),3000); };
  const send = (type: string) => { if (closed || !port || state.getAttribute('data-state') !== 'ready') return; if (!currentFrame()) { stop('replaced'); return; } seq++; expected = type === 'LOCK' ? 'LOCK_ACK' : 'ACK'; port.postMessage({...binding,type,seq,...(type === 'HYDRATE'?{values:boot.values,revision:boot.revision}:{})}); set('waiting'); deadline(); };
  const ready = (event: MessageEvent) => {
    const m = event.data; if (closed || consumed || !loading || !currentFrame() || event.source !== frameWindow || event.origin !== 'null') return;
    if (!m || Object.keys(m).length !== Object.keys(binding).length + 2 || Object.keys(m).some(k=>![...Object.keys(binding),'type','field_keys'].includes(k)) || m.type !== 'READY' || !Object.keys(binding).every(k => m[k] === binding[k]) || !Array.isArray(m.field_keys) || JSON.stringify(m.field_keys) !== JSON.stringify(boot.fields.map((f: any) => f.key).sort())) { stop('rejected'); return; }
    consumed = true; window.removeEventListener('message',ready); const channel = new MessageChannel(); port = channel.port1;
    port.onmessage = (event: MessageEvent) => {
      const m = event.data; if (closed) return;
      if (!currentFrame() || !m || !Object.keys(binding).every(k => m[k] === binding[k]) || m.type !== expected || m.seq !== seq || Object.keys(m).some(k => ![...Object.keys(binding),'type','seq'].includes(k))) { stop('rejected'); return; }
      clearTimeout(timer); expected = ''; set('ready');
    };
    port.onmessageerror = () => stop('rejected'); port.start();
    frame.contentWindow!.postMessage({...binding,type:'INIT',field_schema:boot.fields,readOnly:true,values:boot.values,revision:boot.revision},'*',[channel.port2]); set('waiting'); deadline();
  };
  window.addEventListener('message',ready);
  frame.addEventListener('load',() => { if (closed) return; if (loading) { stop('reloaded'); return; } loading = true; frameWindow = frame.contentWindow; frame.contentWindow!.postMessage({...binding,type:'PROBE'},'*'); set('handshake'); deadline(); });
  document.getElementById('hydrate')!.addEventListener('click',()=>send('HYDRATE'));
  document.getElementById('lock')!.addEventListener('click',()=>send('LOCK'));
  document.getElementById('teardown')!.addEventListener('click',()=>{ if (port) port.postMessage({...binding,type:'TEARDOWN',seq:++seq}); stop(); });
  window.addEventListener('pagehide',()=>stop());
  deadline(); frame.srcdoc = documentHtml; // Never interpolated into the trusted shell DOM.
}
export function renderReadonlySopPreview(input: ReadonlySop): string {
  const config = validateReadonlySop(input);
  const {body,values,...frameConfig} = config;
  const child = htmlScript('(' + frameRuntime.toString() + ')(' + json(frameConfig) + ');');
  const policy = "default-src 'none'; script-src " + scriptPolicy(child) + "; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
  const frame = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape(policy) + '"><body>' + body + '<script>' + child + '</script>';
  const host = htmlScript('(' + hostRuntime.toString() + ')(' + json({...config,body:undefined}) + ',' + json(frame) + ');');
  const hostPolicy = "default-src 'none'; script-src " + scriptPolicy(host) + " " + scriptPolicy(child) + "; frame-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape(hostPolicy) + '"><title>SOP read-only protocol preview</title><h1>SOP只读通道预览</h1><p id="channel-state" role="status" data-state="loading">loading</p><button id="hydrate">回填已存值</button><button id="lock">锁定</button><button id="teardown">销毁通道</button><iframe id="body-frame" title="隔离步骤正文" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><script>' + host + '</script>';
}
