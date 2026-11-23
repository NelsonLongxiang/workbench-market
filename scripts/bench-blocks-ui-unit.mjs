#!/usr/bin/env node
/**
 * 数据视图组件（web/src/bench-blocks）里的纯函数：数字的写法、格子按什么画、图表的系列怎么拼、出错说什么、图表配置只取 token。
 * 用法：node scripts/bench-blocks-ui-unit.mjs
 */
const v = await import('../web/src/bench-blocks/blocks-view.ts');
const c = await import('../web/src/bench-blocks/chart-option.ts');

let pass = 0, fail = 0;
const ok = (n, cond, x = '') => { if (cond) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
const col = (name, type, label) => ({ name, type, label });

console.log('数字和格子');
ok('千分位；整数不带小数点', v.fmtNumber(1234567) === '1,234,567' && v.fmtNumber(0) === '0' && v.fmtNumber(-1200) === '-1,200');
ok('小数最多两位，末尾的 0 不留', v.fmtNumber(3373.5) === '3,373.5' && v.fmtNumber(1.005) === '1' && v.fmtNumber(2.456) === '2.46' && v.fmtNumber(-0.5) === '-0.5', [v.fmtNumber(1.005), v.fmtNumber(2.456)]);
ok('不是数字的给「-」', v.fmtNumber(null) === '-' && v.fmtNumber('12') === '-' && v.fmtNumber(NaN) === '-' && v.fmtNumber(Infinity) === '-');
ok('格子的画法按类型推；显式给了就用给的', v.cellKind(col('a', 'integer')) === 'number' && v.cellKind(col('a', 'datetime')) === 'time' && v.cellKind(col('a', 'date')) === 'date' && v.cellKind(col('a', 'boolean')) === 'bool' && v.cellKind(col('a', 'text')) === 'text' && v.cellKind({ ...col('a', 'text'), display: 'person' }) === 'person');
ok('格子的文字：空给「-」，布尔说是否，对象不直接显示', v.cellText(null, 'text') === '-' && v.cellText('', 'text') === '-' && v.cellText(true, 'bool') === '是' && v.cellText(false, 'bool') === '否' && v.cellText({ a: 1 }, 'text') === '-' && v.cellText(1200, 'number') === '1,200');

console.log('统计卡和进度');
const one = { columns: [col('v', 'integer'), col('t', 'integer')], rows: [{ v: 3, t: 12 }, { v: 99, t: 1 }] };
ok('统计卡取第一行；没有数据、不是数字都给空', v.statOf(one, 'v') === 3 && v.statOf({ columns: [], rows: [] }, 'v') === null && v.statOf(null, 'v') === null && v.statOf({ columns: [], rows: [{ v: 'x' }] }, 'v') === null);
ok('进度：比例 = 值 / 总数', JSON.stringify(v.progressOf(one, 'v', 't')) === JSON.stringify({ value: 3, total: 12, ratio: 0.25 }));
ok('进度：总数可以是写死的数字；超过了夹到 1；负的夹到 0', v.progressOf(one, 'v', 2).ratio === 1 && v.progressOf({ columns: [], rows: [{ v: -1 }] }, 'v', 5).ratio === 0);
ok('进度：总数是 0 或负数时没有比例，不除零', v.progressOf({ columns: [], rows: [{ v: 0, t: 0 }] }, 'v', 't').ratio === null && v.progressOf(one, 'v', -3).ratio === null);
ok('进度：没有数据、缺列都给空', v.progressOf(null, 'v', 't') === null && v.progressOf(one, 'nope', 't') === null && v.progressOf({ columns: [], rows: [] }, 'v', 1) === null);

console.log('柱和线的系列');
const wide = { columns: [col('m', 'text', '月'), col('a', 'decimal', '金额'), col('q', 'integer', '件数')], rows: [{ m: '1月', a: 10, q: 1 }, { m: '2月', a: 20, q: 2 }, { m: '1月', a: 5, q: null }] };
let m = v.toSeries(wide, 'm', ['a', 'q']);
ok('多个 y：每个 y 一个系列，名字用列的显示名；类目按出现的先后；同类目相加', m.categories.join() === '1月,2月' && m.series.map((s) => `${s.name}:${s.values.join('/')}`).join() === '金额:15/20,件数:1/2' && !m.merged, m);
ok('每个类目记着它对应的原始行（点了下钻用）', m.rowsAt[0].length === 2 && m.rowsAt[1].length === 1);
const long = { columns: [col('m', 'text'), col('r', 'text'), col('a', 'decimal')], rows: [{ m: 'x', r: '东', a: 1 }, { m: 'x', r: '西', a: 2 }, { m: 'y', r: '东', a: 3 }, { m: 'y', r: null, a: 4 }] };
m = v.toSeries(long, 'm', 'a', 'r');
ok('一个 y 加 series 列：按那一列的取值分系列；缺的格子是空不是 0；空的取值叫「（空）」', m.series.map((s) => `${s.name}:${s.values.map((x) => x ?? '_').join('/')}`).join() === '东:1/3,西:2/_,（空）:_/4', m.series);
const tooMany = { columns: [], rows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((r, i) => ({ m: 'x', r, a: i + 1 })) };
m = v.toSeries(tooMany, 'm', 'a', 'r');
ok('系列超过 5 个：留前 4 个，其余并成「其他」并相加', m.merged && m.series.length === v.MAX_SERIES && m.series[4].name === v.OTHER && m.series[4].values[0] === 5 + 6 + 7, m.series);
ok('没有数据：空的类目和系列，不抛错', v.toSeries(null, 'm', 'a').categories.length === 0 && v.toSeries({ columns: [], rows: [] }, 'm', ['a']).series.length === 0);
ok('列名撞上对象原型上的名字不出怪事', v.toSeries({ columns: [], rows: [{ constructor: 'k', toString: 3 }] }, 'constructor', 'toString').series[0].values[0] === 3);

console.log('饼');
let p = v.toSlices({ columns: [], rows: [{ k: '甲', n: 3 }, { k: '乙', n: 7 }, { k: '甲', n: 2 }, { k: '丙', n: 0 }, { k: '丁', n: -4 }, { k: '戊', n: 'x' }] }, 'k', 'n');
ok('按标签合并、从大到小；不是正数的不画', p.slices.map((s) => `${s.name}:${s.value}`).join() === '乙:7,甲:5' && p.total === 12 && !p.merged && p.slices[1].rows.length === 2, p.slices);
p = v.toSlices({ columns: [], rows: [9, 8, 7, 6, 5, 4, 3].map((n, i) => ({ k: `k${i}`, n })) }, 'k', 'n');
ok('超过 5 块：小的并成「其他」', p.merged && p.slices.length === 5 && p.slices[4].name === v.OTHER && p.slices[4].value === 5 + 4 + 3 && p.slices[4].rows.length === 3);

console.log('四种状态和宽度');
ok('空：没有数据、rows 不是数组、一行也没有', v.isEmptyData(null) && v.isEmptyData({ columns: [], rows: 'x' }) && v.isEmptyData({ columns: [], rows: [] }) && !v.isEmptyData(one));
const said = ['timeout', 'limit', 'invalid', 'not_found', 'busy', 'forbidden', 'internal', 'whatever'].map((code) => v.errorText({ code, message: 'SQLITE_ERROR: no such column c_x in ds_y' }));
ok('出错的说法：每种都是一句人话，不带服务端的原话和代号', said.every((s) => s.length > 8 && !/SQLITE|c_x|ds_y|timeout|limit|invalid|internal/.test(s)) && new Set(said).size === 7, said);
ok('宽度落到 3 / 4 / 6 / 12；不给时按类型', [1, 3, 4, 5, 6, 7, 12].map((s) => v.snapSpan(s, 'bar')).join() === '3,3,4,6,6,12,12' && v.snapSpan(undefined, 'stat') === 3 && v.snapSpan(undefined, 'table') === 12 && v.snapSpan(undefined, 'pie') === 6 && v.snapSpan('6', 'filter-bar') === 12);

console.log('取值 → 说法');
const L = { status: { done: { text: '已完成', tone: 'success' }, doing: '进行中', odd: { text: '怪', tone: 'purple' }, bad: { tone: 'danger' }, empty: '' } };
ok('对照里有的：给说法和颜色；只写文字的没有颜色', JSON.stringify(v.valueLabel(L, 'status', 'done')) === '{"text":"已完成","tone":"success"}' && JSON.stringify(v.valueLabel(L, 'status', 'doing')) === '{"text":"进行中"}');
ok('对照里没有的取值、没有对照的列：不给说法（表格显示灰色原文）', v.valueLabel(L, 'status', 'late') === null && v.valueLabel(L, 'other', 'done') === null && v.valueLabel(null, 'status', 'done') === null && v.valueLabel('x', 'status', 'done') === null);
ok('不认识的颜色当成缺省；没有文字的不算', v.valueLabel(L, 'status', 'odd').tone === 'default' && v.valueLabel(L, 'status', 'bad') === null && v.valueLabel(L, 'status', 'empty') === null);
ok('取值和列名撞上对象原型上的名字：不当成有对照', v.valueLabel(L, 'status', 'constructor') === null && v.valueLabel(L, 'toString', 'done') === null && v.valueLabel(L, '__proto__', 'x') === null);
// 只认自己带的键：继承来的、原型上的一律当作没有（这三条在把 Object.hasOwn 换成普通下标取值时会红）
ok('列是继承来的：当作没有对照', v.valueLabel(Object.create({ status: { done: '继承来的' } }), 'status', 'done') === null && v.valueLabel({}, 'constructor', 'name') === null && v.valueLabel({}, 'toString', 'name') === null && v.valueLabel({}, '__proto__', 'constructor') === null);
ok('取值是继承来的：当作没有说法', v.valueLabel({ status: Object.create({ done: '继承来的', late: { text: '也是继承来的' } }) }, 'status', 'done') === null && v.valueLabel({ status: Object.create({ late: { text: '也是继承来的' } }) }, 'status', 'late') === null && v.valueLabel({ status: {} }, 'status', 'constructor') === null && v.valueLabel({ status: {} }, 'status', '__proto__') === null && v.valueLabel({ status: {} }, 'status', 'toString') === null);
ok('数字、布尔的取值按文本对', v.valueLabel({ n: { 1: '一', true: '是' } }, 'n', 1).text === '一' && v.valueLabel({ n: { 1: '一', true: '是' } }, 'n', true).text === '是');
const wl = v.withLabelColumns({ columns: [col('status', 'text'), col('n', 'integer'), { ...col('who', 'text'), display: 'person' }], rows: [] }, { status: {}, who: {} });
ok('有对照的列按状态画；已经指定了画法的不改；别的列不动', wl.columns[0].display === 'status' && wl.columns[1].display === undefined && wl.columns[2].display === 'person' && v.withLabelColumns(null, L) === null);

console.log('按值着色');
const R = v.toneRules([{ col: 'm', op: '<', value: 20, tone: 'danger' }, { col: 'm', op: '<', value: 25, tone: 'warning' }, { col: 'm', op: '>=', value: 30, tone: 'success' }]);
ok('最多两条规则；写错的当作没有', R.length === 2 && v.toneRules('x').length === 0 && v.toneRules([{ col: 'm', op: 'like', value: 1, tone: 'danger' }, { col: 'm', op: '<', value: '20', tone: 'danger' }, { col: 'm', op: '<', value: 1, tone: '#ff0000' }, { col: 'm', op: 'constructor', value: 1, tone: 'danger' }, null]).length === 0);
ok('按先后，第一条满足的算；都不满足没有；那一列不是数字没有', v.toneOf({ m: 12 }, R) === 'danger' && v.toneOf({ m: 22 }, R) === 'warning' && v.toneOf({ m: 40 }, R) === null && v.toneOf({ m: '12' }, R) === null && v.toneOf({}, R) === null && v.toneOf(undefined, R) === null);
ok('行里那一列是继承来的、或者列名是原型上的名字：当作没有这个值', v.toneOf(Object.create({ m: 5 }), R) === null && v.toneOf({}, v.toneRules([{ col: 'constructor', op: '!=', value: 0, tone: 'danger' }, { col: '__proto__', op: '!=', value: 0, tone: 'danger' }])) === null && v.toneOf(Object.create({ toString: 1 }), v.toneRules([{ col: 'toString', op: '>', value: 0, tone: 'danger' }])) === null);
ok('六种比较符', ['<', '<=', '>', '>=', '=', '!='].map((op) => v.toneOf({ m: 20 }, v.toneRules([{ col: 'm', op, value: 20, tone: 'danger' }])) ? 1 : 0).join('') === '010110');
ok('说明那一行：红 = 列的显示名 低于 值（带单位）', v.toneNote(R, { columns: [col('m', 'decimal', '毛利率')], rows: [] }, '%') === '红 = 毛利率低于 20%；黄 = 毛利率低于 25%', v.toneNote(R, { columns: [col('m', 'decimal', '毛利率')], rows: [] }, '%'));

console.log('图表配置只取 token');
const T = { series: ['#111111', '#222222', '#333333', '#444444', '#555555'], muted: '#999999', tones: { danger: '#aa0001', warning: '#aa0002', success: '#aa0003' }, text: '#000001', textSecondary: '#000002', border: '#000003', surface: '#000004', fontFamily: 'F', fontSize: 12 };
const hexes = (o) => [...new Set(JSON.stringify(o).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])];
const model = { categories: ['a', 'b'], series: [{ name: 's1', values: [1, 2] }, { name: 's2', values: [3, null] }] };
const allowed = new Set([...T.series, T.muted, ...Object.values(T.tones), T.text, T.textSecondary, T.border, T.surface]);
for (const [name, o] of [['柱', c.cartesianOption('bar', model, T, { stacked: true })], ['横向柱', c.cartesianOption('bar', model, T, { horizontal: true })], ['线', c.cartesianOption('line', model, T, { area: true })], ['饼', c.pieOption([{ name: 'a', value: 1 }], T, { donut: true })]]) {
  ok(`${name}：出现的色值都是递进来的 token，没有图表库自带的颜色`, hexes(o).every((h) => allowed.has(h)) && o.color === T.series && o.textStyle.fontFamily === 'F', hexes(o));
}
let o = c.cartesianOption('bar', model, T, { horizontal: true });
ok('横向柱：类目在纵轴，从上往下排', o.yAxis.type === 'category' && o.yAxis.inverse === true && o.xAxis.type === 'value');
ok('只有一个系列时不画图例；多个时画', c.cartesianOption('bar', { categories: ['a'], series: [model.series[0]] }, T).legend.show === false && o.legend.show === true);
ok('堆叠：各系列同一个 stack；不堆叠没有', c.cartesianOption('bar', model, T, { stacked: true }).series.every((s) => s.stack === 'total') && o.series.every((s) => s.stack === undefined));
o = c.cartesianOption('line', { ...model, merged: true }, T);
ok('并出来的「其他」用中性色，别的系列不动', o.series[1].color === T.muted && o.series[0].color === undefined);
o = c.pieOption([{ name: 'a', value: 2 }, { name: '其他', value: 1 }], T, { merged: true });
ok('饼：并出来的那一块用中性色；环形和实心的半径不同', o.series[0].data[1].itemStyle.color === T.muted && o.series[0].data[0].itemStyle === undefined && o.series[0].radius[0] === 0 && c.pieOption([], T, { donut: true }).series[0].radius[0] !== 0);

