/** Internal settings-only import. Caller validates target/schema/role and supplies a complete frozen capture.
 * No CLI/URL/credential resolution, source reads, default filtering, secret decryption or runtime wiring.
 * Raw database errors may contain private detail; protected diagnostics only.
 */
import {createHash} from 'node:crypto';
import {withPgTransaction} from '../server/src/pg-transaction.ts';
export class SettingsImportRefusal extends Error{constructor(code){super(code);this.code=code;}}
const refuse=code=>{throw new SettingsImportRefusal(code)};
const compare=(a,b)=>a.key<b.key?-1:a.key>b.key?1:0;
const digest=rows=>createHash('sha256').update(JSON.stringify([...rows].sort(compare).map(r=>[r.key,r.value]))).digest('hex');
export async function importPgSettings(pool,rows){
 if(!Array.isArray(rows))refuse('settings_capture_invalid');
 const seen=new Set(),snapshot=rows.map(r=>{
  if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='key,value')refuse('settings_capture_columns_invalid');
  const {key,value}=r;
  if(typeof key!=='string'||typeof value!=='string'||key.includes(String.fromCharCode(0))||value.includes(String.fromCharCode(0)))refuse('settings_capture_text_invalid');
  if(seen.has(key))refuse('settings_capture_duplicate');seen.add(key);return {key,value};
 }).sort(compare),expected=digest(snapshot);
 await withPgTransaction(pool,async tx=>{
  await tx.query('LOCK TABLE public.settings IN ACCESS EXCLUSIVE MODE');
  const cols=await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='settings'");
  if(cols.rows.map(r=>r.column_name).sort().join(',')!=='key,value')refuse('settings_target_columns_mismatch');
  if((await tx.query('SELECT count(*)::text AS n FROM public.settings')).rows[0].n!=='0')refuse('settings_target_not_empty');
  for(const {key,value}of snapshot)await tx.query('INSERT INTO public.settings(key,value) VALUES($1,$2)',[key,value]);
  const readback=(await tx.query('SELECT key,value FROM public.settings')).rows;
  if(readback.length!==snapshot.length||digest(readback)!==expected)refuse('settings_import_readback_mismatch');
 });
 // Whole-set digest only: never disclose keys, values, or per-secret dictionary-check hashes.
 return {format:'wm-pg-settings-import/v1',imported_rows:snapshot.length,selected_rows_sha256:expected};
}
