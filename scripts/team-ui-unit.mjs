#!/usr/bin/env node
/** 「团队」页的纯函数单测（web/src/team-view.ts）：应答整形、管理员视图、团队状态、负责人、成员归谁用、计数、空的说法、读不到和被拒的说法、建部门的校验。数据都是合成的。 */
// 在非 UTC 的时区里跑（东八区）：不带时区的时间写法要按 UTC 解析，在这里才看得出来
process.env.TZ = 'Asia/Shanghai';
import { actionProblem, assignedText, memberlessText, departmentsOf, emptyText, isAdminView, leadsOf, newDeptProblem, personName, memberLabel, nodeLabel, rosterAt, rosterStaleText, ROSTER_STALE_MIN, sourceProblem, teamCounts, teamStatusLabel, teamTitle, teamsOf, pendingText, proposedText } from '../web/src/team-view.ts';

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
ok('整形：不是对象、不是数组都按空', J(teamsOf(null)) === '{"departments":[],"unclaimed":null,"can":null}' && teamsOf({ departments: 'x', unclaimed: 'y' }).unclaimed === null);
ok('管理员视图：应答里有「待认领的团队」这一栏才算（空数组也算）', !isAdminView(t) && isAdminView(teamsOf({ departments: [], unclaimed: [] })));
ok('团队状态：四种说法；原型链上的名字、不认识的不当状态', J(['active', 'lead-vacant', 'off-roster', 'unclaimed'].map((s) => teamStatusLabel(s).text)) === '["正常","负责人缺位","不在名册","待认领"]' && teamStatusLabel('toString').text === '状态未知' && teamStatusLabel(undefined).text === '状态未知');
ok('负责人：去重，挂部门带来的标出来；没有显示名用标识去前缀', J(leadsOf(t.departments[0].teams[0])) === '[{"name":"张经理","viaDepartment":true},{"name":"li","viaDepartment":false}]');
ok('成员归谁用：分配给某人 / 团队公用', assignedText(t.departments[0].teams[0].members[0]) === '分配给 王' && assignedText(t.departments[0].teams[0].members[1]) === '团队公用');
ok('计数：成员不算总工；在办把总工也算上', J(teamCounts(t.departments[0].teams[0])) === '{"members":2,"active":6}');
ok('计数：在办是负数、不是数都按 0', teamCounts({ members: [member('a/1', { active_items: -3 }), member('a/2', { active_items: 'x' })], router: null }).active === 0);
ok('成员名：只写名字、不带句柄；名字自带的句柄后缀去掉；没有名字才用句柄', memberLabel({ name: '小算', seat: 'ops/00000001' }) === '小算' && memberLabel({ name: '合成成员二 (0a1b2c3d)', seat: 'ops/0a1b2c3d' }) === '合成成员二' && memberLabel({ name: '合成成员三（0a1b2c3e）', seat: 'x' }) === '合成成员三' && memberLabel({ name: ' ', seat: 'ops/2' }) === 'ops/2' && memberLabel({ name: '（备用）', seat: 'x' }) === '（备用）');
ok('节点：有名字写名字；没有名字不写这一项，标识不出现', nodeLabel({ node_name: '合成节点甲' }) === '合成节点甲' && nodeLabel({}) === '' && nodeLabel({ node_name: '  ' }) === '' && teamsOf({ departments: [], unclaimed: [{ host: 'a1b2c3d4', team: '', node_name: ' 合成节点乙 ' }] }).unclaimed[0].node_name === '合成节点乙');
ok('团队名：画布名；没有名字的不露团队句柄和节点标识', teamTitle({ name: '合成运营', team: 'ops/canvas/合成运营' }) === '合成运营' && teamTitle({ name: '', team: '' }) === '不在画布里的成员' && teamTitle({ name: '', team: 'ops/12345' }) === '一个没有名字的团队');
ok('没有成员时：不在名册的说不在名册了，别的说还没有成员', /不在节点的名册里/.test(memberlessText({ status: 'off-roster', in_roster: false })) && /还没有成员/.test(memberlessText({ status: 'active', in_roster: true })));
const at = (v) => teamsOf({ departments: [], unclaimed: [{ host: 'a1b2c3d4', team: '', roster_received_at: v }] }).unclaimed[0].roster_at;
const T0 = Date.parse('2030-01-01T00:00:00Z');
ok('名册时刻：ISO 时刻、毫秒数的字符串都认；坏的、空的、null 不带', at('2030-01-01T00:00:00Z') === T0 && at(String(T0)) === T0 && at('不是时间') === undefined && at('') === undefined && at(null) === undefined);
ok('名册时刻：服务端的 sqlTime 写法「2030-01-01 06:00:00」（UTC、不带时区、空格）按 UTC 解析；不带 Z 的 T 写法也按 UTC；带时区的照它', new Date().getTimezoneOffset() === -480 && at('2030-01-01 06:00:00') === Date.UTC(2030, 0, 1, 6) && rosterAt('2030-01-01T06:00:00') === Date.UTC(2030, 0, 1, 6) && rosterAt('2030-01-01 06:00') === Date.UTC(2030, 0, 1, 6) && rosterAt('2030-01-01T14:00:00+08:00') === Date.UTC(2030, 0, 1, 6) && rosterAt('2030-01-01 06:00:00.5') === Date.UTC(2030, 0, 1, 6) + 500);
ok('名册没更新：阈值 15 分钟，没到不提醒，到了按分钟、两小时以上按小时、两天以上按天；没有时刻不提醒', ROSTER_STALE_MIN === 15 && rosterStaleText({ roster_at: T0 }, T0 + 14 * 60_000) === null && rosterStaleText({ roster_at: T0 }, T0 + 15 * 60_000) === '名册已 15 分钟没更新' && rosterStaleText({ roster_at: T0 }, T0 + 119 * 60_000) === '名册已 119 分钟没更新' && rosterStaleText({ roster_at: T0 }, T0 + 3 * 3600_000) === '名册已 3 小时没更新' && rosterStaleText({ roster_at: T0 }, T0 + 50 * 3600_000) === '名册已 2 天没更新' && rosterStaleText({}, T0) === null);
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