const single = { categories: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, 3] }] };
o = c.cartesianOption('bar', single, T, { tones: ['danger', null, 'warning'] });
ok('按值着色：只有那几根柱子换成语义色，别的还是系列的颜色', o.series[0].data[0].itemStyle.color === T.tones.danger && o.series[0].data[1] === 2 && o.series[0].data[2].itemStyle.color === T.tones.warning && hexes(o).every((h) => allowed.has(h)));
ok('多个系列、线图：不按值着色', c.cartesianOption('bar', model, T, { tones: ['danger', 'danger'] }).series[0].data[0] === 1 && c.cartesianOption('line', single, T, { tones: ['danger', null, null] }).series[0].data[0] === 1);
o = c.pieOption([{ name: 'a', value: 1 }], T, { donut: true });
ok('饼的半径按像素定（块再宽也不变大）；图例缺省在右，窄的时候在下', typeof o.series[0].radius[1] === 'number' && o.legend.orient === 'vertical' && c.pieOption([{ name: 'a', value: 1 }], T, { legendBelow: true }).legend.bottom === 0);

console.log('排版：块的宽度、表格的短值列');
const T3 = (t, span) => (span === undefined ? { type: t } : { type: t, span });
// 试点看板（驾驶舱里筛选栏不画）：两张统计卡、一张进度卡先各 3 栏，柱图放不下，独占下一行——撑满；三张卡平分剩下的 3 栏，各 4 栏
ok('独占一行、没写 span 的图撑满这一行（不留半边空白）', JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('progress'), T3('bar')])) === '[4,4,4,12]', v.layoutSpans([T3('stat'), T3('stat'), T3('progress'), T3('bar')]));
ok('一行三张没写 span 的卡：各 4 栏，右边缘对齐（统筹 11-13）', JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('stat')])) === '[4,4,4]');
ok('一行两张卡各 6 栏、四张各 3 栏、五张：四张一行、第五张独占下一行撑满', JSON.stringify(v.layoutSpans([T3('stat'), T3('progress')])) === '[6,6]' && JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('stat'), T3('stat')])) === '[3,3,3,3]' && JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('stat'), T3('stat'), T3('stat')])) === '[3,3,3,3,12]');
ok('写了 span 的卡不动，剩下的平分给没写的：写了 4 栏的一张加两张没写的，没写的各 4 栏', JSON.stringify(v.layoutSpans([T3('stat', 4), T3('stat'), T3('stat')])) === '[4,4,4]');
ok('平分后落不到 4 / 6 / 12 上就不分：两张卡加一张写了 3 栏的卡，余 3 栏不分', JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('stat', 3)])) === '[3,3,3]');
ok('一张卡加一张没写 span 的图：卡 6 栏、图 6 栏', JSON.stringify(v.layoutSpans([T3('stat'), T3('bar')])) === '[6,6]');
ok('平分出来的宽度不在 3 / 4 / 6 / 12 里就不分：一张没写的卡加一张写了 4 栏的块，余 5 栏（3+5=8 栅格认不了），照旧 [3,4]', JSON.stringify(v.layoutSpans([T3('stat'), T3('stat', 4)])) === '[3,4]', v.layoutSpans([T3('stat'), T3('stat', 4)]));
ok('一行放得下的照旧：统计卡两张加一张图正好 12 栏', JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('bar')])) === '[3,3,6]');
ok('写了 span 的照写的来，独占一行也不撑（三张没写的卡照样平分自己那一行）', JSON.stringify(v.layoutSpans([T3('stat'), T3('stat'), T3('progress'), T3('bar', 6)])) === '[4,4,4,6]');
ok('卡全写了 span：照写的，右边留空也不动', JSON.stringify(v.layoutSpans([T3('stat', 3), T3('stat', 3), T3('progress', 3), T3('bar')])) === '[3,3,3,12]');
ok('两张图一行各 6 栏；第三张独占下一行撑满', JSON.stringify(v.layoutSpans([T3('bar'), T3('line'), T3('pie')])) === '[6,6,12]');
ok('表格、筛选栏本来就是 12 栏', JSON.stringify(v.layoutSpans([T3('filter-bar'), T3('table')])) === '[12,12]');
ok('短值列（日期、数字、状态）按最长的值给宽度，日期「2026-01-25」放得下不折行', (v.nowrapWidth('date', '日期', ['2026-01-25', '2026-02-05']) ?? 0) >= 10 * 7.5 + 32 && v.nowrapWidth('number', '用时', ['13']) >= 64 && v.nowrapWidth('status', '结果', ['正常', '异常']) >= 64);
ok('列标题比值长时按标题算（表头也不折行）；中日韩字符按两个单位', v.nowrapWidth('number', '本月应巡检次数', ['9']) > v.nowrapWidth('number', 'n', ['9']));
ok('文本、人、席位列不给宽度（分剩下的、超长省略）；宽度有上限', v.nowrapWidth('text', '名字', ['x']) === undefined && v.nowrapWidth('person', '人', ['x']) === undefined && v.nowrapWidth('seat', '席位', ['x']) === undefined && v.nowrapWidth('number', 'n', ['9'.repeat(200)]) === 240);

