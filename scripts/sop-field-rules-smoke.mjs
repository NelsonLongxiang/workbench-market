#!/usr/bin/env node
/** SOP 字段规则冒烟（纯函数）：从步骤 HTML 抽 required/pattern/长度/类型，完成时核对 run 数据。 */
import { checkRunData, extractFieldRules } from '../server/src/sop-field-rules.ts';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };

const manifest = { title: 't', steps: [
  { key: 'scope', title: '定界', body: `
    <input data-field="period" data-label="报告期" type="month" required>
    <input data-field="anchor" data-label="锚 ASIN" pattern="B0[A-Z0-9]{8}" data-error="ASIN 应为 B0 开头的 10 位" required>
    <input data-field="url" type="url">
    <textarea data-field="note" maxlength="10"></textarea>
    <input data-field="price" type="number" min="0">
    <input data-field="free">` },
  { key: 'verify', title: '验证', body: `<input data-field='run' pattern='run_[0-9a-f]{16}'><select data-field="gate"><option>申报</option></select>` },
] };
const rules = extractFieldRules(manifest);
ok('只抽有规则的字段（free、gate 不算）', rules.map((r) => r.field).join() === 'period,anchor,url,note,price,run', rules.map((r) => r.field).join());
ok('单引号属性与 data-label/data-error 读出', rules.find((r) => r.field === 'run')?.pattern === 'run_[0-9a-f]{16}' && rules.find((r) => r.field === 'anchor')?.message?.startsWith('ASIN'));

const good = { scope: { period: '2026-09', anchor: 'B0TEST0001', url: 'https://example.com/a', note: '短', price: '1980' }, verify: { run: 'run_0123456789abcdef' } };
ok('合规数据通过', checkRunData(rules, good).length === 0, JSON.stringify(checkRunData(rules, good)));
const v = (patch) => checkRunData(rules, { scope: { ...good.scope, ...patch.scope }, verify: { ...good.verify, ...patch.verify } });
ok('必填缺失', v({ scope: { period: '' } }).some((e) => e.includes('报告期') && e.includes('必填')));
ok('月份格式', v({ scope: { period: '2026/09' } }).some((e) => e.includes('YYYY-MM')));
ok('pattern 整体匹配（自定义提示）', v({ scope: { anchor: 'xB0TEST0001' } }).some((e) => e.includes('B0 开头')));
ok('url 须 http(s)', v({ scope: { url: 'ftp://x' } }).some((e) => e.includes('http')));
ok('maxlength', v({ scope: { note: '十一个字十一个字十一个' } }).some((e) => e.includes('最多 10')));
ok('number + min', v({ scope: { price: '-1' } }).some((e) => e.includes('不小于 0')) && v({ scope: { price: 'abc' } }).some((e) => e.includes('数字')));
ok('非必填留空不报', v({ scope: { url: '', note: '', price: '' } }).length === 0);
ok('步骤整体缺失时必填仍报', checkRunData(rules, {}).filter((e) => e.includes('必填')).length === 2);
ok('第二步 pattern', v({ verify: { run: 'run_x' } }).some((e) => e.startsWith('verify.run')));
ok('没有规则的 SOP 永远通过', checkRunData(extractFieldRules({ title: 'x', steps: [{ key: 'a', title: 'a', body: '<input data-field="x">' }] }), {}).length === 0);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
