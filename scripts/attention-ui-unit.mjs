#!/usr/bin/env node
/** 「关注」页、事项页的纯函数单测（阶段八 8d，web/src/attention-view.ts）：等了多久、排序、日志一行的说明。 */
import { answerChoices, answerRoute, byWaited, describe, waited } from '../web/src/attention-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const NOW = Date.parse('2026-11-11T12:00:00Z');

ok('等了多久：分钟、小时、天', waited('2026-11-11 11:30:00', NOW) === '30 分钟' && waited('2026-11-11T09:00:00Z', NOW) === '3 小时' && waited('2026-11-08 12:00:00', NOW) === '3 天');
ok('等了多久：空的显示「—」，认不出的原样', waited('', NOW) === '—' && waited('不是时间', NOW) === '不是时间');
ok('等了多久：未来的时间不显示负数', waited('2026-11-12 00:00:00', NOW) === '0 分钟');
const it = (id, since) => ({ source: 's', source_id: id, category: 'ask', title: id, waiting_for: '', since, answers: [], object: '', phase: '', link: '' });
const sorted = byWaited([it('none', ''), it('new', '2026-11-11 11:00:00'), it('old', '2026-11-01 00:00:00'), it('bad', '坏'), it('mid', '2026-11-05T00:00:00Z')]).map((x) => x.source_id);
ok('排序：等得最久的在前；不知道从何时等的排最后、保持原来的先后', JSON.stringify(sorted) === '["old","mid","new","none","bad"]', JSON.stringify(sorted));
ok('日志说明：提问、答复、进展、判断', describe({ detail: '{"question":"哪天？"}' }) === '哪天？' && describe({ detail: '{"answer":"1 号","ask_id":"9"}' }) === '1 号' && describe({ detail: '{"status":"ready","summary":"做完了"}' }) === '做完了 · 状态：ready' && describe({ detail: '{"verdict":"stop","reason":"不在范围"}' }) === '不在范围 · 判断：stop');
ok('日志说明：未路由、未采信、晚到', describe({ detail: '{"note":"unrouted"}' }) === '没有目标团队' && describe({ detail: '{"note":"untrusted"}' }) === '提交方未验证，收到但未采信' && describe({ detail: '{"outcome":"done","late":true}' }) === '结果：done · 晚到');
ok('日志说明：席位发来的消息、人的回复、人看过（阶段七 R2）——原文在前、加一个标签；别的 note 带 text 不显示', describe({ detail: '{"note":"followup","text":"答复收到，继续处理"}' }) === '答复收到，继续处理 · 席位发来的消息' && describe({ detail: '{"note":"followup-reply","text":"发 apps 仓库"}' }) === '发 apps 仓库 · 人回复了席位的消息' && describe({ detail: '{"note":"followup-read"}' }) === '人看过席位的消息' && describe({ detail: '{"note":"untrusted","text":"不该显示"}' }) === '提交方未验证，收到但未采信');
ok('日志说明：被拒那一行的固定备注不重复显示（原因另有标签）', describe({ detail: '{"note":"收到，未采信"}' }) === '');
ok('日志说明：坏的 detail 当空，不抛', describe({ detail: '{坏' }) === '' && describe({ detail: '' }) === '');

const cr = { source: 'change-requests', category: 'review', answers: ['approve', 'reject'] };
const acc = { source: 'work-items', category: 'accept', answers: ['verify', 'return'] };
const glance = { source: 'work-items', category: 'glance', answers: ['release', 'withdraw'] };
ok('不是管理员：别的来源不给答法和提交按钮（答复入口先过写请求总门），只留「在原页面处理」', answerChoices(false, cr).length === 0 && answerChoices(false, glance).length === 0);
ok('不是管理员：自己「等验收」的事项能答验收、退回，走建立人入口（8e）', JSON.stringify(answerChoices(false, acc)) === '["verify","return"]' && answerRoute(false, acc) === 'creator');
ok('管理员：答法照条目给的列出，都走答复入口', JSON.stringify(answerChoices(true, cr)) === '["approve","reject"]' && answerRoute(true, acc) === 'attention' && answerRoute(true, cr) === 'attention');

console.log(`\nattention-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
