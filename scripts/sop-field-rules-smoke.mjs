#!/usr/bin/env node
/** SOP 字段规则冒烟（纯函数）：从步骤 HTML 抽 required/pattern/长度/类型，完成时核对 run 数据。 */
import { checkMessage, checkRunData, evalCheckExpr, extractFieldRules, parseCheckExpr } from '../server/src/sop-field-rules.ts';
import { renderSopRunner } from '../server/src/sop-runner.ts';
import vm from 'node:vm';

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
ok('月份须在 01–12', v({ scope: { period: '2026-13' } }).some((e) => e.includes('01–12')) && v({ scope: { period: '2026-00' } }).some((e) => e.includes('01–12')) && v({ scope: { period: '2026-12' } }).length === 0);
{
  const dr = extractFieldRules({ title: 'd', steps: [{ key: 's', title: 's', body: '<input data-field="at" data-label="采集日" type="date">' }] });
  const bad = (d) => checkRunData(dr, { s: { at: d } }).some((e) => e.includes('日历上没有'));
  ok('日期按真实日历核', ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2100-02-29'].every(bad), '');
  ok('合法日期与闰日通过', ['2028-02-29', '2000-02-29', '2026-12-31', '2026-01-31'].every((d) => checkRunData(dr, { s: { at: d } }).length === 0));
}
ok('pattern 整体匹配（自定义提示）', v({ scope: { anchor: 'xB0TEST0001' } }).some((e) => e.includes('B0 开头')));
ok('url 须 http(s)', v({ scope: { url: 'ftp://x' } }).some((e) => e.includes('http')));
ok('maxlength', v({ scope: { note: '十一个字十一个字十一个' } }).some((e) => e.includes('最多 10')));
ok('number + min', v({ scope: { price: '-1' } }).some((e) => e.includes('不小于 0')) && v({ scope: { price: 'abc' } }).some((e) => e.includes('数字')));
ok('非必填留空不报', v({ scope: { url: '', note: '', price: '' } }).length === 0);
ok('步骤整体缺失时必填仍报', checkRunData(rules, {}).filter((e) => e.includes('必填')).length === 2);
ok('第二步 pattern', v({ verify: { run: 'run_x' } }).some((e) => e.startsWith('verify.run')));
ok('没有规则的 SOP 永远通过', checkRunData(extractFieldRules({ title: 'x', steps: [{ key: 'a', title: 'a', body: '<input data-field="x">' }] }), {}).length === 0);

// 条件必填 data-required-if：条件成立才必填；不成立只核格式；可跨步；坏写法当作没有条件
const cm = { title: 'c', steps: [
  { key: 'scope', title: '定界', body: `
    <select data-field="task_type"><option value="">—</option><option>单商品研究</option><option>跨任务分类</option></select>
    <input data-field="anchor" data-label="锚 ASIN" pattern="B0[A-Z0-9]{8}" data-required-if="task_type=单商品研究|类目探索">
    <input data-field="product" data-label="商品" required data-required-if="scope.task_type=单商品研究">
    <input data-field="bad" data-required-if="没有等号">` },
  { key: 'deliver', title: '交付', body: `<input data-field="period" data-label="报告期" type="month" data-required-if="scope.task_type=单商品研究">` },
] };
const cr = extractFieldRules(cm);
ok('有条件的字段即使没别的规则也抽出', cr.some((r) => r.field === 'period') && cr.find((r) => r.field === 'anchor')?.requiredIf?.values.join() === '单商品研究,类目探索');
ok('坏写法不算条件（也没别的规则就不抽）', !cr.some((r) => r.field === 'bad'));
const c = (scope, deliver = {}) => checkRunData(cr, { scope, deliver });
ok('条件成立：缺项逐个报必填（含跨步）', (() => { const e = c({ task_type: '单商品研究' }); return ['锚 ASIN', '商品', '报告期'].every((n) => e.some((x) => x.includes(n) && x.includes('必填'))); })());
ok('条件不成立：留空不报（静态 required 让位给条件）', c({ task_type: '跨任务分类' }).length === 0, JSON.stringify(c({ task_type: '跨任务分类' })));
ok('条件不成立：填了仍核格式', c({ task_type: '跨任务分类', anchor: 'x' }).some((e) => e.includes('锚 ASIN')));
ok('条件字段为空：不必填', c({}).length === 0);
ok('条件成立且合规：通过', c({ task_type: '单商品研究', anchor: 'B0TEST0001', product: '支架' }, { period: '2026-09' }).length === 0);

// #437① 文件清单字段：结构校验（行数、file_id、sha256、角色/状态清单）；hash 对文件面的核对在完成时由服务端做
const fm = { title: 'f', steps: [{ key: 'deliver', title: '交付', body: `<textarea data-field="files" data-label="交付文件清单" data-type="file-list" data-roles="交付件|验证报告" data-statuses="有效|作废" data-min-items="1" data-max-items="3" required pattern=".+"></textarea>` }] };
const fr = extractFieldRules(fm);
ok('文件清单字段抽出：类型、角色、状态、行数（pattern 不适用于清单）', fr.length === 1 && fr[0].type === 'file-list' && fr[0].roles?.join() === '交付件,验证报告' && fr[0].statuses?.join() === '有效,作废' && fr[0].minItems === 1 && fr[0].maxItems === 3 && fr[0].pattern === undefined);
const sha = 'a'.repeat(64);
const fc = (files) => checkRunData(fr, { deliver: { files } });
ok('空清单：必填', fc([]).some((e) => e.includes('必填')));
ok('不是数组：报错', fc('abc').some((e) => e.includes('不是文件清单')));
ok('JSON 文本形态也认', fc(JSON.stringify([{ file_id: 1, sha256: sha, role: '交付件', status: '有效' }])).length === 0);
ok('缺 file_id、坏 sha、角色/状态不在清单：逐项报', (() => { const e = fc([{ file_id: 0, sha256: 'x', role: '别的', status: '?' }]); return ['没有选文件', '缺 sha256', '角色须为', '状态须为'].every((k) => e.some((x) => x.includes(k))); })());
ok('超过行数上限：报', fc(Array.from({ length: 4 }, (_, i) => ({ file_id: i + 1, sha256: sha, role: '交付件', status: '有效' }))).some((e) => e.includes('最多 3 行')));
ok('合规：通过', fc([{ file_id: 1, sha256: sha, role: '验证报告', status: '有效' }]).length === 0);

// data-void-statuses：作废行照样核结构，但不计入必填与最少行数
{
  const vr = extractFieldRules({ title: 'v', steps: [{ key: 'v', title: 'v', body: `<textarea data-field="files" data-label="验证文件" data-type="file-list" data-statuses="有效|作废" data-void-statuses="作废" required></textarea><textarea data-field="two" data-label="两件" data-type="file-list" data-statuses="有效|作废" data-void-statuses="作废" data-min-items="2"></textarea>` }] });
  const row = (id, status) => ({ file_id: id, sha256: sha, status });
  const vc = (files, two = [row(8, '有效'), row(9, '有效')]) => checkRunData(vr, { v: { files, two } });
  ok('作废状态抽出', vr[0].voidStatuses?.join() === '作废');
  ok('全是作废行：等于没填', vc([row(1, '作废'), row(2, '作废')]).some((e) => e.includes('验证文件') && e.includes('必填') && e.includes('作废')));
  ok('有一行有效：通过', vc([row(1, '作废'), row(2, '有效')]).length === 0);
  ok('最少行数只数有效行', vc([row(1, '有效')], [row(3, '有效'), row(4, '作废')]).some((e) => e.includes('两件') && e.includes('至少 2 行')));
  ok('作废行照样核结构', vc([row(1, '有效'), { file_id: 0, sha256: 'x', status: '作废' }]).some((e) => e.includes('第 2 行')));
  ok('不写 data-void-statuses 时口径不变', fc([{ file_id: 1, sha256: sha, role: '交付件', status: '作废' }]).length === 0);
}

// #471 字段间数值关系 data-check
{
  const P = (e) => parseCheckExpr(e);
  ok('C1 合法写法都能解析', ['a <= b', 'a+b=c', 'a + b - 1 >= s2.c', '-a < 0', 'a == b', 'a>1.5', ' a  >=  b '].every((e) => P(e)), '');
  ok('C2 写错的表达式返回 null', ['', 'a', 'a <= ', '<= b', 'a <= b <= c', 'a ** b', 'a <= b; alert(1)', 'a(b) = 1', '1 <= 2', 'a <= b'.padEnd(201, ' '), 'a b = c', 'a.b.c = 1', 'a-b-c'].every((e) => P(e) === null), ['', 'a', 'a <= ', '<= b', 'a <= b <= c', 'a ** b', 'a <= b; alert(1)', 'a(b) = 1', '1 <= 2', 'a b = c', 'a.b.c = 1', 'a-b-c'].filter((e) => P(e) !== null).join(' | '));
  const g = (vals) => (step, field) => vals[(step ? step + '.' : '') + field];
  const E = (e, vals) => evalCheckExpr(P(e), g(vals));
  ok('C3 比较五种', E('a <= b', { a: '1', b: '1' }).ok && !E('a < b', { a: '1', b: '1' }).ok && E('a >= b', { a: '2', b: '1' }).ok && !E('a > b', { a: '1', b: '1' }).ok && E('a = b', { a: '3', b: '3' }).ok);
  ok('C4 加减与跨步', E('a + b = s2.c', { a: '40', b: '60', 's2.c': '100' }).ok && !E('a + b = s2.c', { a: '40', b: '61', 's2.c': '100' }).ok && E('a - 1 >= b', { a: '5', b: '4' }).ok && E('-a < 0', { a: '1' }).ok);
  ok('C5 小数相等不受浮点误差影响', E('a + b = c', { a: '0.1', b: '0.2', c: '0.3' }).ok);
  ok('C6 引用为空或不是数字时跳过', E('a <= b', { a: '1', b: '' }) === null && E('a <= b', { a: '1' }) === null && E('a <= b', { a: '1', b: 'abc' }) === null && E('a <= b', { a: 'Infinity', b: '1' }) === null);
  ok('C7 嵌进执行页的三个函数不依赖外部变量', ['parseCheckExpr', 'evalCheckExpr', 'checkMessage'].every((n) => { try { return typeof new Function('return ' + String({ parseCheckExpr, evalCheckExpr, checkMessage }[n]))() === 'function'; } catch { return false; } }));
  ok('C8 默认提示用 label', checkMessage(P('a <= b'), { a: 101, b: 100 }, (st, f) => ({ a: '实际条数', b: '应取条数' })[f]) === '须满足 实际条数 ≤ 应取条数（现为 101 与 100）');

  const km = { title: 'k', steps: [
    { key: 'samples', title: '样本', body: `
      <input data-field="count" data-label="实际条数" type="number" min="0" data-check="count <= target">
      <input data-field="target" data-label="应取条数" type="number" min="1">
      <input data-field="overlap" data-label="交集" type="number" data-check="overlap + only = count" data-check-error="交集＋独有应等于实际条数">
      <input data-field="only" data-label="独有" type="number">
      <input data-field="bad" data-check="bad <= ">
      <textarea data-field="files" data-type="file-list" data-check="files <= 1"></textarea>` },
    { key: 'verify', title: '验证', body: `<input data-field="checked" data-label="已核条数" data-check="checked <= samples.count">` },
  ] };
  const kr = extractFieldRules(km);
  const kv = (samples, verify = {}) => checkRunData(kr, { samples, verify });
  ok('C9 只有带 data-check 也会被抽成规则；写错的表达式不抽', kr.some((r) => r.field === 'checked' && r.check) && !kr.some((r) => r.field === 'bad') && !kr.find((r) => r.field === 'files')?.check);
  ok('C10 合规数据通过', kv({ count: '64', target: '100', overlap: '40', only: '24' }, { checked: '64' }).length === 0, JSON.stringify(kv({ count: '64', target: '100', overlap: '40', only: '24' }, { checked: '64' })));
  ok('C11 违反 ≤ 用默认提示（label）', kv({ count: '101', target: '100' }).some((e) => e === 'samples.实际条数：须满足 实际条数 ≤ 应取条数（现为 101 与 100）'), JSON.stringify(kv({ count: '101', target: '100' })));
  ok('C12 违反和相等用 data-check-error', kv({ count: '64', target: '100', overlap: '40', only: '25' }).includes('samples.交集：交集＋独有应等于实际条数'));
  ok('C13 跨步引用', kv({ count: '64', target: '100' }, { checked: '65' }).some((e) => e.startsWith('verify.已核条数：须满足 已核条数 ≤ 实际条数')));
  ok('C14 自己为空或引用为空都跳过（必填归别的规则）', kv({ count: '', target: '100', overlap: '', only: '' }, { checked: '' }).length === 0 && kv({ count: '64', target: '' }).length === 0);
  ok('C15 不是数字时只报数字格式，不再报关系', JSON.stringify(kv({ count: 'abc', target: '100' })) === JSON.stringify(['samples.实际条数：须为数字']), JSON.stringify(kv({ count: 'abc', target: '100' })));
  const kh = renderSopRunner(km, { id: 1, slug: 'k', title: 'k', kind: 'sop' });
  ok('C16 执行页嵌入同一份函数源码', [parseCheckExpr, evalCheckExpr, checkMessage].every((f) => kh.includes(String(f))));
  ok('C17 执行页条件变化时也重算 data-check 字段', kh.includes("$$('[data-required-if],[data-check]')"));
  // C18：源码里的三个函数带类型标注；嵌进执行页的是 String(fn)，必须是纯 JS，且在独立环境里求值后和模块里的行为一致
  {
    const fns = { parseCheckExpr, evalCheckExpr, checkMessage };
    const leaked = Object.entries(fns).filter(([, f]) => /CheckToken|CheckTerm|string \| null|:\s*(string|number)\b/.test(String(f))).map(([n]) => n);
    ok('C18a 嵌入的源码里没有类型标注', leaked.length === 0, leaked.join());
    const box = vm.runInNewContext(`(function(){ var parseCheckExpr = ${String(parseCheckExpr)}; var evalCheckExpr = ${String(evalCheckExpr)}; var checkMessage = ${String(checkMessage)}; return { parseCheckExpr: parseCheckExpr, evalCheckExpr: evalCheckExpr, checkMessage: checkMessage }; })()`, {});
    const exprs = ['a <= b', 'a+b=c', 'a + b - 1 >= s2.c', '-a < 0', '- - a = 1', 'a == b', 'a>1.5', ' a  >=  b ', 'x1 + 2.25 = y_2', '', 'a', 'a <= ', '<= b', 'a <= b <= c', 'a ** b', 'a <= b; alert(1)', 'a(b) = 1', '1 <= 2', 'a b = c', 'a.b.c = 1', 'a-b-c', 'a <= b'.padEnd(201, ' ')];
    const vals = [{ a: '1', b: '1', c: '2', 's2.c': '1', x1: '3', y_2: '5.25' }, { a: '2', b: '', c: 'abc' }, { a: '0.1', b: '0.2', c: '0.3' }, {}];
    const label = (st, f) => (st ? st + '/' : '') + f.toUpperCase();
    const run = (impl) => JSON.stringify(exprs.map((e) => { const p = impl.parseCheckExpr(e); return [p, p && vals.map((v) => { const r = impl.evalCheckExpr(p, (st, f) => v[(st ? st + '.' : '') + f]); return [r, r && impl.checkMessage(p, r, label)]; })]; }));
    const mine = run(fns), embedded = run(box);
    ok('C18b 嵌入的三个函数在独立环境里和模块行为一致', mine === embedded, embedded.slice(0, 200));
  }
}

// 执行页脚本写在模板字符串里：正则的反斜杠要双写，否则 \s 变成 s，条件必填在浏览器里永远不成立
const runnerHtml = renderSopRunner(cm, { id: 1, slug: 'c', title: 'c', kind: 'sop' });
ok('执行页条件必填正则保留反斜杠', runnerHtml.includes('/^\\s*(?:([A-Za-z0-9_-]+)\\.)?([A-Za-z0-9_-]+)\\s*=([\\s\\S]*)$/'));
ok('执行页文件清单认 data-void-statuses', renderSopRunner(fm, { id: 1, slug: 'f', title: 'f', kind: 'sop' }).includes("getAttribute('data-void-statuses')"));
ok('执行页读清单时非对象行换成空行', renderSopRunner(fm, { id: 1, slug: 'f', title: 'f', kind: 'sop' }).includes("return r && typeof r === 'object' && !Array.isArray(r) ? r : {};"));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
