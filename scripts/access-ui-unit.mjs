#!/usr/bin/env node
/** 「谁能做什么」页的纯函数单测（web/src/access-view.ts）：状态、范围、期限的说法，待核准卡片，按人排的权限表，矩阵格子，读不到时怎么说。数据都是合成的。 */
import { ACCESS_TABS, CELL_LEGEND, actionProblem, cellLabel, declineReasonOk, grantActorRaw, grantRows, grantsOf, indexPrincipals, kindLabel, matrixOf, pendingGrants, principalName, responsibleOf, roleName, roleUsage, rolesOf, scopeLabel, scopeNotYetEffective, sourceProblem, statusLabel, tabFromQuery, termLabel, myRolesOf, summaryDo, OTHERS_ONLY_ADMINS, approvalText, approveState } from '../web/src/access-view.ts';
import { actorLabel } from '../web/src/people.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);
const NOW = Date.parse('2026-11-12T12:00:00Z');

ok('页签：人和权限、角色预设两个（以某人的身份看等身份线的接口，先不出现）', J(ACCESS_TABS.map((t) => t.name)) === '["人和权限","角色预设"]');
ok('页签：地址里认得 roles，其余都当人和权限', tabFromQuery('roles') === 'roles' && tabFromQuery('as') === 'people' && tabFromQuery(null) === 'people');

ok('状态：待核准、生效中、草稿、已过期、已收回；颜色跟着', J(['pending', 'active', 'draft', 'expired', 'revoked'].map((s) => statusLabel(s).text)) === '["待核准","生效中","草稿","已过期","已收回"]' && statusLabel('active').tone === 'success' && statusLabel('pending').tone === 'warning');
ok('状态：原型链上的名字不当成状态（toString）', statusLabel('toString').text === 'toString' && statusLabel('toString').tone === 'default');

ok('范围：* 是全部、self 只限自己、工作台和流程说成人话、认不出的原样', scopeLabel('*') === '全部' && scopeLabel('self') === '只限自己' && scopeLabel('bench:12') === '工作台 12' && scopeLabel('sop:purchase') === '流程 purchase' && scopeLabel('domain:nope') === '这一块 nope' && scopeLabel('domain:work', new Map([['work', '事项与对话']])) === '「事项与对话」这一块' && scopeLabel('weird') === 'weird' && scopeLabel('constructor:x') === 'constructor:x');
ok('按范围的授予尚未生效：只标生效中、范围不是全部的', scopeNotYetEffective({ scope: 'bench:1', status: 'active' }) && !scopeNotYetEffective({ scope: '*', status: 'active' }) && !scopeNotYetEffective({ scope: 'bench:1', status: 'pending' }));

ok('期限：没有是长期；以后的写到哪天；过了的写已到期', termLabel(null, NOW) === '长期' && termLabel(Date.parse('2026-12-31T12:00:00Z'), NOW) === '到 2026-12-31' && termLabel(Date.parse('2026-11-01T12:00:00Z'), NOW).startsWith('已到期'));

const principals = indexPrincipals({ principals: [
  { id: 'user:alpha', kind: 'person', display_name: '甲', owner: '', status: 'active' },
  { id: 'user:beta', kind: 'person', display_name: '', owner: '', status: 'active' },
  { id: 'seat:robot', kind: 'seat', display_name: '小助', owner: 'user:alpha', status: 'active' },
  { bad: true },
] });
ok('主体：有显示名用显示名，没有就去掉前缀', principalName('user:alpha', principals) === '甲' && principalName('user:beta', principals) === 'beta' && principalName('user:gamma', principals) === 'gamma');
ok('主体：形状不对的跳过；应答不是对象按空', principals.size === 3 && indexPrincipals(null).size === 0 && indexPrincipals({ principals: 'x' }).size === 0);
ok('种类：人、AI 员工、工作台、系统、外部节点', J(['person', 'seat', 'app', 'system', 'node'].map(kindLabel)) === '["人","AI 员工","工作台","系统","外部节点"]' && kindLabel('toString') === '');
ok('负责人：人是本人；AI 员工是它挂在谁名下', responsibleOf('user:alpha', principals) === '本人' && responsibleOf('seat:robot', principals) === '甲' && responsibleOf('nobody', principals) === '本人');