console.log('表格的表头');
ok('有说明名用说明名；没有（空、空白、没给）写「第 N 列」，按页面上的次序，不露列名', v.tableHead(col('qty', 'integer', '件数'), 0) === '件数' && v.tableHead(col('qty', 'integer', ''), 2) === '第 3 列' && v.tableHead(col('qty', 'integer', '  '), 0) === '第 1 列' && v.tableHead(col('qty', 'integer'), 1) === '第 2 列');

// 表格组件本身（React，这里不渲染）：表头和列宽都经 tableHead，源码里不再有拿列名兜底的写法（页面上的真实表头由前端的浏览器回归核）
const tableSrc = (await import('node:fs')).readFileSync(new URL('../web/src/bench-blocks/Table.tsx', import.meta.url), 'utf8');
ok('表格组件的表头经 tableHead，没有「label || name」的兜底', /title: head\b/.test(tableSrc) && /const head = tableHead\(c, i\)/.test(tableSrc) && !/label \|\| c\.name/.test(tableSrc));

// 筛选栏的值（连着改两个筛选，第一个不丢）
{
  const F = [{ name: 'month', default: '2026-01' }, { name: 'site' }, { name: 'owner', default: '' }];
  ok('筛选栏的值：视图缺省值打底，人选的盖上去；空值不算', JSON.stringify(v.filterBarValue(F, { site: '北区', owner: '' })) === JSON.stringify({ month: '2026-01', site: '北区' }));
  ok('……人选的月份盖过缺省值', v.filterBarValue(F, { month: '2026-03' }).month === '2026-03');
  // 第一个筛选改完、取数还在路上：上一次取数回来的 params 还是旧的 {}；按人选的算，第二次改动不会冲掉第一个
  const chosenAfterFirst = { site: '北区' };
  const next = { ...v.filterBarValue(F, chosenAfterFirst), owner: '合成甲' };
  ok('连着改两个筛选：第二次改动基于人选的值，第一个还在', next.site === '北区' && next.owner === '合成甲', next);
}

