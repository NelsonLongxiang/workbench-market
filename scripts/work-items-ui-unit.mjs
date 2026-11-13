#!/usr/bin/env node
import { answerChoices, decideCount, workItemTurns } from '../web/src/attention-view.ts';
/** 事项列表页的纯函数单测（web/src/work-items-view.ts）：状态归组、组的计数、按对象分组、行的说明、翻页去重。 */
import { STATE_GROUPS, appendPage, byObject, byState, groupCount, groupOf, rowLine, rowTime, seatOrWaiting, viewsFor, decideLabel, emptyText, splitDecide, othersTurnLabel, OTHERS_GROUP, avatarChar, urlFilter, lifecycleNames, progressSummary, lastSaid, objectName, phaseName } from '../web/src/work-items-view.ts';
import { cleanSeatName, rosterNames, seatNameOnly, speakerName } from '../web/src/people.ts';

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
ok('行说明（按状态）：对象·阶段 · 席位 · 最后进展（说话的就是承接席位，不重复写名字）', rowLine(r, 'state', undefined, { objects: { ob_1: '示例产品 A' }, stages: { st_2: '在售' } }) === '示例产品 A · 在售 · seat_a · 做到一半', rowLine(r, 'state'));
ok('行说明（按对象）：省掉位置，阶段另作标签', rowLine(r, 'object') === 'seat_a · 做到一半', rowLine(r, 'object'));
ok('行说明：没派出去的写「还没派出去」，空的对象阶段不占格', rowLine(row('y', 'draft'), 'state') === '还没派出去');
ok('行说明：最后进展没有文字就不显示', rowLine(row('z', 'held', { seat: 's', last_progress: { actor: 'a', fact: 'create', text: '', at: '' } }), 'state') === 's');

const merged = appendPage([row('a', 'progress'), row('b', 'ready')], [row('b', 'done'), row('c', 'done')]);
ok('翻页去重：同一行只留一份，用后到的', merged.map((x) => `${x.id}:${x.state}`).join() === 'a:progress,b:done,c:done', JSON.stringify(merged.map((x) => x.id)));

{
  const who = { seat: (x) => x.includes(' · ') ? x.replace(' · ', '（') + '）' : x, actor: (x, seat) => /^receiver:/.test(x) && seat ? (seat.includes(' · ') ? seat.replace(' · ', '（') + '）' : seat) : x.replace(/^(receiver|human):/, '') };
  ok('没席位时分开说：没派出去 / 派了还没说哪个席位 / 结束了不写', seatOrWaiting({ seat: null, state: 'held' }) === '还没派出去' && seatOrWaiting({ seat: '', state: 'delivered' }) === '还没说是哪个席位' && seatOrWaiting({ seat: '-', state: 'progress' }) === '还没说是哪个席位' && seatOrWaiting({ seat: null, state: 'done' }) === '');
  ok('行说明：席位按页面给的写法；来源标记用承接席位顶上，和席位是同一个就不重复写', rowLine({ id: 'a', title: '', state: 'progress', object: 'o1', phase: 'p1', seat: '小采 · zone/a1', last_progress: { actor: 'receiver:zone', fact: 'progress', text: '在比价', at: '' }, updated_at: '' }, 'state', who) === '未命名的线 · 小采（zone/a1） · 在比价');
  ok('说话的只写了席位的名字或句柄，也算同一个，不重复', rowLine({ id: 'a', title: '', state: 'progress', object: '', phase: '', seat: '小物 · zone/55', last_progress: { actor: '小物', fact: 'progress', text: '核对中', at: '' }, updated_at: '' }, 'state', who) === '小物（zone/55） · 核对中' && rowLine({ id: 'a', title: '', state: 'progress', object: '', phase: '', seat: '小物 · zone/55', last_progress: { actor: 'zone/55', fact: 'progress', text: '核对中', at: '' }, updated_at: '' }, 'state', who) === '小物（zone/55） · 核对中');
  ok('说话的不是承接席位时写上是谁', rowLine({ id: 'a', title: '', state: 'done', object: '', phase: '', seat: 'zone/a1', last_progress: { actor: 'human:pm-a', fact: 'verify', text: '验收通过', at: '' }, updated_at: '' }, 'state', who) === 'zone/a1 · pm-a：验收通过');
  ok('行的时间：进展时间是空串时用更新时间', rowTime({ last_progress: { actor: '', fact: '', text: '', at: '' }, updated_at: 'U' }) === 'U' && rowTime({ last_progress: { actor: '', fact: '', text: '', at: 'A' }, updated_at: 'U' }) === 'A' && rowTime({ last_progress: null, updated_at: 'U' }) === 'U');
}
ok('视角：按接口的 views 只出能用的，先后是我安排的 / 我的 AI 员工手上的 / 我的团队的 / 全部，件数照接口', viewsFor({ all: { available: false, count: 0 }, team: { available: true, count: 29 }, seats: { available: false, count: 0 }, mine: { available: true, count: 6 } }).map((v) => `${v.key}:${v.label}:${v.count}`).join() === 'mine:我安排的:6,team:我的团队的:29');
ok('视角：四个都能用时四个都出；件数是 0 的照出', viewsFor({ mine: { available: true, count: 0 }, seats: { available: true, count: 2 }, team: { available: true, count: 3 }, all: { available: true, count: 9 } }).map((v) => v.label).join('/') === '我安排的/我的 AI 员工手上的/我的团队的/全部');
ok('视角的红数：用接口给的 decide（#712）；没给、不是数、负数都当 0（页签不出红数）', JSON.stringify(viewsFor({ mine: { available: true, count: 6, decide: 0 }, team: { available: true, count: 30, decide: 3 }, all: { available: true, count: 40 } }).map((v) => [v.key, v.decide])) === '[["mine",0],["team",3],["all",0]]'
  && viewsFor({ mine: { available: true, count: 1, decide: '2' } })[0].decide === 0 && viewsFor({ mine: { available: true, count: 1, decide: -1 } })[0].decide === 0 && viewsFor({ mine: { available: true, count: 1, decide: NaN } })[0].decide === 0 && viewsFor({ mine: { available: true, count: 1, decide: 2.7 } })[0].decide === 2);
