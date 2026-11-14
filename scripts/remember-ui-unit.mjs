#!/usr/bin/env node
/** 「把这次的取舍记成经验」（#745）的纯函数单测（web/src/remember-view.ts）：缺省档、要交什么、能不能交、办完以后说什么、「我处理过的」、拍板人。数据都是合成的。 */
import { viaTakesRemember, answerViaOf } from '../web/src/attention-view.ts';
import { CUE_MAX, LESSON_MAX, answeredWithRemember, decidedByLine, defaultsOf, recentOf, recentTitle, rememberLaterResult, rememberPayload, rememberProblem, rememberedLabel, visibilityOptions } from '../web/src/remember-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

const D = defaultsOf({ default_visibility: 'department', department_name: '采购部' });
const R = defaultsOf({ default_visibility: 'restricted', department_name: null });
ok('缺省档：推得出部门是本部门；推不出、没给、形状不对、写着全公司，都落在「只给管理层」，永远不落在「全公司」',
  D.default_visibility === 'department' && D.department_name === '采购部' && R.default_visibility === 'restricted'
  && defaultsOf(null).default_visibility === 'restricted' && defaultsOf({ default_visibility: 'company' }).default_visibility === 'restricted'
  && defaultsOf({ default_visibility: 'department', department_name: '' }).default_visibility === 'restricted');
ok('三个选项按范围从窄到宽：只给管理层 / 本部门（写部门名）/ 全公司；推不出部门时本部门置灰', J(visibilityOptions(D).map((o) => [o.value, o.label, o.disabled])) === J([['restricted', '只给管理层', false], ['department', '本部门（采购部）', false], ['company', '全公司', false]]) && visibilityOptions(R)[1].disabled && visibilityOptions(R)[1].label === '本部门');
ok('要交的：lesson 去空格；cue 空着不传；谁能看总是带上页面选中的那一档（不靠服务端的缺省）', J(rememberPayload(' 先退回整改 ', '  ', 'department')) === J({ lesson: '先退回整改', visibility: 'department' }) && J(rememberPayload('x', '样品检验不过', 'company')) === J({ lesson: 'x', cue: '样品检验不过', visibility: 'company' }) && J(rememberPayload('x', '', 'restricted')) === J({ lesson: 'x', visibility: 'restricted' }));
ok('缺省档读不到（部门没名字、接口 500 没应答体）时：页面显示只给管理层，交出去的也是 restricted（#766 验收退回）', rememberPayload('x', '', defaultsOf({ default_visibility: 'department', department_name: null }).default_visibility).visibility === 'restricted' && rememberPayload('x', '', defaultsOf(null).default_visibility).visibility === 'restricted');
ok('没填时的提示跟着地方走：答复卡上说「或者取消勾选」，「我处理过的」里说「或者点「取消」」（那里是取消按钮）', rememberProblem('', '').includes('或者取消勾选') && rememberProblem('', '', 'later').includes('或者点「取消」') && !rememberProblem('', '', 'later').includes('勾选'));
ok('能不能交：以后怎么办必填、最多 500 字；情况最多 200 字', rememberProblem('', '').includes('先填') && rememberProblem(' ', '') !== null && rememberProblem('x'.repeat(LESSON_MAX + 1), '').includes('500') && rememberProblem('x', 'y'.repeat(CUE_MAX + 1)).includes('200') && rememberProblem('x', '') === null);
ok('办完的那句：记上了（带谁能看）、之前记过、稍后重试、被拒（用服务端那句）；答复本身都算办完', answeredWithRemember({ status: 'written', duplicate: false, scope_label: '采购部' }).text === '办好了，也记成了经验（采购部）' && answeredWithRemember({ status: 'written', duplicate: true }).text.includes('之前已经记过') && answeredWithRemember({ status: 'pending' }).text === '办好了；经验没记上，稍后会自动重试' && answeredWithRemember({ status: 'refused', message: '你没有对经验库拍板的授予' }).text === '办好了；经验没记上：你没有对经验库拍板的授予' && answeredWithRemember({ status: 'written' }).type === 'success' && answeredWithRemember({ status: 'pending' }).type === 'warning');
ok('被拒的原因像代号（英文代号、字段名）就不原样给，换成去「我处理过的」再记；没给 remember 当没记上', !answeredWithRemember({ status: 'refused', message: 'remember_department_unknown' }).text.includes('remember') && answeredWithRemember({ status: 'refused', message: 'remember_department_unknown' }).text.includes('我处理过的') && answeredWithRemember(undefined).text.startsWith('办好了；经验没记上'));
ok('补记的应答：201 / 200 记上了（重复说之前记过）；403 没授予；404 找不到你答过的；部门推不出；别的稍后再试', rememberLaterResult(201, { status: 'written', duplicate: false, scope_label: '只给管理层' }).text === '记成了经验（只给管理层）' && rememberLaterResult(200, { status: 'written', duplicate: true }).text.includes('之前已经记过') && rememberLaterResult(201, { status: 'pending' }).status === 'pending' && !rememberLaterResult(403, {}).ok && rememberLaterResult(404, {}).text.includes('48 小时') && rememberLaterResult(400, { error: 'remember_department_unknown' }).text.includes('只给管理层') && rememberLaterResult(0, null).text.includes('连不上'));
ok('卡片打开以后这件被别人处理掉了：remember 回 refused / remember_answer_not_found，照服务端那句中文说，答复本身照常算办完', answeredWithRemember({ status: 'refused', error: 'remember_answer_not_found', message: '这件事已经不在你的「关注」里了，没记成经验' }).text === '办好了；经验没记上：这件事已经不在你的「关注」里了，没记成经验' && answeredWithRemember({ status: 'refused', error: 'remember_answer_not_found', message: '这件事已经不在你的「关注」里了' }).type === 'warning');
const REC = recentOf({ items: [
  { source: 'work-items', source_id: 'wi-1', title: '合成：比价', answer: 'release', answer_text: '放行', answered_at: '2026-11-14T08:00:00Z', remembered: null, default_visibility: 'department', department_name: '采购部' },
  { source: 'mcp-access', source_id: '9', title: null, answer: 'approve', answer_text: '批准', answered_at: '2026-11-14T07:00:00Z', remembered: 'written', default_visibility: 'restricted', department_name: null },
  { source: 'weird-src', source_id: 'x', title: '', remembered: 'nope' }, { source: '' }, null] });
