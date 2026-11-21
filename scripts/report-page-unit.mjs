#!/usr/bin/env node
/** 报告页（/use/<卡片 id>/reports，报告第 1 步 PR D）的纯函数单测（web/src/report-page-view.ts）：地址、分组、并排取哪几份、回应接在谁后面、错误说法。数据都是合成的。 */
import { STANCE_TEXT, actorKindText, gateText, groupBySubject, headsOf, kindLabel, myHead, replacedIds, reportError, reportRoute, respondProblem, stanceText } from '../web/src/report-page-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);
const Q = (s) => new URLSearchParams(s);
const R = (id, dimension_id, subject, at, extra = {}) => ({ id, dimension_id, subject, created_at: at, superseded_by: null, supersedes: null, template_version: 1, binding_version: 1, content_sha256: 'x', producer: 'user:alpha', producer_kind: 'human', ...extra });
const resp = (id, claim_key, stance, extra = {}) => ({ id, report_id: 1, claim_key, stance, reason: '合成', responder: 'user:alpha', responder_kind: 'human', position: '', supersedes: null, created_at: id, mine: true, ...extra });

// 地址
ok('地址：?report=<编号> 看一份；?subject=<事物> 并排；都没有是清单', J(reportRoute(Q('report=12'))) === J({ kind: 'one', id: 12 }) && J(reportRoute(Q('subject=item:7'))) === J({ kind: 'subject', subject: 'item:7' }) && reportRoute(Q('')).kind === 'list');
ok('地址：认不出的当没写（编号不是正整数、事物写法不对）；report 和 subject 都写了以 report 为准', reportRoute(Q('report=0')).kind === 'list' && reportRoute(Q('report=1e3')).kind === 'list' && reportRoute(Q('subject=Item:7')).kind === 'list' && reportRoute(Q('subject=item')).kind === 'list' && reportRoute(Q('report=3&subject=item:7')).kind === 'one');

// 分组与并排
const list = [
  R(1, 'finance', 'item:7', 100, { superseded_by: 3 }),
  R(2, 'risk', 'item:7', 110),
  R(3, 'finance', 'item:7', 120, { supersedes: 1 }),
  R(4, 'finance', 'item:9', 90),
  R(5, 'risk', 'item:7', 105),
];
const g = groupBySubject(list);
ok('分组：按事物分，最近有新报告的事物排前面', J(g.map((x) => x.subject)) === J(['item:7', 'item:9']) && g[0].latest === 120);
ok('并排：一件事物下每个维度一份，按维度标识排；被更正过的不选，选更正后的那份', J(g[0].dims.map((d) => [d.dimension_id, d.head.id])) === J([['finance', 3], ['risk', 5]]));
ok('并排：同一维度有几份各自独立生成的链头，取编号最大的，另有几份记在 others', g[0].dims.find((d) => d.dimension_id === 'risk').others === 1 && g[0].dims.find((d) => d.dimension_id === 'finance').others === 0);
ok('并排：全部被更正（链头不在这批里）的维度不出；没有一份能看的事物整组不出', J(headsOf([R(1, 'a', 's:1', 1, { superseded_by: 2 })])) === '[]' && J(groupBySubject([R(1, 'a', 's:1', 1, { superseded_by: 2 })])) === '[]');

// 回应接在谁后面
const rs = [
  resp(10, 'conclusion-1', 'dispute'),
  resp(11, 'conclusion-1', 'agree', { supersedes: 10 }),
  resp(12, 'conclusion-1', 'dispute', { mine: false, responder: 'mcp:seat', responder_kind: 'ai' }),
  resp(13, '', 'supplement'),
  resp(14, 'risk-1', 'agree', { mine: false, responder: 'user:beta' }),
];
ok('改主意接在自己的链头：自己这条论断上没被接掉的最新一条（不是别人的、不是别的论断的）', myHead(rs, 'conclusion-1')?.id === 11 && myHead(rs, '')?.id === 13 && myHead(rs, 'risk-1') === null);
ok('自己没回应过、或者没标 mine（读接口没给读的人）：没有链头，回应是新起一条', myHead([], 'conclusion-1') === null && myHead(rs.map((r) => ({ ...r, mine: undefined })), 'conclusion-1') === null);
ok('被接掉（改过主意）的回应：划掉显示', J([...replacedIds(rs)]) === '[10]');

// 回应框、说法
ok('回应框：立场要是模板允许的；理由必填（空白不算）、最多 4000 字', respondProblem(['agree', 'dispute'], 'supplement', '理由') === '先选一个立场' && respondProblem(['agree'], '', '理由') === '先选一个立场' && respondProblem(['agree'], 'agree', '  ') === '理由必填' && respondProblem(['agree'], 'agree', '理'.repeat(4001)).includes('4000') && respondProblem(['agree'], 'agree', '理'.repeat(4000)) === '');
ok('没成的说法：400、404、409 照服务端说，它没说给一句默认的；401、403、断网各一句；500 不透露原文',
  reportError(400, { message: '理由必填：1～4000 个字' }) === '理由必填：1～4000 个字' && reportError(409, { message: '只能接在你自己回应链的链头上' }).includes('链头') && reportError(409, null).includes('刷新')
  && reportError(404, {}) === '没有这份报告' && reportError(401, null) === '请先登录' && reportError(403, { message: 'x' }).includes('权限') && reportError(0, null).includes('连不上') && reportError(500, { message: 'SQLITE_ERROR raw' }) === '这次没成，稍后再试');
ok('立场、类别、人或 AI、验收声明的说法', STANCE_TEXT.dispute === '反驳' && stanceText('agree') === '认可' && stanceText('other') === 'other' && kindLabel([{ kind: 'conclusion', label: '结论' }], 'conclusion') === '结论' && kindLabel([], 'risk') === 'risk'
  && actorKindText('ai') === 'AI' && actorKindText('human') === '人' && gateText(null) === '' && gateText({ open_dispute_blocks_acceptance: true }).includes('不能验收') && gateText({ open_dispute_blocks_acceptance: false }).includes('也可以验收'));

console.log(`\nreport-page-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
