#!/usr/bin/env node
/** #763 视图契约一致性：view_put 的机器可读 doc 描述与 bench-views 的校验同一来源。纯内存检查，不碰库不碰网。
 *   一、契约覆盖全部组件类型，键/必填/说明自洽
 *   二、视图描述的完整契约（VIEW_DOC_SCHEMA）机器可读：枚举、上限、pattern 都取自 VIEW_DOC_CONTRACT；
 *       它在技能 wm-data-views 的 references/view-doc-schema.json 里，和代码一字不差；view_put 的工具定义里只留最小形状
 *   三、每个 oneOf 分支与 BLOCK_CONTRACT 同构（键集合+顺序、必填、禁多余键）
 *   四、每种组件一个正例过校验；特征反例仍拒——工具描述不许比服务端校验松
 */
import assert from 'node:assert/strict';
import { validateViewDoc, dagGraphMeta, BLOCK_TYPES, BLOCK_CONTRACT, VIEW_DOC_CONTRACT } from '../server/src/bench-views.ts';
import { BENCH_TOOL_DEFS, VIEW_DOC_SCHEMA } from '../server/src/bench-mcp-tools.ts';
import { readFileSync } from 'node:fs';
import { render } from './gen-view-doc-schema.mjs';
import { BLOCK_TYPE_LIST } from '../web/src/bench-blocks/jr/block-types.ts';
import { viewResultToSpec } from '../web/src/bench-blocks/jr/to-spec.ts';

assert.deepEqual([...BLOCK_TYPE_LIST], [...BLOCK_TYPES], '渲染注册表与服务端组件清单一致');
const data = { $state: '/secret', rows: [{ $template: 'literal' }] };
const spec = viewResultToSpec({ blocks: [
  { type: 'filter-bar' }, { type: 'table', data, table_context: { view: 'private' }, can_submit: false },
  { type: 'BenchGrid', title: '不认识的类型' },
] }, true);
assert.deepEqual(spec, { root: 'grid', elements: {
  grid: { type: 'BenchGrid', props: {}, children: ['b1', 'b2'] },
  b1: { type: 'table', props: { index: 1 }, children: [] },
  b2: { type: 'UnknownBlock', props: { index: 2 }, children: [] },
} }, '转换只传稳定序号，隐藏筛选不重新编号、取数与陌生类型不进解释器');
const graphTypes = ['dag', 'gantt', 'flow'];
const graphSpec = viewResultToSpec({ blocks: graphTypes.map((type) => ({ type, shape_col: 'kind' })) });
assert.deepEqual(graphSpec.elements.grid.children.map((id) => graphSpec.elements[id]),
  graphTypes.map((type, index) => ({ type, props: { index }, children: [] })), '三种任务图保留原来的类型和序号');
assert.deepEqual(viewResultToSpec(null).elements.grid.children, [], '空结果保留空网格');

// 一、契约自洽
assert.deepEqual(Object.keys(BLOCK_CONTRACT), [...BLOCK_TYPES]);
for (const t of BLOCK_TYPES) {
  const c = BLOCK_CONTRACT[t];
  assert.deepEqual(c.keys, [...new Set(c.keys)], `${t}：键不重复`);
  assert.equal(c.keys[0], 'type', `${t}：第一个键是 type`);
  assert.ok(c.required.includes('type'), `${t}：必填里有 type`);
  for (const r of c.required) assert.ok(c.keys.includes(r), `${t}：必填 ${r} 不在键清单里`);
  assert.ok(typeof c.note === 'string' && c.note.length >= 8, `${t}：note 讲了条件`);
}

