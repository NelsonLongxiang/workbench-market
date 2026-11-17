#!/usr/bin/env node
/** 条目自带答复入口（answer_via 约定）的纯函数单测（web/src/attention-view.ts）和 AI 会话申请工具那张卡怎么写（web/src/review-view.ts）。
 *  全是合成值。 */
import { answerChoices, answerRoute, answerViaOf, decideCount, safeApiPath, viaBody, viaChoices, viaError, viaInput, viaPath } from '../web/src/attention-view.ts';
import { grantCard, grantDetailOf } from '../web/src/review-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const quiet = () => {};

const via = { method: 'POST', path: '/api/bench-views/demo-bench/mcp-requests/7', answers: {
  approve: { body: { approve: true }, input: { note: { to: 'note', max: 500 } } },
  reject: { body: { approve: false }, input: { note: { to: 'note', required: true, max: 500 } } } } };
const item = (answer_via, extra = {}) => ({ source: 'bench-mcp', source_id: 'demo-bench:7', category: 'grant', kind: 'bench-mcp', answers: ['approve', 'reject'], mine: true, answer_via, ...extra });

ok('地址只认同源、以 /api/ 开头的相对路径', safeApiPath('/api/x/1') && safeApiPath('/api/x?a=1')
  && !safeApiPath('//evil.invalid/api/x') && !safeApiPath('https://evil.invalid/api/x') && !safeApiPath('/api/../admin') && !safeApiPath('/apix/1')
  && !safeApiPath('api/x') && !safeApiPath('/api\\x') && !safeApiPath('/api/x\n') && !safeApiPath(undefined) && !safeApiPath('/api/%2e%2e/admin'));
{
  const v = answerViaOf(item(via), quiet);
  ok('读得出方法、地址、每个答法的请求体和要填的一项', v && v.method === 'POST' && v.path === via.path && v.answers.approve.body.approve === true
    && v.answers.approve.input.to === 'note' && v.answers.approve.input.required === false && v.answers.approve.input.max === 500 && v.answers.reject.input.required === true, JSON.stringify(v));
  ok('请求体 = body 加填的那一项；选填没填的不带；填的会去掉首尾空白', JSON.stringify(viaBody(v, 'approve')) === '{"approve":true}' && JSON.stringify(viaBody(v, 'approve', '   ')) === '{"approve":true}'
    && JSON.stringify(viaBody(v, 'reject', ' 先不开 ')) === '{"approve":false,"note":"先不开"}' && JSON.stringify(viaBody(v, 'nope', 'x')) === '{}');
  ok('超过上限的截到上限', viaBody(v, 'reject', '字'.repeat(600)).note.length === 500);
  ok('答法要不要先填：按条目说的', viaInput(v, 'reject')?.required === true && viaInput(v, 'approve')?.required === false && viaInput(v, 'nope') === null);
  ok('只给条目列了、入口也说了怎么发的答法，按条目的顺序', JSON.stringify(viaChoices(v, ['reject', 'later', 'approve'])) === '["reject","approve"]');
}
{
  const warns = [];
  const w = (m) => warns.push(m);
  ok('没带的不告警，返回 null', answerViaOf(item(undefined), w) === null && answerViaOf(item(null), w) === null && warns.length === 0);
  ok('地址不对、方法不对、形状不对：当没带，并留一条告警', answerViaOf(item({ ...via, path: 'https://evil.invalid/api/x' }), w) === null && answerViaOf(item({ ...via, method: 'DELETE' }), w) === null
    && answerViaOf(item('x'), w) === null && answerViaOf(item({ method: 'POST', path: '/api/x' }), w) === null && warns.length === 4 && warns.every((m) => m.includes('demo-bench:7')), JSON.stringify(warns));
  const two = answerViaOf(item({ method: 'PUT', path: '/api/x', answers: { a: { body: {}, input: { p: { to: 'p', required: true }, q: { to: 'q', required: true } } }, b: { input: { p: { to: 'p' }, q: { to: 'q', required: true } } }, c: {} } }), w);
  ok('多个必填项的答法卡片上办不了，不给；一必填一选填认必填的；没写 body、input 的照空的办', two && !('a' in two.answers) && two.answers.b.input.to === 'q' && two.answers.b.input.max === 4000
    && two.answers.c.input === null && JSON.stringify(two.answers.c.body) === '{}' && two.method === 'PUT', JSON.stringify(two));
  ok('填写项没写发到哪个键的不认', answerViaOf(item({ method: 'POST', path: '/api/x', answers: { a: { body: {}, input: { p: { required: true } } } } }), w).answers.a.input === null);
}
{
  const warns = [];
  const v = answerViaOf(item({ method: 'POST', path: '/api/work-items/demo-1/release', answers: {
    release: { body: {} },
    withdraw: { path: '/api/work-items/demo-1/withdraw', body: {}, input: { why: { to: 'reason', required: true, options: ['写错了', '不做了', '写错了', 7, ''] } } },
    bad: { path: '//evil.invalid/api/x', body: {} } } }, { answers: ['release', 'withdraw', 'bad'] }), (m) => warns.push(m));
  ok('答法自己带地址的用它，没带用顶层的', viaPath(v, 'release') === '/api/work-items/demo-1/release' && viaPath(v, 'withdraw') === '/api/work-items/demo-1/withdraw');
  ok('答法自己的地址不能用：不给这个答法（不退回顶层地址），留一条告警', !('bad' in v.answers) && JSON.stringify(viaChoices(v, ['release', 'withdraw', 'bad'])) === '["release","withdraw"]' && warns.length === 1 && warns[0].includes('bad'), JSON.stringify(warns));
  ok('填写项带选项：去重、只留字符串；请求体只认选项里的值', JSON.stringify(viaInput(v, 'withdraw').options) === '["写错了","不做了"]' && JSON.stringify(viaBody(v, 'withdraw', '不做了')) === '{"reason":"不做了"}' && JSON.stringify(viaBody(v, 'withdraw', '别的')) === '{}');
  ok('没带选项的是自由文本', viaInput(answerViaOf(item(via), quiet), 'reject').options.length === 0);
}
ok('自带答复入口的：不看是不是管理员，都按入口给答法、走 via', JSON.stringify(answerChoices(false, item(via))) === '["approve","reject"]' && JSON.stringify(answerChoices(true, item(via))) === '["approve","reject"]'
  && answerRoute(false, item(via)) === 'via' && answerRoute(true, item(via)) === 'via');
