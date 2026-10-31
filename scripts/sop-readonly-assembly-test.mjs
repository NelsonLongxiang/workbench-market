import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assembleReadonlySop,renderReadonlySopRun} from '../server/src/sop-readonly-assembly.ts';
const yaml=readFileSync(new URL('./fixtures/sop-readonly/typed-v3.yaml',import.meta.url),'utf8');
const source={targetId:4,slug:'inspection-sop',version:3,yaml};
const run={id:12,sop_slug:source.slug,sop_version:3,status:'running',data:{inspect:{note:'saved text',count:4,ok:true,tags:['a']},release:{private_note:'OTHER_STEP_VALUE'},agent_extra:'AGENT_EXTRA_VALUE'},receipt:'RECEIPT_NOT_FOR_FRAME',upload_token:'UPLOAD_TOKEN_NOT_FOR_FRAME'};
const assemble=(s=source,r=run,step='inspect')=>assembleReadonlySop(s,r,step,7,'http://127.0.0.1:21916');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
check('raw frozen YAML fields projected with read constraints',()=>{const c=assemble();assert.equal(c.fields[0].required,true);assert.equal(c.fields[3].maxItems,2);assert.deepEqual(c.fields[0].operations,['read']);assert.equal(c.revision,7)});
check('only current step data/body reaches preview',()=>{const html=renderReadonlySopRun(source,run,'inspect',7,'http://127.0.0.1:21916');for(const marker of ['OTHER_STEP_VALUE','AGENT_EXTRA_VALUE','RECEIPT_NOT_FOR_FRAME','UPLOAD_TOKEN_NOT_FOR_FRAME','private_note'])assert.ok(!html.includes(marker));assert.ok(html.includes('saved text'))});
check('caller mutation cannot change assembled snapshot',()=>{const r=structuredClone(run),c=assemble(source,r);r.data.inspect.note='mutated';assert.equal(c.values.note,'saved text')});
check('finished run stays read-only without losing values',()=>assert.equal(assemble(source,{...run,status:'finished'}).values.count,4));
check('new unsaved required field remains readable; no finish validation',()=>assert.deepEqual(assemble(source,{...run,data:{}}).values,{}));
for(const patch of [{sop_slug:'other'},{sop_version:4},{id:0},{status:'unknown'},{data:[]},{data:{inspect:{unknown:'x'}}},{data:{inspect:{note:{value:'legacy'}}}},{data:{inspect:{tags:['a','b','c']}}},{data:{inspect:'legacy'}}])check('run mismatch or invalid saved data '+JSON.stringify(patch),()=>assert.throws(()=>assemble(source,{...run,...patch})));
check('unknown step rejected rather than fallback',()=>assert.throws(()=>assemble(source,run,'other')));
for(const [name,change] of [
 ['legacy missing schema',s=>s.replace('    fields:','    old_fields:')],
 ['write operation',s=>s.replace('operations: [read]','operations: [save]')],
 ['file unsupported',s=>s.replace('type: text','type: file')],
 ['missing required metadata',s=>s.replace('required: true, ','')],
 ['text limit missing',s=>s.replace('maxLength: 100, ','')],
 ['duplicate key',s=>s.replace('key: count, type: number','key: note, type: number')],
 ['other step invalid',s=>s.replace('key: private_note, type: text','key: private_note, type: file')],
 ['extra schema key',s=>s.replace('required: true','required: true, url: arbitrary')],
 ['duplicate yaml key',s=>s.replace('title: Read-only inspection SOP','title: First'+String.fromCharCode(10)+'title: Duplicate')],
 ['multi limit invalid',s=>s.replace('maxItems: 2','maxItems: 0')]
])check(name,()=>assert.throws(()=>assemble({...source,yaml:change(yaml)})));
check('fixed version binding rejected even with valid YAML',()=>assert.throws(()=>assemble({...source,version:0},{...run,sop_version:0})));
const seed=readFileSync(new URL('./seed-demo-sop.py',import.meta.url),'utf8'),seedYaml=/sop_yaml = """([\s\S]*?)"""/.exec(seed)[1];
const {parse}=await import('../server/node_modules/yaml/dist/index.js');
const candidateYaml=readFileSync(new URL('./fixtures/sop-readonly/demo-rack-v2.yaml',import.meta.url),'utf8'),original=parse(seedYaml),candidate=parse(candidateYaml);
check('real seed migration preserves exact three step bodies',()=>assert.deepEqual(candidate.steps.map(({fields,...rest})=>rest),original.steps));
const seedSource={targetId:8,slug:'demo-rack-sop',version:2,yaml:candidateYaml},seedRun={id:30,sop_slug:'demo-rack-sop',sop_version:2,status:'running',data:{prepare:{配件数:'6',外观:'无'},rack:{机位:'A-12',扭矩复核:'已复核'},power:{自检:'通过',备注:'仅合成值'}}};
for(const step of candidate.steps)check('real seed step metadata assembles '+step.key,()=>{const c=assembleReadonlySop(seedSource,seedRun,step.key,0,'http://127.0.0.1:21916');assert.deepEqual(c.fields.map(f=>f.key),Object.keys(seedRun.data[step.key]));assert.deepEqual(c.values,seedRun.data[step.key])});
check('old frozen seed version never silently upgraded',()=>assert.throws(()=>assembleReadonlySop(seedSource,{...seedRun,sop_version:1},'prepare',0,'http://127.0.0.1:21916')));
check('legacy seed without reviewed schema explicitly rejected',()=>assert.throws(()=>assembleReadonlySop({...seedSource,yaml:seedYaml},seedRun,'prepare',0,'http://127.0.0.1:21916')));
console.log(JSON.stringify({checks,scope:'frozen raw YAML plus synthetic run snapshot; zero routes, DB, network or write capabilities'}));