const withIds = indexPrincipals({ principals: [{ id: 'user:alpha', kind: 'person', display_name: '甲', owner: '', status: 'active', identities: [{ provider: 'odoo', external_id: 'alpha' }] }] });
ok('谁给的：本机命令行；管理员登录对得到人用名字，对不到用登录名；其余交给 people.ts', actorLabel(grantActorRaw('cli'), '') === '本机命令行' && actorLabel(grantActorRaw('odoo:alpha', withIds), '') === '甲' && actorLabel(grantActorRaw('odoo:zed', withIds), '') === 'zed' && actorLabel(grantActorRaw('odoo:alpha'), '') === 'alpha' && actorLabel(grantActorRaw('admin-token'), '') === '管理员');

const g = (id, principal_id, status, more = {}) => ({ id, principal_id, role: 'member', scope: '*', expires_at: null, reason: '', status, created_by: 'cli', approved_by: null, created_at: id, updated_at: id, ...more });
const grants = grantsOf({ grants: [g(1, 'user:beta', 'active'), g(2, 'user:alpha', 'revoked'), g(3, 'user:alpha', 'active', { role: 'admin' }), g(4, 'seat:robot', 'pending', { updated_at: 50 }), g(5, 'user:alpha', 'pending', { updated_at: 10 }), { id: 'x' }] });
ok('授予：形状不对的跳过；应答不是对象按空', grants.length === 5 && grantsOf({ error: 'x' }).length === 0 && grantsOf(null).length === 0);
ok('待核准：只要 pending，先提交的在前', J(pendingGrants(grants).map((x) => x.id)) === '[5,4]');
const every = grantsOf({ grants: ['draft', 'pending', 'active', 'revoked', 'expired', 'toString', ''].map((st, i) => g(i + 1, 'user:alpha', st)) });
ok('待核准的卡片只收待核准：草稿、生效中、已收回、已过期、认不出的状态都不进', J(pendingGrants(every).map((x) => x.status)) === '["pending"]');
const rowsIds = grantRows(grants, principals).map((x) => x.id);
const whoSeq = grantRows(grants, principals).map((x) => x.principal_id);
ok('表：同一个人的行挨在一起（按名字排）', whoSeq.every((w, i) => i === 0 || w === whoSeq[i - 1] || !whoSeq.slice(0, i).includes(w)), J(whoSeq));
ok('表：同一个人按状态排：待核准、生效中…已收回', J(rowsIds.filter((id) => [5, 3, 2].includes(id))) === '[5,3,2]', J(rowsIds));
ok('角色在用：只数生效中的', roleUsage(grants).get('member') === 1 && roleUsage(grants).get('admin') === 1 && !roleUsage(grants).has('nobody'));

const roles = rolesOf({ roles: [{ id: 'owner', name: '属主', platform: true }, { id: 'member', name: '成员' }], custom: [] });
ok('角色名：认得的用名字，不认得的原样', roleName('owner', roles) === '属主' && roleName('ghost', roles) === 'ghost' && rolesOf(null).size === 0);

ok('矩阵格子：全部、范围内、部分、只限自己、不能、没有这类动作', J(CELL_LEGEND.map((c) => cellLabel(c).text)) === '["全部","范围内","部分","只限自己","不能","—"]' && cellLabel('toString').text === '—');
ok('矩阵：形状对才用，不然按读不到', matrixOf({ blocks: [], kinds: [], roles: [] }) !== null && matrixOf({ blocks: [] }) === null && matrixOf(null) === null);

ok('读不到：401 请先登录、403 现在只有管理员能看、404 没上线、其余读不到', sourceProblem('授予', { status: 401 }).text.startsWith('请先登录') && sourceProblem('授予', { status: 403 }).text.includes('现在只有管理员能看') && sourceProblem('授予', { status: 404 }).type === 'info' && sourceProblem('授予', { status: 0 }).text === '读不到授予，稍后再试。' && sourceProblem('授予', { status: 200 }) === null);
ok('核准、不给被拒：服务端给了说法就用它', actionProblem({ status: 403, body: { error: 'owner_required', message: '角色 admin 是管理员级的，只有属主能放行' } }).includes('只有属主') && actionProblem({ status: 200, body: {} }) === null && actionProblem({ status: 500, body: null }) === '没办成，稍后再试。');
ok('不给的理由：去掉空白后 1～500 字', declineReasonOk('不需要') && !declineReasonOk('   ') && !declineReasonOk('长'.repeat(501)));
ok('说法里没有开发用语', [sourceProblem('授予', { status: 403 }).text, sourceProblem('角色', { status: 500 }).text].every((t) => !/接口|字段|暂无数据|待实现/.test(t)));

