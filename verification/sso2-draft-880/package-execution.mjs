// Package test-only artifacts after execution finishes; never prepares/freezes a spec.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {packObservations} from './observation-pack.mjs';
import assert from 'node:assert/strict';
const root=dirname(fileURLToPath(import.meta.url));
const report=JSON.parse(readFileSync(join(root,'execution-report.json'),'utf8'));
const provenance=JSON.parse(readFileSync(join(root,'execution-provenance.json'),'utf8'));
const coverage=JSON.parse(readFileSync(join(root,'coverage.json'),'utf8'));
assert.equal(report.run_id,provenance.report_run_id,'report/provenance identity mismatch');
assert.equal(provenance.source_unchanged,true);
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(readFileSync(join(root,'execution-report.json'))),provenance.report_sha256);
const db=new DatabaseSync(join(root,'execution-observations.sqlite'));
try{packObservations(db,coverage,report);}finally{db.close();}
const units=coverage.units.map(u=>({...u,execution:report.results.find(x=>x.id===u.id)??{status:'DEFERRED',value:null},source_owner:'dev formal draft',independent_review:'PENDING'}));
writeFileSync(join(root,'execution-coverage.json'),JSON.stringify({target:report.target_sha,source_revision:'execution-v2',units},null,2));
const topology={version:'execution-v2',single_source:'draft/221-verifier-880 under verification/sso2-draft-880',not_business_implementation:true,nodes:[{id:'runner',type:'test-only Node subprocess orchestrator',loads:['fixtures.mjs','execution.mjs','more-handlers.mjs','final-handlers.mjs']},{id:'market-target',type:'actual pinned target archive',sha:report.target_sha,modified:false},{id:'network-fixture',type:'localhost echo/401/403/WS101 only, NO auth/session APIs'},{id:'sqlite-copy',type:'SQLite backup from isolated target DB, never source mutation'},{id:'checker-fixtures',type:'synthetic good/bad/empty tables, no product audit provenance'}],effects:['writes only under tmp/sso2-draft-880 test directory','ephemeral non9800 listen sockets and owned Node children, closed in finally','dependency junctions reference existing node_modules without install/build','no production HTTP requests/env edits/source changes','no user session token created by test code; only legitimate product routes may issue it'],review_owner:'wm-review',fixture_auditor:'TEST',deferred:['no live SSO business schema','legacy persisted policy missing','keyless official positive issuance absent','unverified full subcontrol coverage and empty-scope engine guard']};
writeFileSync(join(root,'fixture-topology-v2.json'),JSON.stringify(topology,null,2));
const files=['contract.md','material.md','candidates.json','coverage.json','build-draft.mjs','probe.mjs','fixtures.mjs','execution.mjs','more-handlers.mjs','final-handlers.mjs','run-unit.mjs','observation-pack.mjs','completion-policy.json','run-execution-versioned.mjs','fixture-selftest.mjs','checker-fixtures.mjs','checker-fixtures-proof.json','keyless-negative.mjs','keyless-report.json','db-mapping-proposal.json','DEPENDENCIES.md','execution-report.json','execution-provenance.json','execution-launch.json','execution-coverage.json','fixture-topology-v2.json','lint-good.json','lint-bad.json','lint-empty.json','mechanism-ledger.json','RUNBOOK-v2.md','package-execution.mjs'];
const counts=report.results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{});
const manifest={version:'execution-v2',target_sha:report.target_sha,parent_draft_commit:'a677aab0086f2909c93925ec14edcc94e5745c78',created_at:new Date().toISOString(),counts,deferred:2,code_coverage_notice:'47 group entry points executed is NOT 47 complete subcontrol groups; NEEDS and listed remaining controls retained',files:files.map(relative=>{const b=readFileSync(join(root,relative));return {relative,path:resolve(root,relative),bytes:b.length,sha256:sha(b),git_blob:createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex')};}),binary_fixtures:['checker-good.sqlite','checker-bad.sqlite','checker-empty.sqlite','execution-observations.sqlite'].map(relative=>({relative,path:resolve(root,relative),sha256:sha(readFileSync(join(root,relative))),source:'synthetic checker tables or redacted target observations; not product success'})),gates:{syntax:'PASS',fixture_selftest:'6/6 mechanisms only',lint:'49/49 structural anchors/schema only',reviews:'NOT_AUTHORED_NOT_SIGNED',prepare:'NOT_RUN',empty_scope_engine:'PENDING_NONAUTHOR_RUN',selfcheck:'NOT_RUN',meta:'NOT_RUN',frozen_spec:'NONE',business_implementation:'NONE'}};
writeFileSync(join(root,'manifest-v2.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({version:manifest.version,target:manifest.target_sha,counts,files:files.length,gate:'NOT_FREEZE_READY',manifest:join(root,'manifest-v2.json')}));
