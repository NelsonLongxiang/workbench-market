// Closed unit result snapshots; late checks go to a separate execution-integrity ledger.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MissingFixture} from './fixtures.mjs';
export function controlDigest(controls){return createHash('sha256').update(JSON.stringify(controls)).digest('hex');}
const identity=s=>typeof s==='string'?s.trim().toLowerCase():'';
const integrityLedgers=new WeakMap();
function freezeSnapshot(value){const copy=structuredClone(value);function freeze(x){if(!x||typeof x!=='object')return x;for(const v of Object.values(x))freeze(v);return Object.freeze(x);}return freeze(copy);}
export function lateUnitEvents(result){return freezeSnapshot(integrityLedgers.get(result)??[]);}
export function materializeUnitResult(result,events=lateUnitEvents(result)){
 if(!events.length)return result;
 return freezeSnapshot({...result,status:'ERROR',value:null,settled_status:result.status,business_verdict:result.business_verdict??(result.status==='FAIL'?'FAIL':result.status==='PASS'?'PASS':'NOT_EVALUATED'),error:'check invoked after unit settlement',error_code:'ERR_UNIT_SETTLED',error_kind:'late-unit-check',integrity_events:events});
}
export async function evaluateUnit(id,handler,policy,context={}){
 const assertions=[],completed=new Set(),productAssertionErrors=new WeakSet(),lateEvents=[];let completionDeclared=false,sealed=false;
 function requireOpen(operation,name){
  if(!sealed)return;
  const event=freezeSnapshot({run_id:context.run_id??null,probe_id:id,operation,name:typeof name==='string'?name:null,error_kind:'late-unit-check',error_code:'ERR_UNIT_SETTLED',at:new Date().toISOString()});
  lateEvents.push(event);
  if(context.onIntegrityError)context.onIntegrityError(event); // runner owns durable out-of-band error ledger
  throw Object.assign(new Error('unit already settled: '+id+'/'+operation),{code:'ERR_UNIT_SETTLED'});
 }
 const failed=()=>assertions.some(a=>!a.ok);
 const failure=error=>({id,value:0,status:'FAIL',assertions,error:error??'latched assertion failure (including swallowed assertion)',error_kind:'assertion'});
 const check=(condition,name)=>{
  requireOpen('check',name);
  if(typeof name!=='string'||!name.trim())throw new TypeError('named assertion required');
  assertions.push({ok:Boolean(condition),name});
  try{assert.ok(condition,name);}catch(error){productAssertionErrors.add(error);throw error;}
  completed.add(name);
 };
 check.complete=()=>{requireOpen('complete');completionDeclared=true;};
 async function classify(){
  try{
   try{await handler(check);}finally{sealed=true;}
   if(failed())return failure();
   if(!assertions.length)throw new MissingFixture('zero assertions; no observed controls');
   const author=identity(context.author),approval=policy?.approval;
   if(!author||!policy||policy.probe_id!==id||approval?.status!=='APPROVED'||!policy.required_controls?.length)throw new MissingFixture('non-author approved subcontrol manifest missing');
   const approver=identity(approval.approver);
   if(!approver||approver===author||identity(policy.author)!==author||identity(approval.author)!==author)throw new MissingFixture('self approval or inconsistent author identity rejected');
   const receipt=context.verifiedApprovals?.find(r=>r.evidence===approval.evidence&&r.probe_id===id);
   if(!receipt||receipt.verification!=='VERIFIED_NONAUTHOR'||identity(receipt.approver)!==approver||identity(receipt.author)!==author||receipt.controls_sha256!==controlDigest(policy.required_controls)||receipt.target_sha!==context.target_sha||receipt.source_sha256!==context.source_sha256)throw new MissingFixture('approval reference unverified or not bound to current source/target/controls');
   const missing=policy.required_controls.filter(name=>!completed.has(name));
   if(missing.length||!completionDeclared)throw new MissingFixture('incomplete controls: '+missing.join(',')+'; completion marker='+completionDeclared);
   return {id,value:1,status:'PASS',assertions,completion:{declared:true,required_controls:policy.required_controls,approval:receipt}};
  }catch(error){
   if(error&&productAssertionErrors.has(error))return failure(error?.message);
   if(error instanceof MissingFixture&&failed())return {...failure(),dependency_error:{message:error.message,error_kind:'explicit-missing-prerequisite-fixture-or-completion'}};
   if(error instanceof MissingFixture)return {id,value:null,status:'NEEDS-MATERIAL',assertions,error:error.message,error_kind:'explicit-missing-prerequisite-fixture-or-completion'};
   return {id,value:null,status:'ERROR',business_verdict:failed()?'FAIL':'NOT_EVALUATED',assertions,latched_failed_assertions:assertions.filter(a=>!a.ok),error:error?.message??String(error),error_code:error?.code??null,exit_code:error?.exitCode??null,error_kind:error?.code==='ERR_ASSERTION'?'fixture-or-untracked-assertion-error':'probe-or-infrastructure-error'};
  }
 }
 const result=freezeSnapshot(await classify());integrityLedgers.set(result,lateEvents);return result;
}
