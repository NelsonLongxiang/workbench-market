/** Pure offline SOP preservation planning. Import planSopPreservation({sourceDataDir,rows,hot}).
 * Never opens DB/Redis/files, never writes or captures data. Inputs must come from an independently
 * authorized, frozen, complete capture. No completeness, authenticity, backup or restore claim here.
 * The returned rows are PRIVATE migration material (including upload_token), not a public report.
 */
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
const fields=['id','sop_slug','sop_version','status','started_by','data','cache_revision','started_at','updated_at','finished_at','upload_token'];
const hash=x=>createHash('sha256').update(x).digest('hex');
export class SopPreservationRefusal extends Error{
 constructor(code,id){super(code);this.code=code;if(Number.isSafeInteger(id)&&id>0)this.run_id=id;}
}
const refuse=(code,id)=>{throw new SopPreservationRefusal(code,id)};
const integer=(n,min)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function parseObject(text,id,code){let value;try{value=JSON.parse(text)}catch{refuse(code,id)}if(!object(value))refuse(code,id);return value;}
function validateRow(r){
 if(!object(r)||!integer(r.id,1))refuse('durable_row_invalid');
 if(Object.keys(r).length!==fields.length||!fields.every(k=>Object.hasOwn(r,k)))refuse('durable_columns_unrecognized',r.id);
 if(!integer(r.cache_revision,0)||!integer(r.sop_version,1)||r.sop_version>2147483647)refuse('durable_integer_invalid',r.id);
 for(const k of fields.filter(k=>!['id','cache_revision','sop_version'].includes(k)))if(typeof r[k]!=='string'||r[k].includes(String.fromCharCode(0)))refuse('durable_text_invalid',r.id);
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.sop_slug)||!['running','finished'].includes(r.status))refuse('durable_state_unsupported',r.id);
 parseObject(r.data,r.id,'durable_data_invalid');
}
/** Exact legacy runtime checkpoint shape; sourceDataDir is the ORIGINAL runtime string, not restore path. */
export function legacySopCheckpoint(sourceDataDir,r){
 return hash(JSON.stringify([sourceDataDir,r.id,r.sop_slug,r.sop_version,r.started_at,r.cache_revision,r.status,r.data]));
}
export function planSopPreservation({sourceDataDir,rows,hot}){
 if(typeof sourceDataDir!=='string'||!isAbsolute(sourceDataDir)||sourceDataDir!==sourceDataDir.trim()||sourceDataDir.includes(String.fromCharCode(0)))refuse('original_data_dir_required');
 if(!Array.isArray(rows)||!Array.isArray(hot))refuse('capture_arrays_required');
 const byId=new Map(),hotById=new Map();
 for(const r of rows){validateRow(r);if(byId.has(r.id))refuse('duplicate_durable_run',r.id);byId.set(r.id,r);}
 for(const h of hot){
  if(!object(h)||!integer(h.id,1)||typeof h.snapshot!=='string')refuse('hot_record_invalid');
  if(hotById.has(h.id))refuse('duplicate_hot_run',h.id);
  if(!byId.has(h.id))refuse('orphan_hot_run',h.id);
  const snapshot=parseObject(h.snapshot,h.id,'hot_snapshot_invalid');
  if(snapshot.format!==2||typeof snapshot.checkpoint!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.checkpoint)||!object(snapshot.meta)||!object(snapshot.data))refuse('hot_snapshot_invalid',h.id);
  if(Object.keys(snapshot).sort().join(',')!=='checkpoint,data,format,meta'||Object.keys(snapshot.meta).sort().join(',')!=='slug,started_by,status,updated_at,version')refuse('hot_fields_unrecognized',h.id);
  hotById.set(h.id,{snapshot,sha256:hash(h.snapshot)});
 }
 const privateRows=[],entries=[];
 for(const r of [...byId.values()].sort((a,b)=>a.id-b.id)){
  const captured=hotById.get(r.id),snapshot=captured?.snapshot,original=JSON.stringify(fields.map(k=>r[k]));let selected=r.data;
  if(snapshot){
   // Even normally stale/retired entries need explicit resolution, never silent discard in migration.
   if(r.status!=='running'||r.sop_slug==='task-center')refuse('hot_state_requires_resolution',r.id);
   if(snapshot.checkpoint!==legacySopCheckpoint(sourceDataDir,r))refuse('hot_checkpoint_mismatch',r.id);
   const m=snapshot.meta;
   if(m.slug!==r.sop_slug||m.version!==r.sop_version||m.status!=='running'||m.started_by!==r.started_by||!integer(m.updated_at,0))refuse('hot_metadata_mismatch',r.id);
   selected=JSON.stringify({...parseObject(r.data,r.id,'durable_data_invalid'),...snapshot.data});
  }
  const output={};for(const k of fields)output[k]=k==='data'?selected:r[k];privateRows.push(output);
  entries.push({id:r.id,selection:snapshot?'bound-hot-merge':'durable-only',source_sha256:hash(original),hot_sha256:captured?.sha256??null,selected_sha256:hash(JSON.stringify(fields.map(k=>output[k]))),changed:selected!==r.data});
 }
 const summary={format:'wm-sop-preservation-plan/v1',source_identity_sha256:hash(sourceDataDir),durable_runs:rows.length,hot_runs:hot.length,changed_runs:entries.filter(x=>x.changed).length,entries};
 return {privateRows,summary};
}