ok('「我处理过的」整形：形状不对的丢掉；记没记过只认三种状态；每条自带缺省档', REC.length === 3 && REC[0].remembered === null && REC[1].remembered === 'written' && REC[2].remembered === null && REC[0].defaults.department_name === '采购部' && REC[1].defaults.default_visibility === 'restricted' && recentOf(null).length === 0);
ok('没有标题的用来源名代替；认不出的来源写「一件事」，不露代号', recentTitle(REC[0]) === '合成：比价' && recentTitle(REC[1]) === 'AI 会话申请工具' && recentTitle(REC[2]) === '一件事');
ok('记没记过的说法：已记成经验 / 稍后会自动重试 / 没记上；没记过不写', rememberedLabel('written').text === '已记成经验' && rememberedLabel('pending').tone === 'warning' && rememberedLabel('failed').text === '没记上' && rememberedLabel(null) === null);
ok('拍板人：有名字写「拍板：名字」，没有不写', decidedByLine(' 合成管理层 ') === '拍板：合成管理层' && decidedByLine(null) === null && decidedByLine('') === null);

const via = (bodies) => answerViaOf({ source: 'work-items', source_id: 'wi-1', answer_via: { method: 'POST', path: '/api/work-items/wi-1/release', answers: Object.fromEntries(Object.entries(bodies).map(([k, body]) => [k, { body }])) } }, () => {});
ok('条目自带的答复入口收不收「记成经验」（#767）：每种答法的 body 都带 from_attention: true 才收；少一个、没带、是字符串都不收；没有入口不收',
  viaTakesRemember(via({ release: { from_attention: true } })) && viaTakesRemember(via({ approve: { from_attention: true }, reject: { from_attention: true } }))
  && !viaTakesRemember(via({ approve: { from_attention: true }, reject: {} })) && !viaTakesRemember(via({ release: {} })) && !viaTakesRemember(via({ release: { from_attention: 'true' } })) && !viaTakesRemember(null));
ok('answer_via 一种答法都没有（answers 为 {}）：不给勾选（空数组的 every 恒为真，得先看有没有答法）', viaTakesRemember(via({})) === false);
console.log(`\nremember-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
