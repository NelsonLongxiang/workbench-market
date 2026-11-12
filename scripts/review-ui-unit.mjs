#!/usr/bin/env node
/** 「等你拍板」里审核类卡片的纯函数单测（web/src/review-view.ts）：变更申请的 detail 怎么收、卡片上怎么写、
 *  哪一步要再确认、不通过要写理由、统一待办按 kind 说是什么。形状照 #580；全是合成值。 */
import { REVIEW_NEEDS, changeCard, changeDetailOf, confirmText, reviewAnswerLabel, runCard, runDetailOf, taskKindLabel } from '../web/src/review-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const rollback = { kind: 'app', op: 'rollback', slug: 'demo-app', title: '合成台', exists: true, current_version: 5, target_version: 3, target_changelog: '修了导出', requested_by: 'human:pm-a', reason: '第 5 版导出坏了', created_at: '2026-11-11 00:00:00', irreversible: false };
const del = { kind: 'skill', op: 'delete', slug: 'demo-skill', title: '合成技能', exists: true, current_version: 2, target_version: null, target_changelog: '', requested_by: 'pm-b', reason: '', created_at: '', irreversible: true, impact: { versions: 4, files: 17 } };
const cr = (detail) => ({ source: 'change-requests', detail });

ok('只认变更申请来源、认得的 kind 和 op', changeDetailOf(cr(rollback))?.op === 'rollback' && changeDetailOf({ source: 'tasks', detail: rollback }) === null && changeDetailOf(cr({ ...rollback, op: 'rename' })) === null && changeDetailOf(cr(null)) === null && changeDetailOf(cr('x')) === null);
{
  const d = changeDetailOf(cr({ kind: 'app', op: 'delete', slug: 's', title: 7, impact: { versions: 'x' } }));
  ok('字段形状不对按空值收，不崩；删除一律算收不回来', d && d.title === '' && d.exists === true && d.irreversible === true && d.impact.versions === 0 && d.impact.files === 0, JSON.stringify(d));
}
{
  const c = changeCard(changeDetailOf(cr(rollback)));
  ok('回滚：标题写回到第几版，说明写现在第几版、那一版改了什么、申请理由', c.title === '回滚工作台「合成台」到第 3 版' && c.lines[0] === '现在是第 5 版，回到第 3 版（修了导出）' && c.lines[1] === '申请理由：第 5 版导出坏了' && c.warn === '', JSON.stringify(c));
}
{
  const c = changeCard(changeDetailOf(cr(del)));
  ok('删除：写清会一并删掉几个版本、几个文件；没写理由照实说', c.title === '删除技能「合成技能」' && c.lines[0] === '会一并删掉 4 个版本、17 个文件，删了收不回来。' && c.lines[1] === '没写申请理由', JSON.stringify(c));
}
{
  const c = changeCard(changeDetailOf(cr({ ...rollback, exists: false, title: '', current_version: null })));
  ok('对象已经不在了：名字用 slug，提醒这条办不成', c.title === '回滚工作台「demo-app」到第 3 版' && c.lines[0] === '回到第 3 版（修了导出）' && c.warn.includes('已经不在了'), JSON.stringify(c));
}
ok('没写回到哪一版时照实说', changeCard(changeDetailOf(cr({ ...rollback, target_version: null, target_changelog: '' }))).lines[0] === '现在是第 5 版，没写要回到哪一版');
ok('答法叫法：按钮上写清后果——通过并删除 / 通过并回滚；读不出时只写通过；不通过；别的来源用通用叫法', reviewAnswerLabel('change-requests', 'approve', cr(del)) === '通过并删除' && reviewAnswerLabel('change-requests', 'approve', cr(rollback)) === '通过并回滚' && reviewAnswerLabel('change-requests', 'approve', cr(null)) === '通过' && reviewAnswerLabel('change-requests', 'approve') === '通过' && reviewAnswerLabel('change-requests', 'reject') === '不通过' && reviewAnswerLabel('mcp-access', 'approve') === null);
ok('不通过必须写理由，最多 500 字', REVIEW_NEEDS['change-requests'].reject.key === 'reason' && REVIEW_NEEDS['change-requests'].reject.max === 500 && !REVIEW_NEEDS['change-requests'].approve);
ok('确认：通过删除要确认并写清删什么', (confirmText(cr(del), 'approve') ?? '').includes('4 个版本、17 个文件'));
ok('确认：通过回滚、不通过都不用确认', confirmText(cr(rollback), 'approve') === null && confirmText(cr(del), 'reject') === null && confirmText(cr(rollback), 'reject') === null);
ok('确认：读不出申请要动什么时，通过也要先确认（可能是删除）', (confirmText(cr(null), 'approve') ?? '').includes('读不出') && confirmText(cr(null), 'reject') === null);
ok('确认：别的来源的撤回、不给照旧要确认', confirmText({ source: 'work-items' }, 'withdraw') !== null && confirmText({ source: 'mcp-access' }, 'reject') !== null && confirmText({ source: 'work-items' }, 'verify') === null);
ok('统一待办不是审核：按 kind 说是什么，认不得的算待办；别的来源返回 null', taskKindLabel({ source: 'tasks', kind: 'task' }) === '任务中心的任务' && taskKindLabel({ source: 'tasks', kind: 'sop-run' }) === 'SOP 执行' && taskKindLabel({ source: 'tasks' }) === '待办' && taskKindLabel({ source: 'tasks', kind: 'zzz' }) === '待办' && taskKindLabel({ source: 'change-requests', kind: 'task' }) === null);