// 你的权限（非管理员）：/api/auth/me 的本人角色
const me = { authenticated: true, principal: 'user:bing', roles: [{ id: 'member', name: '普通员工', scope: '*', preset: true, expires_at: null }, { id: 'dept-lead', name: '', scope: 'domain:work', expires_at: NOW + 86400000 }, null, { name: '缺 id' }] };
const mine = myRolesOf(me);
ok('你的权限：认出了人才有列表；名字空的用角色键；坏项丢掉', J(mine?.map((r) => r.name)) === '["普通员工","dept-lead"]' && mine[1].scope === 'domain:work' && mine[1].expires_at === NOW + 86400000);
ok('你的权限：没登录、只有口令（principal 为空）、读不到都是 null；认出了人没有角色是空列表', myRolesOf(null) === null && myRolesOf({ authenticated: false, roles: [] }) === null && myRolesOf({ authenticated: true, principal: null, roles: [] }) === null && J(myRolesOf({ authenticated: true, principal: 'user:x', roles: [] })) === '[]');
ok('读不到矩阵时，块的范围也说名字（「事项与对话」这一块）；矩阵给的名字优先；原型链上的名字不当块名', scopeLabel('domain:work') === '「事项与对话」这一块' && scopeLabel('domain:work', new Map([['work', '事项']])) === '「事项」这一块' && scopeLabel('domain:toString') === '这一块 toString');
ok('别人的权限谁能看：一句话', OTHERS_ONLY_ADMINS === '别人的权限现在只有管理员能看。');
ok('能做一格：去掉「能做：」前缀和「；能管：…」', summaryDo('能做：事项与对话（全部）；能管：全景（全部）、关注（全部）') === '事项与对话（全部）' && summaryDo('能做：无') === '无' && summaryDo(undefined) === '');

// 要谁放行：服务端给的 approval_text 原样用；没有这个字段（服务端还没加）就不显示
const rolesWithApproval = rolesOf({ roles: [{ id: 'management', name: '管理层', approval: 'owner', approval_text: '只有属主能放行' }, { id: 'member', name: '普通员工', approval: 'admin', approval_text: '  管理员即可放行 ' }, { id: 'guest', name: '访客' }, { id: 'odd', name: '怪', approval_text: 7 }] });
ok('要谁放行：照服务端的说法原样显示（去掉两头空白）；没有字段、不是字符串、没有这个角色都不显示', approvalText('management', rolesWithApproval) === '只有属主能放行' && approvalText('member', rolesWithApproval) === '管理员即可放行' && approvalText('guest', rolesWithApproval) === null && approvalText('odd', rolesWithApproval) === null && approvalText('nope', rolesWithApproval) === null);

// 核准按钮：照服务端的 can_approve；没这个字段照旧可点
ok('核准按钮：服务端说能 → 可点、不写说法；说不能 → 置灰、写服务端的短说法；说不能却没给说法 → 置灰、写通用的一句；没这个字段 → 照旧可点',
  J(approveState({ can_approve: true, approve_denied_text: null })) === '{"enabled":true,"note":null}'
  && J(approveState({ can_approve: false, approve_denied_text: ' 只有属主能放行 ' })) === '{"enabled":false,"note":"只有属主能放行"}'
  && J(approveState({ can_approve: false, approve_denied_text: null })) === '{"enabled":false,"note":"你现在放行不了这一项"}'
  && J(approveState({})) === '{"enabled":true,"note":null}' && approveState({ can_approve: 'false' }).enabled === true);

// 部门范围不露标识：服务端带了 scope_name 就写名字，没带写「一个部门」；别的范围有名字也用名字
ok('部门范围：有显示名写名字，没有写「一个部门」，都不露 dept: 标识', scopeLabel('dept:trial-dev', undefined, '研发部') === '「研发部」这个部门' && scopeLabel('dept:trial-dev') === '一个部门'
  && scopeLabel('dept:trial-dev', undefined, '  ') === '一个部门' && scopeLabel('dept:x', undefined, 5) === '一个部门' && !scopeLabel('dept:trial-dev').includes('trial-dev'));
ok('别的范围带了显示名就用名字（工作台「…」、「…」这一块）；没带照旧', scopeLabel('bench:12', undefined, '采购台') === '工作台「采购台」' && scopeLabel('domain:work', undefined, '事项') === '「事项」这一块' && scopeLabel('bench:12') === '工作台 12' && scopeLabel('*', undefined, '名字') === '全部');
ok('「你的权限」带上服务端给的范围显示名，没给就不带', myRolesOf({ authenticated: true, principal: 'user:a', roles: [{ id: 'dept-lead', name: '部门负责人', scope: 'dept:d1', scope_name: ' 研发部 ' }, { id: 'member', scope: '*' }] }).map((r) => r.scope_name ?? '-').join() === '研发部,-');

console.log(`\naccess-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
