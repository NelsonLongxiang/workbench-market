#!/usr/bin/env node
/** 驾驶舱骨架的纯函数单测（web/src/cockpit-frame-view.ts）：三栏尺寸的范围、拖分隔条的方向、本机存的尺寸读坏了退回缺省、
 *  放大 / 还原、「看的是」的胶囊、页签落点。 */
import { benchViewError, benchViewRefs, benchViewUrl, isBenchViewPanel, mainTabKeys, refsOfTab, DEFAULT_SIZES, activeTab, clampSizes, ctxChips, dragSizes, parseSizes, toggleMax } from '../web/src/cockpit-frame-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok('尺寸夹在范围里：左 220–480、右 260–520、下 140–520', eq(clampSizes({ left: 10, right: 9999, bottom: 300 }), { left: 220, right: 520, bottom: 300 }));
ok('不是数字的退回缺省', eq(clampSizes({ left: 'x', right: NaN, bottom: null }), DEFAULT_SIZES) && eq(clampSizes(null), DEFAULT_SIZES));
ok('拖左栏的分隔条：往右变宽、往左变窄', dragSizes(DEFAULT_SIZES, 'left', 50, 0).left === 350 && dragSizes(DEFAULT_SIZES, 'left', -50, 0).left === 250);
ok('拖右栏的分隔条：往右变窄、往左变宽（分隔条在它左边）', dragSizes(DEFAULT_SIZES, 'right', 40, 0).right === DEFAULT_SIZES.right - 40 && dragSizes(DEFAULT_SIZES, 'right', -40, 0).right === DEFAULT_SIZES.right + 40);
ok('缺省宽度：左 280、右 300，剩下的归中间（1440 下中间 554）', DEFAULT_SIZES.left === 280 && DEFAULT_SIZES.right === 300);
ok('拖下面一块的分隔条：往下变矮、往上变高；只动自己那一项', dragSizes(DEFAULT_SIZES, 'bottom', 0, 60).bottom === 200 && dragSizes(DEFAULT_SIZES, 'bottom', 999, -60).bottom === 320 && dragSizes(DEFAULT_SIZES, 'bottom', 999, -60).left === 300);
ok('拖过头停在范围边上', dragSizes(DEFAULT_SIZES, 'left', 5000, 0).left === 480 && dragSizes(DEFAULT_SIZES, 'right', 5000, 0).right === 260);
ok('本机存的尺寸：读得出就用（照样夹范围），读坏了、空的退回缺省', eq(parseSizes('{"left":400,"right":300,"bottom":9}'), { left: 400, right: 300, bottom: 140 }) && eq(parseSizes('{bad'), DEFAULT_SIZES) && eq(parseSizes(null), DEFAULT_SIZES) && eq(parseSizes('[]'), DEFAULT_SIZES));
ok('放大 / 还原：点已放大的还原，点别的换成那一块', toggleMax(null, 'board') === 'board' && toggleMax('board', 'board') === null && toggleMax('board', 'items') === 'items');
ok('「看的是」只列有值的，去空白；一个都没有就是空', eq(ctxChips([{ name: 'shop', label: '店铺' }, { name: 'month', label: '月份' }, { name: 'batch', label: '批次' }], { shop: ' 美国站 ', month: '', batch: 7 }), [{ label: '店铺', value: '美国站' }]) && ctxChips([{ name: 'shop', label: '店铺' }], null).length === 0);
ok('页签：选的还在就用它，不在了落到第一个，没有页签为空串', activeTab([{ key: 'a' }, { key: 'b' }], 'b') === 'b' && activeTab([{ key: 'a' }, { key: 'b' }], 'zzz') === 'a' && activeTab([{ key: 'a' }], null) === 'a' && activeTab([], 'a') === '');

// 驾驶舱里对数据视图的引用（只存引用，取数走台的视图入口）
const panels = [
  { i: 'wb-1', workbenchId: 1, x: 0, y: 0, w: 6, h: 8 },
  { i: 'bv-a', kind: 'bench-view', bench: 'profit-desk', view: 'kpi', tab: 'board', order: 2 },
  { kind: 'bench-view', bench: 'profit-desk', view: 'trend', tab: 'board', order: 1 },
  { kind: 'bench-view', bench: 'profit-desk', view: 'rows', tab: 'detail', order: 0 },
  { kind: 'bench-view', bench: 'Bad Slug', view: 'x', tab: 'board', order: 0 },
  { kind: 'bench-view', bench: 'ok', view: '', tab: 'board', order: 0 },
  { kind: 'bench-view', bench: 'ok', view: 'Bad Key', tab: 'board', order: 0 },
  { i: 'bv-ok-saved', workbenchId: 0, kind: 'bench-view', bench: 'ok2', view: 'saved', tab: 'detail', order: 5, x: 0, y: 0, w: 6, h: 10 },
  { kind: 'bench-view', bench: 'ok', view: 'x', tab: 'elsewhere', order: 0 },
  null, 'x',
];
const refs = benchViewRefs(panels);
ok('引用：只认写法对的（台是 slug、视图非空、页签是 board / detail）；没给 i 的补一个', refs.length === 4 && refs[1].i === 'bv-profit-desk-trend' && refs[3].i === 'bv-ok-saved' && benchViewRefs(null).length === 0);
ok('面板栅格不画数据视图的引用；别的面板照旧', isBenchViewPanel(panels[1]) && !isBenchViewPanel(panels[0]) && !isBenchViewPanel(null));
ok('一个页签上的引用按次序排', refsOfTab(refs, 'board').map((r) => r.view).join() === 'trend,kpi' && refsOfTab(refs, 'detail').map((r) => r.view).join() === 'rows,saved');
ok('中间的页签：配了数据视图才有看板、明细，排在前面；有面板才有工作台', mainTabKeys(refs, 1).join() === 'board,detail,benches' && mainTabKeys(refs, 0).join() === 'board,detail' && mainTabKeys(refs.filter((r) => r.tab === 'detail'), 2).join() === 'detail,benches');
ok('没配数据视图：只有工作台，看板不出空壳；一个面板都没有也留工作台（放空状态）', mainTabKeys([], 2).join() === 'benches' && mainTabKeys([], 0).join() === 'benches');
ok('取数地址：台、视图、筛选值（空的不带，名字前加 p.）', benchViewUrl({ bench: 'profit-desk', view: 'kpi' }, { month: '2026-11', shop: '' }) === '/api/bench-views/profit-desk/render?view=kpi&p.month=2026-11');
ok('整份没取到的说法：403 一律看不到；没开放和视图不在了分开说', benchViewError(403, 'bench_views_forbidden') === '你看不到这个台的数据' && benchViewError(403, 'bench_views_admin_token_denied') === '你看不到这个台的数据' && benchViewError(404, 'bench_views_off') === '数据视图还没开放' && benchViewError(404, 'not_found') === '这份视图不在了' && benchViewError(404, 'bench_not_found') === '这份视图不在了');
ok('整份没取到的说法：没登录、超时、太忙、断网、其他', benchViewError(401) === '请先登录' && benchViewError(504, 'timeout').includes('太慢') && benchViewError(503, 'busy').includes('太多') && benchViewError(0) === '连不上服务器' && benchViewError(500, 'internal').includes('读不到'));

console.log(`\ncockpit-frame-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
