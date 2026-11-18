#!/usr/bin/env node
/** P0 compiler tests. Pure synthetic inputs; no database, external origin or policy implementation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { materializeReport, ReportError } from '../web/src/report-template/p0.ts';
import { makeOperatingFixture, makeProductFixture } from './fixtures/report-template-p0.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const run=f=>materializeReport(f.template,f.bindings,f.views,f.input,f.assets);
let n=0;const check=(label,fn)=>{fn();n++;console.log('✓ '+label);};
check('308 full rows are preserved and results are deeply frozen',()=>{const f=makeOperatingFixture();const r=run(f);assert.equal(r.sources.find(x=>x.slot==='details').rows,308);assert.equal(r.body[2].children[0].data.rows.length,308);assert(Object.isFrozen(r.body[2].children[0].data.rows[0]));assert.equal(r.body[1].children[0].content,f.input.fields.summary);});
check('frozen artifact survives data, field, template and source object mutations',()=>{const f=makeOperatingFixture();const r=run(f),h=hash(r);f.views.source.blocks[2].data.rows[0].amount=-100;f.input.fields.summary='changed';f.template.title='changed';f.bindings.details.identity='changed';assert.equal(hash(r),h);assert.notEqual(hash(run(makeOperatingFixture('synthetic-b','2026-11'))),h);});
check('same template accepts two periods and two compatible source identities',()=>{const a=makeOperatingFixture('a','2026-10'),b=makeOperatingFixture('b','2026-11');assert.deepEqual(a.template,b.template);assert.deepEqual(run(a).body.map(x=>x.type),run(b).body.map(x=>x.type));assert.equal(run(b).inputs.parameters.period,'2026-11');});
check('50 repeat sections expand to stable distinct ids with images',()=>{const r=run(makeProductFixture());assert.equal(r.body.filter(x=>x.type==='section').length,50);assert.equal(new Set(r.body.map(x=>x.id)).size,r.body.length);assert.match(r.body[50].children[0].content,/SKU0050/);});
/** 拒收要拒在预期的那一道检查上：只断言抛 ReportError 的话，被别的检查顺手拦下也算过，那道检查本身被删掉测不出来 */
const refuses=(fn,code)=>assert.throws(fn,e=>e instanceof ReportError&&e.message.startsWith(code+' at '),'expected ReportError '+code);
const bad=(label,change,code,make=makeOperatingFixture)=>check(label+' ['+code+']',()=>{const f=make();change(f);refuses(()=>run(f),code);});
bad('truncated 200/308 cannot be accepted as full report',f=>{f.views.source.blocks[2].data.rows=f.views.source.blocks[2].data.rows.slice(0,200);f.views.source.blocks[2].data.truncated=true;},'incomplete_data');
bad('false truncated flag but wrong count still refuses',f=>{f.views.source.blocks[2].data.rows.pop();},'incomplete_data');
bad('missing columns refuse rather than blank cells',f=>{f.views.source.blocks[2].data.columns.pop();},'unknown_key');
bad('stringified amount does not become a silently coerced numeric value',f=>{f.views.source.blocks[2].data.rows[0].amount='10';},'invalid_cell');
bad('definition hash mismatch refuses',f=>{f.views.source.definition_sha256='f'.repeat(64);},'source_changed');
bad('source lifecycle identity mismatch refuses',f=>{f.views.source.identity='deleted-and-recreated';},'source_changed');
bad('fixed index pointing to a different component refuses',f=>{f.views.source.blocks[2].type='form';},'block_changed');
bad('parameter mapping is exact not best-effort',f=>{f.input.parameters.period='2026-12';},'parameter_mismatch');
bad('invalid month refuses before rendering',f=>{f.input.parameters.period='2026-13';},'invalid_month');
bad('unknown nodes and executable props refuse',f=>{f.template.body[0].onload='alert(1)';},'unknown_key');
bad('duplicate template node ids refuse',f=>{f.template.body[1].id='cover';},'node_id_or_limit');
bad('invalid grid refuses',f=>{f.template.body[1].children[1].columns=[8,8];},'invalid_grid');
bad('undeclared field references refuse',f=>{f.template.body[1].children[0].content=[{ref:{scope:'field',name:'secret'}}];},'missing_reference');
bad('partial source errors cannot be published',f=>{f.views.source.blocks[2].error={code:'unavailable'};},'source_unavailable');
check('duplicate stable repeat row keys refuse',()=>{const f=makeProductFixture();f.views.products.blocks[0].data.rows[1].sku=f.views.products.blocks[0].data.rows[0].sku;assert.throws(()=>run(f),ReportError);});
check('repeat bounds refuse',()=>{const f=makeProductFixture();f.template.body[1].max_items=49;assert.throws(()=>run(f),ReportError);});
check('asset URL cannot cause a fetch',()=>{const f=makeProductFixture();f.assets.sample.data_url='http://example.invalid/secret';assert.throws(()=>run(f),ReportError);});
bad('unmapped source parameter does not silently change report scope',f=>{f.views.source.params.extra='hidden-scope';},'unmapped_source_parameter');
bad('unknown binding column aliases refuse',f=>{f.bindings.details.columns.extra='secret';},'unknown_key');
bad('unimplemented grid ratios are not silently stacked',f=>{f.template.body[1].children[1].columns=[8,4];},'grid_ratio_unsupported');
bad('duplicate table columns refuse',f=>{f.template.body[2].children[0].props.columns.push('id');},'invalid_table_columns');
bad('inherited slot mappings are not capabilities',f=>{f.bindings=Object.create(f.bindings);},'missing_binding');
bad('duplicate detail keys refuse even outside repeats',f=>{f.views.source.blocks[2].data.rows[1].id=f.views.source.blocks[2].data.rows[0].id;},'duplicate_row_key');
// 下面几条各自只触发一道检查（其余输入保持合法），专门守那一道：
bad('truncated flag alone refuses even when the row count still matches',f=>{f.views.source.blocks[2].data.truncated=true;},'incomplete_data');
bad('source column type must match the slot column type',f=>{const d=f.views.source.blocks[2].data;d.columns=d.columns.map(c=>c.name==='amount'?{...c,type:'text'}:c);},'incompatible_column');
bad('form blocks are refused even when the binding expects a form',f=>{f.views.source.blocks[2].type='form';f.bindings.details.expect_type='form';},'block_changed');
bad('filter-bar blocks are refused even when the binding expects one',f=>{f.views.source.blocks[2].type='filter-bar';f.bindings.details.expect_type='filter-bar';},'block_changed');
bad('inherited column mappings are not capabilities',f=>{f.bindings.details.columns=Object.create(f.bindings.details.columns);},'missing_column_mapping');
bad('repeat expansion beyond 1000 nodes refuses',f=>{f.template.body[1].children[0].children.push(...Array.from({length:20},(_,i)=>({id:'pad-'+i,type:'text',content:['填充']})));},'expanded_limit',makeProductFixture);
console.log('report-template-p0-test: '+n+' passed / 0 failed');
