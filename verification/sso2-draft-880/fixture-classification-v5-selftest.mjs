// Synthetic fake response objects only; never a runnable replacement market service.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {evaluateUnit} from './run-unit.mjs';
import {createWorkbench,audit,MissingFixture} from './fixtures.mjs';
const unavailable={request:async()=>({status:500,json:{error:'synthetic fixture failure'}})};
const cases=[
 ['actual createWorkbench helper500',()=>createWorkbench(unavailable,'http://127.0.0.1:1/'),'ERROR',null,0],
 ['actual audit helper500',()=>audit(unavailable),'ERROR',null,0],
 ['actual audit bad shape',()=>audit({request:async()=>({status:200,json:{}})}),'ERROR',null,0],
 ['port safety raw assertion',()=>assert.notEqual(9800,9800),'ERROR',null,0],
 ['listener wrong process',()=>assert.ok([123].every(pid=>pid===456),'listener belongs to wrong process'),'ERROR',null,0],
 ['raw assertion handler',()=>assert.equal(500,201),'ERROR',null,0],
 ['forged ERR_ASSERTION code',()=>{throw Object.assign(new Error('not from check'),{code:'ERR_ASSERTION'});},'ERROR',null,0],
 ['named product mismatch',t=>t(false,'expected policy403'),'FAIL',0,1],
 ['swallowed product mismatch',t=>{try{t(false,'policy')}catch{}t(true,'policy');t.complete();},'FAIL',0,1],
 ['fixture error after product mismatch',async t=>{try{t(false,'product mismatch')}catch{}await createWorkbench(unavailable,'http://127.0.0.1:1/');},'ERROR',null,1],
 ['fixture error after successful named check',async t=>{t(true,'positive prerequisite');await audit(unavailable);},'ERROR',null,0],
 ['explicit missing fixture',()=>{throw new MissingFixture('controlled issuance absent');},'NEEDS-MATERIAL',null,0],
 ['missing after product mismatch',t=>{try{t(false,'product mismatch')}catch{}throw new MissingFixture('later dependency');},'FAIL',0,1],
];
const records=[];
for(const [name,fn,status,value,failures]of cases){const actual=await evaluateUnit('synthetic_fixture_classification',fn);assert.equal(actual.status,status,name);assert.equal(actual.value,value,name);assert.equal(actual.assertions.filter(a=>!a.ok).length,failures,name);if(status==='ERROR'){assert.equal(actual.business_verdict,failures?'FAIL':'NOT_EVALUATED');assert.equal(actual.error_code,'ERR_ASSERTION');assert.equal(actual.error_kind,'fixture-or-untracked-assertion-error');}records.push({name,expected:{status,value,failed_named_assertions:failures},actual});}
writeFileSync(new URL('./fixture-classification-v5-report.json',import.meta.url),JSON.stringify({mechanism_only:true,replacement_market_service:false,product_runs:0,exit_code:0,records},null,2));
console.log('Fixture assertion classification '+records.length+'/'+records.length+'; raw helpers never business FAIL');
