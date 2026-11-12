#!/usr/bin/env node
/** 「团队」页的纯函数单测（web/src/team-view.ts）：应答整形、管理员视图、团队状态、负责人、成员归谁用、计数、空的说法、读不到和被拒的说法、建部门的校验。数据都是合成的。 */
import { actionProblem, assignedText, memberlessText, departmentsOf, emptyText, isAdminView, leadsOf, newDeptProblem, personName, seatRaw, sourceProblem, teamCounts, teamStatusLabel, teamTitle, teamsOf } from '../web/src/team-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

const member = (seat, more = {}) => ({ seat, seat_id: '', name: '', role: 'worker', online: true, router: false, assigned_to: null, active_items: 0, ...more });
const team = (more = {}) => ({ host: 'a1b2c3d4', team: 'ops/canvas/合成运营', name: '合成运营', status: 'active', in_roster: true, department: { id: 'ops', name: '运营部' }, leads: [], router: null, members: [], ...more });
const body = {
  departments: [{ id: 'ops', name: '运营部', lead: { principal: 'user:zhang', display_name: '张经理' }, teams: [team({
    leads: [{ principal: 'user:zhang', display_name: '张经理', source: 'department' }, { principal: 'user:li', display_name: '', source: 'explicit' }, { principal: 'user:zhang', display_name: '张经理', source: 'explicit' }],
    router: member('ops/a1b2c3d4', { name: '总工', role: 'router', router: true, active_items: 2 }),
    members: [member('ops/00000001', { name: '小算', active_items: 3, assigned_to: { principal: 'user:wang', display_name: '王' } }), member('ops/00000002', { active_items: 1 }), { bad: true }],
  }), { team: 'x' }] }, { id: 7 }],
};

const t = teamsOf(body);
ok('整形：坏的部门、团队、成员丢掉，不崩', t.departments.length === 1 && t.departments[0].teams.length === 1 && t.departments[0].teams[0].members.length === 2);
ok('整形：不是对象、不是数组都按空', J(teamsOf(null)) === '{"departments":[],"unclaimed":null}' && teamsOf({ departments: 'x', unclaimed: 'y' }).unclaimed === null);
ok('管理员视图：应答里有「待认领的团队」这一栏才算（空数组也算）', !isAdminView(t) && isAdminView(teamsOf({ departments: [], unclaimed: [] })));
ok('团队状态：四种说法；原型链上的名字、不认识的不当状态', J(['active', 'lead-vacant', 'off-roster', 'unclaimed'].map((s) => teamStatusLabel(s).text)) === '["正常","负责人缺位","不在名册","待认领"]' && teamStatusLabel('toString').text === '状态未知' && teamStatusLabel(undefined).text === '状态未知');
ok('负责人：去重，挂部门带来的标出来；没有显示名用标识去前缀', J(leadsOf(t.departments[0].teams[0])) === '[{"name":"张经理","viaDepartment":true},{"name":"li","viaDepartment":false}]');
ok('成员归谁用：分配给某人 / 团队公用', assignedText(t.departments[0].teams[0].members[0]) === '分配给 王' && assignedText(t.departments[0].teams[0].members[1]) === '团队公用');
ok('计数：成员不算总工；在办把总工也算上', J(teamCounts(t.departments[0].teams[0])) === '{"members":2,"active":6}');
ok('计数：在办是负数、不是数都按 0', teamCounts({ members: [member('a/1', { active_items: -3 }), member('a/2', { active_items: 'x' })], router: null }).active === 0);
ok('席位显示：有名字传「名字 · 句柄」，没有只传句柄', seatRaw({ name: '小算', seat: 'ops/00000001' }) === '小算 · ops/00000001' && seatRaw({ name: ' ', seat: 'ops/2' }) === 'ops/2');
ok('团队名：画布名；不在画布里的说明在哪个节点', teamTitle({ name: '合成运营', team: 'ops/canvas/合成运营', host: 'a1b2c3d4' }) === '合成运营' && teamTitle({ name: '', team: '', host: 'a1b2c3d4' }) === '节点 a1b2c3d4 上不在画布里的成员');
ok('没有成员时：不在名册的说不在名册了，别的说还没有成员', /不在节点的名册里/.test(memberlessText({ status: 'off-roster', in_roster: false })) && /还没有成员/.test(memberlessText({ status: 'active', in_roster: true })));
ok('人名：显示名优先，没有去前缀，空的给空串', personName({ principal: 'user:zhao', display_name: '' }) === 'zhao' && personName(null) === '');

const deps = departmentsOf({ departments: [{ id: 'ops', name: '运营部', lead: null, member_count: 3 }, { name: '缺标识' }] });
ok('部门列表：缺标识的丢掉；不是对象按空', deps.length === 1 && deps[0].member_count === 3 && departmentsOf('x').length === 0);
ok('空：没有部门——管理员说先建部门，别人说等管理员', /先建部门/.test(emptyText(teamsOf({ departments: [], unclaimed: [] }), [], true)) && /等管理员先建部门/.test(emptyText(teamsOf({ departments: [] }), [], false)));
ok('空：有部门没团队——管理员说会先出现在待认领里，别人说哪些团队会出现', /待认领的团队/.test(emptyText(teamsOf({ departments: [], unclaimed: [] }), deps, true)) && /你所在部门的团队/.test(emptyText(teamsOf({ departments: [] }), deps, false)));
ok('空：有团队（哪怕只有待认领的）就不算空；部门读不到时只看团队', emptyText(teamsOf({ departments: [], unclaimed: [team({ status: 'unclaimed', department: null })] }), deps, true) === null && emptyText(t, null, false) === null);

ok('读不到：401 请先登录、403 不能查看、404 没上线、其余读不到', sourceProblem('团队', { status: 401 }).text.startsWith('请先登录') && /不能查看团队/.test(sourceProblem('团队', { status: 403 }).text) && sourceProblem('团队', { status: 404 }).type === 'info' && sourceProblem('团队', { status: 0 }).text === '读不到团队，稍后再试。' && sourceProblem('团队', { status: 200 }) === null);
ok('被拒：服务端的说法优先；只有代码不显示代码', actionProblem({ status: 409, body: { error: 'last_lead', message: '最后一个负责人不能直接移除' } }) === '最后一个负责人不能直接移除' && actionProblem({ status: 403, body: { error: 'not_team_lead' } }) === '你的账号现在不能做这一步。' && actionProblem({ status: 201, body: {} }) === null);
ok('建部门：名称必填、≤64；标识按服务端同一条；不能和已有的重复', newDeptProblem('ops-2', '运营二部', deps) === null && /部门名称/.test(newDeptProblem('x', ' ', deps)) && /小写字母开头/.test(newDeptProblem('2ops', '某部', deps)) && /小写字母开头/.test(newDeptProblem('Ops', '某部', deps)) && /已经有部门在用/.test(newDeptProblem('ops', '某部', deps)) && /最多 64/.test(newDeptProblem('ok', '长'.repeat(65), deps)));
ok('说法里没有开发用语', [emptyText(teamsOf({ departments: [] }), [], true), sourceProblem('团队', { status: 500 }).text, actionProblem({ status: 500, body: null })].every((s) => !/接口|字段|暂无数据|待实现|principal|seat/.test(s)));

console.log(`\nteam-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
