// Classification and reviewed completion controls only; never authenticates market requests.
import assert from 'node:assert/strict';
import {MissingFixture} from './fixtures.mjs';
export async function evaluateUnit(id,handler,policy){
 const assertions=[],completed=new Set();let completionDeclared=false;
 const check=(condition,name)=>{
  if(typeof name!=='string'||!name.trim())throw new TypeError('named assertion required');
  assertions.push({ok:Boolean(condition),name});assert.ok(condition,name);completed.add(name);
 };
 check.complete=()=>{completionDeclared=true;};
 try{
  await handler(check);
  if(!assertions.length)throw new MissingFixture('zero assertions; no observed controls');
  if(!policy||policy.probe_id!==id||policy.approval?.status!=='APPROVED'||!policy.approval?.evidence||!policy.required_controls?.length)throw new MissingFixture('non-author approved subcontrol manifest missing');
  const missing=policy.required_controls.filter(name=>!completed.has(name));
  if(missing.length||!completionDeclared)throw new MissingFixture('incomplete controls: '+missing.join(',')+'; completion marker='+completionDeclared);
  return {id,value:1,status:'PASS',assertions,completion:{declared:true,required_controls:policy.required_controls,approval:policy.approval}};
 }catch(error){
  if(error instanceof MissingFixture)return {id,value:null,status:'NEEDS-MATERIAL',assertions,error:error.message,error_kind:'explicit-missing-prerequisite-fixture-or-completion'};
  if(error?.code==='ERR_ASSERTION')return {id,value:0,status:'FAIL',assertions,error:error.message,error_kind:'assertion'};
  return {id,value:null,status:'ERROR',assertions,error:error?.message??String(error),error_code:error?.code??null,exit_code:error?.exitCode??null,error_kind:'probe-or-infrastructure-error'};
 }
}
