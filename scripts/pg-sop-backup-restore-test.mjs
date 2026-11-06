/** Disposable fixture-only pg_dump/pg_restore test. Called by pg-transaction-integration.mjs.
 * Uses one owned tmpfs container, not a production backup utility; no URL/credential arguments.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function verifySopDumpRestore({docker,container,nonce,verifyOwned}){
 assert.match(nonce,/^[a-f0-9]{24}$/);verifyOwned();
 const source='wm_sop_fixture',target='wm_sop_restore',user='wm_sop_fixture',dir='/var/run/postgresql/restore-'+nonce,file=dir+'/sop.dump';
 const exec=args=>{verifyOwned();return docker(['exec','--env','PGPASSWORD',container,...args],60000)};
 const sql=(db,text,who=user)=>exec(['psql','--no-psqlrc','--set','ON_ERROR_STOP=1','-h','127.0.0.1','-U',who,'-d',db,'-Atc',text]);
 const snapshot=db=>{
  const rows=sql(db,"SELECT COALESCE(json_agg(r ORDER BY id),'[]'::json)::text FROM public.sop_runs r");
  const generation=sql(db,"SELECT last_value::text || ':' || is_called::text FROM public.sop_runs_id_seq");
  const trigger=sql(db,"SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.sop_runs'::regclass AND NOT tgisinternal ORDER BY tgname");
  const columns=sql(db,"SELECT json_agg(json_build_array(column_name,data_type,is_nullable,column_default,is_identity) ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='sop_runs'");
  const settings=sql(db,"SELECT COALESCE(json_agg(r ORDER BY key),'[]'::json)::text FROM public.settings r");
  const registry=sql(db,"SELECT COALESCE(json_agg(r ORDER BY id),'[]'::json)::text FROM public.workbenches r");
  const variables=sql(db,"SELECT COALESCE(json_agg(r ORDER BY workbench_id,key),'[]'::json)::text FROM public.workbench_vars r");
  const audit=sql(db,"SELECT COALESCE(json_agg(r ORDER BY id),'[]'::json)::text FROM public.workbench_var_audit r");
  const submissions=sql(db,"SELECT COALESCE(json_agg(r ORDER BY id),'[]'::json)::text FROM public.app_data r");
  return {rows,generation,trigger,columns,settings,registry,variables,audit,submissions};
 };
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 let checks=0;const check=(name,ok)=>{assert(ok,name);checks++;console.log('PASS RESTORE '+name)};
 const before=snapshot(source);check('source synthetic capture is nonempty',JSON.parse(before.rows).length>0);
 exec(['mkdir','-m','700',dir]);
 exec(['pg_dump','-h','127.0.0.1','-U',user,'-d',source,'--format=custom','--file',file]);
 const sha=exec(['sha256sum',file]).split(' ')[0],size=Number(exec(['stat','-c','%s',file]));assert.match(sha,/^[a-f0-9]{64}$/);check('real pg_dump archive exists and hashes',size>100);
 check('archive table of contents is readable',exec(['pg_restore','--list',file]).includes('sop_runs'));
 sql('postgres','CREATE DATABASE '+target+' OWNER '+user,'postgres');
 exec(['pg_restore','-h','127.0.0.1','-U',user,'-d',target,'--no-owner','--no-privileges','--single-transaction','--exit-on-error',file]);
 const restored=snapshot(target);check('all row bytes and private fields survive restore',restored.rows===before.rows);
 check('synthetic settings values survive logical restore',restored.settings===before.settings);
 check('synthetic registry and credential fields survive logical restore',restored.registry===before.registry);
 check('variables constants and audit history survive logical restore',restored.variables===before.variables&&restored.audit===before.audit);
 check('submissions idempotency and soft-delete history survive logical restore',restored.submissions===before.submissions);
 check('schema column shape and generation trigger survive restore',restored.columns===before.columns&&restored.trigger===before.trigger);
 check('sequence last value and called state survive restore',restored.generation===before.generation);
 const [last,called]=before.generation.split(':');const expected=BigInt(last)+(called==='true'?1n:0n);
 const inserted=sql(target,"INSERT INTO public.sop_runs(sop_slug,sop_version) VALUES('restore-probe',1) RETURNING id").split(String.fromCharCode(10))[0];
 check('restored identity allocates expected new ID',BigInt(inserted)===expected);
 const revision=sql(target,'UPDATE public.sop_runs SET data=data WHERE id='+String(BigInt(inserted))+' RETURNING cache_revision').split(String.fromCharCode(10))[0];
 check('restored same-value update advances generation',revision==='1');
 check('restore probes never mutate source database',digest(snapshot(source))===digest(before));
 exec(['dd','if='+file,'of='+dir+'/truncated.dump','bs=1','count=32','status=none']);
 let rejected=false;try{exec(['pg_restore','--list',dir+'/truncated.dump'])}catch(error){
  const detail=String(error.stderr??'');
  assert.equal(error.status,1,'truncated archive must fail pg_restore, not infrastructure');
  assert.match(detail,/pg_restore: error:.*(input file is too short|could not read from input file|end of file)/s);rejected=true;
 }
 check('truncated archive fails validation negative control',rejected);
 check('archive remains unchanged after restore',exec(['sha256sum',file]).split(' ')[0]===sha);
 const receipt={restore_checks:checks,archive_bytes:size,archive_sha256:sha,source_snapshot_sha256:digest(before),restored_snapshot_sha256:digest(restored),storage:'owned-container-tmpfs',production_requests:0,production_backup:false,scope:'synthetic SOP/settings/registry/vars-audit/submissions logical dump/restore in same disposable PG instance; no offhost/PITR/full-market evidence'};
 console.log(JSON.stringify(receipt));return receipt;
}
