#!/usr/bin/env node
/** 台的 MCP 管理页（/bench-mcp/<台>，#904）和 MCP 网关页「台上的申请」的纯函数单测（web/src/bench-mcp-view.ts）。数据都是合成的。 */
import { asMcpPage, benchRequestRows, categoryText, decideProblem, grantSource, logActionText, mcpError, splitRequests, statusOf } from '../web/src/bench-mcp-view.ts';
import { grantDetailOf } from '../web/src/review-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);
const R = (id, status) => ({ id, status, bench: 'synth', tools: [], tool_kinds: [], reason: '', note: '', created_at: id, decided_at: null, session_id: 1, session: 's', decided_by: '' });

ok('状态说法：待批、已批准、已驳回、已失效；认不出的照写', statusOf('pending').text === '待批' && statusOf('approved').text === '已批准' && statusOf('rejected').text === '已驳回' && statusOf('expired').text === '已失效' && statusOf('odd').text === 'odd');
ok('读写：只有明写 read 的算只读，别的一律按写', categoryText('read') === '只读' && categoryText('write') === '写' && categoryText('admin') === '写' && categoryText('') === '写');
ok('授予从哪来：批准哪条申请来的，还是直接授予', grantSource(12) === '批准申请 #12' && grantSource(null) === '直接授予');
const sp = splitRequests([R(5, 'approved'), R(3, 'pending'), R(9, 'rejected'), R(1, 'pending'), R(7, 'expired')]);
ok('待批的先来先办（编号从小到大）；办过的（含失效）从新到旧', J(sp.pending.map((r) => r.id)) === '[1,3]' && J(sp.done.map((r) => r.id)) === '[9,7,5]');
ok('驳回必须写理由（空白不算）；批准可以不写；最多 500 字', decideProblem(false, '  ') !== '' && decideProblem(false, '不开放') === '' && decideProblem(true, '') === '' && decideProblem(true, '理'.repeat(501)).includes('500') && decideProblem(true, '理'.repeat(500)) === '');
ok('没成的说法：400、404、409 照服务端说，它没说给一句默认的；401、403、断网各一句；500 不透露原文',
  mcpError(409, { message: '申请 #3 已经批准过了' }) === '申请 #3 已经批准过了' && mcpError(409, null).includes('刷新') && mcpError(404, { message: '这个台上没有申请 #9' }).includes('#9') && mcpError(404, {}).includes('没有')
  && mcpError(400, { message: '不批要写理由' }) === '不批要写理由' && mcpError(401, null) === '请先登录' && mcpError(403, { message: 'x' }).includes('拍板') && mcpError(0, null).includes('连不上') && mcpError(500, { message: 'SQLITE raw' }) === '这次没成，稍后再试');
ok('台的授权页区分来源被拒和拍板权限不足', mcpError(403, { error: 'bench_views_cross_origin_denied' }).includes('请求来源') && mcpError(403, { error: 'bench_views_forbidden' }).includes('拍板'));
const page = { bench: { slug: 'synth', title: '合成台', workbench_id: 3 }, grants: [], requests: [], log: [], can: { decide: true } };
ok('管理页应答：像样的照收（旧应答没有 unmatched 当空的）；can.decide 只认 true', asMcpPage(page)?.unmatched.length === 0 && asMcpPage(page)?.can.decide === true && asMcpPage({ ...page, can: { decide: 'yes' } })?.can.decide === false && asMcpPage({ ...page, can: undefined })?.can.decide === false);
ok('管理页应答不像样（缺台、缺清单、不是对象）：当读取出错，不显示成「没有申请」', asMcpPage(null) === null && asMcpPage({ ...page, bench: undefined }) === null && asMcpPage({ ...page, requests: undefined }) === null && asMcpPage({ ...page, log: 'x' }) === null && asMcpPage('x') === null);
ok('留痕动作的说法', logActionText('approve') === '批准申请' && logActionText('reject') === '驳回申请' && logActionText('grant') === '直接授予' && logActionText('revoke') === '收回' && logActionText('expire') === '到期失效' && logActionText('other') === 'other');

// 「台上的申请」：从「关注」的 bench-mcp 条目换来
const item = (source_id, detail, source = 'bench-mcp') => ({ source, source_id, detail });
const rows = benchRequestRows([
  item('synth:12', { session: 'seat-a', bench: 'synth', bench_title: '合成台', bench_registered: true, workbench_id: 3, tools: [{ tool: 'dataset_list', category: 'read' }, { tool: 'dataset_append', category: 'write' }], reason: '维护', created_at: 1 }),
  item('wb-7:4', { session: 'seat-b', bench: 'wb-7', bench_title: '合成卡片', bench_registered: false, workbench_id: 7, tools: [{ tool: 'view_get', category: 'read' }], reason: '看页面', created_at: 2 }),
  item('x:1', { session: 'z' }, 'mcp-access'),
  item('no-number', { session: 'z', bench: 'b', tools: [] }),
], grantDetailOf);
ok('台上的申请：只收 bench-mcp 来源、编号读得出的；按编号先来先办', J(rows.map((r) => r.key)) === J(['wb-7:4', 'synth:12']));
ok('台登记过的链到台的授权页；还没开台库的卡片链到「等你拍板」（批准会顺带开台库）；工具读写分开', rows[1].to === '/bench-mcp/synth' && rows[1].registered && J(rows[1].read) === '["dataset_list"]' && J(rows[1].write) === '["dataset_append"]' && rows[0].to === '/attention' && rows[0].registered === false && rows[0].id === 4);

console.log(`\nbench-mcp-page-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
