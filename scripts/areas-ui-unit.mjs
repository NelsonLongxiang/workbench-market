#!/usr/bin/env node
/** 领域页（/areas）的说法和整形（web/src/areas-view.ts）：接口契约按后端领域第 1 步（PR2b、PR3a）给的。全是合成值。 */
const { AREA_ID_RE, PENDING_LEAD_HINT, STATUS_TEXT, actionError, areaFormProblem, areasOf, leadCandidates, leadLine, leadStepText, leadsOf, migrateResult, pageKind, personLabel } = await import('../web/src/areas-view.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const J = JSON.stringify;

const A = (id, name, status, extra = {}) => ({ id, name, status, spec_version: null, team_host: '', team: '', source: 'manual', created_at: 1, created_by: 'x', updated_at: 1, updated_by: 'x', ...extra });
const body = { areas: [A('fin', '利润核算', 'active', { spec_version: 3 }), A('buy', '采购跟单', 'pending-lead', { source: 'department' }), A('old', '旧领域', 'retired'), A('', '没标识', 'active'), A('x', 'x', 'weird'), null], can: { create: true, migrate: true, assign_lead: true } };
const v = areasOf(body);
ok('列表：形状不对的丢掉（没标识、状态认不出、不是对象）', v.areas.length === 3, J(v.areas));
ok('列表：等负责人的在前，再在用的，已撤的最后', v.areas.map((a) => a.id).join() === 'buy,fin,old');
ok('列表：由部门迁来的标出来；规范版本只认正整数', v.areas[0].fromDepartment && !v.areas[1].fromDepartment && v.areas[1].specVersion === 3 && v.areas[0].specVersion === null);
ok('can：三项照服务端给', v.can.create && v.can.migrate && v.can.assignLead);
ok('can：没给、给的不是严格的 true（比如 PR3a 之前的服务端没带 can）：都不能', J(areasOf({ areas: [] }).can) === J({ create: false, migrate: false, assignLead: false }) && areasOf({ can: { create: 'true', migrate: 1 } }).can.create === false);
ok('应答不是对象：空列表、都不能', areasOf(null).areas.length === 0 && areasOf('x').can.create === false);
ok('状态各一句人话，没有英文代号', ['pending-lead', 'active', 'retired'].every((s) => STATUS_TEXT[s] && !/[A-Za-z]/.test(STATUS_TEXT[s])) && PENDING_LEAD_HINT.includes('安排事'));

const leads = leadsOf({ area: {}, leads: [
  { grant: 3, principal: 'user:syn-c', display_name: '', status: 'disabled' },
  { grant: 2, principal: 'user:syn-b', display_name: '合成乙', status: 'pending' },
  { grant: 1, principal: 'user:syn-a', display_name: '合成甲', status: 'active' },
  { grant: 'x', principal: 'user:bad', status: 'active' }, { grant: 4, principal: '', status: 'active' }, { grant: 5, principal: 'user:z', status: 'gone' },
] });
ok('负责人：形状不对的丢掉；生效的在前，再待放行的，停用的最后', leads.map((l) => l.grant).join() === '1,2,3', J(leads));
ok('负责人那一行：生效的写名字，待放行的标出来，人停用的说不算；没显示名的不露 user: 前缀', leadLine(leads) === '合成甲、合成乙（待放行）、syn-c（人已停用，不算）' && !leadLine(leads).includes('user:'), leadLine(leads));
ok('没有负责人：写「还没有」', leadLine([]) === '还没有' && leadsOf(null).length === 0);
ok('人的说法：有显示名用显示名，没有去掉前缀', personLabel('user:syn-x', ' 合成 ') === '合成' && personLabel('user:syn-x', '') === 'syn-x');

const principals = { principals: [
  { id: 'user:syn-a', kind: 'person', status: 'active', display_name: '合成甲' }, { id: 'user:syn-b', kind: 'person', status: 'active', display_name: '合成乙' },
  { id: 'user:syn-c', kind: 'person', status: 'active', display_name: '合成丙' }, { id: 'user:syn-d', kind: 'person', status: 'disabled', display_name: '合成丁' },
  { id: 'seat:syn-e', kind: 'seat', status: 'active', display_name: '合成席位' },
] };
const cands = leadCandidates(principals, leads);
ok('可选的人：只列在用的人（不列停用的、席位）；已经是生效或待放行负责人的不再列；人停用了的负责人可以再列（他本人也停用了就不列）', cands.map((c) => c.id).join() === 'user:syn-c', J(cands));
ok('可选的人：主体清单读不到就是空', leadCandidates(null, []).length === 0);

ok('建领域：名字必填、1～64 个字、不带控制字符', /领域名字/.test(areaFormProblem('fin2', ' ', v.areas)) && /1～64/.test(areaFormProblem('fin2', '长'.repeat(65), v.areas)) && /控制字符/.test(areaFormProblem('fin2', 'a\nb', v.areas)));
ok('建领域：标识照服务端那条规则（小写字母开头，字母、数字、连字符，最多 48 个字）', /标识/.test(areaFormProblem('', '新', v.areas)) && ['Fin', '2fin', 'fin_x', 'a'.repeat(49)].every((i) => /小写字母开头/.test(areaFormProblem(i, '新', v.areas))) && AREA_ID_RE.test('a' + 'b'.repeat(47)));
ok('建领域：标识不能和已有的重（撤了的也占着）', /撤了的领域也占着/.test(areaFormProblem('old', '新', v.areas)) && areaFormProblem('fin-2', '利润核算二', v.areas) === null);

ok('出错：后端的错误代号各一句（不是属主、标识被占、给自己授予、领域已撤、最后一位负责人）',
  actionError(403, { error: 'areas_owner_only' }).includes('只有属主') && actionError(409, { error: 'area_exists', message: 'x' }).includes('撤了的领域也占着')
  && actionError(403, { error: 'self_grant' }).includes('不能给自己') && actionError(422, { error: 'area_retired' }).includes('已经撤了') && actionError(409, { error: 'area_last_lead' }).includes('至少要有一位'));
ok('出错：写请求总门的 403（error 是一句话、没有 message）按状态码说；有中文 message 的照用；断网说连不上；PR3a 前没有迁移接口说没有这个接口',
  actionError(403, { error: '需要有效的 X-Admin-Token 或站内管理员登录' }).includes('属主的站内账号') && actionError(400, { error: 'odd', message: '合成：服务端说的话' }) === '合成：服务端说的话'
  && actionError(0, null).includes('连不上') && actionError(404, {}).includes('还没有这个接口') && !actionError(400, { message: 'some_code_here' }).includes('some_code'));
ok('读列表的状态：200 正常；401 去登录；403 看不了；断网、别的出错', pageKind(200).kind === 'ok' && pageKind(401).kind === 'login' && pageKind(403).kind === 'forbidden' && pageKind(0).text.includes('连不上') && pageKind(500).kind === 'error');

const m = migrateResult({ created: [{ id: 'ops', name: '运营' }, { id: 'buy', name: '采购' }], drafted: [{ department: 'ops', grant: 9, principal: 'user:syn-a' }], skipped: [{ department: 'pd', reason: 'lead_without_grant' }, { department: 'x', reason: 'self_grant' }, { department: 'y', reason: 'unknown_code' }, { reason: 'id_invalid' }] });
ok('迁移结果：建了几个、起草了几条待你放行', m.created === 2 && m.drafted === 1 && m.summary === '建了 2 个领域，起草了 1 条负责人授予待你放行', J(m));
ok('迁移结果：跳过的每个部门说为什么（只有字段没授予、给自己、认不出的拒绝码）；没写部门的不列', m.skipped.length === 3 && m.skipped[0].includes('只写了名字') && m.skipped[1].includes('给自己') && m.skipped[2].includes('服务端拒了') && !m.skipped.join().includes('unknown_code'), J(m.skipped));
ok('迁移结果：再跑一次（三个数组都空）说都已经迁过了；应答看不懂不崩', migrateResult({ created: [], drafted: [], skipped: [] }).summary.includes('都已经迁过了') && migrateResult(null).created === 0);

ok('指定负责人：三步都成说已放行；停在起草说没指定上；停在提交、放行说已起草、到谁能做什么接着办',
  leadStepText(null, '合成甲', '').includes('已放行') && leadStepText('draft', '合成甲', '不能给自己授予').startsWith('没指定上：不能给自己')
  && leadStepText('submit', '合成甲', 'x').includes('已起草，但提交没成') && leadStepText('approve', '合成甲', 'x').includes('已起草并提交，但放行没成') && leadStepText('approve', '合成甲', 'x').includes('谁能做什么'));

console.log(`\nareas-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
