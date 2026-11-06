/** Registry-only internal importer. Caller independently validates target/catalog/role and complete frozen capture.
 * No CLI/URL/credentials/source reads. Private auth_config remains exact text, never logged/decrypted.
 * Cross-table cookie/type/vars/cockpit references are NOT migrated or certified here.
 */
import {createHash} from 'node:crypto';
import {withPgTransaction} from '../server/src/pg-transaction.ts';
const fields=['id','name','url','type','icon','description','category','tags','enabled','health_path','last_status','last_checked_at','last_latency_ms','last_http_code','last_error','sort','auth_config','created_at','updated_at','cookie_set_id'];
const nullable=new Set(['icon','description','category','tags','health_path','last_status','last_checked_at','last_latency_ms','last_http_code','last_error']);
const int32=new Set(['enabled','sort','last_latency_ms','last_http_code']);
const integer=(value,min,max)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const hash=rows=>createHash('sha256').update(JSON.stringify([...rows].sort((a,b)=>a.id-b.id).map(r=>fields.map(k=>r[k])))).digest('hex');
export class RegistryImportRefusal extends Error{constructor(code){super(code);this.code=code;}}
const refuse=code=>{throw new RegistryImportRefusal(code)};
export async function importPgWorkbenches(pool,rows){
 if(!Array.isArray(rows))refuse('registry_capture_invalid');
 const ids=new Set(),snapshot=rows.map(raw=>{
  if(!raw||typeof raw!=='object'||Object.keys(raw).length!==fields.length||!fields.every(k=>Object.hasOwn(raw,k)))refuse('registry_capture_columns_invalid');
  const row={};for(const k of fields)row[k]=raw[k];
  for(const k of fields){const v=row[k];if(v===null&&nullable.has(k))continue;
   if(k==='id'||k==='cookie_set_id'){if(!integer(v,k==='id'?1:0,Number.MAX_SAFE_INTEGER))refuse('registry_capture_integer_invalid');}
   else if(int32.has(k)){if(!integer(v,-2147483648,2147483647))refuse('registry_capture_integer_invalid');}
   else if(typeof v!=='string'||v.includes(String.fromCharCode(0)))refuse('registry_capture_text_invalid');
  }
  if(![0,1].includes(row.enabled))refuse('registry_capture_enabled_invalid');
  if(ids.has(row.id))refuse('registry_capture_duplicate_id');ids.add(row.id);return row;
 }).sort((a,b)=>a.id-b.id);
 const max=snapshot.at(-1)?.id??0;if(max===Number.MAX_SAFE_INTEGER)refuse('registry_import_identity_exhausted');
 const expected=hash(snapshot);
 await withPgTransaction(pool,async tx=>{
  await tx.query('LOCK TABLE public.workbenches IN ACCESS EXCLUSIVE MODE');
  const cols=(await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='workbenches'")).rows.map(r=>r.column_name).sort();
  if(JSON.stringify(cols)!==JSON.stringify([...fields].sort()))refuse('registry_target_columns_mismatch');
  if((await tx.query('SELECT count(*)::text AS n FROM public.workbenches')).rows[0].n!=='0')refuse('registry_target_not_empty');
  await tx.query('ALTER TABLE public.workbenches ALTER COLUMN id RESTART WITH '+String(max+1));
  for(const row of snapshot)await tx.query('INSERT INTO public.workbenches('+fields.join(',')+') VALUES('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',fields.map(k=>row[k]));
  const readback=(await tx.query('SELECT * FROM public.workbenches')).rows.map(r=>({...r,id:Number(r.id),cookie_set_id:Number(r.cookie_set_id)}));
  if(readback.length!==snapshot.length||hash(readback)!==expected)refuse('registry_import_readback_mismatch');
 });
 return {format:'wm-pg-registry-import/v1',imported_rows:snapshot.length,selected_rows_sha256:expected,next_identity:max+1};
}
