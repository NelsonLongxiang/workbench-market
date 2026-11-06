/** Internal submission-only import. Caller verifies target/catalog/role and complete authorized frozen capture.
 * No source reads/CLI/URL. App existence/contracts/events/file references remain external prerequisites.
 */
import {createHash} from 'node:crypto';
import {withPgTransaction} from '../server/src/pg-transaction.ts';
const fields=['id','app_slug','data','created_by','created_at','deleted_at','idempotency_key'];
export class AppDataImportRefusal extends Error{constructor(code){super(code);this.code=code;}}
const refuse=code=>{throw new AppDataImportRefusal(code)};
const digest=rows=>createHash('sha256').update(JSON.stringify([...rows].sort((a,b)=>a.id-b.id).map(r=>fields.map(k=>r[k])))).digest('hex');
export async function importPgAppData(pool,rows){
 if(!Array.isArray(rows))refuse('submission_capture_invalid');const ids=new Set(),keys=new Set();
 const snapshot=rows.map(raw=>{
  if(!raw||typeof raw!=='object'||Object.keys(raw).length!==fields.length||!fields.every(k=>Object.hasOwn(raw,k)))refuse('submission_capture_columns_invalid');
  const r={};for(const k of fields)r[k]=raw[k];
  if(typeof r.id!=='number'||!Number.isSafeInteger(r.id)||r.id<1)refuse('submission_capture_id_invalid');
  for(const k of fields.slice(1))if(typeof r[k]!=='string'||r[k].includes(String.fromCharCode(0)))refuse('submission_capture_text_invalid');
  try{JSON.parse(r.data)}catch{refuse('submission_capture_json_invalid')}
  if(ids.has(r.id))refuse('submission_capture_duplicate_id');ids.add(r.id);
  if(r.idempotency_key){const key=JSON.stringify([r.app_slug,r.idempotency_key]);if(keys.has(key))refuse('submission_capture_duplicate_key');keys.add(key);}
  return r;
 }).sort((a,b)=>a.id-b.id),max=snapshot.at(-1)?.id??0;
 if(max===Number.MAX_SAFE_INTEGER)refuse('submission_identity_exhausted');const expected=digest(snapshot);
 await withPgTransaction(pool,async tx=>{
  await tx.query('LOCK TABLE public.app_data IN ACCESS EXCLUSIVE MODE');
  const columns=(await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='app_data'")).rows.map(r=>r.column_name).sort();
  if(JSON.stringify(columns)!==JSON.stringify([...fields].sort()))refuse('submission_target_columns_mismatch');
  if((await tx.query('SELECT count(*)::text AS n FROM public.app_data')).rows[0].n!=='0')refuse('submission_target_not_empty');
  await tx.query('ALTER TABLE public.app_data ALTER COLUMN id RESTART WITH '+String(max+1));
  for(const r of snapshot)await tx.query('INSERT INTO public.app_data('+fields.join(',')+') VALUES('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',fields.map(k=>r[k]));
  const actual=(await tx.query('SELECT * FROM public.app_data')).rows.map(r=>({...r,id:Number(r.id)}));
  if(actual.length!==snapshot.length||digest(actual)!==expected)refuse('submission_import_readback_mismatch');
 });
 return {format:'wm-pg-submission-import/v1',imported_rows:snapshot.length,selected_rows_sha256:expected,next_identity:max+1};
}