// 二、doc 机器可读且同源（完整契约在技能里，工具定义里只留最小形状）
const viewPut = BENCH_TOOL_DEFS.find((t) => t.name === 'view_put');
assert.ok(viewPut, '有 view_put 工具');
const slim = viewPut.inputSchema.properties.doc;
assert.equal(slim.type, 'object');
assert.deepEqual([...slim.required].sort(), ['title', 'views']);
assert.ok(slim.description.includes('references/view-doc-schema.json'), 'view_put 的 doc 说明指向技能里的完整契约');
assert.ok(Buffer.byteLength(JSON.stringify(viewPut)) < 3000, `view_put 的定义要小（现在 ${Buffer.byteLength(JSON.stringify(viewPut))} 字节）：完整契约不放进工具定义`);
assert.equal(readFileSync(new URL('../skills/wm-data-views/references/view-doc-schema.json', import.meta.url), 'utf8'), render(), '技能里的 view-doc-schema.json 和代码生成的一字不差（不一致就跑 node scripts/gen-view-doc-schema.mjs）');
const doc = VIEW_DOC_SCHEMA;
assert.equal(doc.type, 'object');
const views = doc.properties.views;
assert.equal(views.maxItems, VIEW_DOC_CONTRACT.maxViews);
const viewItem = views.items;
assert.equal(viewItem.properties.key.pattern, VIEW_DOC_CONTRACT.viewKeyPattern);
const blocks = viewItem.properties.blocks;
assert.equal(blocks.maxItems, VIEW_DOC_CONTRACT.maxBlocks);
const branches = blocks.items.oneOf;
assert.deepEqual(branches.map((b) => b.properties.type.enum[0]), [...BLOCK_TYPES]);
const filterBranch = branches.find((b) => b.properties.type.enum[0] === 'filter-bar');
assert.equal(filterBranch.properties.fields.maxItems, VIEW_DOC_CONTRACT.filterFieldsMax);

// 三、分支与契约同构
for (const br of branches) {
  const t = br.properties.type.enum[0];
  const c = BLOCK_CONTRACT[t];
  assert.equal(br.type, 'object', t);
  assert.equal(br.additionalProperties, false, t);
  assert.deepEqual(Object.keys(br.properties), [...c.keys], `${t}：分支键与契约一致`);
  assert.deepEqual([...br.required].sort(), [...c.required].sort(), `${t}：必填与契约一致`);
  assert.ok(typeof br.description === 'string' && br.description.length >= 8, `${t}：分支带说明`);
}

