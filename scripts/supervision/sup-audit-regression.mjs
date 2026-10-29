// Execute copies only, stub all network, never import/run original production script.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const root=resolve(repo,'tmp/sup-audit-regression'),fixture=join(root,'fixture'),summary=join(fixture,'evidence/e2e-summary.json');
mkdirSync(join(fixture,'scripts/supervision'),{recursive:true});mkdirSync(join(fixture,'evidence'),{recursive:true});mkdirSync(join(root,'unrelated-cwd'),{recursive:true});
const original=readFileSync(resolve(repo,'scripts/supervision/sup-audit.mjs'));copyFileSync(resolve(repo,'scripts/supervision/sup-audit.mjs'),join(fixture,'scripts/supervision/sup-audit.mjs'));
const stub=join(root,'network-stub.mjs');writeFileSync(stub,
 'globalThis.fetch=async (url,opts)=>{console.log("[STUB] "+JSON.stringify({url,method:opts.method,has_signal:!!opts.signal}));if(url!=="http://127.0.0.1:9800/api/workbenches"||opts.method!=="GET"||!opts.signal)throw new Error("unsafe request");const mode=process.env.AUDIT_STUB;if(mode==="connect")throw Object.assign(new Error("connect failed"),{cause:{code:"ECONNREFUSED"}});if(mode==="timeout")return await new Promise((_,reject)=>{const alive=setTimeout(()=>reject(new Error("stub watchdog")),6500);opts.signal.addEventListener("abort",()=>{clearTimeout(alive);reject(opts.signal.reason);},{once:true});});if(mode==="http500")return {ok:false,status:500,json:async()=>({})};if(mode==="badjson")return {ok:true,status:200,json:async()=>{throw new SyntaxError("bad response json")}};return {ok:true,status:200,json:async()=>mode==="badshape"?{}:[{last_status:"up"}]};};');
const good=()=>({total:26,passed:26,failed:0,all_passed:1,finished_at:new Date(Date.now()-3600000).toISOString()});
const cases=[
 ['repo-cwd',good(),'ok',0,fixture],['other-cwd',good(),'ok',0,join(root,'unrelated-cwd')],['script-cwd',good(),'ok',0,join(fixture,'scripts/supervision')],
 ['missing',undefined,'ok',1],['malformed','{','ok',1],['null',null,'ok',1],['missing-date',{...good(),finished_at:undefined},'ok',1],['date-number',{...good(),finished_at:Date.now()},'ok',1],['date-invalid',{...good(),finished_at:'not-a-date'},'ok',1],['future',{...good(),finished_at:new Date(Date.now()+3600000).toISOString()},'ok',1],['stale49h',{...good(),finished_at:new Date(Date.now()-49*3600000).toISOString()},'ok',1],['age30h-still-fresh',{...good(),finished_at:new Date(Date.now()-30*3600000).toISOString()},'ok',0],['fresh-failed',{...good(),passed:21,failed:5,all_passed:0},'ok',1],['flag-string',{...good(),all_passed:'1'},'ok',1],['contradictory',{...good(),passed:21,failed:5},'ok',1],['connection-error',good(),'connect',1],['http-error',good(),'http500',1],['bad-json',good(),'badjson',1],['bad-shape',good(),'badshape',1],['timeout',good(),'timeout',1]
];
const records=[];
for(const [name,input,network,expected,cwd=fixture]of cases){
 if(input===undefined){const fs=await import('node:fs');if(existsSync(summary))fs.unlinkSync(summary);}else writeFileSync(summary,typeof input==='string'?input:JSON.stringify(input));
 const r=spawnSync(process.execPath,['--import',pathToFileURL(stub).href,join(fixture,'scripts/supervision/sup-audit.mjs')],{cwd,env:{...process.env,AUDIT_STUB:network},encoding:'utf8',timeout:12000});
 assert.equal(r.status,expected,name+': '+r.stdout+r.stderr);assert.match(r.stdout,/ledger.*NOT_CHECKED/);assert.ok(!r.stdout.includes('method":"POST'),'POST found');
 const calls=r.stdout.split('\n').filter(l=>l.startsWith('[STUB] ')).map(l=>JSON.parse(l.slice(7)));assert.equal(calls.length,1,name);assert.ok(calls.every(c=>c.method==='GET'&&c.has_signal));
 if(!expected)assert.match(r.stdout,/AUDIT-OK.*scope=e2e-summary,market-list ledger=NOT_CHECKED/);else assert.match(r.stdout,/AUDIT-FAIL/);
 records.push({name,expected_exit:expected,exit:r.status,calls,stdout:r.stdout,stderr:r.stderr});console.log(name+': PASS expected exit '+expected);
}
assert.deepEqual(readFileSync(resolve(repo,'scripts/supervision/sup-audit.mjs')),original,'source changed during tests');
writeFileSync(join(root,'selftest-report.json'),JSON.stringify({at:new Date().toISOString(),cases:records.length,passed:records.length,source_sha256:createHash('sha256').update(original).digest('hex'),production_script_executed:false,network:'fully stubbed, GET-only calls asserted, no production connection',schedule_changed:false,records},null,2));
console.log('Audit isolated regression '+records.length+'/'+records.length+'; production script never executed');
