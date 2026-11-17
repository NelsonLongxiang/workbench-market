/** Synthetic P0 fixtures only; no business sources, credentials or runtime grants. */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
const digest = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const col = (name, type, label) => ({ name, type, label });
const ref = (scope, name) => ({ ref: { scope, name } });
export function makeOperatingFixture(source = 'synthetic-a', period = '2026-10') {
 const rows = Array.from({length:308},(_,i)=>({ id:'ROW'+String(i+1).padStart(4,'0'), category:['甲类','乙类','丙类'][i%3], amount:(i+1)*10, note:i===157?'长中文说明用于跨页换行。'.repeat(12):'合成明细，仅供排版验证。', day:period+'-'+String(i%28+1).padStart(2,'0') }));
 const columns=[col('id','text','单号'),col('category','text','类别'),col('amount','decimal','金额 CNY'),col('note','text','说明'),col('day','date','业务日期')];
 const metrics={columns:[col('n','integer','记录数'),col('amount','decimal','合计 CNY')],rows:[{n:rows.length,amount:rows.reduce((n,r)=>n+r.amount,0)}],truncated:false};
 const by={columns:[col('category','text','类别'),col('amount','decimal','金额 CNY')],rows:['甲类','乙类','丙类'].map(category=>({category,amount:rows.filter(r=>r.category===category).reduce((n,r)=>n+r.amount,0)})),truncated:false};
 const definition=digest('operating-schema-v1');
 const view={identity:source,version:1,definition_sha256:definition,params:{month:period},blocks:[{type:'stat',data:metrics},{type:'bar',data:by},{type:'table',data:{columns,rows,truncated:false}}]};
 const slots={metrics:{columns:metrics.columns,max_rows:1,completeness:'summary'},by_category:{columns:by.columns,max_rows:20,completeness:'summary'},details:{columns,key:['id'],max_rows:500,completeness:'all'}};
 const template={schema_version:1,key:'operating-report',title:'经营概览 · 合成验证报告',parameters:{period:{type:'month',required:true}},fields:{summary:{required:true,max_length:2000}},slots,body:[
  {id:'cover',type:'cover',title:['经营概览'],content:['报告期间：',ref('parameter','period'),'。此报告只含合成数据。']},
  {id:'summary',type:'section',title:['本期摘要'],children:[{id:'summary-text',type:'text',content:[ref('field','summary')]},
   {id:'metrics-grid',type:'grid',columns:[6,6],items:[{id:'count',type:'data-view',component:'stat',data:'metrics',props:{value:'n',unit:'条'}},{id:'amount',type:'data-view',component:'stat',data:'metrics',props:{value:'amount',unit:'CNY'}}]},
   {id:'chart',type:'data-view',component:'bar',data:'by_category',props:{x:'category',y:['amount']}}]},
  {id:'details',type:'section',title:['完整明细（308行）'],children:[{id:'table',type:'data-view',component:'table',data:'details',props:{columns:columns.map(c=>c.name)}}]},
  {id:'tail',type:'text',content:['明细结束 · END308 · 数据截至本次合成输入。']}
 ]};
 const bindings=Object.fromEntries(Object.entries(slots).map(([name,slot],i)=>[name,{source:'source',identity:source,version:1,definition_sha256:definition,block_index:i,expect_type:view.blocks[i].type,params:{month:ref('parameter','period')},columns:Object.fromEntries(slot.columns.map(c=>[c.name,c.name])),expected_rows:view.blocks[i].data.rows.length}]));
 return {template,bindings,views:{source:view},input:{parameters:{period},fields:{summary:'这是可替换数据源的周期报告，含两列指标、图表和完整长表。 <script>NOT_EXECUTED</script>'}},assets:{}};
}
function png() {
 const crc = data => { let c=0xffffffff; for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; };
 const chunk=(type,data)=>{const name=Buffer.from(type);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const sum=Buffer.alloc(4);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);};
 const w=160,h=80,raw=Buffer.alloc((w*3+1)*h);for(let y=0;y<h;y++){const start=y*(w*3+1);raw[start]=0;for(let x=0;x<w;x++){const a=x<w/2;const i=start+1+x*3;raw[i]=a?30:4;raw[i+1]=a?58:120;raw[i+2]=a?95:87;}}
 const header=Buffer.alloc(13);header.writeUInt32BE(w,0);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export function makeProductFixture() {
 const data=png();const asset={mime:'image/png',data_url:'data:image/png;base64,'+data.toString('base64'),sha256:createHash('sha256').update(data).digest('hex')};
 const rows=Array.from({length:50},(_,i)=>({sku:'SKU'+String(i+1).padStart(4,'0'),name:'合成产品 '+String(i+1).padStart(2,'0'),description:('产品说明：以中文长段落检验正文自然换行、图片与图注、章节跨页后的完整性；不把文字截断成省略号。').repeat(i%7===0?10:5)}));
 const columns=[col('sku','text','产品编号'),col('name','text','产品名称'),col('description','text','说明')],hash=digest('product-schema-v1');
 const template={schema_version:1,key:'products-report',title:'产品线重复详情 · 合成验证报告',parameters:{},fields:{},slots:{products:{columns,key:['sku'],max_rows:100,completeness:'all'}},body:[
  {id:'cover',type:'cover',title:['产品线报告'],content:['50个产品详情，素材为本地生成的合成PNG。']},
  {id:'products',type:'repeat',data:'products',row_key:['sku'],max_items:100,children:[{id:'product',type:'section',title:[ref('row','name')],children:[
   {id:'sku',type:'text',content:['产品编号：',ref('row','sku')]},
   {id:'image',type:'image',asset:'sample',alt:'合成双色产品占位图'},
   {id:'description',type:'text',content:[ref('row','description')]}]}]},
  {id:'tail',type:'text',content:['重复详情结束 · END50']}
 ]};
 return {template,bindings:{products:{source:'products',identity:'synthetic-products',version:1,definition_sha256:hash,block_index:0,expect_type:'table',params:{},columns:{sku:'sku',name:'name',description:'description'},expected_rows:50}},views:{products:{identity:'synthetic-products',version:1,definition_sha256:hash,params:{},blocks:[{type:'table',data:{columns,rows,truncated:false}}]}},input:{parameters:{},fields:{}},assets:{sample:asset}};
}
