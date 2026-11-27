#!/usr/bin/env node
/** #1085 + #1095 数字显示格式（server/src/value-format.ts）：报告 $format / 统计卡 format 与数据视图列 format 共用的一个实现。数据都是合成的。 */
import { columnNumberSpec, formatNumber, plainNumber, reportNumberSpec } from '../server/src/value-format.ts';
import { cellText, fmtColumnNumber, mainColumns, recordCards } from '../web/src/bench-blocks/blocks-view.ts';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const rep = (o) => reportNumberSpec(o, (k) => Object.prototype.hasOwnProperty.call(o, k));
const R = (o, v) => { const s = rep(o); return s.ok ? formatNumber(v, s.spec) : s.error; };
const C = (f, v) => { const s = columnNumberSpec(f); return s.ok ? formatNumber(v, s.spec) : s.error; };
console.log('一、报告的写法');
ok('不写小数位和以前一样（Intl 默认）：0.2110 percent 是 21%，1234.5 number 是 1,234.5，CNY 是 ¥1,234.50', R({ style: 'percent' }, 0.211) === new Intl.NumberFormat('zh-CN', { style: 'percent' }).format(0.211) && R({ style: 'percent' }, 0.211) === '21%'
  && R({ style: 'number' }, 1234.5) === '1,234.5' && R({ style: 'currency' }, 1234.5) === new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(1234.5));
ok('0.2110 配 percent、两位小数：21.10%', R({ style: 'percent', minimum_fraction_digits: 2, maximum_fraction_digits: 2 }, 0.211) === '21.10%', R({ style: 'percent', minimum_fraction_digits: 2, maximum_fraction_digits: 2 }, 0.211));
ok('金额配 currency USD、两位小数：和 Intl 同样写法', R({ style: 'currency', currency: 'USD', minimum_fraction_digits: 2, maximum_fraction_digits: 2 }, 1234.5) === new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5));
ok('小数位越界、不是整数、前大于后：invalid_format', ['x', -1, 7, 1.5].every((d) => R({ style: 'number', maximum_fraction_digits: d }, 1) === 'invalid_format') && R({ style: 'number', minimum_fraction_digits: 3, maximum_fraction_digits: 2 }, 1) === 'invalid_format');
ok('不认识的 style、坏 locale、不是 currency 却写了 currency：invalid_format', R({ style: 'date' }, 1) === 'invalid_format' && R({ style: 'number', locale: '!!' }, 1) === 'invalid_format' && R({ style: 'number', currency: 'USD' }, 1) === 'invalid_format' && R({ style: 'currency', currency: 'usd' }, 1) === 'invalid_format');
console.log('二、数据视图列的写法');
ok('decimals 固定位数、补零：1.5 → 1.50，3 → 3.00，6.175 → 6.18（四舍五入）', C({ decimals: 2 }, 1.5) === '1.50' && C({ decimals: 2 }, 3) === '3.00' && C({ decimals: 2 }, 6.175) === new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(6.175));
ok('percent：0.15 两位小数是 15.00%；不写 decimals 是 15%', C({ percent: true, decimals: 2 }, 0.15) === '15.00%' && C({ percent: true }, 0.15) === '15%');
ok('千分位缺省是：1234567.8 → 1,234,567.80；thousands:false → 1234567.80', C({ decimals: 2 }, 1234567.8) === '1,234,567.80' && C({ decimals: 2, thousands: false }, 1234567.8) === '1234567.80');
ok('unit 万：7000 两位小数是 0.70万，171000 是 17.10万；亿 按 1e8', C({ unit: '万', decimals: 2 }, 7000) === '0.70万' && C({ unit: '万', decimals: 2 }, 171000) === '17.10万' && C({ unit: '亿', decimals: 1 }, 250000000) === '2.5亿');
ok('currency：CNY 两位小数和 Intl 同样写法', C({ currency: 'CNY', decimals: 2 }, 2.4) === new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(2.4));
ok('负数照写，null / NaN / Infinity / 文本回 null（调用方写「-」）', C({ decimals: 2 }, -1.5) === '-1.50' && [null, NaN, Infinity, '1.5', undefined].every((v) => C({ decimals: 2 }, v) === null));
ok('不合格的 format 给中文说法：不认识的键、decimals 越界、percent 与 unit 同写、unit 不认识、currency 小写', [{ x: 1 }, { decimals: 9 }, { percent: true, unit: '万' }, { unit: '千万' }, { currency: 'cny' }, { thousands: 'y' }, [], null].every((f) => { const s = columnNumberSpec(f); return !s.ok && /[\u4e00-\u9fa5]/.test(s.error); }));
console.log('三、没配格式的数');
ok('原样：不截断、不补零，整数部分加千分位', plainNumber(1234567.891) === '1,234,567.891' && plainNumber(1.5) === '1.5' && plainNumber(3) === '3' && plainNumber(-0.25) === '-0.25' && plainNumber(0.1 + 0.2) === '0.30000000000000004');
ok('很大很小的数写科学记数；null / NaN 回 null', plainNumber(1e21) === '1e+21' && plainNumber(1e-7) === '1e-7' && plainNumber(null) === null && plainNumber(NaN) === null);
console.log('四、数据视图的块怎么用');
const AMT = { name: 'amount', type: 'decimal', label: '金额', format: { decimals: 2, unit: '万' } };
ok('列配了 format：按它写（表格的格子、统计卡同一个函数）；没配原样写；配得不对回落原样；不是数写「-」', fmtColumnNumber(7000, AMT) === '0.70万' && cellText(171000, 'number', AMT) === '17.10万'
  && fmtColumnNumber(1.5, { name: 'x' }) === '1.5' && fmtColumnNumber(1.5, { format: { decimals: 99 } }) === '1.5' && fmtColumnNumber(null, AMT) === '-' && cellText(null, 'number', AMT) === '-');
ok('没有 format 时小数列按 scale 补位，显式 format 优先', fmtColumnNumber(1.5, { scale: 2 }) === '1.50' && fmtColumnNumber(1.5, { scale: 2, format: { decimals: 1 } }) === '1.5');
ok('主表不放只在行详情里显示的列', JSON.stringify(mainColumns([{ name: 'a' }, { name: 'raw', detail_only: true }, { name: 'b', detail_only: false }]).map((c) => c.name)) === JSON.stringify(['a', 'b']));
const cards = recordCards({ columns: [{ name: 't', type: 'text' }, AMT, { name: 'raw', type: 'text', detail_only: true }], rows: [{ t: '合成', amount: 7000, raw: '7000.000000001' }] }, { title_col: 't', fields: ['amount', 'raw'], details: [] });
ok('记录卡：数按列的格式写；写在 fields 里的只在详情列挪到展开后的详情里', cards[0].fields.map((f) => f.name + '=' + f.text).join() === 'amount=0.70万' && cards[0].details.map((f) => f.name + '=' + f.text).join() === 'raw=7000.000000001', JSON.stringify(cards[0]));
console.log(`\nvalue-format-unit: ${pass} 过 / ${fail} 败`); process.exit(fail ? 1 : 0);
