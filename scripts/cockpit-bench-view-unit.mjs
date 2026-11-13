#!/usr/bin/env node
/** 驾驶舱里「数据视图」这一部分的纯函数单测（web/src/cockpit-bench-view.ts）：共用的筛选怎么合、按名字传值、
 *  把视图挂进驾驶舱时面板清单怎么变（别的面板原样留着）、选台选视图取不到时的几种说法、小标题。 */
import { ANON_VIEW, NO_BENCH, rowName, nextChosen, shownParams, MAX_VIEW_PANELS, addRef, benchListState, filtersOf, mergeFilters, moveRef, orderedRefs, panelHeading, paramsFor, pruneParams, removeRef, retabRef, viewChoices } from '../web/src/cockpit-bench-view.ts';
import { benchViewRefs as P } from '../web/src/cockpit-frame-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// —— 共用的筛选 ——
const fa = filtersOf({ filters: [{ name: 'month', kind: 'month', label: '月份' }, { name: 'region', kind: 'select', label: '区域', options: ['东区', '南区'] }, { name: '', kind: 'month' }, { name: 'x', kind: 'weird' }, null, 'nope'] });
ok('取数应答里的筛选项：只留有名字、种类认识的；选项原样带着', eq(fa.map((f) => f.name), ['month', 'region']) && eq(fa[1].options, ['东区', '南区']) && eq(filtersOf(null), []) && eq(filtersOf({ filters: 'x' }), []));
const fb = filtersOf({ filters: [{ name: 'q', kind: 'search' }, { name: 'month', kind: 'month', label: '账期' }] });
const merged = mergeFilters([fa, fb, []]);
ok('几份视图的筛选项按名字合成一排：同名只留一个，先出现的那份说了算，次序照视图的次序', eq(merged.map((f) => `${f.name}:${f.label ?? ''}`), ['month:月份', 'region:区域', 'q:']));
ok('一份都不认筛选项：那一排是空的', eq(mergeFilters([[], []]), []));
const value = { month: '2026-01', region: '', q: '泵', other: 'x' };
ok('按名字传值：只带这份视图认的、非空的', eq(paramsFor(fa, value), { month: '2026-01' }) && eq(paramsFor(fb, value), { q: '泵', month: '2026-01' }) && eq(paramsFor([], value), {}));
ok('没有视图认的名字、空值，从共用的值里去掉', eq(pruneParams(merged, value), { month: '2026-01', q: '泵' }));

const fc = filtersOf({ blocks: [{ type: 'stat' }, { type: 'filter-bar', fields: [{ name: 'region', kind: 'select', options: ['东区'] }] }], filters: [{ name: 'region', kind: 'select', label: '区域' }, { name: 'month', kind: 'month', label: '月份' }] });
ok('筛选项先从筛选栏块里取（带选项），块里没有的从 filters 补，同名不重复', eq(fc, [{ name: 'region', kind: 'select', options: ['东区'] }, { name: 'month', kind: 'month', label: '月份' }]));
ok('那一排显示的值：各份视图生效的值（缺省值在里面），同名先出现的说了算，人选的盖在上面', eq(shownParams([{ month: '2026-02', a: '' }, { month: '2026-01', q: 'x' }], { q: 'y' }), { month: '2026-02', q: 'y' }) && eq(shownParams([], {}), {}));

// 页签里每一轮：显示的值 = 各份生效的值 + 人选的；传给每份的 = 显示的值里它认的。连着算几轮要停得住（不能来回变）
{
  const views = [{ f: fa, def: { month: '2026-01' } }, { f: fb, def: {} }];
  let eff = views.map((v) => v.def), sent = [], rounds = 0;
  for (; rounds < 6; rounds++) {
    const shown = shownParams(eff, {});
    const next = views.map((v) => paramsFor(v.f, shown));
    if (eq(next, sent)) break;
    sent = next; eff = views.map((v, n) => ({ ...v.def, ...next[n] }));
  }
  ok('一份视图的缺省值传给别的同名筛选项之后就稳住：两轮之内不再变，第二份照 2026-01 筛', rounds <= 2 && eq(sent, [{ month: '2026-01' }, { month: '2026-01' }]), { rounds, sent });
}

