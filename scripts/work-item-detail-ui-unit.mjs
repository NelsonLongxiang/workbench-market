#!/usr/bin/env node
/** 事项详情页的纯函数单测（web/src/work-item-view.ts）：提示条、进展一行字、结果解析与链接、关注条目对到事项。 */
import { askIdOf, creatorLabel, groupRejected, hiddenInTimeline, timelineLabel, artifactHref, artifactsFromLog, mergeArtifacts, askAnswerBody, initialChoice, lastAskAnswered, parseArtifacts, pendingFor, progressLine, stateHint } from '../web/src/work-item-view.ts';

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
ok('结果：只认 kind、id 都是非空字符串的项，url 丢掉；title、submitted_by、at 缺的是 null', JSON.stringify(arr) === '[{"kind":"file","id":"f1","title":"t","submitted_by":null,"at":null},{"kind":"sop-run","id":"demo/7","title":null,"submitted_by":null,"at":null}]', JSON.stringify(arr));
ok('结果：带齐三项的照取', JSON.stringify(parseArtifacts(JSON.stringify([{ kind: 'file', id: 'f', title: 'out.txt', submitted_by: 'team/a1', at: '2026-11-11 08:00:00' }]))) === '[{"kind":"file","id":"f","title":"out.txt","submitted_by":"team/a1","at":"2026-11-11 08:00:00"}]');
ok('时间线对到提问：提问行取 fact_id，答复行取 detail.ask_id，别的行没有', askIdOf({ fact: 'ask', fact_id: '41', detail: '' }) === '41' && askIdOf({ fact: 'answer', detail: '{"ask_id":"41"}' }) === '41' && askIdOf({ fact: 'answer', detail: '{"ask_id":41}' }) === '41' && askIdOf({ fact: 'note', fact_id: '41', detail: '' }) === null);
ok('结果：最多 16 项', parseArtifacts(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ kind: 'file', id: 'f' + i })))).length === 16);
const fromLog = artifactsFromLog([{ fact: 'receipt', detail: JSON.stringify({ artifacts: [{ kind: 'table', id: 'out' }] }) }, { fact: 'receipt', rejected: 'terminal', detail: JSON.stringify({ artifacts: [{ kind: 'file', id: 'late' }] }) }, { fact: 'report', detail: JSON.stringify({ artifacts: [{ kind: 'file', id: 'no' }] }) }, { fact: 'receipt', detail: '{坏' }]);
ok('日志里的产物：只取被采信的回执行，三项按 null', JSON.stringify(fromLog) === '[{"kind":"table","id":"out","title":null,"submitted_by":null,"at":null}]', JSON.stringify(fromLog));
ok('合并：按 kind + id 去重、保持先后、先到的为准', JSON.stringify(mergeArtifacts([{ kind: 'file', id: 'a', title: 'first' }], [{ kind: 'file', id: 'a', title: 'second' }, { kind: 'table', id: 'a' }])) === '[{"kind":"file","id":"a","title":"first"},{"kind":"table","id":"a"}]');
ok('链接：sop-run 拼成本站 /sops/<slug>/runs/<runId>', artifactHref({ kind: 'sop-run', id: 'demo-space/42' }) === '/sops/demo-space/runs/42');
ok('链接：table、file、不认得的 kind、形状不对的 sop-run 都不给链接', [{ kind: 'table', id: 't' }, { kind: 'file', id: 'f' }, { kind: 'x', id: 'y' }, { kind: 'sop-run', id: '../etc/1' }, { kind: 'sop-run', id: 'demo/0' }, { kind: 'sop-run', id: 'https://evil.example/1' }, { kind: 'sop-run', id: 'Demo_Space/3' }].every((a) => artifactHref(a) === null));

ok('答复请求体：选了选项只给 answer，否则给去空白的文本，都没有给 null', JSON.stringify(askAnswerBody('甲', '也写了')) === '{"answer":"甲"}' && JSON.stringify(askAnswerBody('', ' 中文 ')) === '{"text":"中文"}' && askAnswerBody('', '  ') === null);
ok('初始选择：缺省项在选项里才预选', initialChoice({ options: ['甲', '乙'], default: '乙' }) === '乙' && initialChoice({ options: ['甲'], default: '丙' }) === '' && initialChoice({ options: [] }) === '');

ok('建立人：以 creator_principal 为准，和发布人不同时注明', creatorLabel('human:root-admin', 'user:alpha') === 'alpha · 由 root-admin 发布' && creatorLabel('user:alpha', 'user:alpha') === 'alpha' && creatorLabel('human:alice', null) === 'alice' && creatorLabel('', '') === '—');
ok('时间线：系统合上旧提问的答复叫「提问作废」，真答复照旧', timelineLabel({ fact: 'answer', fact_id: '9:closes-ask:3', detail: '' }, { answer: '答复' }) === '提问作废' && timelineLabel({ fact: 'answer', fact_id: 'u1', detail: '' }, { answer: '答复' }) === '答复');
ok('时间线：看过消息的备注不进时间线，别的备注照进', hiddenInTimeline({ fact: 'note', detail: '{"note":"followup-read","late":true}' }) && !hiddenInTimeline({ fact: 'note', detail: '{"note":"followup"}' }) && !hiddenInTimeline({ fact: 'note', detail: '{坏' }));
const gr = groupRejected([{ seq: 1 }, { seq: 2, rejected: 'terminal' }, { seq: 3 }, { seq: 4, rejected: 'terminal' }, { seq: 5, rejected: 'terminal' }, { seq: 6, rejected: 'terminal' }]).map((g) => g.kind === 'row' ? g.row.seq : g.rows.map((r) => r.seq).join('+'));
ok('时间线：连续两条以上的被拒行收成一组，单独一条不收', JSON.stringify(gr) === '[1,2,3,"4+5+6"]', JSON.stringify(gr));

const att = (source, link) => ({ source, source_id: '1', category: 'ask', title: '', waiting_for: '', since: '', answers: [], object: '', phase: '', link });
const mine = pendingFor([att('seat-asks', '/work-items/wi_a'), att('work-items', '/work-items/wi_b'), att('work-items', '/work-items/wi_a'), att('x', '/other')], 'wi_a');
ok('关注条目：只取链接到这件事项的', mine.length === 2 && mine.every((x) => x.link === '/work-items/wi_a'));

console.log(`\nwork-item-detail-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
