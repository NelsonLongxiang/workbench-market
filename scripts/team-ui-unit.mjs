#!/usr/bin/env node
/** 「团队」页的纯函数单测（web/src/team-view.ts）：应答整形、管理员视图、团队状态、负责人、成员归谁用、计数、空的说法、读不到和被拒的说法、建部门的校验。数据都是合成的。 */
// 在非 UTC 的时区里跑（东八区）：不带时区的时间写法要按 UTC 解析，在这里才看得出来
process.env.TZ = 'Asia/Shanghai';
import { actionProblem, assignedText, memberlessText, departmentsOf, emptyText, isAdminView, leadsOf, newDeptProblem, personName, memberLabel, nodeLabel, rosterAt, rosterStaleText, ROSTER_STALE_MIN, sourceProblem, teamCounts, teamStatusLabel, teamTitle, teamsOf, pendingText, proposedText , proposalsOf, knownNames, proposalTitle, proposerText, proposalGroups, rejectLabel, claimButtonText, LEAD_SKIPPED_TEXT, teamKey, outcomeLabel, outcomeReasonText, assignOps, assigneeOptions, assignDoneText, reassignHalfDoneText, unassignConfirmText, ASSIGN_BY_TEXT } from '../web/src/team-view.ts';

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

// ---------- 关系的提议 ----------
const P = (id, kind, more = {}) => ({ id, kind, status: 'pending', department_id: 'synthetic-ops', host: 'a1b2c3d4', team: 'ops/canvas/合成运营', principal_id: 'user:yi', proposed_by: 'admin-token', proposed_at: 1000 + id, confirm_by_text: '管理层或接收部门的负责人', can_approve: false, approve_denied_text: null, can_reject: false, ...more });
const props = proposalsOf({ proposals: [P(1, 'team-claim', { can_approve: true, can_reject: true }), P(2, 'team-lead', { mine: true, can_reject: true, confirm_by_text: '属主' }), P(3, 'dept-lead', { approve_denied_text: '只有属主能放行', can_reject: true }), P(4, 'team-claim', { status: 'approved' }), P(5, 'weird'), { id: 'x' }] });
ok('提议整形：can_approve、can_reject、mine 只认真正的布尔真（字符串 \'true\'、数字 1 都当不是）', (() => { const q = proposalsOf({ proposals: [P(31, 'team-claim', { can_approve: 'true', can_reject: 1, mine: 'true' }), P(32, 'team-claim', { can_approve: 1 })] }); return q[0].can_approve === false && q[0].can_reject === false && q[0].mine === null && q[1].can_approve === false && proposalGroups(q).forMe.length === 0 && rejectLabel(q[0]) === null; })());
ok('提议整形：只留待确认的、种类认得的；mine 没给是 null', props.length === 3 && props[0].mine === null && props[1].mine === true && props[2].approve_denied_text === '只有属主能放行');
const kn = knownNames(teamsOf({ departments: [{ id: 'synthetic-ops', name: '合成运营部', teams: [] }], unclaimed: [{ host: 'a1b2c3d4', team: 'ops/canvas/合成运营', name: '合成运营' }] }), [], [{ id: 'user:yi', name: '乙主管' }]);
ok('提议怎么说：认领、团队负责人、部门负责人；名字取页面已有的', proposalTitle(props[0], kn) === '把「合成运营」挂到「合成运营部」' && proposalTitle(props[1], kn) === '让 乙主管 做「合成运营」的负责人' && proposalTitle(props[2], kn) === '让 乙主管 做「合成运营部」的负责人');
const none = knownNames(teamsOf({ departments: [] }), null, []);
ok('名字页面也不知道时写人话，不露标识；服务端给了名字就用服务端的', proposalTitle(props[0], none) === '把「一个团队」挂到「一个部门」' && proposalTitle(props[1], none) === '让 一位同事 做「一个团队」的负责人' && proposalTitle(proposalsOf({ proposals: [P(9, 'team-claim', { team_name: '服务端团队', department_name: '服务端部门' })] })[0], none) === '把「服务端团队」挂到「服务端部门」');
ok('谁提的：服务端的名字；管理口令写「管理员」，本机命令行写「本机命令行」；对不到人写「一位同事」', proposerText(props[0], none) === '管理员' && proposerText(proposalsOf({ proposals: [P(9, 'team-claim', { proposed_by: 'cli' })] })[0], none) === '本机命令行' && proposerText(proposalsOf({ proposals: [P(9, 'team-claim', { proposed_by: 'user:zz' })] })[0], none) === '一位同事' && proposerText(proposalsOf({ proposals: [P(9, 'team-claim', { proposed_by_name: '丙' })] })[0], none) === '丙');
const g = proposalGroups(props);
ok('分组：能确认的进「等你确认」，自己提的进「你提的」（能确认也不进前一组），其余进「别的」', J(g.forMe.map((p) => p.id)) === '[1]' && J(g.mine.map((p) => p.id)) === '[2]' && J(g.others.map((p) => p.id)) === '[3]' && proposalGroups(proposalsOf({ proposals: [P(7, 'team-claim', { mine: true, can_approve: true })] })).forMe.length === 0);
ok('驳回按钮：自己提的叫「撤回」，别人提的叫「驳回」，服务端说不能就不出', rejectLabel(props[1]) === '撤回' && rejectLabel(props[0]) === '驳回' && rejectLabel(proposalsOf({ proposals: [P(8, 'team-claim')] })[0]) === null);
const dec = proposalsOf({ proposals: [
  P(41, 'team-claim', { status: 'rejected', outcome: 'expired', outcome_reason: '部门已经不在了', mine: true, decided_by_name: '系统' }),
  P(42, 'team-lead', { status: 'rejected', outcome: 'rejected', outcome_reason: '人选再议', mine: true }),
  P(43, 'team-lead', { status: 'rejected', outcome: 'withdrawn', mine: true }),
  P(44, 'team-claim', { status: 'approved', outcome: 'approved', mine: true }),
  P(45, 'team-claim', { status: 'approved', outcome: 'approved' }),
  P(46, 'team-claim', { status: 'rejected', mine: true }),
  P(47, 'team-claim', { outcome: 'weird', mine: true }),
  P(48, 'team-claim', { mine: true, can_reject: true }),
] });
ok('结局：处理过的只留自己提的、服务端给了结局的；别人的、没给结局的、结局不认得的都不列', J(dec.map((p) => p.id)) === '[41,42,43,44,48]');
const gd = proposalGroups(dec);
ok('你提的：待确认的在前，处理过的在后；别的两组只有待确认的', J(gd.mine.map((p) => p.id)) === '[48,41,42,43,44]' && gd.forMe.length === 0 && gd.others.length === 0);
ok('结局怎么说：失效叫「失效」不叫驳回；被驳回、已撤回、已确认；按 outcome 判，不看处理人', J(dec.slice(0, 4).map((p) => outcomeLabel(p).text)) === '["失效","被驳回","已撤回","已确认"]' && outcomeLabel(dec[4]).text === '待确认');
ok('结局的原因：失效、驳回写服务端的原因；撤回没给原因不写；失效没给原因写一句兜底；已确认不写', outcomeReasonText(dec[0]) === '原因：部门已经不在了' && outcomeReasonText(dec[1]) === '原因：人选再议' && outcomeReasonText(dec[2]) === null && outcomeReasonText({ outcome: 'expired', outcome_reason: null }) === '原因：没有人否决，已经不能确认了' && outcomeReasonText(dec[3]) === null);
ok('处理过的不出撤回、驳回（就算 can_reject 写成真）', rejectLabel({ ...dec[0], can_reject: true }) === null && rejectLabel(dec[4]) === '撤回');
ok('认领按钮照 can：能直接认领写「认领」，只能提议写「提议认领」，都不能不出；没给 can 照旧「认领」', claimButtonText({ claim: true, propose_claim: false }) === '认领' && claimButtonText({ claim: false, propose_claim: true }) === '提议认领' && claimButtonText({ claim: false, propose_claim: false }) === null && claimButtonText(null) === '认领');
ok('认领只是提议、选了负责人：补一句负责人等认领确认后再指定', /负责人等认领确认后再指定/.test(LEAD_SKIPPED_TEXT) && teamKey('a', 'b') !== teamKey('ab', ''));

