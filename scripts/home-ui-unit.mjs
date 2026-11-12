#!/usr/bin/env node
/** 全景首页的纯函数单测（web/src/home-view.ts）：进全景的类型、列、每格状态与待定件数、终态的线、总结句、问候、点格筛选。
 *  数据形状照生命周期只读接口（/api/lifecycle/stages、objects）；全是合成值。 */
import { cleanWho, seatLabel, teamLabel, waitingLabel } from '../web/src/people.ts';
import { answerChoices, decideCount, groupCards, isMine } from '../web/src/attention-view.ts';
import { cardWording, splitAskTitle, buildRows, splitRows, daysLabel, filterAttention, greeting, objectLabel, panoramaType, stageColumns, summaryLine, decideLine, toggleFocus } from '../web/src/home-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const pd = { type: 'pd', name: '产品', panorama_row: true, parent_type: null, flags: [{ code: 'fl_hold_01', name: '搁置' }],
  stages: [{ code: 'st_3', name: '三', order: 3, terminal: false }, { code: 'st_1', name: '一', order: 1, terminal: false }, { code: 'st_2', name: '二', order: 2, terminal: false }, { code: 'st_x', name: '取消', order: 9, terminal: true }] };
const po = { ...pd, type: 'po', panorama_row: false };
ok('进全景的只有 panorama_row 的类型', panoramaType([po, pd])?.type === 'pd' && panoramaType([po]) === null);
ok('列：非终态阶段按 order 排', stageColumns(pd).map((s) => s.code).join() === 'st_1,st_2,st_3');

const obj = (id, stage, extra = {}) => ({ id, type: 'pd', name: null, stage, since: null, days: null, parents: [], flags: [], ...extra });
const att = (object, phase) => ({ source: 'work-items', source_id: object + phase, category: 'accept', title: '', waiting_for: '', since: '', answers: [], object, phase, link: '' });
const rows = buildRows(pd, [obj('a', 'st_2', { days: 3, flags: ['fl_hold_01'] }), obj('b', 'st_x'), obj('c', 'st_unknown'), { ...obj('d', 'st_1'), type: 'po' }], [att('a', 'st_2'), att('a', 'st_2'), att('b', 'st_1')]);
ok('只出这一类的对象', rows.map((r) => r.id).join() === 'a,b,c');
ok('之前已走完、这一步走到、之后没到', rows[0].cells.map((c) => c.state).join() === 'past,current,future');
ok('格子上的待定件数按 object + phase 对', rows[0].cells.map((c) => c.pending).join() === '0,2,0' && rows[0].pending === 2);
ok('标记换成显示名', rows[0].flags.join() === '搁置');
ok('结束的线：不知道停在哪，一律不标已走完；行上标终态名', rows[1].terminal && rows[1].stageName === '取消' && rows[1].cells.every((c) => c.state === 'future'));
const sp = splitRows(rows);
ok('结束的线收到表底下，不进表', sp.active.map((r) => r.id).join() === 'a,c' && sp.ended.map((r) => r.id).join() === 'b');
ok('不认识的阶段码：不猜，一律没到', rows[2].cells.every((c) => c.state === 'future'));
ok('名字为空显示 id', objectLabel({ id: 'x-1', name: null }) === 'x-1' && objectLabel({ id: 'x-1', name: ' ' }) === 'x-1' && objectLabel({ id: 'x-1', name: '甲' }) === '甲');
ok('天数：null 显示未知', daysLabel(null) === '天数未知' && daysLabel(9) === '已 9 天');
ok('总结：只数进行中的线，件数按「关注」给你的条数，有红格时指一句', summaryLine(rows, 3) === '公司现在有 2 条线在走，有 3 件等你拍板——红色标出来的格子就是。', summaryLine(rows, 3));
ok('总结：有待办但对不上格子时不提红格', summaryLine(buildRows(pd, [obj('a', 'st_1')], []), 5) === '公司现在有 1 条线在走，有 5 件等你拍板。');
ok('总结：没有待办换一句', summaryLine(buildRows(pd, [obj('a', 'st_1')], []), 0) === '公司现在有 1 条线在走，眼下没有要你拍板的。');
ok('卡片的谁：去前缀、系统来源说人话', cleanWho('receiver:zone') === 'zone' && cleanWho('human:root-admin') === 'root-admin' && cleanWho('market') === '市场' && cleanWho('mcp:s1') === 's1');
ok('卡片说法：非管理员看到的是自己的；管理员替建立人代办', cardWording('accept', false).label === '等你验收' && !cardWording('accept', false).proxy && cardWording('accept', true).label === '等建立人验收' && cardWording('accept', true).proxy && cardWording('ask', true).label === '在问建立人' && cardWording('glance', true).label === '等你过目' && !cardWording('glance', true).proxy);
ok('问候按时段，有名字带名字', greeting(9, 'alpha') === '早上好，alpha。' && greeting(15, null) === '下午好。' && greeting(21, 'b') === '晚上好，b。');
const f1 = toggleFocus(null, { object: 'a', stage: 'st_2' });
ok('点格筛选：点一格只看这一格，再点同一格回到全部', f1?.object === 'a' && toggleFocus(f1, { object: 'a', stage: 'st_2' }) === null && toggleFocus(f1, { object: 'b', stage: 'st_1' })?.object === 'b');
ok('筛选：按 object + phase', filterAttention([att('a', 'st_2'), att('b', 'st_1')], f1).length === 1 && filterAttention([att('a', 'st_2')], null).length === 1);

