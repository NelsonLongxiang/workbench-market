#!/usr/bin/env node
/** 生命周期全景纯显示逻辑单测（web/src/pages/lifecycle-view.ts，node 直接剥类型运行）：
 *  fmt 对非字符串不抛错；防篡改徽标按 链不一致 → 锚点对不上 → 全覆盖 → 部分覆盖 → 未防篡改 判定；
 *  covered_through 是行号；anchor_ok/anchor_failures 缺省（lc 未升级）时退回原显示。 */
const { fmt, ledgerBadge } = await import('../web/src/pages/lifecycle-view.ts');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); } };
const base = { rows: 132, chain_consistent: true, anchored: false, tamper_evident: false, covered_through: null, unanchored_rows: 132 };
const t = (o, ledger = 'main') => ledgerBadge({ ...base, ...o }, ledger);

ok('fmt(132) 不抛错，原样转字符串', (() => { try { return fmt(132) === '132'; } catch { return false; } })());
ok('fmt(null/undefined/空串) → —', fmt(null) === '—' && fmt(undefined) === '—' && fmt('') === '—');
ok('fmt 带时区时间只截到分钟、不换算', fmt('2026-12-18T18:00:00+08:00') === '2026-12-18 18:00');

let b = t({ anchored: true, tamper_evident: true, covered_through: 132, unanchored_rows: 0, anchor_ok: true, anchor_failures: 0 });
ok('全覆盖：绿色，提示「锚点覆盖到第 132 行」与本地锚点口径', b.color === 'success' && /第 132 行/.test(b.tip) && /main\.jsonl/.test(b.tip) && /已推送/.test(b.tip), JSON.stringify(b));
b = t({ anchored: true, tamper_evident: true, covered_through: 120, unanchored_rows: 12 });
ok('部分覆盖（无 anchor_ok 字段）：黄色「最近 12 行未受保护」', b.color === 'warning' && /最近 12 行未受保护/.test(b.text) && /第 120 行/.test(b.tip), JSON.stringify(b));
b = t({ anchored: true, tamper_evident: false, covered_through: null, unanchored_rows: 132, anchor_ok: false, anchor_failures: 1 });
ok('锚点对不上：红色「锚点对不上 · 1 行」，提示 lc ledger --anchor', b.color === 'error' && b.text === '锚点对不上 · 1 行' && /lc ledger --anchor/.test(b.tip) && /main\.jsonl/.test(b.tip), JSON.stringify(b));
b = t({ chain_consistent: false, anchor_ok: false, anchor_failures: 3 });
ok('链不一致优先于锚点对不上', b.color === 'error' && b.text === '账本链不一致', JSON.stringify(b));
b = t({ anchored: true, tamper_evident: false, covered_through: null, unanchored_rows: 132 });
ok('lc 未升级（anchor_ok 缺省）且锚点对不上：退回黄色未防篡改，不报错', b.color === 'warning' && /未防篡改/.test(b.text), JSON.stringify(b));
b = t({ anchor_ok: null, anchor_failures: 0 }, null);
ok('没带锚点：黄色未防篡改，提示「账本尚未外部锚定」', b.color === 'warning' && /尚未外部锚定/.test(b.tip) && !/jsonl/.test(b.tip), JSON.stringify(b));

console.log(`lifecycle-view-unit: ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
