#!/usr/bin/env node
/** #763 视图契约一致性：view_put 的机器可读 doc 描述与 bench-views 的校验同一来源。纯内存检查，不碰库不碰网。
 *   一、契约覆盖全部组件类型，键/必填/说明自洽
 *   二、视图描述的完整契约（VIEW_DOC_SCHEMA）机器可读：枚举、上限、pattern 都取自 VIEW_DOC_CONTRACT；
 *       它在技能 wm-data-views 的 references/view-doc-schema.json 里，和代码一字不差；view_put 的工具定义里只留最小形状
 *   三、每个 oneOf 分支与 BLOCK_CONTRACT 同构（键集合+顺序、必填、禁多余键）
 *   四、每种组件一个正例过校验；特征反例仍拒——工具描述不许比服务端校验松
 */
import assert from 'node:assert/strict';
import { validateViewDoc, BLOCK_TYPES, BLOCK_CONTRACT, VIEW_DOC_CONTRACT } from '../server/src/bench-views.ts';
import { BENCH_TOOL_DEFS, VIEW_DOC_SCHEMA } from '../server/src/bench-mcp-tools.ts';
import { readFileSync } from 'node:fs';
import { render } from './gen-view-doc-schema.mjs';

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
};
for (const t of BLOCK_TYPES) assert.deepEqual(validateViewDoc(docOf([positives[t]]), datasets), [], `${t} 正例须过`);
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
console.log('bench-view-contract-test: 8 个契约分支同构 + 正反例全部通过；不认识的键报出能用的键');
