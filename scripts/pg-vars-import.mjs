/** Internal vars+audit import, not source capture or runtime wiring.
 * Caller independently validates target/catalog/role and complete authorized frozen capture.
 * Preserve historical actors/actions/hashes; do not backfill owners or fabricate missing audit.
 */
import {createHash} from 'node:crypto';
import {withPgTransaction} from '../server/src/pg-transaction.ts';
const varsFields=['workbench_id','key','kind','value','revision','updated_by','created_at','updated_at'];
const auditFields=['id','workbench_id','key','action','actor','kind','old_revision','new_revision','old_sha256','new_sha256','reason','at'];
export class VarsImportRefusal extends Error{constructor(code){super(code);this.code=code;}}
const refuse=code=>{throw new VarsImportRefusal(code)};
const integer=(v,min)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const digest=(rows,fields)=>createHash('sha256').update(JSON.stringify(rows.map(r=>fields.map(k=>r[k])))).digest('hex');
const compare=(a,b)=>a.workbench_id-b.workbench_id||(a.key<b.key?-1:a.key>b.key?1:0);
function copy(rows,fields,audit){
 if(!Array.isArray(rows))refuse('vars_capture_invalid');const seen=new Set();
 return rows.map(raw=>{
  if(!raw||typeof raw!=='object'||Object.keys(raw).length!==fields.length||!fields.every(k=>Object.hasOwn(raw,k)))refuse('vars_capture_columns_invalid');
  const row={};for(const k of fields)row[k]=raw[k];
  for(const k of fields){const v=row[k];
   if(['id','workbench_id','revision','old_revision','new_revision'].includes(k)){
    if(v===null&&['old_revision','new_revision'].includes(k))continue;
    if(!integer(v,1))refuse('vars_capture_integer_invalid');
   }else if(typeof v!=='string'||v.includes(String.fromCharCode(0)))refuse('vars_capture_text_invalid');
  }
  if(!audit){if(!['var','const'].includes(row.kind))refuse('vars_capture_kind_invalid');try{JSON.parse(row.value)}catch{refuse('vars_capture_value_invalid')}}
  const identity=audit?row.id:JSON.stringify([row.workbench_id,row.key]);if(seen.has(identity))refuse('vars_capture_duplicate');seen.add(identity);return row;
 }).sort(audit?(a,b)=>a.id-b.id:compare);
}
function normalize(rows,fields){return rows.map(raw=>{const r={};for(const k of fields)r[k]=['id','workbench_id','revision','old_revision','new_revision'].includes(k)&&raw[k]!==null?Number(raw[k]):raw[k];return r;});}
export async function importPgVars(pool,capture){
 const variables=copy(capture?.variables,varsFields,false),audit=copy(capture?.audit,auditFields,true),max=audit.at(-1)?.id??0;
 if(max===Number.MAX_SAFE_INTEGER)refuse('vars_audit_identity_exhausted');
 const expectedVars=digest(variables,varsFields),expectedAudit=digest(audit,auditFields);
 await withPgTransaction(pool,async tx=>{
  // Parent first matches runtime lock ordering. Audit may legitimately outlive deleted parent/value rows.
  await tx.query('LOCK TABLE public.workbenches IN SHARE MODE');
  await tx.query('LOCK TABLE public.workbench_vars,public.workbench_var_audit IN ACCESS EXCLUSIVE MODE');
  for(const [table,fields]of [['workbench_vars',varsFields],['workbench_var_audit',auditFields]]){
   const columns=(await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.map(r=>r.column_name).sort();
   if(JSON.stringify(columns)!==JSON.stringify([...fields].sort()))refuse('vars_target_columns_mismatch');
   if((await tx.query('SELECT count(*)::text AS n FROM public.'+table)).rows[0].n!=='0')refuse('vars_target_not_empty');
  }
  for(const id of new Set(variables.map(r=>r.workbench_id)))if(!(await tx.query('SELECT id FROM public.workbenches WHERE id=$1',[id])).rows.length)refuse('vars_parent_missing');
  await tx.query('ALTER TABLE public.workbench_var_audit ALTER COLUMN id RESTART WITH '+String(max+1));
  for(const [table,fields,rows]of [['workbench_vars',varsFields,variables],['workbench_var_audit',auditFields,audit]])for(const row of rows)await tx.query('INSERT INTO public.'+table+'('+fields.join(',')+') VALUES('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',fields.map(k=>row[k]));
  const actualVars=normalize((await tx.query('SELECT * FROM public.workbench_vars ORDER BY workbench_id,key')).rows,varsFields).sort(compare);
  const actualAudit=normalize((await tx.query('SELECT * FROM public.workbench_var_audit ORDER BY id')).rows,auditFields);
  if(actualVars.length!==variables.length||actualAudit.length!==audit.length||digest(actualVars,varsFields)!==expectedVars||digest(actualAudit,auditFields)!==expectedAudit)refuse('vars_import_readback_mismatch');
 });
 return {format:'wm-pg-vars-audit-import/v1',variables:variables.length,audit_rows:audit.length,variables_sha256:expectedVars,audit_sha256:expectedAudit,next_audit_id:max+1};
}
