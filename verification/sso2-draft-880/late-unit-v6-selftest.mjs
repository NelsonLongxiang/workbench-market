// Controlled Promise barriers, no sleep or fake product service.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {evaluateUnit,controlDigest,lateUnitEvents,materializeUnitResult} from './run-unit.mjs';
import {createRunIntegrity,loadRunIntegrity} from './run-integrity.mjs';
import {packObservations} from './observation-pack.mjs';
const root=dirname(fileURLToPath(import.meta.url)),dir=join(root,'late-v6-tests');mkdirSync(dir,{recursive:true});
const engineRoot=process.argv[2];assert.ok(engineRoot,'actual installed engine directory required');
const require=createRequire(import.meta.url),{runVerify}=require(join(engineRoot,'dist/packages/verify/core/src/engine.js')),{SqliteRunner}=require(join(engineRoot,'dist/packages/verify/core/src/sqlite-runner.js'));
const version=JSON.parse(readFileSync(join(engineRoot,'package.json'),'utf8')).version;
const candidates=JSON.parse(readFileSync(join(root,'candidates.json'),'utf8'));
const originalCoverage=JSON.parse(readFileSync(join(root,'coverage.json'),'utf8'));
const unitId='http_gate',otherId='boot';
const unitIndex=originalCoverage.units.findIndex(u=>u.id===unitId),otherIndex=originalCoverage.units.findIndex(u=>u.id===otherId);
function controls(id){const required=['sync ok'];const receipt={probe_id:id,author:'synthetic-author',approver:'synthetic-reviewer',evidence:'synthetic:'+id,verification:'VERIFIED_NONAUTHOR',controls_sha256:controlDigest(required),target_sha:'synthetic-target',source_sha256:'synthetic-source'};return {policy:{probe_id:id,author:receipt.author,required_controls:required,approval:{status:'APPROVED',author:receipt.author,approver:receipt.approver,evidence:receipt.evidence}},context:{author:receipt.author,target_sha:receipt.target_sha,source_sha256:receipt.source_sha256,verifiedApprovals:[receipt]}};}
const tests=[
 ['late-false-caught-pass','PASS','check',false,false],
 ['late-false-caught-needs','NEEDS-MATERIAL','check',false,false],
 ['late-true-caught-pass','PASS','check',true,false],
 ['late-complete-caught-pass','PASS','complete',true,false],
 ['late-false-after-report','PASS','check',false,true],
 ['late-complete-after-report','NEEDS-MATERIAL','complete',true,true],
];
const records=[];
for(const [name,initial,operation,condition,afterFinal]of tests){
 let release,detached,lateCheck,caughtCode;
 const barrier=new Promise(r=>release=r),run_id='synthetic-v6-'+name;
 const files={events:join(dir,name+'-events.jsonl'),state:join(dir,name+'-state.json')};const ledger=createRunIntegrity(run_id,files);
 const c=controls(unitId);const context={...c.context,run_id,onIntegrityError:e=>ledger.record(e)};
 const result=await evaluateUnit(unitId,t=>{lateCheck=t;detached=(async()=>{await barrier;try{if(operation==='complete')t.complete();else t(condition,'late control');}catch(e){caughtCode=e.code;}})();t(true,'sync ok');t.complete();},initial==='PASS'?c.policy:undefined,context);
 assert.equal(result.status,initial);const before=JSON.stringify(result);
 const other=await evaluateUnit(otherId,t=>{t(true,'other complete');},undefined,{run_id,onIntegrityError:e=>ledger.record(e)});const otherBefore=JSON.stringify(other);
 let report={run_id,target_sha:'synthetic-target',results:[result,other],integrity_events:ledger.snapshot().integrity_events};
 const reportPath=join(dir,name+'-settled-report.json'),reportBytes=JSON.stringify(report);writeFileSync(reportPath,reportBytes);
 let packedBefore;
 if(afterFinal){ledger.finalize(reportBytes);const beforeDb=new DatabaseSync(join(dir,name+'-before.sqlite'));try{packObservations(beforeDb,{units:[{id:unitId},{id:otherId}]},JSON.parse(reportBytes));packedBefore=JSON.stringify(beforeDb.prepare('SELECT * FROM sso2_execution_integrity ORDER BY probe_id').all());}finally{beforeDb.close();}}
 release();await detached; // explicit ownership of delayed callback, not a timing guess
 assert.equal(caughtCode,'ERR_UNIT_SETTLED');assert.equal(JSON.stringify(result),before,'settled result mutated');assert.equal(JSON.stringify(other),otherBefore,'next unit mutated');
 assert.equal(result.assertions.length,1);assert.equal(result.assertions[0].ok,true);
 assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.assertions),true);assert.equal(Object.isFrozen(result.assertions[0]),true);
 if(initial==='PASS'){assert.equal(Object.isFrozen(result.completion),true);assert.equal(Object.isFrozen(result.completion.approval),true);assert.equal(Object.isFrozen(result.completion.required_controls),true);c.context.verifiedApprovals[0].approver='later mutation';c.policy.required_controls.push('later control');assert.equal(JSON.stringify(result),before,'approval snapshot retained external alias');}
 const late=lateUnitEvents(result);assert.equal(late.length,1);assert.equal(late[0].run_id,run_id);assert.equal(late[0].probe_id,unitId);
 const elevated=materializeUnitResult(result);assert.equal(elevated.status,'ERROR');assert.equal(elevated.error_code,'ERR_UNIT_SETTLED');assert.equal(elevated.assertions.length,1);
 if(!afterFinal){report={...report,integrity_events:ledger.snapshot().integrity_events};ledger.finalize(JSON.stringify(report));}
 const loaded=loadRunIntegrity(report,files.state,files.events);assert.equal(loaded.integrity_state.valid,false);
 if(afterFinal){assert.equal(readFileSync(reportPath,'utf8'),reportBytes,'final report bytes mutated');assert.equal(loaded.integrity_state.phase,'INVALIDATED');assert.equal(loaded.integrity_events.at(-1).invalidates_report,true);const beforeDb=new DatabaseSync(join(dir,name+'-before.sqlite'),{readOnly:true});try{assert.equal(JSON.stringify(beforeDb.prepare('SELECT * FROM sso2_execution_integrity ORDER BY probe_id').all()),packedBefore,'previous package mutated');}finally{beforeDb.close();}}
 const dbPath=join(dir,name+'.sqlite'),db=new DatabaseSync(dbPath);try{packObservations(db,{units:[{id:unitId},{id:otherId}]},JSON.parse(JSON.stringify(loaded)));}finally{db.close();}
 const spec={contract_version:'1.1',spec_id:'mechanism_late_'+name,spec_version:1,title:name,domain:'mechanism-only',created:'2026-10-29T00:00:00.000Z',runtime_min:'1',verifier:{engine_version:version,corpus_version:'mechanism-only'},as_of:{kind:'snapshot',value:'2026-10-29T00:00:00.000Z'},attachments:[],sealed:{review:false},vu:[unitIndex,unitIndex+49,otherIndex+49].map((n,i)=>{const c=candidates[n];return{id:'V'+i,role:'assert',title:c.source_clause,severity:'S1',source_clause:c.source_clause,expected_from:c.anchor,checker:c.checker};})};
 const runner=new SqliteRunner(dbPath);let engine;try{engine=await runVerify(spec,{runner});}finally{runner.close();}
 assert.equal(engine.vu[0].verdict,'NEEDS-MATERIAL','late ERROR not business value0');assert.equal(engine.vu[1].verdict,'FAIL','late integrity must block PASS');assert.equal(engine.vu[2].verdict,'PASS','other unit not contaminated');assert.equal(engine.overall,'FAIL');
 writeFileSync(join(dir,name+'-engine.json'),JSON.stringify(engine,null,2));records.push({name,initial,operation,after_final:afterFinal,caughtCode,result_snapshot_unchanged:true,other_unchanged:true,run_id,late_event:late[0],integrity_state:loaded.integrity_state,engine_summary:engine.summary,engine_vu:engine.vu.map(x=>({id:x.id,verdict:x.verdict,witness:x.witness}))});
 console.log(name+': immutable snapshot; run integrity ERROR; engine guard FAIL; other unit PASS');
}
// Explicitly awaited async checks still count before settlement.
const c=controls(unitId);const awaited=await evaluateUnit(unitId,async t=>{await Promise.resolve();t(true,'sync ok');t.complete();},c.policy,c.context);assert.equal(awaited.status,'PASS');assert.equal(lateUnitEvents(awaited).length,0);
writeFileSync(join(root,'late-unit-v6-report.json'),JSON.stringify({mechanism_only:true,synthetic_receipts_not_approvals:true,product_runs:0,engine_version:version,engine_path:engineRoot,exit_code:0,late_cases:records.length,awaited_positive_control:true,records},null,2));
console.log('Late-unit mechanisms '+records.length+' late cases + awaited positive control; no sleeps/product run');