// 关系确认制（#638）：提议不当成已生效；按钮照服务端的 can
{
  const pv = teamsOf({ can: { claim: false, propose_claim: true, add_lead: false, propose_lead: true, manage_departments: true },
    departments: [{ id: 'ops', name: '运营部', lead: null, pending_lead: { id: 3, principal: 'user:li', department: 'ops', confirm_by_text: '属主' }, teams: [team({ pending_leads: [{ id: 4, principal: 'user:li', department: null, confirm_by_text: '属主' }, { bad: 1 }] })] }],
    unclaimed: [{ host: 'a1b2c3d4', team: 'ops/canvas/别队', pending_claim: { id: 5, principal: null, department: 'ops', confirm_by_text: '管理层或接收部门的负责人' } }, { host: 'a1b2c3d4', team: 'ops/canvas/又一队', pending_claim: null }] });
  ok('整形：can 照服务端（缺的、不是 true 的都当假）；没有 can 是 null（老应答）', J(pv.can) === J({ claim: false, propose_claim: true, add_lead: false, propose_lead: true, manage_departments: true }) && teamsOf({ departments: [] }).can === null);
  ok('整形：待确认的认领、团队负责人、部门负责人带上；坏的丢掉；没有的是 null',
    pv.unclaimed[0].pending_claim?.id === 5 && pv.unclaimed[1].pending_claim === null && pv.departments[0].pending_lead?.principal === 'user:li' && pv.departments[0].teams[0].pending_leads.length === 1);
  ok('「已提出，等〈谁〉确认」：谁照服务端给的；没给写「业务侧」', pendingText({ confirm_by_text: '属主' }) === '已提出，等属主确认' && pendingText({ confirm_by_text: '' }) === '已提出，等业务侧确认'
    && pendingText(teamsOf({ departments: [], unclaimed: [{ host: 'a1b2c3d4', team: 'x', pending_claim: { id: 1 } }] }).unclaimed[0].pending_claim) === '已提出，等业务侧确认');
  ok('写操作的应答：202 带提议、建部门带 lead_proposal 都是「已提出」；直接生效的（200、201 不带提议）不是',
    proposedText({ status: 202, body: { ok: true, proposed: true, proposal: { id: 1, confirm_by_text: '管理层或接收部门的负责人' } } }) === '已提出，等管理层或接收部门的负责人确认'
    && proposedText({ status: 201, body: { department: {}, lead_proposal: { id: 2, confirm_by_text: '属主' } } }) === '已提出，等属主确认'
    && proposedText({ status: 200, body: { ok: true, changed: true } }) === null && proposedText({ status: 201, body: { department: {} } }) === null && proposedText({ status: 202, body: null }) === null);
}

console.log(`\nteam-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