// 别的节点派进来、等验收的流程执行（sop-runs）
const runItem = (detail) => ({ source: 'sop-runs', detail });
const runOk = { sop: 'rack-check', sop_title: '机柜验收', run_id: 12, dispatcher: { team: 'zone/canvas/team-a', caller: 'x', task_id: 't1' }, steps: [{ key: 'a', title: '机位确认', filled: true }, { key: 'b', title: '扭矩复核', filled: true }, { key: 'c', title: '通电自检', filled: false }], attachments: { count: 4, names: ['a.txt', 'b.txt', 'c.txt', 'd.txt'] }, ready: true, problems: [] };
ok('派进来的执行：只认 sop-runs 来源；形状不对按空值收', runDetailOf(runItem(runOk))?.run_id === '12' && runDetailOf({ source: 'tasks', detail: runOk }) === null && runDetailOf(runItem(null)) === null && runDetailOf(runItem({})).ready === false);
{
  const c = runCard(runDetailOf(runItem(runOk)), (t) => t.replace(/^[^/]+\/canvas\//, ''));
  ok('卡片：哪条流程、谁派来的、填了几步、交了什么', c.title === '机柜验收 #12' && c.lines.join(' | ') === 'team-a 派来的 | 3 步里填了 2 步 | 交了 4 个附件：a.txt、b.txt、c.txt 等' && c.problems.length === 0, JSON.stringify(c));
}
{
  const c = runCard(runDetailOf(runItem({ ...runOk, ready: false, problems: ['「通电自检」必填', 1, 'b', 'c', 'd', 'e', 'f'], attachments: {}, dispatcher: null })));
  ok('还不能验：列出差什么（最多 5 条）；没给原因也说一句；没附件、不知道谁派的照实说', c.problems.length === 5 && c.problems[0] === '「通电自检」必填' && c.lines.includes('没有附件') && c.lines[0] === '别的团队派来的' && runCard(runDetailOf(runItem({ ready: false }))).problems[0].includes('验不了'));
}
ok('答法叫法：finish 写「验收通过」，不露代号', reviewAnswerLabel('sop-runs', 'finish') === '验收通过' && reviewAnswerLabel('sop-runs', 'other') === null);

console.log(`\nreview-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
