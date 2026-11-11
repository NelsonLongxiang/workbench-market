#!/usr/bin/env node
/** 事项详情页的纯函数单测（web/src/work-item-view.ts）：提示条、进展一行字、结果解析与链接、关注条目对到事项。 */
import { artifactHref, askAnswerBody, initialChoice, lastAskAnswered, parseArtifacts, pendingFor, progressLine, stateHint } from '../web/src/work-item-view.ts';

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

ok('结果：空的给空数组', parseArtifacts('').length === 0 && parseArtifacts(null).length === 0 && parseArtifacts('  ').length === 0);
const arr = parseArtifacts(JSON.stringify([{ kind: 'file', id: 'f1', title: 'out.txt', url: '/apps/x/files/f1' }, 'plain', { kind: 'table' }, { id: 7 }, null]));
ok('结果：JSON 数组逐项取，没 id 没 url 的丢掉', JSON.stringify(arr) === JSON.stringify([{ kind: 'file', id: 'f1', title: 'out.txt', url: '/apps/x/files/f1' }, { kind: 'text', id: 'plain' }, { kind: 'item', id: '7' }]), JSON.stringify(arr));
ok('结果：不是 JSON 的字符串整体当一条', JSON.stringify(parseArtifacts('见附件')) === '[{"kind":"text","id":"见附件"}]');
ok('链接：同源路径和 http(s) 给链接', artifactHref({ kind: 'file', id: 'a', url: '/apps/x' }) === '/apps/x' && artifactHref({ kind: 'file', id: 'a', url: 'https://example.org/a' }) === 'https://example.org/a');
ok('链接：别的协议、协议相对地址、没有 url 都不给链接', artifactHref({ kind: 'f', id: 'a', url: 'javascript:alert(1)' }) === null && artifactHref({ kind: 'f', id: 'a', url: '//evil.example/a' }) === null && artifactHref({ kind: 'f', id: 'a' }) === null);

ok('答复请求体：选了选项只给 answer，否则给去空白的文本，都没有给 null', JSON.stringify(askAnswerBody('甲', '也写了')) === '{"answer":"甲"}' && JSON.stringify(askAnswerBody('', ' 中文 ')) === '{"text":"中文"}' && askAnswerBody('', '  ') === null);
ok('初始选择：缺省项在选项里才预选', initialChoice({ options: ['甲', '乙'], default: '乙' }) === '乙' && initialChoice({ options: ['甲'], default: '丙' }) === '' && initialChoice({ options: [] }) === '');

const att = (source, link) => ({ source, source_id: '1', category: 'ask', title: '', waiting_for: '', since: '', answers: [], object: '', phase: '', link });
const mine = pendingFor([att('seat-asks', '/work-items/wi_a'), att('work-items', '/work-items/wi_b'), att('work-items', '/work-items/wi_a'), att('x', '/other')], 'wi_a');
ok('关注条目：只取链接到这件事项的', mine.length === 2 && mine.every((x) => x.link === '/work-items/wi_a'));

console.log(`\nwork-item-detail-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
