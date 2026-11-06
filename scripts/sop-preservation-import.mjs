/** Internal SOP-only PG import primitive; no CLI, URL, credential resolution or production capture.
 * Caller must independently validate target/schema/role and freeze a complete authorized capture.
 * Does not prove cross-table consistency, source completeness, backup or disaster recovery.
 */
import {createHash} from 'node:crypto';
import {planSopPreservation,SopPreservationRefusal} from './sop-preservation-plan.mjs';
import {withPgTransaction} from '../server/src/pg-transaction.ts';
const fields=['id','sop_slug','sop_version','status','started_by','data','cache_revision','started_at','updated_at','finished_at','upload_token'];
const digest=rows=>createHash('sha256').update(JSON.stringify(rows.map(r=>fields.map(k=>r[k])))).digest('hex');
const refuse=code=>{throw new SopPreservationRefusal(code)};
function normalized(rows){return rows.map(r=>{const row={};for(const k of fields){row[k]=['id','cache_revision'].includes(k)?Number(r[k]):r[k];}return row;});}
export async function importSopPreservation(pool,capture){
 // Planner makes independent primitive-only private rows before the first asynchronous checkout.
 const {privateRows,summary}=planSopPreservation(capture);
 const max=privateRows.at(-1)?.id??0;
 if(max>=Number.MAX_SAFE_INTEGER)refuse('import_identity_exhausted');
 const expected=digest(privateRows);
 await withPgTransaction(pool,async tx=>{
  await tx.query('LOCK TABLE public.sop_runs IN ACCESS EXCLUSIVE MODE');
  const count=await tx.query('SELECT count(*)::text AS n FROM public.sop_runs');
  if(count.rows[0].n!=='0')refuse('import_target_not_empty');
  const cols=await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='sop_runs' ORDER BY ordinal_position");
  if(JSON.stringify(cols.rows.map(r=>r.column_name).sort())!==JSON.stringify([...fields].sort()))refuse('import_target_columns_mismatch');
  // Transactional RESTART precedes inserts: ALTER TABLE cannot follow pending deferred trigger events.
  await tx.query('ALTER TABLE public.sop_runs ALTER COLUMN id RESTART WITH '+String(max+1));
  for(const row of privateRows)await tx.query('INSERT INTO public.sop_runs('+fields.join(',')+') VALUES('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',fields.map(k=>row[k]));
  const saved=await tx.query('SELECT * FROM public.sop_runs ORDER BY id');
  if(saved.rows.length!==privateRows.length||digest(normalized(saved.rows))!==expected)refuse('import_readback_mismatch');
 });
 return {...summary,format:'wm-sop-preservation-import/v1',selected_rows_sha256:expected,imported_runs:privateRows.length,next_identity:max+1};
}