// ---------- 成员分配（规范 14 第二节）----------
const asg = teamsOf({ departments: [{ id: 'ops', name: '运营部', teams: [
  team({ can_assign: true, assign_denied_text: null, assignable: [{ principal: 'user:wang', display_name: '王' }, { principal: 'user:zhao', display_name: '赵' }, { principal: 'user:wang', display_name: '王' }, { bad: 1 }, { principal: 'user:li', display_name: '' }],
    members: [member('ops/00000001', { name: '小算', assigned_to: { principal: 'user:wang', display_name: '王' } }), member('ops/00000002', { name: '小记' })], router: member('ops/r', { router: true }) }),
  team({ team: 'ops/canvas/另一个', can_assign: false, assign_denied_text: '只有这个团队的负责人或管理层能分配、收回成员', assignable: [{ principal: 'user:wang', display_name: '王' }], members: [member('ops/00000003')] }),
  team({ team: 'ops/canvas/没给', members: [member('ops/00000004')] }),
] }] }).departments[0].teams;
ok('整形：can_assign 只认 true；不能分配时不收 assignable（服务端给了也丢）；说法原样留', asg[0].can_assign === true && asg[1].can_assign === false && asg[2].can_assign === false
  && asg[1].assignable.length === 0 && asg[2].assignable.length === 0 && asg[1].assign_denied_text === '只有这个团队的负责人或管理层能分配、收回成员' && asg[2].assign_denied_text === null);
