#!/usr/bin/env node
/** P0 L1 seam: real isolated benchStore, no HTTP/policy substitution and no production store. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { materializeReport, ReportError } from '../web/src/report-template/p0.ts';
import { makeOperatingFixture } from './fixtures/report-template-p0.mjs';
const ROOT=resolve('.');mkdirSync(join(ROOT,'tmp'),{recursive:true});
const DATA=mkdtempSync(join(ROOT,'tmp','report-p0-store-'));
process.env.DATA_DIR=DATA;process.env.NODE_ENV='test';
const {benchStore,closeBenchStores}=await import('../server/src/services/bench-store.ts');
const {db}=await import('../server/src/db.ts');
const f=makeOperatingFixture(),source=f.views.source;
const ctx={actor:'synthetic-report-p0',note:'synthetic seam check',at:Date.now()};
let passed=0;
try{
 const store=await benchStore('report-p0');
 const columns=source.blocks[2].data.columns;
 await store.defineDataset({name:'records',key:['id'],columns},ctx);
 await store.replace('records',source.blocks[2].data.rows,ctx);
 const query={dataset:'records',filter:[{col:'day',op:'prefix',value:'$month'}]};
 const doc=(limit)=>({title:'合成报表源',views:[{key:'report',title:'报告源',blocks:[
  {type:'filter-bar',fields:[{name:'month',kind:'month',label:'月份'}]},
  {type:'stat',query:{...query,measures:[{fn:'count',as:'n'},{fn:'sum',col:'amount',as:'amount',label:'金额'}]},value:'n'},
  {type:'bar',query:{...query,group:['category'],measures:[{fn:'sum',col:'amount',as:'amount',label:'金额'}]},x:'category',y:['amount']},
  {type:'table',query:{...query,...(limit?{limit}:{}),sort:[{col:'id'}]},columns:columns.map(c=>c.name)}
 ]}]});
 await store.putView(doc(),{...ctx,base:0});
 let resolved=await store.renderView({view:'report',params:{month:'2026-10'}}),definition=await store.getView();
 assert.equal(resolved.blocks[3].data.rows.length,200);assert.equal(resolved.blocks[3].data.truncated,true);passed++;
 const bindTo=(result,def)=>{for(const b of Object.values(f.bindings)){b.version=def.version;b.definition_sha256=def.sha256;}return {identity:source.identity,version:def.version,definition_sha256:def.sha256,params:result.params,blocks:result.blocks.slice(1)};};
 f.views.source=bindTo(resolved,definition);
 assert.throws(()=>materializeReport(f.template,f.bindings,f.views,f.input),ReportError);passed++;
 await store.putView(doc(500),{...ctx,base:1});
 resolved=await store.renderView({view:'report',params:{month:'2026-10'}});definition=await store.getView();
 f.views.source=bindTo(resolved,definition);
 const count=resolved.blocks[1].data.rows[0].n;
 f.bindings.details.expected_rows=count; // independent same-render aggregate, not the returned detail array length
 assert.equal(count,308);assert.equal(resolved.blocks[3].data.rows.length,308);assert.equal(resolved.blocks[3].data.truncated,false);passed++;
 const frozen=materializeReport(f.template,f.bindings,f.views,f.input);
 assert.equal(frozen.sources.find(s=>s.slot==='details').rows,308);
 const sealed=JSON.stringify(frozen);
 await store.append('records',[{id:'ROW0309',category:'甲类',amount:20,note:'new live row',day:'2026-10-31'}],ctx);
 const changed=await store.renderView({view:'report',params:{month:'2026-10'}});
 assert.equal(changed.blocks[1].data.rows[0].n,309);assert.equal(JSON.stringify(frozen),sealed);passed++;
 console.log('report-template-p0-store-test: '+passed+' passed (real default-200 refusal, full 308 capture, live mutation vs frozen input)');
}finally{await closeBenchStores();db.close();rmSync(DATA,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
