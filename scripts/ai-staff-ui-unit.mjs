#!/usr/bin/env node
/** 驾驶舱「AI 员工」的纯函数单测（web/src/ai-staff-view.ts）：分给我的成员、我负责的团队、忙闲的说法、点进去的地址。全是合成值。 */
import { busyText, ledTeams, myStaff, staffCard, staffLink } from '../web/src/ai-staff-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const m = (seat, name, extra = {}) => ({ seat, seat_id: '', name, role: 'member', online: true, router: false, assigned_to: null, active_items: 0, ...extra });
const mine = { principal: 'person:pm-a', teams: [], members: [
  { host: '0a1b2c3d', team: 'zone/canvas/team-a', team_name: '合成一组', status: 'active', ...m('zone/0a1b2c3d', '小采 (0a1b2c3d)', { seat_id: 's-1', active_items: 3 }) },
  { host: '0a1b2c3d', team: 'zone/canvas/team-b', team_name: '', status: 'active', ...m('zone/0e0e0e0e', '', { online: false }) },
  { nope: 1 }, null,
] };
{
  const c = myStaff(mine);
  ok('分给我的成员：名字去掉句柄后缀、头像取首字、团队用服务端给的名字；没名字用句柄；形状不对的跳过', c.length === 2 && c[0].name === '小采' && c[0].initial === '小' && c[0].team === '合成一组' && c[0].active === 3 && c[0].online
    && c[1].name === 'zone/0e0e0e0e' && c[1].team === 'team-b' && !c[1].online && c[1].active === 0, JSON.stringify(c));
  ok('读坏了不崩', myStaff(null).length === 0 && myStaff({ members: 'x' }).length === 0 && staffCard({ name: 'x' }) === null);
}
ok('忙闲：说的是这个成员一共多忙，不叫「你的」', busyText(3) === '手上在办 3 件' && busyText(0) === '手上没有在办的' && !busyText(3).includes('你'));
ok('点进去：事项列表「我的 AI 员工手上的」视角，按席位筛（有 seat_id 用它）', staffLink({ seat: 'zone/0a1b2c3d', seat_id: 's-1' }) === '/work-items?view=seats&seat=s-1'
  && staffLink({ seat: 'zone/0a1b2c3d', seat_id: '' }) === '/work-items?view=seats&seat=zone%2F0a1b2c3d');
{
  const teams = { departments: [
    { id: 'd1', teams: [
      { host: '0a1b2c3d', team: 'zone/canvas/team-a', name: '合成一组', leads: [{ principal: 'person:pm-a' }], members: [m('zone/0a1b2c3d', '小采', { seat_id: 's-1', active_items: 3 }), m('zone/11111111', '小运', { active_items: 1 })] },
      { host: '0a1b2c3d', team: 'zone/canvas/team-c', name: '合成三组', leads: [{ principal: 'person:other' }], members: [m('zone/22222222', '别人的')] },
    ] },
    { id: 'd2', teams: [{ host: '0f0f0f0f', team: 'zone/canvas/team-d', name: '', leads: [{ principal: 'person:pm-a' }], members: [] }] },
  ] };
  const keys = new Set(myStaff(mine).map((c) => c.key));
  const led = ledTeams(teams, 'person:pm-a', keys);
  ok('我负责的团队：只挑 leads 里有我的；已经在「分给我的」里的成员不重复；没成员的团队也列出来', led.length === 2 && led[0].name === '合成一组' && led[0].members.length === 1 && led[0].members[0].name === '小运'
    && led[1].name === 'team-d' && led[1].members.length === 0, JSON.stringify(led));
  ok('不知道我是谁、读坏了：没有这一组', ledTeams(teams, '').length === 0 && ledTeams(null, 'person:pm-a').length === 0);
}

console.log(`\nai-staff-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