ok('视角的红数：不可用的视角不出（连 decide 也不看）；读法是「N 件等你拍板」', viewsFor({ team: { available: false, count: 0, decide: 5 } }).length === 0 && decideLabel(3) === '3 件等你拍板');
ok('视角：接口没给 views（旧服务端）或形状不对就一个都不出；available 不是 true 的不出；件数不是数当 0', viewsFor(undefined).length === 0 && viewsFor('x').length === 0
  && viewsFor({ mine: { available: 'true', count: 3 } }).length === 0 && viewsFor({ mine: { available: true, count: 'abc' } })[0].count === 0 && viewsFor({ zzz: { available: true, count: 1 } }).length === 0);
ok('空态：每个视角各说各的；按 AI 员工筛着时说这个员工手上；没有能用的视角另说', emptyText('mine') === '你还没有安排过事项' && emptyText('seats') === '你的 AI 员工手上现在没有事项'
  && emptyText('team') === '你的团队现在没有事项' && emptyText('all') === '还没有事项' && emptyText('seats', 's-1') === '这个 AI 员工手上现在没有事项' && emptyText(null) === '你现在没有能看的事项'
  && new Set(['mine', 'seats', 'team', 'all'].map((k) => emptyText(k))).size === 4);
{
  const roster = rosterNames([{ team: 'zone/canvas/t', seats: [{ seat: 'zone/0a1b2c3d', name: '小运' }, { seat: 'zone/00', name: '' }, null, { name: 'x' }] }, 'bad']);
  ok('名册拍平成句柄 → 名字；没名字、形状不对的不收', roster['zone/0a1b2c3d'] === '小运' && Object.keys(roster).length === 1 && Object.keys(rosterNames(null)).length === 0);
  ok('列表里的席位只写名字：带名字的取名字，只有句柄查名册，查不到写「一位 AI 员工」', seatNameOnly('小采 · zone/a1', roster) === '小采' && seatNameOnly('zone/0a1b2c3d', roster) === '小运' && seatNameOnly('zone/ffff', roster) === '一位 AI 员工' && seatNameOnly('-', roster) === '' && seatNameOnly('') === '');
  ok('圆标的字：名字第一个字；只有句柄不放字符（页面放席位图标）；没有席位为空', avatarChar('小采') === '小' && avatarChar('zone/0a1b2c3d') === '' && avatarChar('alpha') === 'A' && avatarChar('') === '');
}
{
  const n = lifecycleNames([{ type: 'pd', stages: [{ code: 'st_pd_05', name: '在售' }, { code: 'x' }, null] }, 'bad'], [{ id: 'run:pd-A', name: '示例产品 A' }, { id: 'run:pd-B', name: null }, 7]);
  ok('线和阶段的名字从生命周期取；代号不露：线没名字写「未命名的线」，阶段查不到就不写', objectName('run:pd-A', n) === '示例产品 A' && phaseName('st_pd_05', n) === '在售' && objectName('run:pd-B', n) === '未命名的线' && objectName('zzz') === '未命名的线' && phaseName('st_unknown', n) === '' && objectName(null, n) === '' && phaseName('', n) === '');
  ok('进展摘要：结局代号换中文，去掉节点的套话和代号，留正文头一句', progressSummary('completed：工单「比价」已结束（completed）：【比价结果回执】三家里第二家最便宜。详情见附件') === '做完了 · 三家里第二家最便宜', progressSummary('completed：工单「比价」已结束（completed）：【比价结果回执】三家里第二家最便宜。详情见附件'));
  ok('进展摘要：清不出正文只写结局；没有代号的原文照取头一句；空的为空', progressSummary('failed：工单「x」已结束（failed）') === '没办成' && progressSummary('completed') === '做完了' && progressSummary('已核对 12 / 30 箱') === '已核对 12 / 30 箱' && progressSummary('') === '' && progressSummary('failed: 供应商没回复；明天再催') === '没办成 · 供应商没回复');
  ok('进展摘要：太长截断', progressSummary('x'.repeat(60)).endsWith('…') && [...progressSummary('x'.repeat(60))].length === 41);
}
ok('最后一条是验收、撤回、打回这类事时说出来；正文只是内部代号时不显示', lastSaid({ fact: 'withdraw', text: '' }) === '撤回了' && lastSaid({ fact: 'verify', text: '' }) === '验收通过' && lastSaid({ fact: 'return', text: '请换一句更短的，不超过十个字。' }) === '打回重做：请换一句更短的，不超过十个字' && lastSaid({ fact: 'note', text: 'followup-read' }) === '' && lastSaid({ fact: 'receipt', text: 'completed' }) === '做完了' && lastSaid({ fact: 'ask', text: '问候语用哪种风格？ 后面还有' }) === '在问：问候语用哪种风格' && lastSaid({ fact: 'submit', text: '' }) === '');
ok('名册里的名字自带句柄后缀时去掉', cleanSeatName('成员二 (0a1b2c3d)') === '成员二' && cleanSeatName('成员二（0a1b2c3d）') === '成员二' && cleanSeatName('小采 (三组)') === '小采 (三组)' && rosterNames([{ seats: [{ seat: 'z/0a1b2c3d', name: '成员二 (0a1b2c3d)' }] }])['z/0a1b2c3d'] === '成员二');
{
  const ro = { 'zone/0a1b2c3d': '小运', constructor: 'x' };
  ok('说话人：画布团队只写团队名，不露句柄', speakerName('zone/canvas/team-a', '', {}) === 'team-a' && rowLine({ id: 'a', title: '', state: 'ready', object: '', phase: '', seat: '', last_progress: { actor: 'zone/canvas/team-a', fact: 'receipt', text: 'completed', at: '' }, updated_at: '' }, 'state', { seat: (x) => x, actor: (x, seat) => speakerName(x, seat, {}) }) === '还没说是哪个席位 · team-a：做完了');
  ok('说话人：对端来源有承接用承接、没有不写；席位查名册；人去前缀', speakerName('receiver:zone', '小采 · zone/a1', ro) === '小采' && speakerName('receiver:zone', '', ro) === '' && speakerName('zone/0a1b2c3d', '', ro) === '小运' && speakerName('human:pm-a', '', ro) === 'pm-a' && speakerName('', '', ro) === '');
  ok('查表只认自己的键（不认 toString、constructor 这类继承来的）', seatNameOnly('toString', {}) === 'toString' && lastSaid({ fact: 'toString', text: '' }) === '' && lastSaid({ fact: 'constructor', text: '进展' }) === '进展');
}
ok('地址里的视角和席位：只认四个视角名、席位不超过 200 字、去掉空白；认不出的当没带', JSON.stringify(urlFilter('?view=seats&seat=s-1')) === '{"view":"seats","seat":"s-1"}'
  && JSON.stringify(urlFilter('?view=bogus&seat=')) === '{}' && JSON.stringify(urlFilter('')) === '{}' && JSON.stringify(urlFilter('?seat=%20zone%2F0a1b2c3d%20')) === '{"seat":"zone/0a1b2c3d"}'
  && JSON.stringify(urlFilter('?seat=' + 'x'.repeat(201))) === '{}' && JSON.stringify(urlFilter('?view=all')) === '{"view":"all"}');

