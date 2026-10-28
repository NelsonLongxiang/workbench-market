// Synthetic receipts are classifier inputs only, not actual review approvals.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {evaluateUnit,controlDigest} from './run-unit.mjs';
import {MissingFixture} from './fixtures.mjs';
const controls=['a','b'];
const policy={probe_id:'synthetic',author:'author-role',required_controls:controls,approval:{status:'APPROVED',author:'author-role',approver:'review-role',evidence:'synthetic:receipt'}};
const context={author:'author-role',target_sha:'synthetic-target',source_sha256:'synthetic-source',verifiedApprovals:[{probe_id:'synthetic',author:'author-role',approver:'review-role',evidence:'synthetic:receipt',verification:'VERIFIED_NONAUTHOR',controls_sha256:controlDigest(controls),target_sha:'synthetic-target',source_sha256:'synthetic-source'}]};
const done=t=>{t(true,'a');t(true,'b');t.complete();};
const cases=[
 ['valid synthetic nonauthor receipt',done,policy,context,'PASS',1],
 ['swallowed failure same name',t=>{try{t(false,'a')}catch{}t(true,'a');t(true,'b');t.complete();},policy,context,'FAIL',0],
 ['swallowed failure then MissingFixture',t=>{try{t(false,'a')}catch{}throw new MissingFixture('later missing');},policy,context,'FAIL',0],
 ['swallowed failure then TypeError',t=>{try{t(false,'a')}catch{}throw new TypeError('later bug');},policy,context,'ERROR',null],
 ['swallowed failure no policy',t=>{try{t(false,'a')}catch{}t.complete();},undefined,{},'FAIL',0],
 ['swallowed failure no completion',t=>{try{t(false,'a')}catch{}},undefined,{},'FAIL',0],
 ['author self approval',done,{...policy,approval:{...policy.approval,approver:'author-role'}},context,'NEEDS-MATERIAL',null],
 ['author case whitespace bypass',done,{...policy,approval:{...policy.approval,approver:' AUTHOR-ROLE '}},context,'NEEDS-MATERIAL',null],
 ['missing approver',done,{...policy,approval:{...policy.approval,approver:null}},context,'NEEDS-MATERIAL',null],
 ['policy-only evidence not trusted',done,policy,{...context,verifiedApprovals:[]},'NEEDS-MATERIAL',null],
 ['missing author',done,{...policy,author:null},context,'NEEDS-MATERIAL',null],
 ['missing evidence',done,{...policy,approval:{...policy.approval,evidence:null}},context,'NEEDS-MATERIAL',null],
 ['fake evidence',done,{...policy,approval:{...policy.approval,evidence:'forged'}},context,'NEEDS-MATERIAL',null],
 ['wrong probe binding',done,{...policy,probe_id:'other'},context,'NEEDS-MATERIAL',null],
 ['source hash changed',done,policy,{...context,source_sha256:'changed'},'NEEDS-MATERIAL',null],
 ['target hash changed',done,policy,{...context,target_sha:'changed'},'NEEDS-MATERIAL',null],
 ['controls changed',done,{...policy,required_controls:['a']},context,'NEEDS-MATERIAL',null],
 ['ordinary partial controls',t=>{t(true,'a');t.complete();},policy,context,'NEEDS-MATERIAL',null],
 ['missing completion',t=>{t(true,'a');t(true,'b');},policy,context,'NEEDS-MATERIAL',null],
 ['zero assertions',()=>{},policy,context,'NEEDS-MATERIAL',null],
 ['plain assertion',t=>t(false,'a'),policy,context,'FAIL',0],
 ['explicit missing',()=>{throw new MissingFixture('register404');},policy,context,'NEEDS-MATERIAL',null],
 ['TypeError classified ERROR',()=>{throw new TypeError('probe bug');},policy,context,'ERROR',null],
 ['network and rc retained',()=>{throw Object.assign(new Error('refused'),{code:'ECONNREFUSED',exitCode:17});},policy,context,'ERROR',null],
];
const records=[];
for(const [name,fn,p,c,status,value]of cases){const r=await evaluateUnit('synthetic',fn,p,c);assert.equal(r.status,status,name);assert.equal(r.value,value,name);if(name==='swallowed failure then TypeError'){assert.equal(r.business_verdict,'FAIL');assert.equal(r.latched_failed_assertions.length,1);}if(name==='network and rc retained'){assert.equal(r.error_code,'ECONNREFUSED');assert.equal(r.exit_code,17);}records.push({name,expected:{status,value},actual:r});}
writeFileSync(new URL('./run-unit-v4-selftest.json',import.meta.url),JSON.stringify({mechanism_only:true,synthetic_approval_receipts:true,real_review_approvals:0,exit_code:0,records},null,2));
console.log('Classifier v4 mechanisms '+records.length+'/'+records.length+'; no product/real review PASS');
