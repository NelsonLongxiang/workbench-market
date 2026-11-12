#!/usr/bin/env node
/** 驾驶舱骨架的纯函数单测（web/src/cockpit-frame-view.ts）：三栏尺寸的范围、拖分隔条的方向、本机存的尺寸读坏了退回缺省、
 *  放大 / 还原、「看的是」的胶囊、页签落点。 */
import { DEFAULT_SIZES, activeTab, clampSizes, ctxChips, dragSizes, parseSizes, toggleMax } from '../web/src/cockpit-frame-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok('尺寸夹在范围里：左 220–480、右 260–520、下 140–520', eq(clampSizes({ left: 10, right: 9999, bottom: 300 }), { left: 220, right: 520, bottom: 300 }));
ok('不是数字的退回缺省', eq(clampSizes({ left: 'x', right: NaN, bottom: null }), DEFAULT_SIZES) && eq(clampSizes(null), DEFAULT_SIZES));
ok('拖左栏的分隔条：往右变宽、往左变窄', dragSizes(DEFAULT_SIZES, 'left', 50, 0).left === 350 && dragSizes(DEFAULT_SIZES, 'left', -50, 0).left === 250);
ok('拖右栏的分隔条：往右变窄、往左变宽（分隔条在它左边）', dragSizes(DEFAULT_SIZES, 'right', 40, 0).right === 300 && dragSizes(DEFAULT_SIZES, 'right', -40, 0).right === 380);
ok('拖下面一块的分隔条：往下变矮、往上变高；只动自己那一项', dragSizes(DEFAULT_SIZES, 'bottom', 0, 60).bottom === 200 && dragSizes(DEFAULT_SIZES, 'bottom', 999, -60).bottom === 320 && dragSizes(DEFAULT_SIZES, 'bottom', 999, -60).left === 300);
ok('拖过头停在范围边上', dragSizes(DEFAULT_SIZES, 'left', 5000, 0).left === 480 && dragSizes(DEFAULT_SIZES, 'right', 5000, 0).right === 260);
ok('本机存的尺寸：读得出就用（照样夹范围），读坏了、空的退回缺省', eq(parseSizes('{"left":400,"right":300,"bottom":9}'), { left: 400, right: 300, bottom: 140 }) && eq(parseSizes('{bad'), DEFAULT_SIZES) && eq(parseSizes(null), DEFAULT_SIZES) && eq(parseSizes('[]'), DEFAULT_SIZES));
ok('放大 / 还原：点已放大的还原，点别的换成那一块', toggleMax(null, 'board') === 'board' && toggleMax('board', 'board') === null && toggleMax('board', 'items') === 'items');
ok('「看的是」只列有值的，去空白；一个都没有就是空', eq(ctxChips([{ name: 'shop', label: '店铺' }, { name: 'month', label: '月份' }, { name: 'batch', label: '批次' }], { shop: ' 美国站 ', month: '', batch: 7 }), [{ label: '店铺', value: '美国站' }]) && ctxChips([{ name: 'shop', label: '店铺' }], null).length === 0);
ok('页签：选的还在就用它，不在了落到第一个，没有页签为空串', activeTab([{ key: 'a' }, { key: 'b' }], 'b') === 'b' && activeTab([{ key: 'a' }, { key: 'b' }], 'zzz') === 'a' && activeTab([{ key: 'a' }], null) === 'a' && activeTab([], 'a') === '');

console.log(`\ncockpit-frame-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