ok('团队名：画布团队显示名字，进程团队没名字显示句柄', teamLabel('zone/canvas/team-a') === 'team-a' && teamLabel('zone/0a1b2c3d') === 'zone/0a1b2c3d');
ok('卡片的谁：receiver:<区> 有承接时显示承接席位「名字（句柄）」', cleanWho('receiver:zone', '小采 · zone/0a1b2c3d') === '小采（zone/0a1b2c3d）' && cleanWho('zone/canvas/team-a') === 'team-a' && seatLabel('zone/0a1b2c3d') === 'zone/0a1b2c3d');
{
  const s = splitAskTitle('zone/canvas/team-a 问：用什么语气（可选：正式 / 口语 / 俏皮）');
  ok('提问标题：去掉「<团队> 问：」，拆出选项', s.question === '用什么语气' && s.options.join('|') === '正式|口语|俏皮', JSON.stringify(s));
  const n = splitAskTitle('普通标题');
  ok('提问标题：没有前缀和选项的原样', n.question === '普通标题' && n.options.length === 0);
}
{
  const it = (category, source_id, since = '') => ({ source: 'x', source_id, category, title: '', waiting_for: '', since, answers: category === 'review' ? [] : ['a'], object: '', phase: '', link: '' });
  const g = groupCards([it('review', 'r1'), it('glance', 'g1'), it('review', 'r2'), it('ask', 'q1'), it('accept', 'v1')], (x) => x.answers);
  ok('等你拍板：能当场办的在前（在问 → 验收 → 过目），要去别处办的另一组', g.now.map((x) => x.source_id).join(',') === 'q1,v1,g1' && g.elsewhere.map((x) => x.source_id).join(',') === 'r1,r2', JSON.stringify(g.now.map((x) => x.source_id)));
}

