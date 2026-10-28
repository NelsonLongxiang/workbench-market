// Real engine on synthetic runner errors: no market routes, no review/freeze.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {evaluateUnit} from './run-unit.mjs';
import {packObservations} from './observation-pack.mjs';
import {MissingFixture,createWorkbench,audit} from './fixtures.mjs';
const root=dirname(fileURLToPath(import.meta.url)),engineRoot=process.argv[2];assert.ok(engineRoot);
const require=createRequire(import.meta.url),enginePath=join(engineRoot,'dist/packages/verify/core/src/engine.js');
const {runVerify}=require(enginePath),{SqliteRunner}=require(join(engineRoot,'dist/packages/verify/core/src/sqlite-runner.js'));
const version=JSON.parse(readFileSync(join(engineRoot,'package.json'),'utf8')).version;
const coverage=JSON.parse(readFileSync(join(root,'coverage.json'),'utf8')),candidates=JSON.parse(readFileSync(join(root,'candidates.json'),'utf8'));
assert.equal(candidates.length,98);assert.equal(coverage.units.length,49);
const dir=join(root,'fixture-error-v5-tests');mkdirSync(dir,{recursive:true});
const failingInstance={request:async()=>({status:500,json:{error:'synthetic500'}})};
const cases=[
 {name:'create-workbench500',handler:()=>createWorkbench(failingInstance,'http://127.0.0.1:1/'),guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR'},
 {name:'audit500',handler:()=>audit(failingInstance),guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR'},
 {name:'port-protection',handler:()=>assert.notEqual(9800,9800),guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR'},
 {name:'listener-owner-mismatch',handler:()=>assert.ok(false,'listener owner mismatch'),guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR'},
 {name:'typeerror',handler:()=>{throw new TypeError('synthetic driver bug');},guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR'},
 {name:'network-rc',handler:()=>{throw Object.assign(new Error('synthetic refused'),{code:'ECONNREFUSED',exitCode:23});},guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR'},
 {name:'failed-then-crash',handler:t=>{try{t(false,'mismatch')}catch{}throw Object.assign(new TypeError('later crash'),{code:'ERR_FIXTURE',exitCode:24});},guard:'FAIL',business:'NEEDS-MATERIAL',status:'ERROR',latched:'FAIL'},
 {name:'failed-then-return',handler:t=>{try{t(false,'same')}catch{}t(true,'same');t.complete();},guard:'PASS',business:'FAIL',status:'FAIL'},
 {name:'explicit-missing',handler:()=>{throw new MissingFixture('synthetic register missing');},guard:'PASS',business:'NEEDS-MATERIAL',status:'NEEDS-MATERIAL'},
];
const records=[];
for(const tc of cases){
 const results=[];for(const u of coverage.units)if(!u.id.startsWith('deferred_'))results.push(await evaluateUnit(u.id,tc.handler));
 const raw={target_sha:coverage.target,run_id:'SYNTHETIC_'+tc.name,results};
 const path=join(dir,tc.name+'.sqlite'),db=new DatabaseSync(path);try{packObservations(db,coverage,raw);}finally{db.close();}
 const runner=new SqliteRunner(path);let report;const spec={contract_version:'1.1',spec_id:'mechanism_integrity_'+tc.name,spec_version:1,title:'Execution integrity synthetic '+tc.name,domain:'mechanism-only',created:'2026-10-29T00:00:00.000Z',runtime_min:'1',verifier:{engine_version:version,corpus_version:'mechanism-only'},as_of:{kind:'snapshot',value:'2026-10-29T00:00:00.000Z'},attachments:[],sealed:{review:false},vu:candidates.map((c,n)=>({id:(n<49?'S':'G')+String(n%49).padStart(2,'0'),role:'assert',title:n<49?'business:'+coverage.units[n].id:'integrity:'+coverage.units[n-49].id,severity:c.severity??'S1',source_clause:c.source_clause,expected_from:c.anchor,checker:c.checker}))};
 try{report=await runVerify(spec,{runner});}finally{runner.close();}
 for(let n=0;n<49;n++){
  const u=coverage.units[n],s=report.vu.find(x=>x.id==='S'+String(n).padStart(2,'0')),g=report.vu.find(x=>x.id==='G'+String(n).padStart(2,'0'));
  if(u.id.startsWith('deferred_')){assert.equal(s.verdict,'NEEDS-MATERIAL');assert.equal(g.verdict,'PASS');continue;}
  assert.equal(s.verdict,tc.business,tc.name+'/'+u.id+'/business');assert.equal(g.verdict,tc.guard,tc.name+'/'+u.id+'/guard');
  const original=raw.results.find(x=>x.id===u.id);assert.equal(original.status,tc.status);if(tc.latched)assert.equal(original.business_verdict,tc.latched);
  const copied=new DatabaseSync(path,{readOnly:true});try{const r=copied.prepare('SELECT * FROM sso2_execution_integrity WHERE probe_id=?').get(u.id);assert.equal(r.status,tc.status);if(tc.name==='network-rc'){assert.equal(r.error_code,'ECONNREFUSED');assert.equal(r.exit_code,23);}if(tc.name==='failed-then-crash'){assert.equal(r.business_verdict,'FAIL');assert.equal(r.exit_code,24);}records.push({fixture:tc.name,probe_id:u.id,status:r.status,error_kind:r.error_kind,error_code:r.error_code,exit_code:r.exit_code,business_verdict:r.business_verdict,engine_business:s.verdict,engine_integrity_guard:g.verdict,witness:g.witness,evidence:r.evidence_json});}finally{copied.close();}
 }
 writeFileSync(join(dir,tc.name+'-raw.json'),JSON.stringify(raw,null,2));writeFileSync(join(dir,tc.name+'-engine.json'),JSON.stringify(report,null,2));console.log(tc.name+': engine '+report.overall+' '+JSON.stringify(report.summary));
}
// Scope contamination of guard table cannot hide or import another unit's error.
for(const [name,rows,expected]of [['other-error-only',[['other','ERROR']],'NEEDS-MATERIAL'],['target-ok-other-error',[['boot','PASS'],['other','ERROR']],'PASS'],['target-error-other-ok',[['boot','ERROR'],['other','PASS']],'FAIL']]){
 const path=join(dir,name+'.sqlite'),db=new DatabaseSync(path);db.exec('DROP TABLE IF EXISTS sso2_execution_integrity;CREATE TABLE sso2_execution_integrity(probe_id TEXT,status TEXT,error_kind TEXT,error_code TEXT,exit_code INTEGER,business_verdict TEXT,evidence_json TEXT)');for(const [id,status]of rows)db.prepare('INSERT INTO sso2_execution_integrity VALUES(?,?,NULL,NULL,NULL,NULL,NULL)').run(id,status);db.close();
 const c=candidates[49];const runner=new SqliteRunner(path);let report;try{report=await runVerify({contract_version:'1.1',spec_id:'guard_scope_'+name,spec_version:1,title:name,domain:'mechanism-only',created:'2026-10-29T00:00:00.000Z',runtime_min:'1',verifier:{engine_version:version,corpus_version:'mechanism-only'},as_of:{kind:'snapshot',value:'2026-10-29T00:00:00.000Z'},attachments:[],sealed:{review:false},vu:[{id:'G00',role:'assert',title:'integrity only',severity:'S1',source_clause:c.source_clause,expected_from:c.anchor,checker:c.checker}]},{runner});}finally{runner.close();}assert.equal(report.vu[0].verdict,expected);writeFileSync(join(dir,name+'-engine.json'),JSON.stringify(report,null,2));records.push({fixture:name,expected,actual:report.vu[0].verdict});
}
writeFileSync(join(root,'fixture-error-v5-engine-report.json'),JSON.stringify({mechanism_only:true,engine_version:version,engine_path:enginePath,engine_sha256:createHash('sha256').update(readFileSync(enginePath)).digest('hex'),candidate_sha256:createHash('sha256').update(readFileSync(join(root,'candidates.json'))).digest('hex'),product_runs:0,new_spec_frozen:false,exit_code:0,records},null,2));
console.log('ERROR packaging to actual engine verified '+records.length+' records; integrity FAIL != SSO business FAIL');