#!/usr/bin/env node
/** 视图台页面（/use/<卡片 id>）的纯函数单测（web/src/bench-page-view.ts）：入口应答怎么走、地址里的视图和筛选、表单没交上去时说什么。数据都是合成的。 */
import { ENTRY_TEXT, asEntry, entryOutcome, formError, pageTitle, paramsFromQuery, toQuery, viewFromQuery } from '../web/src/bench-page-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

const E = { bench: { slug: 'synth-wb', title: '合成台', workbench_id: 7 }, version: 3, title: '合成看板', default_view: 'board', views: [{ key: 'board', title: '看板' }, { key: 'rows', title: '明细' }] };

// 入口
ok('200 且形状对：进视图台页面', entryOutcome(200, E).kind === 'bench' && entryOutcome(200, E).entry.title === '合成看板');
ok('404：照原来打开卡片（不管 error 写的是什么）', entryOutcome(404, { error: 'bench_not_found' }).kind === 'card' && entryOutcome(404, null).kind === 'card' && entryOutcome(404, { error: 'bench_views_off' }).kind === 'card');
ok('401 去登录；403 要用自己的账号；5xx、断网读不到', entryOutcome(401, {}).kind === 'login' && entryOutcome(403, {}).kind === 'forbidden' && entryOutcome(500, {}).kind === 'error' && entryOutcome(0, null).kind === 'error' && entryOutcome(503, null).kind === 'error');
ok('200 但形状不对（没有视图、键重复、台名缺）：当读不到，不猜', entryOutcome(200, { ...E, views: [] }).kind === 'error' && entryOutcome(200, { ...E, views: [{ key: 'a', title: 'A' }, { key: 'a', title: 'B' }] }).kind === 'error' && entryOutcome(200, { ...E, bench: {} }).kind === 'error' && entryOutcome(200, null).kind === 'error');
ok('默认视图不在清单里：用第一份；标题缺了用台名', asEntry({ ...E, default_view: 'gone', title: '' }).default_view === 'board' && asEntry({ ...E, title: '' }).title === '合成台');

// 地址
const Q = (s) => new URLSearchParams(s);
ok('地址里的视图：认得的照用，认不出、没写的用默认', viewFromQuery(E, Q('v=rows')) === 'rows' && viewFromQuery(E, Q('v=nope')) === 'board' && viewFromQuery(E, Q('')) === 'board');
ok('地址里的筛选：只收 p.<字段>，空值不算', J(paramsFromQuery(Q('v=rows&p.month=2026-11&p.site=&x=1&p.=y'))) === '{"month":"2026-11"}');
ok('写回地址：默认视图不写 v，筛选空值不写', toQuery(E, 'board', {}) === '' && toQuery(E, 'rows', { month: '2026-11', site: '' }) === '?v=rows&p.month=2026-11');
ok('写回再读回来是同一份（链接发给别人看到的一样）', (() => { const s = toQuery(E, 'rows', { month: '2026-11', 区域: '东 区' }); const q = Q(s.slice(1)); return viewFromQuery(E, q) === 'rows' && J(paramsFromQuery(q)) === J({ month: '2026-11', 区域: '东 区' }); })());
ok('标签页标题：视图标题和台名不同时带台名', pageTitle(E) === '合成看板 · 合成台' && pageTitle({ ...E, title: '合成台' }) === '合成台');

// 表单
ok('版本变了（409）：表单说页面过期', formError(409, { error: 'conflict', message: 'x' }).code === 'conflict');
ok('服务端说填得不对：原样带它的原因', J(formError(400, { error: 'invalid', message: '「件数」要是整数' })) === J({ code: 'invalid', message: '「件数」要是整数' }));
ok('没登录、不让交、断网、别的：各一句人话', formError(401, null).message === '请先登录' && formError(403, { error: 'forbidden' }).message === '你的账号不能在这个台上填表' && formError(0, null).message.includes('连不上') && formError(500, { error: 'internal', message: 'SQLITE_BUSY' }).message === '这次没交上去，稍后再试');
ok('说法里没有开发用语、不露代号', [...Object.values(ENTRY_TEXT), ...[401, 403, 0, 500, 413].map((s) => formError(s, { error: 'limit', message: 'raw' }).message)].every((t) => !/接口|字段|slug|bench|error|SQLITE|raw/i.test(t)));

console.log(`\nbench-page-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
