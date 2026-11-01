/** Test-only Redis protocol. Optional file state survives only owned synthetic servers. */
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const stateFile=process.env.SYNTHETIC_REDIS_STATE;
const previous=stateFile&&existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
const hashes=new Map(Object.entries(previous.hashes??{})),active=new Set(previous.active??[]),fail=new Set();
const persist=()=>{if(stateFile)writeFileSync(stateFile,JSON.stringify({hashes:Object.fromEntries(hashes),active:[...active]}));};
let online=true;
const requireOnline=()=>{if(!online)throw Error('synthetic_redis_unavailable');};
const maybeFail=kind=>{if(fail.delete(kind))throw Error('synthetic_transient_'+kind);};
const client={
 get isReady(){return online;},on(){return this;},async connect(){online=true;return this;},
 async hSet(key,field,value){requireOnline();maybeFail(key.endsWith(':data')?'data':'meta');const row=hashes.get(key)??{};if(typeof field==='object')Object.assign(row,field);else row[field]=value;hashes.set(key,row);persist();},
 async hGetAll(key){requireOnline();return {...(hashes.get(key)??{})};},
 async sAdd(_key,value){requireOnline();maybeFail('active');active.add(value);persist();},
 async sRem(_key,value){requireOnline();active.delete(value);persist();},
 async sMembers(){requireOnline();return [...active];},async expire(){requireOnline();return 1;},
};
export const createClient=()=>client;
process.on('message',msg=>{
 if(msg?.kind!=='synthetic-redis')return;
 if(msg.action==='offline')online=false;
 if(msg.action==='online')online=true;
 if(msg.action==='clear'){hashes.clear();active.clear();}
 if(msg.action==='fail')fail.add(msg.operation);
 if(msg.action==='active'){active.clear();for(const id of msg.ids)active.add(String(id));}
 persist();process.send?.({kind:'synthetic-redis-receipt',id:msg.id,online,active:[...active]});
 if(msg.action==='graceful-stop')process.emit('SIGTERM','SIGTERM'); // exercise the actual server shutdown handler, not OS signal delivery
});
