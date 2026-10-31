/** #309 offline owner-operated rotation. Default read-only dry-run; no token values in output.
 * Does NOT import production db.ts; an explicit absolute DB path and approval are required outside tests. */
import{DatabaseSync}from'node:sqlite';import{statSync}from'node:fs';import{randomBytes,createHash}from'node:crypto';import{isAbsolute,resolve}from'node:path';import{pathToFileURL}from'node:url';
export function rotateSopUploadTokens(db,{apply=false,expectedPlan}={}){
 const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 const read=()=>db.prepare("SELECT id,status,upload_token FROM sop_runs ORDER BY id").all();
 const rows=read(),plan=digest(rows);if(!apply)return{dry_run:true,running_runs:rows.filter(r=>r.status==='running').length,plan};
 if(typeof expectedPlan!=='string'||expectedPlan!==plan)throw Error('Rotation plan mismatch; dry-run again');
 db.exec('BEGIN IMMEDIATE');try{const current=read();if(digest(current)!==expectedPlan)throw Error('Rotation source changed');
  const update=db.prepare("UPDATE sop_runs SET upload_token=? WHERE id=? AND status='running' AND upload_token=?");
  for(const row of current.filter(r=>r.status==='running')){const token=randomBytes(32).toString('hex');if(update.run(token,row.id,row.upload_token).changes!==1)throw Error('Rotation conflict');}
  // Blank finished tokens too; old completed capabilities are never reissued.
  db.prepare("UPDATE sop_runs SET upload_token='' WHERE status<>'running' AND upload_token<>''").run();
  db.exec('COMMIT');return{dry_run:false,rotated_running:current.filter(r=>r.status==='running').length,completed_tokens_cleared:true};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const values={};const flags=new Set();for(let i=0;i<process.argv.slice(2).length;i++){const args=process.argv.slice(2),key=args[i];if(flags.has(key)||Object.hasOwn(values,key))throw Error('Duplicate rotation argument');if(['--db','--expected-plan'].includes(key)){const value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing rotation argument');values[key]=value;}else if(['--apply','--ack-upload-interruption'].includes(key))flags.add(key);else throw Error('Unknown rotation argument');}
 const path=values['--db'],apply=flags.has('--apply');if(!path||!isAbsolute(path))throw Error('Explicit absolute --db required');if(!statSync(path).isFile())throw Error('Explicit database must be an existing file');
 if(apply&&(!flags.has('--ack-upload-interruption')||!values['--expected-plan']))throw Error('Explicit plan and upload interruption acknowledgment required');
 const db=new DatabaseSync(path,{readOnly:!apply});try{if(!apply)db.exec('PRAGMA query_only=ON');console.log(JSON.stringify(rotateSopUploadTokens(db,{apply,expectedPlan:values['--expected-plan']})));}finally{db.close();}
}
