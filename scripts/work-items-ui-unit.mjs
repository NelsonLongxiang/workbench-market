#!/usr/bin/env node
/** 事项列表页的纯函数单测（web/src/work-items-view.ts）：状态归组、组的计数、按对象分组、行的说明、翻页去重。 */
import { STATE_GROUPS, appendPage, byObject, byState, groupCount, groupOf, rowLine } from '../web/src/work-items-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const row = (id, state, extra = {}) => ({ id, title: id, state, object: null, phase: null, seat: null, last_progress: null, updated_at: '2026-11-11 00:00:00', ...extra });

const all = ['draft', 'held', 'delivered', 'accepted', 'progress', 'waiting', 'blocked', 'ready', 'done', 'failed', 'dropped', 'cancelled'];
ok('每个状态恰好归一组', all.every((s) => STATE_GROUPS.filter((g) => g.states.includes(s)).length === 1));
ok('归组：拍板 / 在办 / 已结束 / 未派发', groupOf('blocked') === 'decide' && groupOf('held') === 'decide' && groupOf('waiting') === 'doing' && groupOf('cancelled') === 'closed' && groupOf('draft') === 'draft');
ok('不认识的状态归「在办」，不藏起来', groupOf('something_new') === 'doing');
ok('未派发缺省折叠，其余展开', STATE_GROUPS.filter((g) => g.collapsed).map((g) => g.key).join() === 'draft');
ok('组的计数取服务端计数，缺的状态当 0', groupCount({ blocked: 2, ready: 3, progress: 9 }, 'decide') === 5 && groupCount({}, 'closed') === 0);

const grouped = byState([row('a', 'progress'), row('b', 'ready'), row('c', 'done'), row('d', 'draft'), row('e', 'progress')]);
ok('按状态分组：组内保持服务端的先后', grouped.doing.map((r) => r.id).join() === 'a,e' && grouped.decide[0].id === 'b' && grouped.closed[0].id === 'c' && grouped.draft[0].id === 'd');

const objs = byObject([row('a', 'progress', { object: 'ob_2' }), row('b', 'ready'), row('c', 'done', { object: 'ob_1' }), row('d', 'draft', { object: 'ob_2' })]);
ok('按对象分组：按对象标识排，没关联对象的放最后', objs.map((g) => g.object).join('|') === 'ob_1|ob_2|' && objs[1].rows.map((r) => r.id).join() === 'a,d');

const r = row('x', 'progress', { object: 'ob_1', phase: 'st_2', seat: 'seat_a', last_progress: { actor: 'seat_a', fact: 'report', text: '做到一半', at: '2026-11-11 01:00:00' } });
ok('行说明（按状态）：对象·阶段 · 席位 · 最后进展', rowLine(r, 'state') === 'ob_1·st_2 · seat_a · seat_a：做到一半', rowLine(r, 'state'));
ok('行说明（按对象）：省掉位置，阶段另作标签', rowLine(r, 'object') === 'seat_a · seat_a：做到一半', rowLine(r, 'object'));
ok('行说明：没派的写「还没派」，空的对象阶段不占格', rowLine(row('y', 'draft'), 'state') === '还没派');
ok('行说明：最后进展没有文字就不显示', rowLine(row('z', 'held', { seat: 's', last_progress: { actor: 'a', fact: 'create', text: '', at: '' } }), 'state') === 's');

const merged = appendPage([row('a', 'progress'), row('b', 'ready')], [row('b', 'done'), row('c', 'done')]);
ok('翻页去重：同一行只留一份，用后到的', merged.map((x) => `${x.id}:${x.state}`).join() === 'a:progress,b:done,c:done', JSON.stringify(merged.map((x) => x.id)));

console.log(`\nwork-items-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
