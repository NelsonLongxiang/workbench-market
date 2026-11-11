#!/usr/bin/env node
/** 事项详情页的纯函数单测（web/src/work-item-view.ts）：提示条、进展一行字、结果解析与链接、关注条目对到事项。 */
import { artifactHref, artifactsFromLog, mergeArtifacts, askAnswerBody, initialChoice, lastAskAnswered, parseArtifacts, pendingFor, progressLine, stateHint } from '../web/src/work-item-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

ok('提示：在等放行要说清是管理员放行', stateHint('held', '')?.text.includes('放行') && stateHint('held', '').type === 'warning');
ok('提示：在问你、等验收、已转交各有一句', stateHint('blocked', 's')?.type === 'warning' && stateHint('ready', 's')?.type === 'success' && !!stateHint('delivered', ''));
ok('提示：已接手但没有席位时说明，有席位就不提示', !!stateHint('accepted', '') && stateHint('accepted', 'seat_a') === null);
ok('提示：在问你但最近的提问已答复，说在等席位', stateHint('blocked', '', true)?.type === 'info' && stateHint('blocked', '', true).text.includes('已经答复'));
ok('最近的提问答过没有：答复在提问之后才算，被拒的不算', lastAskAnswered([{ fact: 'ask' }, { fact: 'answer' }]) && !lastAskAnswered([{ fact: 'answer' }, { fact: 'ask' }]) && !lastAskAnswered([{ fact: 'ask' }, { fact: 'answer', rejected: 'terminal' }]) && !lastAskAnswered([]));
ok('提示：终态和进行中不出提示', ['done', 'failed', 'dropped', 'cancelled', 'progress', 'waiting'].every((s) => stateHint(s, 'x') === null));

ok('进展：第几步 · 状态 · 前面还有几件', progressLine({ n: 2, state: 'queued', summary: '', at: '', ahead: 3, tickets: [], received_at: '' }) === '第 2 步 · 排队中 · 前面还有 3 件');
ok('进展：没有排队数、不认识的状态原样', progressLine({ n: 1, state: 'odd', summary: '', at: '', tickets: [], received_at: '' }) === '第 1 步 · odd');

ok('结果：缺省值和坏的都按空读', parseArtifacts('{}').length === 0 && parseArtifacts('[]').length === 0 && parseArtifacts('').length === 0 && parseArtifacts(null).length === 0 && parseArtifacts('坏').length === 0);
const arr = parseArtifacts(JSON.stringify([{ kind: 'file', id: 'f1', title: 't', url: 'https://example.org/x' }, 'plain', { kind: 'table' }, { kind: '', id: 'x' }, { kind: 'sop-run', id: 'demo/7' }]));
ok('结果：只认 kind、id 都是非空字符串的项，url、title 一律丢掉', JSON.stringify(arr) === '[{"kind":"file","id":"f1"},{"kind":"sop-run","id":"demo/7"}]', JSON.stringify(arr));
ok('结果：最多 16 项', parseArtifacts(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ kind: 'file', id: 'f' + i })))).length === 16);
const fromLog = artifactsFromLog([{ fact: 'receipt', detail: JSON.stringify({ artifacts: [{ kind: 'table', id: 'out' }] }) }, { fact: 'receipt', rejected: 'terminal', detail: JSON.stringify({ artifacts: [{ kind: 'file', id: 'late' }] }) }, { fact: 'report', detail: JSON.stringify({ artifacts: [{ kind: 'file', id: 'no' }] }) }, { fact: 'receipt', detail: '{坏' }]);
ok('日志里的产物：只取被采信的回执行', JSON.stringify(fromLog) === '[{"kind":"table","id":"out"}]', JSON.stringify(fromLog));
ok('合并：按 kind + id 去重、保持先后', JSON.stringify(mergeArtifacts([{ kind: 'file', id: 'a' }], [{ kind: 'file', id: 'a' }, { kind: 'table', id: 'a' }])) === '[{"kind":"file","id":"a"},{"kind":"table","id":"a"}]');
ok('链接：sop-run 拼成本站 /sops/<slug>/runs/<runId>', artifactHref({ kind: 'sop-run', id: 'demo-space/42' }) === '/sops/demo-space/runs/42');
ok('链接：table、file、不认得的 kind、形状不对的 sop-run 都不给链接', [{ kind: 'table', id: 't' }, { kind: 'file', id: 'f' }, { kind: 'x', id: 'y' }, { kind: 'sop-run', id: '../etc/1' }, { kind: 'sop-run', id: 'demo/0' }, { kind: 'sop-run', id: 'https://evil.example/1' }, { kind: 'sop-run', id: 'Demo_Space/3' }].every((a) => artifactHref(a) === null));

ok('答复请求体：选了选项只给 answer，否则给去空白的文本，都没有给 null', JSON.stringify(askAnswerBody('甲', '也写了')) === '{"answer":"甲"}' && JSON.stringify(askAnswerBody('', ' 中文 ')) === '{"text":"中文"}' && askAnswerBody('', '  ') === null);
ok('初始选择：缺省项在选项里才预选', initialChoice({ options: ['甲', '乙'], default: '乙' }) === '乙' && initialChoice({ options: ['甲'], default: '丙' }) === '' && initialChoice({ options: [] }) === '');

const att = (source, link) => ({ source, source_id: '1', category: 'ask', title: '', waiting_for: '', since: '', answers: [], object: '', phase: '', link });
const mine = pendingFor([att('seat-asks', '/work-items/wi_a'), att('work-items', '/work-items/wi_b'), att('work-items', '/work-items/wi_a'), att('x', '/other')], 'wi_a');
ok('关注条目：只取链接到这件事项的', mine.length === 2 && mine.every((x) => x.link === '/work-items/wi_a'));

console.log(`\nwork-item-detail-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