ok('入口不能用的照旧：不是管理员没有答法，管理员走答复入口', answerChoices(false, item({ ...via, path: '//evil.invalid/api' })).length === 0 && answerRoute(true, item({ ...via, path: '//evil.invalid/api' })) === 'attention');
ok('没带入口的条目一点不变', answerRoute(true, { source: 'change-requests', category: 'review' }) === 'attention' && answerRoute(false, { source: 'seat-asks', category: 'ask' }) === 'ask'
  && answerRoute(false, { source: 'work-items', category: 'accept' }) === 'creator');
ok('等你拍板的件数把它算进去（不是管理员也算）', decideCount([item(via), item(via, { mine: false }), item(undefined)], (x) => answerChoices(false, x)) === 1);
ok('没办成：有 message 原样给；没有按状态说', viaError(400, { error: 'invalid', message: '不批要写理由（note）' }) === '不批要写理由（note）' && viaError(409, { error: 'conflict' }) === '这一条已经有人办过了，刷新看看'
  && viaError(401, null) === '请先登录' && viaError(403, {}) === '你没有权限办这一条' && viaError(500, 'x') === '没办成' && viaError(400, { message: '  ' }) === '没办成');

{
  const detail = { session: 'demo-session', bench: 'demo-bench', bench_title: '合成台', tools: [{ tool: 'list_rows', category: 'read' }, { tool: 'update_row', category: 'write' }, { tool: 'odd' }, 7], reason: ' 要查上周的数 ', created_at: 1 };
  const d = grantDetailOf(item(via, { detail }));
  ok('申请详情：读、写分开；没写明是读的按写算；只认 bench-mcp 来源', d && JSON.stringify(d.read) === '["list_rows"]' && JSON.stringify(d.write) === '["update_row","odd"]' && d.reason === '要查上周的数'
    && grantDetailOf({ source: 'tasks', detail }) === null && grantDetailOf(item(via)) === null, JSON.stringify(d));
  const c = grantCard(d);
  ok('卡片：标题说哪个会话要用哪个台的几个工具；会改数据的单独提醒；带申请理由', c.title === 'AI 会话「demo-session」想用工作台「合成台」的 3 个工具' && c.lines[0] === '只读：list_rows' && c.lines[1] === '申请理由：要查上周的数' && c.warn === '会改数据：update_row、odd', JSON.stringify(c));
  const e = grantCard(grantDetailOf(item(via, { detail: { tools: 'x' } })));
  ok('字段缺了照实说，不崩', e.title === 'AI 会话「没写名字」想用工作台「没写是哪个」的工具' && e.lines[0] === '没写申请理由' && e.warn === '', JSON.stringify(e));
  const many = grantCard(grantDetailOf(item(via, { detail: { session: 's', bench: 'b', tools: ['a', 'b', 'c', 'd', 'e', 'f'].map((tool) => ({ tool, category: 'read' })) } })));
  ok('工具多了只列前四个，写总数；没有台名用台的代号', many.lines[0] === '只读：a、b、c、d 等 6 个' && many.title.includes('「b」'), JSON.stringify(many));
}

console.log(`\n${pass} 过，${fail} 没过`);
process.exit(fail ? 1 : 0);