// 记录卡（records，#858）
{
  const srv = await import('../server/src/bench-views.ts');
  const LINKS = ['https://example.com/a?b=1', 'http://x.y', ' https://ok.com ', 'HTTPS://UP.com/p', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', '//evil.example/x', '/rel/path', 'rel/path', 'ftp://x.y', 'https://u:p@h.example/', 'https:///nohost', 'https://', '', null, 5, 'https://ex.com/' + 'a'.repeat(2100)];
  ok('来源链接：页面和服务端用同一套规则（每一种写法两边结果一样）', LINKS.every((x) => JSON.stringify(v.safeLink(x)) === JSON.stringify(srv.safeLink(x))), LINKS.map((x) => [x, v.safeLink(x), srv.safeLink(x)]).filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b)));
  ok('来源链接：只认 http(s) 完整网址，host 只给主机名', JSON.stringify(v.safeLink('https://example.com/a?b=1')) === JSON.stringify({ href: 'https://example.com/a?b=1', host: 'example.com' }));
  ok('来源链接：javascript:、data:、相对地址、协议相对地址（//）、ftp、带账号密码、没主机名都不认', ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.example/x', '/rel/path', 'rel/path', 'ftp://x.y', 'https://u:p@h.example/', 'https:///nohost'].every((x) => v.safeLink(x) === null));
  const XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const data = { columns: [{ name: 't', type: 'text', label: '事项' }, { name: 'st', type: 'text', label: '状态' }, { name: 'who', type: 'text', label: '负责人' }, { name: 'note', type: 'text', label: '说明' }, { name: 'day', type: 'date', label: '约定日期' }, { name: 'url', type: 'text', label: '来源' }, { name: 'url2', type: 'text', label: '资料' }],
    rows: [
      { t: XSS, st: 'open', who: null, note: XSS, day: null, url: 'https://ok.example/doc', url2: 'javascript:alert(3)' },
      { t: '第二件', st: 'weird', who: '合成乙', note: '短', day: '2026-11-21', url: 'https://ok.example/x', url2: null },
    ], truncated: false };
  const spec = { title_col: 't', badges: ['st'], fields: ['who'], details: ['note'], date_col: 'day', links: [{ col: 'url', label: '查看依据' }, { col: 'url2', label: '打开资料' }], value_labels: { st: { open: { text: '进行中', tone: 'warning' } } } };
  const targets = data.rows.map((r) => spec.links.map((l) => srv.safeLink(r[l.col])));
  const cards = v.recordCards(data, spec, targets);
  ok('字段一律当纯文本：带 <script>、<img onerror> 的值原样当文字给出（标题、次要字段都是）', cards[0].title === XSS && cards[0].details[0].text === XSS);
  ok('空值写「—」、空日期写「未填」，不当成完成', cards[0].fields[0].text === '—' && cards[0].fields[0].empty && cards[0].date === '未填' && cards[1].date === '2026-11-21');
  ok('徽标：有说法的照说法和语气；没有说法的照原值、标未定义的取值', cards[0].badges[0].text === '进行中' && cards[0].badges[0].tone === 'warning' && !cards[0].badges[0].undefinedValue && cards[1].badges[0].text === 'weird' && cards[1].badges[0].undefinedValue);
  ok('字段说明名取列的 label', cards[0].fields[0].label === '负责人' && cards[0].details[0].label === '说明');
  ok('来源链接：http(s) 给 href 和主机名；javascript: 标无效；这一行没有的不显示', JSON.stringify(cards[0].links) === JSON.stringify([{ label: '查看依据', href: 'https://ok.example/doc', host: 'ok.example' }, { label: '打开资料', invalid: true }]) && cards[1].links.length === 1);
  const noServer = v.recordCards(data, spec, undefined);
  ok('服务端没给核过的链接：一律当无效，不渲染成链接（两边都认才给）', noServer[0].links.every((l) => l.invalid === true));
  const mismatch = v.recordCards(data, spec, [[{ href: 'https://other.example/', host: 'other.example' }, null], [null]]);
  ok('服务端核出来的地址和页面核出来的不是同一个：当无效', mismatch[0].links[0].invalid === true);
  ok('长文字（超过 120 字或有换行）先收起', v.isLongText('x'.repeat(121)) && v.isLongText('a\nb') && !v.isLongText('短'));
  ok('记录卡缺省占一整行', v.snapSpan(undefined, 'records') === 12);
  const recSrc = (await import('node:fs')).readFileSync(new URL('../web/src/bench-blocks/Records.tsx', import.meta.url), 'utf8');
  ok('记录卡组件不用 innerHTML、链接带 noopener noreferrer 和新窗口、悬停和读屏给主机名', !/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(recSrc) && /rel="noopener noreferrer"/.test(recSrc) && /target="_blank"/.test(recSrc) && /title=\{`打开 \$\{l\.host\}`\}/.test(recSrc) && /aria-label=\{`\$\{l\.label\}（打开 \$\{l\.host\}）`\}/.test(recSrc));
}

