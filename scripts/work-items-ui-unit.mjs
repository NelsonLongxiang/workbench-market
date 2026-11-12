#!/usr/bin/env node
/** 事项列表页的纯函数单测（web/src/work-items-view.ts）：状态归组、组的计数、按对象分组、行的说明、翻页去重。 */
import { STATE_GROUPS, appendPage, byObject, byState, groupCount, groupOf, rowLine, rowTime, seatOrWaiting, viewsFor, avatarChar, rosterNames, seatNameOnly, lifecycleNames, progressSummary, lastSaid, speakerName, cleanSeatName, objectName, phaseName } from '../web/src/work-items-view.ts';

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
  ok('行说明：席位按页面给的写法；来源标记用承接席位顶上，和席位是同一个就不重复写', rowLine({ id: 'a', title: '', state: 'progress', object: 'o1', phase: 'p1', seat: '小采 · zone/a1', last_progress: { actor: 'receiver:dsh', fact: 'progress', text: '在比价', at: '' }, updated_at: '' }, 'state', who) === '未命名的线 · 小采（zone/a1） · 在比价');
  ok('说话的只写了席位的名字或句柄，也算同一个，不重复', rowLine({ id: 'a', title: '', state: 'progress', object: '', phase: '', seat: '小物 · zone/55', last_progress: { actor: '小物', fact: 'progress', text: '核对中', at: '' }, updated_at: '' }, 'state', who) === '小物（zone/55） · 核对中' && rowLine({ id: 'a', title: '', state: 'progress', object: '', phase: '', seat: '小物 · zone/55', last_progress: { actor: 'zone/55', fact: 'progress', text: '核对中', at: '' }, updated_at: '' }, 'state', who) === '小物（zone/55） · 核对中');
  ok('说话的不是承接席位时写上是谁', rowLine({ id: 'a', title: '', state: 'done', object: '', phase: '', seat: 'zone/a1', last_progress: { actor: 'human:pm-a', fact: 'verify', text: '验收通过', at: '' }, updated_at: '' }, 'state', who) === 'zone/a1 · pm-a：验收通过');
  ok('行的时间：进展时间是空串时用更新时间', rowTime({ last_progress: { actor: '', fact: '', text: '', at: '' }, updated_at: 'U' }) === 'U' && rowTime({ last_progress: { actor: '', fact: '', text: '', at: 'A' }, updated_at: 'U' }) === 'A' && rowTime({ last_progress: null, updated_at: 'U' }) === 'U');
}
ok('视角：只给接口现在给得出的那一个——管理员「全部」，别人「我安排的」，件数是可见范围的总数', viewsFor(true, 22).map((v) => `${v.key}:${v.label}:${v.count}`).join() === 'all:全部:22' && viewsFor(false, 3).map((v) => `${v.key}:${v.label}:${v.count}`).join() === 'mine:我安排的:3');
{
  const roster = rosterNames([{ team: 'zone/canvas/t', seats: [{ seat: 'zone/98b94be9', name: '小运' }, { seat: 'zone/00', name: '' }, null, { name: 'x' }] }, 'bad']);
  ok('名册拍平成句柄 → 名字；没名字、形状不对的不收', roster['zone/98b94be9'] === '小运' && Object.keys(roster).length === 1 && Object.keys(rosterNames(null)).length === 0);
  ok('列表里的席位只写名字：带名字的取名字，只有句柄查名册，查不到显示句柄', seatNameOnly('小采 · zone/a1', roster) === '小采' && seatNameOnly('zone/98b94be9', roster) === '小运' && seatNameOnly('zone/ffff', roster) === 'zone/ffff' && seatNameOnly('-', roster) === '' && seatNameOnly('') === '');
  ok('圆标的字：名字第一个字；只有句柄不放字符（页面放席位图标）；没有席位为空', avatarChar('小采') === '小' && avatarChar('zone/98b94be9') === '' && avatarChar('alpha') === 'A' && avatarChar('') === '');
}
{
  const n = lifecycleNames([{ type: 'pd', stages: [{ code: 'st_pd_05', name: '在售' }, { code: 'x' }, null] }, 'bad'], [{ id: 'run:pd-A', name: '示例产品 A' }, { id: 'run:pd-B', name: null }, 7]);
  ok('线和阶段的名字从生命周期取；代号不露：线没名字写「未命名的线」，阶段查不到就不写', objectName('run:pd-A', n) === '示例产品 A' && phaseName('st_pd_05', n) === '在售' && objectName('run:pd-B', n) === '未命名的线' && objectName('zzz') === '未命名的线' && phaseName('st_unknown', n) === '' && objectName(null, n) === '' && phaseName('', n) === '');
  ok('进展摘要：结局代号换中文，去掉节点的套话和代号，留正文头一句', progressSummary('completed：工单「比价」已结束（completed）：【比价结果回执】三家里第二家最便宜。详情见附件') === '做完了 · 三家里第二家最便宜', progressSummary('completed：工单「比价」已结束（completed）：【比价结果回执】三家里第二家最便宜。详情见附件'));
  ok('进展摘要：清不出正文只写结局；没有代号的原文照取头一句；空的为空', progressSummary('failed：工单「x」已结束（failed）') === '没办成' && progressSummary('completed') === '做完了' && progressSummary('已核对 12 / 30 箱') === '已核对 12 / 30 箱' && progressSummary('') === '' && progressSummary('failed: 供应商没回复；明天再催') === '没办成 · 供应商没回复');
  ok('进展摘要：太长截断', progressSummary('x'.repeat(60)).endsWith('…') && [...progressSummary('x'.repeat(60))].length === 41);
}
ok('最后一条是验收、撤回、打回这类事时说出来；正文只是内部代号时不显示', lastSaid({ fact: 'withdraw', text: '' }) === '撤回了' && lastSaid({ fact: 'verify', text: '' }) === '验收通过' && lastSaid({ fact: 'return', text: '请换一句更短的，不超过十个字。' }) === '打回重做：请换一句更短的，不超过十个字' && lastSaid({ fact: 'note', text: 'followup-read' }) === '' && lastSaid({ fact: 'receipt', text: 'completed' }) === '做完了' && lastSaid({ fact: 'ask', text: '问候语用哪种风格？ 后面还有' }) === '在问：问候语用哪种风格' && lastSaid({ fact: 'submit', text: '' }) === '');
ok('名册里的名字自带句柄后缀时去掉', cleanSeatName('成员二 (98b94be9)') === '成员二' && cleanSeatName('成员二（98b94be9）') === '成员二' && cleanSeatName('小采 (三组)') === '小采 (三组)' && rosterNames([{ seats: [{ seat: 'z/98b94be9', name: '成员二 (98b94be9)' }] }])['z/98b94be9'] === '成员二');
{
  const ro = { 'zone/98b94be9': '小运', constructor: 'x' };
  const plain = (v) => v.replace(/^(human|user|seat):/, '');
  ok('说话人：画布团队只写团队名，不露句柄', speakerName('dsh/canvas/team-a', '', {}, plain) === 'team-a' && rowLine({ id: 'a', title: '', state: 'ready', object: '', phase: '', seat: '', last_progress: { actor: 'dsh/canvas/team-a', fact: 'receipt', text: 'completed', at: '' }, updated_at: '' }, 'state', { seat: (x) => x, actor: (x, seat) => speakerName(x, seat, {}, plain) }) === '还没说是哪个席位 · team-a：做完了');
  ok('说话人：对端来源有承接用承接、没有不写；席位查名册；人去前缀', speakerName('receiver:dsh', '小采 · zone/a1', ro) === '小采' && speakerName('receiver:dsh', '', ro) === '' && speakerName('zone/98b94be9', '', ro) === '小运' && speakerName('human:pm-a', '', ro, plain) === 'pm-a' && speakerName('', '', ro) === '');
  ok('查表只认自己的键（不认 toString、constructor 这类继承来的）', seatNameOnly('toString', {}) === 'toString' && lastSaid({ fact: 'toString', text: '' }) === '' && lastSaid({ fact: 'constructor', text: '进展' }) === '进展');
}
console.log(`\nwork-items-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