ok('整形：assignable 里坏的丢掉', asg[0].assignable.length === 4);
ok('操作：团队公用的出「分配给…」，已分配的出「改派」「收回」', J(assignOps(asg[0], asg[0].members[1])) === '{"assign":true,"reassign":false,"unassign":false}' && J(assignOps(asg[0], asg[0].members[0])) === '{"assign":false,"reassign":true,"unassign":true}');
ok('操作：总工不分配（不论当总工传进来、还是成员上标了 router）', J(assignOps(asg[0], asg[0].router, true)) === '{"assign":false,"reassign":false,"unassign":false}' && !assignOps(asg[0], member('x', { router: true })).assign);
ok('操作：can_assign 不是真、没给、团队待认领，一个都不出', J([assignOps(asg[1], asg[1].members[0]), assignOps(asg[2], asg[2].members[0]), assignOps({ ...asg[0], status: 'unclaimed' }, asg[0].members[1])].map((o) => o.assign || o.reassign || o.unassign)) === '[false,false,false]');
ok('选人：去重、按名字排；没显示名的用标识去前缀', J(assigneeOptions(asg[0], asg[0].members[1]).map((o) => o.label)) === J(['li', '王', '赵'].sort((a, b) => a.localeCompare(b, 'zh-CN'))));
ok('选人：改派时去掉现在归的那个人', !assigneeOptions(asg[0], asg[0].members[0]).some((o) => o.value === 'user:wang') && assigneeOptions(asg[0], asg[0].members[0]).length === 2);
ok('办成的说法：分配、改派直接生效写「已分配给」「已改派给」，是成功；回 202 照提议说，是提示、不当成已生效',
  J(assignDoneText('assign', '小记', '赵', { status: 201, body: { ok: true, id: 3 } })) === J({ kind: 'success', text: '「小记」已分配给 赵。' })
  && J(assignDoneText('reassign', '小算', '赵', { status: 201, body: { ok: true } })) === J({ kind: 'success', text: '「小算」已改派给 赵。' })
  && J(assignDoneText('assign', '小记', '赵', { status: 202, body: { ok: true, proposed: true, proposal: { id: 9, confirm_by_text: '业务侧负责人' } } })) === J({ kind: 'info', text: '「小记」分配给 赵：已提出，等业务侧负责人确认。' }));
ok('收回的说法：收回了写回到团队公用（成功）；本来就没分配（removed=false）照实说（提示）', assignDoneText('unassign', '小算', '', { status: 200, body: { ok: true, removed: true } }).text.includes('现在是团队公用') && J(assignDoneText('unassign', '小算', '', { status: 200, body: { ok: true, removed: false } })) === J({ kind: 'info', text: '「小算」本来就是团队公用。' }));
ok('收回的确认：照实说变成团队公用，分给他期间接手的事他照样看得到，之后的不算他的', unassignConfirmText('小算', '丙') === '收回后「小算」变成团队公用，由总工分派。它分给 丙 期间接手的事，丙 照样看得到；收回之后再接的事，不再算 丙 的。');
ok('名册过期：正常的团队改标「名册过期」（提醒色），不和「名册已 N 天没更新」打架；别的状态照旧', J(teamStatusLabel('active', true)) === J({ text: '名册过期', tone: 'warning' }) && teamStatusLabel('active', false).text === '正常' && teamStatusLabel('lead-vacant', true).text === '负责人缺位' && teamStatusLabel('active').text === '正常');
ok('系统管理员头卡上的一句：分配归负责人或管理层', ASSIGN_BY_TEXT === '成员分配由团队负责人或管理层做');
ok('改派一半：收回成了、分配没成，说清楚现在是团队公用；原因末尾的句号不重复', reassignHalfDoneText('小算', '赵', '只分给启用的人，user:zhao 不是。') === '「小算」已收回，但改派给 赵 没办成：只分给启用的人，user:zhao 不是。现在是团队公用，可以再分一次。');
ok('分配被拒：服务端的说法原样给（409 已分给别人、422 不是启用的人、403 不是负责人）', actionProblem({ status: 409, body: { error: 'seat_assigned', message: '这个成员已经分给 user:wang，先收回再分' } }) === '这个成员已经分给 user:wang，先收回再分' && actionProblem({ status: 403, body: { error: 'not_team_lead' } }) === '你的账号现在不能做这一步。');

console.log(`\nteam-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
