#!/usr/bin/env node
/** Native-table tests use an isolated synthetic bench store; no business rows or production services. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tableCsv, tableTarget, tableDigest } from '../server/src/bench-table.ts';
mkdirSync('tmp', {recursive:true});
const dir=mkdtempSync(resolve('tmp/bench-table-'));process.env.DATA_DIR=join(dir,'data');
const {benchStore,closeBenchStores}=await import('../server/src/services/bench-store.ts');
const {db}=await import('../server/src/db.ts');
let n=1800000000000;const ctx=()=>({actor:'synthetic',at:++n});let count=0;const pass=label=>{count++;console.log('PASS '+label)};
try{
 const store=await benchStore('synthetic-table');
 const cols=[{name:'id',type:'integer',label:'行号'},{name:'batch',type:'text',label:'批次'},{name:'source_version',type:'text',label:'来源版本'},{name:'sku',type:'text',label:'商品'},{name:'warehouse',type:'text',label:'仓库'},{name:'qty',type:'decimal',label:'数量'},{name:'source_row',type:'text',label:'原行定位'},{name:'formula',type:'text',label:'公式原文'}];
 await store.defineDataset({name:'receipts',title:'合成收货',key:['id'],columns:cols},ctx());
 const rows=Array.from({length:4833},(_,i)=>({id:i+1,batch:'frozen',source_version:'v68',sku:i<1650?'Sample Cup':'其他',warehouse:i<1650?'TestWest':'Other',qty:i+0.25,source_row:'SheetA!'+(i+2),formula:i===0?'=SUM(A1:A2)':'原值'}));
 await store.replace('receipts',[...rows,{...rows[0],id:9900,batch:'another-snapshot'}],ctx());
 const filter=[{col:'batch',op:'=',value:'frozen'},{col:'source_version',op:'=',value:'v68'},{col:'sku',op:'contains',value:'$sku'},{col:'warehouse',op:'contains',value:'$warehouse'}];
 const doc={title:'合成台',views:[{key:'receipts',title:'收货',blocks:[{type:'filter-bar',fields:[{name:'sku',kind:'search',label:'商品'},{name:'warehouse',kind:'search',label:'仓库'}]},{type:'table',title:'明细',query:{dataset:'receipts',select:['id','batch','source_version','sku','warehouse','qty'],filter,sort:[{col:'id'}],limit:50},page_size:50}]}]};
 await store.putView(doc,{...ctx(),base:0,note:'synthetic'});
 const render=await store.renderView({view:'receipts'});const target=render.blocks[1].table_context;
 assert.equal(render.blocks[1].data.rows.length,50);assert.equal(render.blocks[1].data.truncated,true);assert.ok(target && typeof target.revision==='string','saved table has a read-context revision');pass('display limit50 exposes context without claiming complete data');
 const all=await store.tableExport(target);assert.equal(all.row_count,4833);assert.equal(all.rows.at(-1).id,4833);assert.equal(all.truncated,false);assert.ok(all.rows.every(r=>r.batch==='frozen'&&r.source_version==='v68'));pass('all4833 matches exported, excluding foreign snapshot');
 const filtered=await store.renderView({view:'receipts',params:{sku:'Sample Cup',warehouse:'TestWest'}});const chosen=filtered.blocks[1].table_context;
 const selected=await store.tableExport(chosen);assert.equal(selected.row_count,1650);assert.ok(selected.rows.every(r=>r.sku==='Sample Cup'&&r.warehouse==='TestWest'));pass('currentSample CupTestWest filter exports all1650 not first50');
 await assert.rejects(()=>store.tableExport({...chosen,params:{sku:'其他'}}),e=>e.code==='conflict');pass('filter switch cannot reuse stale context');
 const row=filtered.blocks[1].data.rows[49];const detail=await store.tableRow(chosen,49,row,true);assert.equal(detail.source_row.id,50);assert.equal(detail.source_row.source_row,'SheetA!51');assert.deepEqual(detail.params,{sku:'Sample Cup',warehouse:'TestWest'});pass('business row opens exact original row with source fields and same filters');
 const denied=await store.tableRow(chosen,49,row,false);assert.equal(denied.source_row,null);assert.equal(denied.source_columns.length,0);pass('original dataset fields withheld without query permission');
 await assert.rejects(()=>store.tableRow(chosen,49,{...row,qty:999},true),e=>e.code==='conflict');await assert.rejects(()=>store.tableRow(chosen,50,row,true),e=>e.code==='invalid');pass('forged row and out-of-display index rejected');
 assert.throws(()=>tableTarget({...chosen,dataset:'private'}),e=>e.code==='invalid');assert.throws(()=>tableTarget({...chosen,revision:'bad'}),e=>e.code==='invalid');pass('no arbitrary dataset/query or invalid revision selectors');
 const csv=tableCsv([{name:'a',label:'内容'},{name:'n',label:'数'}],[{a:'=SUM(A1:A2)',n:-3},{a:'"quoted",line\nnew',n:null}]);assert.ok(csv.startsWith('\ufeff"内容","数"\r\n'));assert.ok(csv.includes("\"'=SUM(A1:A2)\",\"-3\""));assert.ok(csv.includes('""quoted""'));pass('CSV quotes newlines and formula text but preserves numeric negatives');
 await store.upsert('receipts',[{id:1,qty:999}],ctx());await assert.rejects(()=>store.tableExport(target),e=>e.code==='conflict');await assert.rejects(()=>store.tableRow(chosen,49,row,true),e=>e.code==='conflict');pass('writes invalidate export and row-detail contexts');
 const latest=await store.renderView({view:'receipts'});assert.notEqual(latest.blocks[1].table_context.revision,target.revision);assert.equal((await store.tableExport(latest.blocks[1].table_context)).rows[0].qty,999);pass('explicit refresh obtains new versioned read identity');
 await store.defineDataset({name:'large',title:'合成长表',key:['id'],columns:[{name:'id',type:'integer',label:'编号'},{name:'value',type:'text',label:'值'}]},ctx());
 await store.replace('large',Array.from({length:6123},(_,i)=>({id:i+1,value:'V'+i})),ctx());
 const doc2={title:'长表',views:[...doc.views,{key:'large',title:'长表',blocks:[{type:'table',query:{dataset:'large',sort:[{col:'id'}],limit:20}}]}]};await store.putView(doc2,{...ctx(),base:1,note:'addlarge'});
 const many=await store.renderView({view:'large'});const exported=await store.tableExport(many.blocks[0].table_context);assert.equal(exported.row_count,6123);assert.equal(exported.rows[5000].id,5001);assert.equal(exported.rows.at(-1).id,6123);pass('complete export spans query pages beyond5000 with stable order');
 // Grouped drill-through preserves literal group names including dollar-prefixed text, nulls, and current filters.
 await store.defineDataset({name:'groups',title:'合成来源',key:['id'],columns:[{name:'id',type:'integer',label:'行'},{name:'batch',type:'text',label:'批次'},{name:'tag',type:'text',label:'组'},{name:'value',type:'decimal',label:'数'}]},ctx());
 await store.replace('groups',[{id:1,batch:'frozen',tag:'$dollar',value:1},{id:2,batch:'frozen',tag:'$dollar',value:2},{id:3,batch:'frozen',tag:null,value:4},{id:4,batch:'other',tag:'$dollar',value:9}],ctx());
 const groupedDoc={title:'来源',views:[{key:'grouped',title:'分组',blocks:[{type:'table',query:{dataset:'groups',filter:[{col:'batch',op:'=',value:'frozen'}],group:['tag'],measures:[{fn:'sum',col:'value',as:'total',label:'合计'}]},column_labels:{tag:'组'}}]}]};await store.putView(groupedDoc,{...ctx(),base:2,note:'grouped'});
 const grouped=await store.renderView({view:'grouped'}),gt=grouped.blocks[0].table_context;
 const dollarIndex=grouped.blocks[0].data.rows.findIndex(r=>r.tag==='$dollar');const groupDetail=await store.tableRow(gt,dollarIndex,grouped.blocks[0].data.rows[dollarIndex],true);assert.deepEqual(groupDetail.source_rows.map(r=>r.id),[1,2]);assert.equal(groupDetail.source_status,'group-rows');pass('grouped source rows preserve dollar literals and frozen batch');
 const nullIndex=grouped.blocks[0].data.rows.findIndex(r=>r.tag===null);const nullDetail=await store.tableRow(gt,nullIndex,grouped.blocks[0].data.rows[nullIndex],true);assert.deepEqual(nullDetail.source_rows.map(r=>r.id),[3]);pass('null grouping drills only into null source rows');
 const emptyDoc={title:'空',views:[{key:'empty',title:'空',blocks:[{type:'table',query:{dataset:'groups',filter:[{col:'batch',op:'=',value:'missing'}]}}]}]};await store.putView(emptyDoc,{...ctx(),base:3,note:'empty'});const empty=await store.renderView();assert.equal((await store.tableExport(empty.blocks[0].table_context)).row_count,0);pass('empty matching result exports header-only with honest zero count');
 assert.equal(tableDigest({b:2,a:1}),tableDigest({a:1,b:2}));pass('read digest ignores object key insertion order');
  // CSV export must carry the same value wording the page shows (value_labels), without losing the raw value.
  const statusLabels={status:{not_confirmed:'业务接受待确认',accepted:'业务接受已确认'},level:{high:{text:'高',tone:'danger'}}};
  const statusDoc={title:'状态',views:[{key:'status',title:'状态',blocks:[
    {type:'table',title:'证据',query:{dataset:'status_rows',select:['id','status','level','note'],sort:[{col:'id'}]},value_labels:statusLabels},
    {type:'table',title:'无对照',query:{dataset:'status_rows',select:['id','status'],sort:[{col:'id'}]}}]}]};
  await store.defineDataset({name:'status_rows',title:'合成状态',key:['id'],columns:[{name:'id',type:'integer',label:'行号'},{name:'status',type:'text',label:'业务接受证据状态'},{name:'level',type:'text',label:'等级'},{name:'note',type:'text',label:'备注'}]},ctx());
  await store.replace('status_rows',[{id:1,status:'not_confirmed',level:'high',note:'=HYPERLINK("x")'},{id:2,status:'accepted',level:'low',note:'plain'},{id:3,status:'unmapped_x',level:'high',note:'third'}],ctx());
  await store.putView(statusDoc,{...ctx(),base:4,note:'valuelabels'});
  const statusView=await store.renderView({view:'status'});
  const labelled=await store.tableExport(statusView.blocks[0].table_context);
  const unlabelled=await store.tableExport(statusView.blocks[1].table_context);
  const csvCells=text=>text.replace(/^\ufeff/,'').split('\r\n').filter(Boolean).map(line=>{const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(q){if(ch==='"'){if(line[i+1]==='"'){cur+='"';i++}else q=false}else cur+=ch}else if(ch==='"')q=true;else if(ch===','){out.push(cur);cur=''}else cur+=ch}out.push(cur);return out});
  const L=csvCells(tableCsv(labelled.columns,labelled.rows,labelled.value_labels)),U=csvCells(tableCsv(unlabelled.columns,unlabelled.rows,unlabelled.value_labels));
  // Raw columns keep their header and their raw value: existing consumers are unaffected.
  assert.deepEqual(L[0].slice(0,4),['行号','业务接受证据状态','等级','备注']);pass('labelled export keeps every raw column header unchanged');
  assert.deepEqual(L[1].slice(0,4),['1','not_confirmed','high','\'=HYPERLINK("x")']);assert.deepEqual(U[1],['1','not_confirmed']);pass('raw status stays not_confirmed in CSV (same value as page), formula text still neutralized');
  // The page wording arrives as added columns, one per column that has value_labels.
  assert.deepEqual(L[0].slice(4),['业务接受证据状态（说明）','等级（说明）']);pass('a wording column is appended for each column that has value_labels');
  assert.deepEqual(L[1].slice(4),['业务接受待确认','高']);pass('page wording 业务接受待确认 is exported for not_confirmed, object form yields its text');
  assert.deepEqual(L[2].slice(4),['业务接受已确认','']);pass('value without a mapping leaves the wording cell empty rather than inventing text');
  assert.deepEqual(L[3].slice(4),['','高']);pass('unmapped raw value keeps raw column and leaves wording empty');
  assert.equal(L[0].length,6);pass('note and id columns get no wording column');
  // A table without value_labels exports exactly as before.
  assert.deepEqual(U[0],['行号','业务接受证据状态']);assert.deepEqual(U[1],['1','not_confirmed']);assert.deepEqual(U[2],['2','accepted']);pass('table without value_labels exports byte-for-byte as before (no extra columns)');
  // The exporter result carries value_labels so the route can pass them through.
  assert.deepEqual(labelled.value_labels,statusLabels);assert.equal(unlabelled.value_labels,undefined);pass('tableExport returns the block value_labels for the route to hand to tableCsv');
  // 派生说明表头必须经过与原表头相同的 CSV 单元格编码（非作者评审 B1）：
  // 列名含逗号、引号或公式样式文本时，说明表头不得被拆格、错位，也不得失去转义与文本标记。
  {
    const tricky = { name: 'st', label: '=收货,状态"x' };
    const tl = { st: { a: '=说明,值"y' } };
    // 按 RFC4180 解析（与评审一致）：引号感知；未加引号的格子里的逗号就是分隔符
    const rfc = (line) => { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
    const T = tableCsv([{ name: 'id', label: '编号' }, tricky], [{ id: 1, st: 'a' }], tl).replace(/^\ufeff/, '').split('\r\n').filter(Boolean).map(rfc);
    assert.equal(T[0].length, 3, 'header has one cell per column plus one wording column: ' + JSON.stringify(T[0]));
    assert.equal(T[1].length, 3, 'data row has as many cells as the header');
    assert.equal(T[0][1], "'=收货,状态\"x", 'the raw header is cell-encoded');
    assert.equal(T[0][2], "'=收货,状态\"x（说明）", 'the derived wording header is cell-encoded too: commas, quotes and formula-style text stay one cell');
    pass('derived wording header goes through the same CSV cell encoding: a column label with commas, quotes and formula-style text stays one cell and the header has as many cells as a data row');
    assert.equal(T[1][1], 'a', 'the raw value is untouched');
    assert.equal(T[1][2], "'=说明,值\"y", 'the wording value is cell-encoded with its text marker');
    pass('the wording value keeps its CSV encoding and text marker while the raw column is untouched');
  }
 console.log(JSON.stringify({passed:count,failed:0,synthetic:true,production:false}));
}finally{await closeBenchStores();db.close();rmSync(dir,{recursive:true,force:true});}
