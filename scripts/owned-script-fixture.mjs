/** Snapshot fixture child-attested listener guard. Not a defense against malicious local port rebinding. */
import {spawn as nativeSpawn} from 'node:child_process';
import {networkInterfaces} from 'node:os';
const localAddresses=()=>new Set(['127.0.0.1','localhost','[::1]',...Object.values(networkInterfaces()).flat().filter(Boolean).map(i=>i.address)]);
export const fixtureLanHost=()=>Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&!i.internal)?.address??'';
const owners=new Map();let installed=false;
const preload="import net from'node:net';const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){this.once('listening',()=>{const a=this.address();if(a&&typeof a==='object')process.send?.({kind:'wm-owned-fixture-listener',port:a.port});});return original.apply(this,args)};";
export function spawn(file,args=[],options={}){
 const port=Number(options.env?.PORT);if(!Number.isInteger(port)||port<1||port>65534)throw Error('explicit_fixture_port_required');
 if(!installed){const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);const owner=owners.get(Number(url.port));if(owner){if(!localAddresses().has(url.hostname))throw Error('explicit_fixture_host_not_local');const end=Date.now()+15000;while(!owner.ready.has(Number(url.port))){if(owner.child.exitCode!==null||owner.child.signalCode!==null)throw Error('explicit_fixture_listener_not_owned');if(Date.now()>end)throw Error('explicit_fixture_listener_ownership_deadline');await new Promise(r=>setTimeout(r,20));}if(owner.child.exitCode!==null||owner.child.signalCode!==null)throw Error('explicit_fixture_child_exited');}return original(input,init);};installed=true;}
 let stdio=options.stdio??'pipe';if(typeof stdio==='string')stdio=[stdio,stdio,stdio,'ipc'];else{stdio=[...stdio];if(!stdio.includes('ipc'))stdio.push('ipc');}
 const child=nativeSpawn(file,['--import','data:text/javascript,'+encodeURIComponent(preload),...args],{...options,stdio});const owner={child,ready:new Set()};owners.set(port,owner);const control=options.env?.WM_CONTROL_PORT==='0'?0:Number(options.env?.WM_CONTROL_PORT??port+1);if(control)owners.set(control,owner);child.on('message',m=>{if(m?.kind==='wm-owned-fixture-listener'&&Number.isInteger(m.port))owner.ready.add(m.port);});return child;
}