// 四、正例过、反例拒（服务端校验是权威）
const datasets = new Map([
  ['d', { name: 'd', columns: [{ name: 'a', type: 'text', label: 'A' }, { name: 'n', type: 'decimal', label: 'N' }] }],
  ['d2', { name: 'd2', columns: [{ name: 'r', type: 'text', required: true, label: 'R' }, { name: 'n', type: 'decimal', label: 'N' }] }],
  ['d3', { name: 'd3', columns: [{ name: 't', type: 'text', label: '事项' }, { name: 'st', type: 'text', label: '状态' }, { name: 'who', type: 'text', label: '负责人' }, { name: 'note', type: 'text', label: '说明' }, { name: 'day', type: 'date', label: '约定日期' }, { name: 'url', type: 'text', label: '来源' }, { name: 'raw', type: 'text' }, { name: 'n', type: 'decimal', label: 'N' }], key: [] }],
  ['tasks', { name: 'tasks', columns: [{ name: 'id', type: 'text', label: '编号' }, { name: 'name', type: 'text', label: '任务' }, { name: 'deps', type: 'text', label: '前置' }, { name: 'role', type: 'text', label: '角色' }, { name: 'st', type: 'text', label: '状态' }, { name: 'pct', type: 'integer', label: '进度' }, { name: 'n', type: 'decimal', label: 'N' }, { name: 'start', type: 'date', label: '开始', required: true }, { name: 'due', type: 'date', label: '截止', required: true }, { name: 'loose', type: 'date', label: '大约' }, { name: 'at', type: 'datetime', label: '时刻', required: true }, { name: 'code', type: 'text', label: '代码', required: true }, { name: 'shape', type: 'text', label: '形状' }], key: ['id'] }],
]);
const docOf = (blocks) => ({ title: '契约台', views: [{ key: 'v', title: '总览', blocks }] });
const agg = { dataset: 'd', group: ['a'], measures: [{ fn: 'sum', col: 'n', as: 's', label: 'S' }] };
const positives = {
  'filter-bar': { type: 'filter-bar', fields: [{ name: 'p', kind: 'select', options: ['x', 'y'] }] },
  stat: { type: 'stat', query: agg, value: 's' },
  table: { type: 'table', query: agg, page_size: 20 },
  bar: { type: 'bar', query: agg, x: 'a', y: ['s'] },
  line: { type: 'line', query: agg, x: 'a', y: ['s'], area: true },
  pie: { type: 'pie', query: agg, label: 'a', value: 's' },
  progress: { type: 'progress', query: agg, value: 's', total: 100 },
  form: { type: 'form', dataset: 'd', fields: ['a', 'n'] },
  flow: { type: 'flow', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', deps_col: 'deps', role_col: 'role', shape_col: 'shape', status_col: 'st', progress_col: 'pct', direction: 'LR', detail_cols: ['st'] },
  dag: { type: 'dag', query: { dataset: 'tasks', filter: [{ col: 'st', op: 'eq', value: 'todo' }] }, id_col: 'id', label_col: 'name', deps_col: 'deps', role_col: 'role', status_col: 'st', done_values: ['done', 'skipped'], progress_col: 'pct', detail_cols: ['st'], direction: 'TB', value_labels: { st: { done: { text: '完成', tone: 'success' } } } },
  gantt: { type: 'gantt', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', start_col: 'start', end_col: 'due', deps_col: 'deps', role_col: 'role', status_col: 'st', done_values: ['done'], progress_col: 'pct', group_col: 'role', detail_cols: ['st'], value_labels: { st: { done: '完成' } } },
  records: { type: 'records', query: { dataset: 'd3' }, title_col: 't', badges: ['st'], fields: ['who'], details: ['note'], date_col: 'day', links: [{ col: 'url', label: '查看依据' }], page_size: 20, value_labels: { st: { open: '进行中' } }, empty_text: '暂无事项' },
};
for (const t of BLOCK_TYPES) assert.deepEqual(validateViewDoc(docOf([positives[t]]), datasets), [], `${t} 正例须过`);
// 任务图的特征反例：聚合查询、写了 limit 或 offset、依赖或角色列不是文本、进度不是数值、缺角色列、done_values 没配状态列、方向不对
{
  const base = { type: 'dag', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', deps_col: 'deps', role_col: 'role' };
  const bad = {
    aggregate: { ...base, query: { dataset: 'tasks', group: ['st'], measures: [{ fn: 'count', as: 'c', label: 'C' }] } },
    limit: { ...base, query: { dataset: 'tasks', limit: 10 } },
    offset: { ...base, query: { dataset: 'tasks', offset: 10 } },
    depsNotText: { ...base, deps_col: 'pct' },
    roleNotText: { ...base, role_col: 'n' },
    progressNotNumber: { ...base, progress_col: 'name' },
    noRole: { type: 'dag', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', deps_col: 'deps' },
    doneWithoutStatus: { ...base, done_values: ['done'] },
    direction: { ...base, direction: 'RL' },
    unknownCol: { ...base, label_col: 'nope' },
    tooManyDetails: { ...base, detail_cols: Array(13).fill('st') },
  };
  for (const [k, blk] of Object.entries(bad)) assert.ok(validateViewDoc(docOf([blk]), datasets).length > 0, `dag 反例 ${k} 须拒`);
  assert.deepEqual(validateViewDoc(docOf([base]), datasets), [], 'dag 只给必填项也合法');
}
// 流程图的特征反例：缺依赖列或角色列（与甘特图不同，流程图必填）、形状列不是文本、聚合、写了 limit、甘特图才有的 start_col
{
  const base = { type: 'flow', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', deps_col: 'deps', role_col: 'role' };
  const bad = {
    noDeps: { type: 'flow', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', role_col: 'role' },
    noRole: { type: 'flow', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', deps_col: 'deps' },
    shapeNotText: { ...base, shape_col: 'pct' },
    shapeMissing: { ...base, shape_col: 'nope' },
    aggregate: { ...base, query: { dataset: 'tasks', group: ['st'], measures: [{ fn: 'count', as: 'c', label: 'C' }] } },
    limit: { ...base, query: { dataset: 'tasks', limit: 10 } },
    startCol: { ...base, start_col: 'start' },
  };
  for (const [k, blk] of Object.entries(bad)) assert.ok(validateViewDoc(docOf([blk]), datasets).length > 0, `flow 反例 ${k} 须拒`);
  assert.ok(validateViewDoc(docOf([bad.shapeNotText]), datasets).some((e) => /shape_col/.test(e) && /文本列/.test(e)), 'flow：形状列不是文本时说清楚');
  assert.ok(validateViewDoc(docOf([bad.aggregate]), datasets).some((e) => /流程图的查询须为明细查询/.test(e)), 'flow：聚合查询的报错写的是流程图');
  assert.deepEqual(validateViewDoc(docOf([base]), datasets), [], 'flow 只给必填项也合法');
  assert.deepEqual(validateViewDoc(docOf([{ ...base, shape_col: 'shape' }]), datasets), [], 'flow：形状列是文本列即可');
}
// 甘特图的特征反例：开始或截止不是必填列、不是日期、缺截止、聚合、写了 limit、带任务图才有的 direction、依赖列不是文本、进度不是数值
{
  const base = { type: 'gantt', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', start_col: 'start', end_col: 'due' };
  const bad = {
    startNotRequired: { ...base, start_col: 'loose' },
    endNotRequired: { ...base, end_col: 'loose' },
    startNotDate: { ...base, start_col: 'code' },
    noEnd: { type: 'gantt', query: { dataset: 'tasks' }, id_col: 'id', label_col: 'name', start_col: 'start' },
    aggregate: { ...base, query: { dataset: 'tasks', group: ['st'], measures: [{ fn: 'count', as: 'c', label: 'C' }] } },
    limit: { ...base, query: { dataset: 'tasks', limit: 10 } },
    direction: { ...base, direction: 'TB' },
    sourceCol: { ...base, source_col: 'st' },
    depsNotText: { ...base, deps_col: 'pct' },
    progressNotNumber: { ...base, progress_col: 'name' },
  };
  for (const [k, blk] of Object.entries(bad)) assert.ok(validateViewDoc(docOf([blk]), datasets).length > 0, `gantt 反例 ${k} 须拒`);
  assert.ok(validateViewDoc(docOf([bad.startNotRequired]), datasets).some((e) => /必填列/.test(e)), 'gantt：开始不是必填列时说清楚要 required');
  assert.ok(validateViewDoc(docOf([bad.startNotDate]), datasets).some((e) => /日期或日期时间列/.test(e)), 'gantt：必填但不是日期的列也拒，说清楚要日期');
  assert.deepEqual(validateViewDoc(docOf([base]), datasets), [], 'gantt 只给必填项也合法（不给依赖、角色列）');
  assert.deepEqual(validateViewDoc(docOf([{ ...base, end_col: 'at' }]), datasets), [], 'gantt：截止可以是日期时间列');
  // 取数说明：有 filter 才算筛选；只开 current_only 不算（第五节之一）
  assert.deepEqual(dagGraphMeta({ dataset: 'tasks' }), { filtered: false });
  assert.deepEqual(dagGraphMeta({ dataset: 'tasks', current_only: true }), { filtered: false }, '只开 current_only 按全量');
  assert.deepEqual(dagGraphMeta({ dataset: 'tasks', filter: [{ col: 'st', op: 'eq', value: 'todo' }] }), { filtered: true });
  assert.deepEqual(dagGraphMeta({ dataset: 'tasks', filter: [] }), { filtered: false }, '空 filter 不算筛选');
}
// stat 独立取值（本台引用）也是合法形态（#777 引入）
assert.deepEqual(validateViewDoc(docOf([{ type: 'stat', value: { var: 'k' } }]), datasets), []);

const negatives = [
  ['未知类型', [{ type: 'gauge' }]],
  ['多余键', [{ type: 'stat', value: { var: 'k' }, zzz: 1 }]],
  ['缺 value', [{ type: 'stat', query: agg }]],
  ['缺 y', [{ type: 'bar', query: agg, x: 'a' }]],
  ['非 select 带 options', [{ type: 'filter-bar', fields: [{ name: 'p', kind: 'search', options: ['x'] }] }]],
  ['$参数未声明', [{ type: 'stat', query: { dataset: 'd', filter: [{ col: 'a', op: '=', value: '$p' }] }, value: 'n' }]],
  ['必填列不在表单', [{ type: 'form', dataset: 'd2', fields: ['n'] }]],
  ['独立取值还写 query', [{ type: 'stat', value: { var: 'k' }, query: agg }]],
  ['记录卡缺 title_col', [{ type: 'records', query: { dataset: 'd3' } }]],
  ['记录卡同一列放进两处', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', fields: ['who'], details: ['who'] }]],
  ['记录卡标题列又当徽标', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', badges: ['t'] }]],
  ['记录卡日期列又当主要字段', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', fields: ['day'], date_col: 'day' }]],
  ['记录卡 date_col 不是日期', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', date_col: 'who' }]],
  ['记录卡的列没有说明名', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', fields: ['raw'] }]],
  ['记录卡链接 label 太长', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', links: [{ col: 'url', label: '这是一个超过十二个字的链接说法啊' }] }]],
  ['记录卡链接指向数值列', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', links: [{ col: 'n', label: '打开' }] }]],
  ['记录卡链接多余键', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', links: [{ col: 'url', label: '打开', href: 'x' }] }]],
  ['记录卡徽标超过 3 个', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', badges: ['st', 'who', 'note', 'url'] }]],
  ['记录卡 page_size 超上限', [{ type: 'records', query: { dataset: 'd3' }, title_col: 't', page_size: 201 }]],
];
for (const [name, blocks] of negatives) {
  const errs = validateViewDoc(docOf(blocks), datasets);
  assert.notEqual(errs.length, 0, `${name} 须被拒`);
}

// 五、报错帮会话自己改对：不认识的键点名是哪个，并列出这里能用的键（和契约同一份）
{
  const errs = validateViewDoc(docOf([{ type: 'stat', query: agg, value: 's', colour: 'red' }]), datasets);
  const hit = errs.find((e) => e.includes('有不认识的键 colour'));
  assert.ok(hit, `多写了键：报出是哪个键（${errs.join(' | ')}）`);
  assert.ok(hit.includes(`这里能用的键：${BLOCK_CONTRACT.stat.keys.join('、')}`), `列出 stat 能用的键，和契约一致（${hit}）`);
  const top = validateViewDoc({ title: 'x', views: [{ key: 'v', title: 't', blocks: [] }], theme: 'dark' }, datasets).find((e) => e.includes('有不认识的键 theme'));
  assert.ok(top?.includes('这里能用的键：title、views'), `顶层也列出能用的键（${top}）`);
}
const { renderComponentCatalog } = await import('./gen-view-doc-schema.mjs');
const componentCatalog = readFileSync(new URL('../skills/wm-data-views/references/views.md', import.meta.url), 'utf8');
assert.equal(componentCatalog, renderComponentCatalog(componentCatalog), '组件一览与服务端契约一致');

console.log(`bench-view-contract-test: ${BLOCK_TYPES.length} 个契约分支同构 + 正反例全部通过；不认识的键报出能用的键`);