ok('等你拍板：建立人看到的席位提问算能当场办', groupCards([{ source: 'seat-asks', source_id: 'q', category: 'ask', title: '', waiting_for: '', since: '', answers: ['answer'], object: '', phase: '', link: '' }], (x) => answerChoices(false, x)).now.length === 1);
ok('筛选要同时看线和这一步：同一条线两个阶段各一条，点其中一格只剩那一条', (() => { const two = [att('a', 'st_1'), att('a', 'st_2')]; const r1 = filterAttention(two, { object: 'a', stage: 'st_1' }); const r2 = filterAttention(two, { object: 'a', stage: 'st_2' }); return r1.length === 1 && r1[0].phase === 'st_1' && r2.length === 1 && r2[0].phase === 'st_2' && filterAttention(two, { object: 'b', stage: 'st_1' }).length === 0; })());
ok('不认识的类别写中性的「等你处理」，不露代号', cardWording('stuck', false).label === '等你处理' && cardWording('team-unclaimed', true).label === '等你处理' && !cardWording('stuck', true).proxy);
ok('总结只数能当场办的，要到别处处理的另说一句', summaryLine(buildRows(pd, [obj('a', 'st_1')], []), 2, 2) === '公司现在有 1 条线在走，有 2 件等你拍板。另有 2 件要到别处处理。' && decideLine(0, 3) === '眼下没有要你当场拍板的，另有 3 件要到别处处理。' && decideLine(0, 0) === '眼下没有要你拍板的。' && decideLine(4, 0) === '有 4 件等你拍板。');
ok('卡片说法只看条目的 mine：轮到你不算代办（管理员也是）；不轮到你才是代办；没带 mine 才按管理员推', cardWording('accept', true, true).label === '等你验收' && !cardWording('accept', true, true).proxy && cardWording('accept', false, false).proxy && cardWording('accept', false, false).label === '等建立人验收' && cardWording('ask', true, undefined).proxy && !cardWording('ask', false, undefined).proxy);
{
  const it = (id, category, mine, answers = ['a']) => ({ source: 'work-items', source_id: id, category, title: '', waiting_for: '', since: '', answers, object: '', phase: '', link: '', ...(mine === undefined ? {} : { mine }) });
  const items = [it('m1', 'glance', true), it('p1', 'accept', false), it('p2', 'ask', false), it('e1', 'review', true, []), it('old', 'accept', undefined)];
  const g = groupCards(items, (x) => x.answers);
  ok('三组：轮到你能当场办的 / 别人的事你能代办的 / 要到别处处理的', g.now.map((x) => x.source_id).join() === 'old,m1' && g.proxy.map((x) => x.source_id).join() === 'p2,p1' && g.elsewhere.map((x) => x.source_id).join() === 'e1', JSON.stringify([g.now.map((x) => x.source_id), g.proxy.map((x) => x.source_id)]));
  ok('「等你拍板」的件数：角标、总结句、卡片区同一个数——轮到你且能当场办的', decideCount(items, (x) => x.answers) === g.now.length && decideCount(items, (x) => x.answers) === 2 && isMine({}) && !isMine({ mine: false }));
  ok('总结句：代办的、别处处理的各说一句，不算进等你拍板', decideLine(2, 1, false, 3) === '有 2 件等你拍板。另有 3 件别人的事你可以代办，1 件要到别处处理。' && decideLine(0, 0, false, 2) === '眼下没有要你当场拍板的，另有 2 件别人的事你可以代办。' && decideLine(1, 2) === '有 1 件等你拍板。另有 2 件要到别处处理。');
  ok('代办的卡片写出在等谁：有建立人名字写名字，没有写「建立人」', cardWording('accept', true, false, 'alpha').label === '等 alpha 验收' && cardWording('ask', true, false, 'alpha').label === '在问 alpha' && cardWording('accept', true, false, '').label === '等建立人验收' && cardWording('accept', false, true, 'alpha').label === '等你验收');
}
{
  const people = [{ principal: 'person:synthetic-beta', display_name: 'Synthetic beta' }];
  const cases = [['person:synthetic-beta', 'Synthetic beta'], ['person:x', '一位同事'], ['user:pm-a', '一位同事'], ['synthetic:ext-1', '一个外部账号'], ['odoo:42', '一个外部账号'],
    ['mcp:合成会话', 'AI 会话「合成会话」'], ['task-center', '任务中心'], ['https://peer.invalid', '一个对端节点'], ['zone/canvas/team-a', 'team-a'], ['小采 · zone/0a1b2c3d', '小采'], ['zone/0a1b2c3d', '一位 AI 员工'], ['', '']];
  const got = cases.map(([raw]) => waitingLabel(raw, { people }));
  ok('卡片第一行的「谁」不露主体键、外部身份和来源代号：认得的人写显示名，别的说人话', JSON.stringify(got) === JSON.stringify(cases.map((c) => c[1])), JSON.stringify(got));
  ok('对端来源（receiver:）有承接席位写它的名字，没有写「对方团队」', waitingLabel('receiver:zone', { seat: '小运 · zone/11111111' }) === '小运' && waitingLabel('receiver:zone') === '对方团队');
}

ok('服务端给了名字（#657 的 waiting_for_name）就直接用；null、空串才退化', waitingLabel('person:x', { name: '合成同事甲' }) === '合成同事甲' && waitingLabel('person:x', { name: null }) === '一位同事'
  && waitingLabel('person:x', { name: '  ' }) === '一位同事' && waitingLabel('mcp:s1', { name: 'MCP 会话 s1' }) === 'MCP 会话 s1');

console.log(`\nhome-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
