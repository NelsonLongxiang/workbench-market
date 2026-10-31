/** Pure dry-run planner only: no DB, IO, network, binder or apply operation. Inputs must be operator-reviewed evidence.
 * Legacy started_by and A2A node/caller are deliberately not accepted as authority. */
type Row={id:number;slug:string;version:number;dataSha256:string};
type Evidence={runId:number;targetId:number;slug:string;version:number;ownerSubject:string;assigneeSubject?:string;manifestSha256:string;dataSha256:string;evidenceRef:string};
export function planSopRunMigration(rows:Row[],evidence:Evidence[],existingRunIds:number[]=[]) {
  if(!Array.isArray(rows)||!Array.isArray(evidence)||!Array.isArray(existingRunIds)||rows.length>10000||evidence.length>10000)throw Error('Invalid migration dry-run inputs');
  const seen=new Set<number>(),bindings:Evidence[]=[],pending:{runId:number;reason:string}[]=[];
  const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),subject=(v:unknown)=>typeof v==='string'&&/^user:[^\s:]+:[1-9][0-9]*$/.test(v)&&v.length<=256;
  for(const row of rows){
    if(!Number.isSafeInteger(row.id)||row.id<1||seen.has(row.id)||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.slug)||!Number.isSafeInteger(row.version)||row.version<1||!sha(row.dataSha256))throw Error('Invalid/duplicate migration run');
    seen.add(row.id);const candidates=evidence.filter(e=>e.runId===row.id);
    if(existingRunIds.includes(row.id)){pending.push({runId:row.id,reason:'existing_binding_preserved'});continue;}
    if(candidates.length!==1){pending.push({runId:row.id,reason:candidates.length?'ambiguous_authority':'missing_authority'});continue;}
    const e=candidates[0];
    if(Object.keys(e).some(k=>!['runId','targetId','slug','version','ownerSubject','assigneeSubject','manifestSha256','dataSha256','evidenceRef'].includes(k))||e.slug!==row.slug||e.version!==row.version||e.dataSha256!==row.dataSha256||!Number.isSafeInteger(e.targetId)||e.targetId<1||!subject(e.ownerSubject)||e.assigneeSubject!==undefined&&!subject(e.assigneeSubject)||!sha(e.manifestSha256)||typeof e.evidenceRef!=='string'||!/^evidence:[a-f0-9]{64}$/.test(e.evidenceRef)){
      pending.push({runId:row.id,reason:'authority_or_snapshot_mismatch'});continue;
    }
    bindings.push(structuredClone(e));
  }
  if(evidence.some(e=>!seen.has(e.runId)))throw Error('Evidence references a run outside the reviewed snapshot');
  return {dryRun:true as const,bindings,pending,summary:{reviewed:rows.length,ready:bindings.length,pending:pending.length}};
}
