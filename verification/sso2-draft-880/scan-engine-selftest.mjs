// Actual installed engine run on synthetic predicate fixtures; no prepare/freeze/review signatures.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
const root=dirname(fileURLToPath(import.meta.url));
const engineRoot=process.argv[2];assert.ok(engineRoot,'explicit installed ygl-trees package directory required');
const require=createRequire(import.meta.url);
const enginePath=join(engineRoot,'dist/packages/verify/core/src/engine.js');
const runnerPath=join(engineRoot,'dist/packages/verify/core/src/sqlite-runner.js');
const {runVerify,renderPredicate}=require(enginePath);
const {SqliteRunner}=require(runnerPath);
const pkg=JSON.parse(readFileSync(join(engineRoot,'package.json'),'utf8'));
const candidates=JSON.parse(readFileSync(join(root,'candidates.json'),'utf8')).slice(0,49); // original business/deferred scope; integrity guards tested separately
const coverage=JSON.parse(readFileSync(join(root,'coverage.json'),'utf8'));
assert.equal(candidates.length,49);
const variants=[
 {name:'empty',rows:id=>[],expected:'NEEDS-MATERIAL'},
 {name:'other-only',rows:id=>[['other',1]],expected:'NEEDS-MATERIAL'},
 {name:'target-good',rows:id=>[[id,1]],expected:'PASS'},
 {name:'target-bad',rows:id=>[[id,0]],expected:'FAIL'},
 {name:'mixed-good-other-bad',rows:id=>[[id,1],['other',0]],expected:'PASS'},
 {name:'mixed-bad-other-good',rows:id=>[[id,0],['other',1]],expected:'FAIL'},
 {name:'target-null',rows:id=>[[id,null]],expected:'FAIL'},
];
const dir=join(root,'scan-engine-tests');mkdirSync(dir,{recursive:true});
const all=[];
for(const variant of variants){
 const path=join(dir,variant.name+'.sqlite');const db=new DatabaseSync(path);
 try{for(const u of coverage.units){const table='sso2_eval_'+u.id;db.exec('DROP TABLE IF EXISTS '+table+';CREATE TABLE '+table+'(probe_id TEXT PRIMARY KEY,value INTEGER)');for(const row of variant.rows(u.id))db.prepare('INSERT INTO '+table+' VALUES(?,?)').run(...row);}}finally{db.close();}
 const spec={contract_version:'1.1',spec_id:'mechanism_sso2_scan_'+variant.name,spec_version:1,title:'Synthetic SSO2 scan mechanism '+variant.name,domain:'mechanism-only',created:'2026-10-29T00:00:00.000Z',runtime_min:'1',verifier:{engine_version:pkg.version,corpus_version:'mechanism-only'},as_of:{kind:'snapshot',value:'2026-10-29T00:00:00.000Z'},attachments:[],sealed:{review:false},vu:candidates.map((c,i)=>({id:'S'+String(i).padStart(2,'0'),role:'assert',title:coverage.units[i].id,severity:'S1',source_clause:c.source_clause,expected_from:c.anchor,checker:c.checker}))};
 const runner=new SqliteRunner(path);let report;try{report=await runVerify(spec,{runner,nowIso:()=>new Date().toISOString()});}finally{runner.close();}
 const output=join(dir,'report-'+variant.name+'.json');writeFileSync(output,JSON.stringify(report,null,2));
 for(let n=0;n<coverage.units.length;n++){const u=coverage.units[n];const result=report.vu.find(x=>x.id==='S'+String(n).padStart(2,'0'));assert.ok(result,'missing report unit '+u.id);assert.equal(result.verdict,variant.expected,variant.name+'/'+u.id);const rendered=renderPredicate(candidates[n].checker.predicate);all.push({probe_id:u.id,fixture:variant.name,expected:variant.expected,actual:result.verdict,rows_scanned:result.witness?.rows_scanned,rows_matched:result.witness?.rows_matched,scope_sql:rendered.scopeSql,find_sql:rendered.findSql,report:output});}
 console.log(variant.name+': '+report.overall+' '+JSON.stringify(report.summary));
}
// Historical counterexample: deliberately remove scan in-memory only; old draft preserved.
const oldChecker=structuredClone(candidates[0].checker);delete oldChecker.predicate.scan;
const oldSpec={contract_version:'1.1',spec_id:'mechanism_old_no_scan',spec_version:1,title:'Historical no-scan counterexample',domain:'mechanism-only',created:'2026-10-29T00:00:00.000Z',runtime_min:'1',verifier:{engine_version:pkg.version,corpus_version:'mechanism-only'},as_of:{kind:'snapshot',value:'2026-10-29T00:00:00.000Z'},attachments:[],sealed:{review:false},vu:[{id:'old',role:'assert',title:'no scan',severity:'S1',source_clause:candidates[0].source_clause,expected_from:candidates[0].anchor,checker:oldChecker}]};
const oldRunner=new SqliteRunner(join(dir,'other-only.sqlite'));let old;try{old=await runVerify(oldSpec,{runner:oldRunner});}finally{oldRunner.close();}assert.equal(old.vu[0].verdict,'PASS');writeFileSync(join(dir,'historical-no-scan-report.json'),JSON.stringify(old,null,2));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(join(root,'scan-engine-report.json'),JSON.stringify({mechanism_only:true,synthetic_spec_not_prepared:true,real_product_pass:false,independent_review:false,engine:{version:pkg.version,path:enginePath,sha256:hash(enginePath),runner_sha256:hash(runnerPath)},candidate_sha256:hash(join(root,'candidates.json')),units:49,variants:variants.length,assertions:all.length,exit_code:0,historical_without_scan:old.vu[0].verdict,records:all},null,2));
console.log('Actual engine '+pkg.version+': '+all.length+' scoped outcomes verified; no spec frozen, no business verdicts');
