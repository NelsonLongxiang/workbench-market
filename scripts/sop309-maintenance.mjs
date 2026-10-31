/** #309 offline maintenance. No process stop/start and no default DB. Owner approval and drained service are prerequisites. */
import{DatabaseSync}from'node:sqlite';import{randomBytes,createHash}from'node:crypto';import{statSync}from'node:fs';import{isAbsolute,resolve}from'node:path';import{pathToFileURL}from'node:url';
export function maintainSop309(db,{apply=false,expectedPlan,uploadsDrained=false}={}){
 const snapshot=()=>({strict:db.prepare("SELECT value FROM settings WHERE key='run_upload_require_token'").get()?.value??null,runs:db.prepare('SELECT id,status,upload_token FROM sop_runs ORDER BY id').all()});
 const digest=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex'),before=snapshot(),plan=digest(before);
 const summary={dry_run:true,strict_before:before.strict==='1'?'1':'not_1',strict_after:'1',running_runs:before.runs.filter(r=>r.status==='running').length,plan,requires_drained_service:true};
 if(!apply)return summary;
 if(!uploadsDrained||typeof expectedPlan!=='string'||plan!==expectedPlan)throw Error('Explicit drained-service acknowledgment and current plan required');
 db.exec('BEGIN IMMEDIATE');try{const current=snapshot();if(digest(current)!==expectedPlan)throw Error('Maintenance source changed');
  db.prepare("INSERT INTO settings(key,value) VALUES('run_upload_require_token','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  const update=db.prepare("UPDATE sop_runs SET upload_token=? WHERE id=? AND status='running' AND upload_token=?");
  for(const r of current.runs.filter(r=>r.status==='running'))if(update.run(randomBytes(32).toString('hex'),r.id,r.upload_token).changes!==1)throw Error('Maintenance rotation conflict');
  db.prepare("UPDATE sop_runs SET upload_token='' WHERE status<>'running' AND upload_token<>''").run();
  if(db.prepare("SELECT value FROM settings WHERE key='run_upload_require_token'").get()?.value!=='1')throw Error('Strict upload gate not established');
  db.exec('COMMIT');return{dry_run:false,strict:'1',rotated_running:summary.running_runs,completed_tokens_cleared:true,safe_rollback:'keep_strict_1_and_new_tokens; no_old_credential_restore'};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),values={},flags=new Set();for(let i=0;i<args.length;i++){const k=args[i];if(flags.has(k)||Object.hasOwn(values,k))throw Error('Duplicate maintenance argument');if(['--db','--expected-plan'].includes(k)){const v=args[++i];if(!v||v.startsWith('--'))throw Error('Missing maintenance argument');values[k]=v;}else if(['--apply','--ack-service-stopped-and-uploads-drained'].includes(k))flags.add(k);else throw Error('Unknown maintenance argument');}
 const file=values['--db'],apply=flags.has('--apply');if(!file||!isAbsolute(file)||!statSync(file).isFile())throw Error('Explicit existing absolute --db required');
 if(apply&&(!flags.has('--ack-service-stopped-and-uploads-drained')||!values['--expected-plan']))throw Error('Apply needs current plan and drained-service acknowledgment');
 const db=new DatabaseSync(file,{readOnly:!apply});try{if(!apply)db.exec('PRAGMA query_only=ON');console.log(JSON.stringify(maintainSop309(db,{apply,expectedPlan:values['--expected-plan'],uploadsDrained:flags.has('--ack-service-stopped-and-uploads-drained')})));}finally{db.close();}
}