ok('在一个页签上改了值：这个页签认的名字照新值、清空的去掉；别的页签认的名字原样留着', eq(nextChosen({ region: '北区', month: '2026-01', q: '泵' }, fb, { month: '2026-02' }), { region: '北区', month: '2026-02' })
  && eq(nextChosen({}, fa, { month: '2026-02', stray: 'x' }), { month: '2026-02' }));

// —— 把视图挂进驾驶舱 ——
const wb = { i: 'wb-3', workbenchId: 3, x: 0, y: 0, w: 6, h: 10 };
const tasks = { i: 'tasks', workbenchId: 0, kind: 'tasks', x: 6, y: 0, w: 6, h: 12 };
let panels = [wb, tasks];
let r = addRef(P, panels, { bench: 'sales', view: 'main', tab: 'board' });
ok('加第一份：别的面板原样在前，引用带着 i、kind、台、视图、页签、次序 0', r.ok && eq(r.panels, [wb, tasks, { i: 'bv-sales-main', kind: 'bench-view', bench: 'sales', view: 'main', tab: 'board', order: 0 }]));
panels = r.panels;
panels = addRef(P, panels, { bench: 'sales', view: 'rows', tab: 'detail' }).panels;
panels = addRef(P, panels, { bench: 'ops', view: 'kpi', tab: 'board' }).panels;
panels = addRef(P, panels, { bench: 'ops', view: 'trend', tab: 'board' }).panels;
const ids = (p) => orderedRefs(P, p).map((x) => `${x.tab}:${x.i}:${x.order}`);
ok('再加三份：各自排在所选页签的最后，次序按页签从 0 数', eq(ids(panels), ['board:bv-sales-main:0', 'board:bv-ops-kpi:1', 'board:bv-ops-trend:2', 'detail:bv-sales-rows:0']));
r = addRef(P, panels, { bench: 'sales', view: 'main', tab: 'detail' });
ok('同一份视图不能放两次（换个页签也不行）', r.ok === false && /已经在/.test(r.reason));
ok('往后挪一位、往前挪一位；到头到尾不动', eq(ids(moveRef(P, panels, 'bv-sales-main', 1)), ['board:bv-ops-kpi:0', 'board:bv-sales-main:1', 'board:bv-ops-trend:2', 'detail:bv-sales-rows:0'])
  && eq(ids(moveRef(P, panels, 'bv-ops-trend', -1)), ['board:bv-sales-main:0', 'board:bv-ops-trend:1', 'board:bv-ops-kpi:2', 'detail:bv-sales-rows:0'])
  && eq(ids(moveRef(P, panels, 'bv-sales-main', -1)), ids(panels)) && eq(ids(moveRef(P, panels, 'bv-ops-trend', 1)), ids(panels)) && eq(ids(moveRef(P, panels, 'no-such', 1)), ids(panels)));
ok('换页签：挪到另一个页签的最后，两边的次序都重排', eq(ids(retabRef(P, panels, 'bv-ops-kpi', 'detail')), ['board:bv-sales-main:0', 'board:bv-ops-trend:1', 'detail:bv-sales-rows:0', 'detail:bv-ops-kpi:1']) && eq(ids(retabRef(P, panels, 'bv-ops-kpi', 'board')), ids(panels)));
const removed = removeRef(P, panels, 'bv-ops-kpi');
ok('移除一份：剩下的次序补齐；别的面板还在、还在前面', eq(ids(removed), ['board:bv-sales-main:0', 'board:bv-ops-trend:1', 'detail:bv-sales-rows:0']) && eq(removed.slice(0, 2), [wb, tasks]));
ok('每一步之后别的面板都原样留着', [moveRef(P, panels, 'bv-sales-main', 1), retabRef(P, panels, 'bv-ops-kpi', 'detail'), removeRef(P, panels, 'no-such')].every((p) => eq(p.filter((x) => x.kind !== 'bench-view'), [wb, tasks])));
let many = [wb];
for (let n = 0; n < MAX_VIEW_PANELS; n++) many = addRef(P, many, { bench: 'b', view: `v${n}`, tab: n % 2 ? 'detail' : 'board' }).panels;
r = addRef(P, many, { bench: 'b', view: 'one-more', tab: 'board' });
ok(`到上限（${MAX_VIEW_PANELS} 份）再加：不让加，说明上限`, orderedRefs(P, many).length === MAX_VIEW_PANELS && r.ok === false && r.reason.includes(String(MAX_VIEW_PANELS)));
ok('清单里写法不对的引用（台标识、视图键、页签不对）不算数，重排时不带回去', eq(ids(removeRef(P, [wb, { kind: 'bench-view', bench: 'Bad Slug', view: 'x', tab: 'board', order: 0 }, { kind: 'bench-view', bench: 'ok', view: 'v', tab: 'elsewhere', order: 0 }, { kind: 'bench-view', bench: 'ok', view: 'v', tab: 'board', order: 5 }], 'no-such')), ['board:bv-ok-v:0']));
ok('面板清单不是数组：当成空的', eq(orderedRefs(P, null), []) && addRef(P, undefined, { bench: 'a', view: 'v', tab: 'board' }).ok === true);