// 「等你拍板」只放轮到你、能当场办的（和侧栏角标同一个判法）；别人的另成「等别人处理」
{
  const att = (id, category, mine, extra = {}) => ({ source: 'work-items', source_id: id, category, title: id, waiting_for: '', since: '', answers: category === 'accept' ? ['verify', 'return'] : ['release', 'withdraw'], object: '', phase: '', link: `/work-items/${id}`, mine, creator: { principal: 'user:c', display_name: '合成建立人' }, ...extra });
  const ask = (id) => ({ source: 'seat-asks', source_id: 'q1', category: 'ask', title: '问', waiting_for: '', since: '', answers: ['answer'], object: '', phase: '', link: `/work-items/${id}`, mine: true });
  const items = [att('wi-a', 'accept', true), att('wi-b', 'accept', false), att('wi-c', 'accept', false), ask('wi-d'), { ...att('wi-z', 'grant', true), source: 'a2a-peers', link: '/team' }];
  const choices = (x) => answerChoices(false, x);
  const t = workItemTurns(items, choices);
  ok('轮到谁：和侧栏角标同一个判法——轮到你的事项数 = decideCount 里事项的那几条', [...t.mine].sort().join() === 'wi-a,wi-d' && t.mine.size === decideCount(items.filter((x) => x.link.startsWith('/work-items/')), choices), [...t.mine]);
  const row = (id, state) => ({ id, title: id, state, object: null, phase: null, seat: null, last_progress: null, updated_at: '' });
  // 团队负责人在团队视角：三件等验收里只有 wi-a 是他自己建的；wi-d 在问他；wi-h 等放行（不是管理员，轮不到）
  const rows = [row('wi-a', 'ready'), row('wi-b', 'ready'), row('wi-c', 'ready'), row('wi-d', 'blocked'), row('wi-h', 'held'), row('wi-x', 'progress')];
  const sp = splitDecide(rows, t.mine, 5);
  ok('负责人在团队视角：建立人不是他的「等验收」不计入红色数，进「等别人处理」', sp.mineCount === 2 && sp.mine.map((r) => r.id).join() === 'wi-a,wi-d' && sp.others.map((r) => r.id).join() === 'wi-b,wi-c,wi-h' && sp.othersCount === 3, sp);
  ok('「等别人处理」的件数 = 这几种状态的总数减去轮到你的（总数覆盖整个视角）；不出负数', splitDecide(rows, t.mine, 9).othersCount === 7 && splitDecide(rows, t.mine, 1).othersCount === 0 && OTHERS_GROUP.title === '等别人处理');
  ok('读不到「关注」（空集合）：一件都不算轮到你', splitDecide(rows, new Set(), 5).mineCount === 0);
  ok('等谁写清：有建立人名字写名字；等验收没有名字写「建立人」，在问没有名字不说是谁；等放行不猜是谁、不写管理员；不露标识', othersTurnLabel('ready', '合成建立人') === '等 合成建立人 验收' && othersTurnLabel('ready') === '等建立人验收'
    && othersTurnLabel('blocked', '甲') === '在等 甲 答复' && othersTurnLabel('blocked', '  ') === '在等答复' && othersTurnLabel('held', '甲') === '等放行' && !othersTurnLabel('held').includes('管理员') && othersTurnLabel('progress') === '');
}

console.log(`\nwork-items-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
