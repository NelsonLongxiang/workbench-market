/** Canonical PG schema inventory. Values never contain business rows. */
import { createHash } from 'node:crypto';
// Candidate baselines are generated from pinned YGL a9f6ae4 migration DDL in a
// fresh disposable database, never from the target being verified. PG 18 adds
// explicit NOT NULL catalog rows; review this registry with the code change.
// Baseline equality is not an approval of the whole YGL engine or deployment.
const TRUSTED_CATALOGS = Object.freeze({
  'f216c8505b27ca4749b45e5101ad311ef1ebfa2f10bbd520a5ff45de317e630c': Object.freeze([
    '212cbc0e94c3fb3ab191fc6cd4b5c95458093827108118845c252042a7f3c3c4',
    '3d4a77745feed3f9f9b66334b05da00d005b2d6cf46cbad959e08f42b8c8e3a9',
  ]),
});
export const pinnedCatalogs = (normalizedModuleSha256) => typeof normalizedModuleSha256==='string' && /^[a-f0-9]{64}$/.test(normalizedModuleSha256) && Object.hasOwn(TRUSTED_CATALOGS,normalizedModuleSha256) ? TRUSTED_CATALOGS[normalizedModuleSha256] : null;

const cmp=(a,b)=>a<b?-1:a>b?1:0;
const ordered=(rows,...keys)=>rows.sort((a,b)=>{for(const k of keys){const v=cmp(a[k],b[k]);if(v)return v;}return 0;});
export async function pgCatalog(client){
  const columns=(await client.query("SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,character_maximum_length,numeric_precision,numeric_scale,datetime_precision,collation_schema,collation_name,domain_schema,domain_name,is_nullable,column_default,is_generated,generation_expression,is_identity,identity_generation FROM information_schema.columns WHERE table_schema='public'")).rows;
  const constraints=(await client.query("SELECT c.relname AS table_name,p.conname,p.contype,p.condeferrable,p.condeferred,p.convalidated,COALESCE(to_jsonb(p)->>'conenforced','true') AS enforced,pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid WHERE p.connamespace='public'::regnamespace")).rows;
  const indexes=(await client.query("SELECT t.relname AS tablename,i.relname AS indexname,pg_get_indexdef(i.oid) AS indexdef,x.indisvalid,x.indisready,x.indislive FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'")).rows;
  const relations=(await client.query("SELECT c.relname,c.relkind,c.relpersistence,c.relreplident,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')")).rows;
  const triggers=(await client.query("SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).rows;
  const routines=(await client.query("SELECT p.proname,p.prokind,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).rows;
  const policies=(await client.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public'")).rows;
  const schemas=(await client.query("SELECT nspname FROM pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema'")).rows;
  const sequences=(await client.query("SELECT sequencename,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size FROM pg_sequences WHERE schemaname='public'")).rows;
  const rules=(await client.query("SELECT tablename,rulename,definition FROM pg_rules WHERE schemaname='public'")).rows;
  const eventTriggers=(await client.query("SELECT evtname,evtevent,evtenabled,evttags FROM pg_event_trigger")).rows;
  // FK constraints remain in pg_constraint even when their internal triggers are disabled.
  const alteredInternalTriggers=(await client.query("SELECT c.relname AS table_name,p.conname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_constraint p ON p.oid=t.tgconstraint WHERE n.nspname='public' AND t.tgisinternal AND t.tgenabled<>'O'")).rows;
  const catalog={columns:ordered(columns,'table_name','ordinal_position'),constraints:ordered(constraints,'table_name','conname'),indexes:ordered(indexes,'tablename','indexname'),relations:ordered(relations,'relname','relkind'),triggers:ordered(triggers,'table_name','tgname'),routines:ordered(routines,'proname','arguments'),policies:ordered(policies,'tablename','policyname'),schemas:ordered(schemas,'nspname'),sequences:ordered(sequences,'sequencename'),rules:ordered(rules,'tablename','rulename'),eventTriggers:ordered(eventTriggers,'evtname'),alteredInternalTriggers:ordered(alteredInternalTriggers,'table_name','conname','tgenabled')};
  return {...catalog,sha256:createHash('sha256').update(JSON.stringify(catalog)).digest('hex')};
}