// —— 选台、选视图 ——
let s = benchListState(200, { benches: [{ slug: 'sales', title: '销售台' }, { slug: 'ops', title: '' }, { title: '没标识' }, null] });
ok('台的清单：有名字用名字，没有用标识；没标识的不要', s.kind === 'ok' && eq(s.benches, [{ slug: 'sales', title: '销售台' }, { slug: 'ops', title: 'ops' }]));
const texts = { off: benchListState(404, { error: 'bench_views_off' }), login: benchListState(401, { error: 'login_required' }), token: benchListState(403, { error: 'bench_views_admin_token_denied' }), none: benchListState(403, { error: 'bench_views_forbidden' }), down: benchListState(0, null), other: benchListState(500, null) };
ok('取不到的几种各有各的说法：没开启、没登录、管理口令、没有可看的台、连不上、别的', texts.off.kind === 'off' && /没有开启/.test(texts.off.text) && texts.login.kind === 'login' && /登录/.test(texts.login.text)
  && texts.token.kind === 'forbidden' && /管理口令/.test(texts.token.text) && texts.none.kind === 'forbidden' && /没有可以看的台/.test(texts.none.text)
  && texts.down.kind === 'error' && /连不上/.test(texts.down.text) && texts.other.kind === 'error' && new Set(Object.values(texts).map((x) => x.text)).size === 6, texts);
let v = viewChoices(200, { view: { version: 1, content: { title: 't', views: [{ key: 'board', title: '看板' }, { key: 'rows' }, { title: '没键' }] } } });
ok('一个台的视图：有标题用标题，没有用键；没键的不要', eq(v.views, [{ key: 'board', title: '看板' }, { key: 'rows', title: 'rows' }]) && v.text === '');
ok('还没有视图描述、看不到、不在了、取不到：空清单加一句话', viewChoices(200, { view: null }).text === '这个台还没有视图。' && /看不到/.test(viewChoices(403, null).text) && /不在了/.test(viewChoices(404, null).text) && /连不上/.test(viewChoices(0, null).text) && viewChoices(500, null).views.length === 0);

// —— 小标题 ——
ok('小标题：视图名 · 台名；两样一样只写一个', panelHeading({ title: '销售台', view: { key: 'main', title: '总览' } }) === '总览 · 销售台' && panelHeading({ title: '总览', view: { title: '总览' } }) === '总览');
ok('没取到（没权限、出错）：只写「一份数据视图」，不拿台标识、视图键顶替', panelHeading(null) === ANON_VIEW && panelHeading({ error: 'bench_views_forbidden' }) === ANON_VIEW && !/[a-z]/.test(ANON_VIEW));
ok('配置对话框里一行的名字：哪样没取到就不写哪样，都没有写「一份数据视图」', rowName('总览', '销售台') === '总览 · 销售台' && rowName(undefined, '销售台') === '销售台' && rowName('总览', undefined) === '总览' && rowName(undefined, undefined) === ANON_VIEW);
ok('一个台都看不到：说清挂视图要先有台的读权限', /读权限/.test(NO_BENCH) && texts.none.text === NO_BENCH);

console.log(`cockpit-bench-view-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
