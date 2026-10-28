// Synthetic classifier controls, not independent approval or product evidence.
import assert from 'node:assert/strict';
import {evaluateUnit} from './run-unit.mjs';
import {MissingFixture} from './fixtures.mjs';
import {writeFileSync} from 'node:fs';
const policy={probe_id:'synthetic',required_controls:['positive','negative'],approval:{status:'APPROVED',evidence:'SYNTHETIC_MECHANISM_INPUT_ONLY_NOT_A_REAL_APPROVAL'}};
const done=t=>{t(true,'positive');t(true,'negative');t.complete();};
const cases=[
 ['complete reviewed manifest',done,policy,'PASS',1],
 ['no approval',done,{...policy,approval:{status:'PENDING'}},'NEEDS-MATERIAL',null],
 ['partial control',t=>{t(true,'positive');t.complete();},policy,'NEEDS-MATERIAL',null],
 ['missing completion marker',t=>{t(true,'positive');t(true,'negative');},policy,'NEEDS-MATERIAL',null],
 ['zero assertions',()=>{},policy,'NEEDS-MATERIAL',null],
 ['assertion mismatch',t=>t(false,'positive'),policy,'FAIL',0],
 ['explicit MissingFixture',()=>{throw new MissingFixture('registration404');},policy,'NEEDS-MATERIAL',null],
 ['TypeError',()=>{throw new TypeError('fixture code bug');},policy,'ERROR',null],
 ['network exception',()=>{throw Object.assign(new Error('refused'),{code:'ECONNREFUSED'});},policy,'ERROR',null],
 ['bad assertion API',t=>t(true,''),policy,'ERROR',null],
];
const records=[];
for(const [name,fn,p,status,value]of cases){const got=await evaluateUnit('synthetic',fn,p);assert.equal(got.status,status,name);assert.equal(got.value,value,name);records.push({name,expected:{status,value},actual:{status:got.status,value:got.value,error_kind:got.error_kind},ok:true});}
writeFileSync(new URL('./run-unit-selftest.json',import.meta.url),JSON.stringify({mechanism_only:true,synthetic_approval_only:true,real_independent_approvals:0,exit_code:0,records},null,2));
console.log('Classifier mechanisms '+records.length+'/'+records.length+'; no product PASS/no real approvals');