console.log('图片列（docs/image-step1.md 用例 9）');
{
  const src = { bench: 'wb-7', view: 'pics', version: 3, params: { month: '2026-01', empty: '' } };
  const u = v.imageSrc('photos/a b&c.png', src);
  const q = new URL(u, 'http://x').searchParams;
  ok('缩略图地址走市场代取路由，带来源视图（台、视图、版本、筛选值）；链接原样编码进 u', u.startsWith('/api/bench-views/wb-7/image?') && q.get('u') === 'photos/a b&c.png' && q.get('view') === 'pics' && q.get('version') === '3' && q.get('p.month') === '2026-01' && !q.has('p.empty'), u);
  ok('台标识也编码（不拼进路径层级）', v.imageSrc('a.png', { bench: 'a/b', view: 'v' }).startsWith('/api/bench-views/a%2Fb/image?'));
  ok('没有来源、没有台或视图、值为空或不是文本：不给地址（不让浏览器直接访问链接）', v.imageSrc('a.png', null) === null && v.imageSrc('a.png', { bench: '', view: 'v' }) === null && v.imageSrc('a.png', { bench: 'b', view: '' }) === null && v.imageSrc('', src) === null && v.imageSrc(null, src) === null && v.imageSrc(7, src) === null);
  ok('版本不是正整数就不带', !new URL(v.imageSrc('a.png', { bench: 'b', view: 'v', version: 0 }), 'http://x').searchParams.has('version') && !new URL(v.imageSrc('a.png', { bench: 'b', view: 'v', version: 1.5 }), 'http://x').searchParams.has('version'));
  ok('image 列的画法是 image；列宽固定、不随链接长短变', v.cellKind(col('p', 'image')) === 'image' && v.nowrapWidth('image', '图片', ['https://example.com/' + 'x'.repeat(300)]) === v.nowrapWidth('image', '图片', ['a.png']) && v.nowrapWidth('image', '图片', []) >= 80);
  const data = { columns: [col('t', 'text', '名'), col('p', 'image', '图片')], rows: [{ t: '甲', p: 'photos/a.png' }, { t: '乙', p: null }] };
  const cards = v.recordCards(data, { title_col: 't', fields: ['p'] });
  ok('记录卡：图片字段带原值（画缩略图），文字不露链接；空的写「—」、不带原值', cards[0].fields[0].image === 'photos/a.png' && cards[0].fields[0].text === '图片' && !cards[0].fields[0].empty && cards[1].fields[0].image === undefined && cards[1].fields[0].text === '—' && cards[1].fields[0].empty, cards.map((c) => c.fields[0]));
  const fsm = await import('node:fs');
  const read = (p) => fsm.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const img = read('../web/src/bench-blocks/BenchImage.tsx');
  ok('缩略图组件：地址只经 imageSrc 拼（不直接用链接当 src）、懒加载、取不到有占位、可点开看原图；没有内联样式和写死的颜色', /imageSrc\(value,/.test(img) && /<Image\s+src=\{src\}/.test(img) && !/src=\{[^}]*value/.test(img) && /loading="lazy"/.test(img) && /onError=/.test(img) && /图片取不到/.test(img) && /preview=/.test(img) && !/style=\{\{/.test(img) && !/#[0-9A-Fa-f]{3,6}\b|rgba?\(/.test(img));
  const css = fsm.readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8');
  const imgCss = css.split('\n').filter((l) => /\.wm-img|\.wm-rec-image/.test(l)).join('\n');
  ok('缩略图尺寸：表格 48px 见方、记录卡 160px 高，object-fit: cover；颜色只用 token', /\.wm-img-cell \{ width: 48px; height: 48px; \}/.test(imgCss) && /\.wm-img-card \{[^}]*height: 160px/.test(imgCss) && /object-fit: cover/.test(imgCss) && !/#[0-9A-Fa-f]{3,6}\b|rgba?\(/.test(imgCss), imgCss);
  const bv = read('../web/src/bench-blocks/BenchView.tsx'), tb = read('../web/src/bench-blocks/Table.tsx'), rc = read('../web/src/bench-blocks/Records.tsx');
  ok('来源视图取这次取数的台、视图、版本、筛选值；表格和记录卡都用缩略图组件', /view: result\.view\.key, version: result\.version, params: result\.params/.test(bv) && /ImageSourceContext\.Provider/.test(bv) && /kind === 'image'\) return <BenchImage/.test(tb) && /<BenchImage value=\{f\.image\} size="card"/.test(rc));
  const page = read('../web/src/pages/BenchPage.tsx'), panel = read('../web/src/components/cockpit/BenchViewPanel.tsx');
  ok('台页面和驾驶舱面板都给了图片的台', /imageBench=\{cardId\}/.test(page) && /imageBench=\{refItem\.bench\}/.test(panel));
}

console.log(`\nbench-blocks-ui-unit: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
