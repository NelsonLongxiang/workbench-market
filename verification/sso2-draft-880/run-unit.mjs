// Test classifier: failure latch, independently verified approval receipt, explicit ERROR.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MissingFixture} from './fixtures.mjs';
export function controlDigest(controls){return createHash('sha256').update(JSON.stringify(controls)).digest('hex');}
const identity=s=>typeof s==='string'?s.trim().toLowerCase():'';
export async function evaluateUnit(id,handler,policy,context={}){
 const assertions=[],completed=new Set();let completionDeclared=false;
 const failed=()=>assertions.some(a=>!a.ok);
 const failure=error=>({id,value:0,status:'FAIL',assertions,error:error??'latched assertion failure (including swallowed assertion)',error_kind:'assertion'});
 const check=(condition,name)=>{
  if(typeof name!=='string'||!name.trim())throw new TypeError('named assertion required');
  assertions.push({ok:Boolean(condition),name});assert.ok(condition,name);completed.add(name);
 };
 check.complete=()=>{completionDeclared=true;};
 try{
  await handler(check);
  if(failed())return failure(); // retrying the same name cannot erase an earlier mismatch
  if(!assertions.length)throw new MissingFixture('zero assertions; no observed controls');
  const author=identity(context.author),approval=policy?.approval;
  if(!author||!policy||policy.probe_id!==id||approval?.status!=='APPROVED'||!policy.required_controls?.length)throw new MissingFixture('non-author approved subcontrol manifest missing');
  const approver=identity(approval.approver);
  if(!approver||approver===author||identity(policy.author)!==author||identity(approval.author)!==author)throw new MissingFixture('self approval or inconsistent author identity rejected');
  // A policy cannot bless its own evidence: runner supplies separately verified receipts.
  const receipt=context.verifiedApprovals?.find(r=>r.evidence===approval.evidence&&r.probe_id===id);
  if(!receipt||receipt.verification!=='VERIFIED_NONAUTHOR'||identity(receipt.approver)!==approver||identity(receipt.author)!==author||receipt.controls_sha256!==controlDigest(policy.required_controls)||receipt.target_sha!==context.target_sha||receipt.source_sha256!==context.source_sha256)throw new MissingFixture('approval reference unverified or not bound to current source/target/controls');
  const missing=policy.required_controls.filter(name=>!completed.has(name));
  if(missing.length||!completionDeclared)throw new MissingFixture('incomplete controls: '+missing.join(',')+'; completion marker='+completionDeclared);
  return {id,value:1,status:'PASS',assertions,completion:{declared:true,required_controls:policy.required_controls,approval:receipt}};
 }catch(error){
  if(error?.code==='ERR_ASSERTION')return failure(error?.message);
  if(error instanceof MissingFixture&&failed())return {...failure(),dependency_error:{message:error.message,error_kind:'explicit-missing-prerequisite-fixture-or-completion'}};
  if(error instanceof MissingFixture)return {id,value:null,status:'NEEDS-MATERIAL',assertions,error:error.message,error_kind:'explicit-missing-prerequisite-fixture-or-completion'};
  return {id,value:null,status:'ERROR',business_verdict:failed()?'FAIL':'NOT_EVALUATED',assertions,latched_failed_assertions:assertions.filter(a=>!a.ok),error:error?.message??String(error),error_code:error?.code??null,exit_code:error?.exitCode??null,error_kind:'probe-or-infrastructure-error'};
 }
}
