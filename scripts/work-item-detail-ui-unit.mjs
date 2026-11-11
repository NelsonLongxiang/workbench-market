#!/usr/bin/env node
/** 事项详情页的纯函数单测（web/src/work-item-view.ts）：提示条、进展一行字、结果解析与链接、关注条目对到事项。 */
import { VIEWER_NONE, actorLabel, groupTimeline, isCreator, seatLabel, askerLabel, textOf, who, CAN_NONE, canOf, stateLabel, askIdOf, creatorLabel, hiddenInTimeline, timelineLabel, artifactHref, artifactsFromLog, mergeArtifacts, askAnswerBody, initialChoice, lastAskAnswered, parseArtifacts, pendingFor, progressLine, stateHint } from '../web/src/work-item-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const V = (o) => ({ ...VIEWER_NONE, creator: 'alpha', ...o, can: { ...CAN_NONE, ...(o?.can ?? {}) } });
ok('「你」指本来该找的人：建立人看在问你 / 等你验收，管理员看在问 alpha / 等 alpha 验收', stateLabel('blocked', V({ mine: true })) === '在问你' && stateLabel('blocked', V({ can: { answer: true } })) === '在问 alpha' && stateLabel('ready', V({ mine: true })) === '等你验收' && stateLabel('ready', V({ can: { verify: true } })) === '等 alpha 验收');
ok('放行：有放行权限的看等你过目，别人看等放行', stateLabel('held', V({ can: { release: true } })) === '等你过目' && stateLabel('held', V({ mine: true })) === '等放行');
ok('中性叫法（时间线、列表）不带「你」，草稿叫未派发、对方放弃单列', ['draft','held','delivered','accepted','progress','waiting','blocked','ready','done','failed','dropped','cancelled'].every((s) => !stateLabel(s).includes('你')) && stateLabel('draft') === '未派发' && stateLabel('dropped') === '对方放弃了' && stateLabel('blocked') === '在等答复');
ok('提示条：建立人「席位在问你」，能代答的管理员「你可以代答」，无关的人只说在等谁', stateHint('blocked', '', false, V({ mine: true })).text.startsWith('席位在问你') && stateHint('blocked', '', false, V({ can: { answer: true } })).text.includes('你可以代答') && !stateHint('blocked', '', false, V({})).text.includes('你'));
ok('提示条：验收同理', stateHint('ready', '', false, V({ mine: true })).text.includes('等你验收') && stateHint('ready', '', false, V({ can: { verify: true } })).text.includes('你可以代为验收') && !stateHint('ready', '', false, V({})).text.includes('你'));
ok('是不是建立人：登录名对 user:<登录名>', isCreator('alpha', 'user:alpha') && !isCreator('root-admin', 'user:alpha') && !isCreator(null, 'user:alpha') && !isCreator('alpha', null));
ok('席位：名字 · 句柄 显示成 名字（句柄），只有句柄照用', seatLabel('成员一 · dsh/d6f79e90') === '成员一（dsh/d6f79e90）' && seatLabel('dsh/d6f79e90') === 'dsh/d6f79e90' && seatLabel('') === '');
ok('日志的谁：去前缀、对端席位换承接名字、系统来源说人话', actorLabel('receiver:dsh', '成员一 · dsh/x') === '成员一（dsh/x）' && actorLabel('human:root-admin', '') === 'root-admin' && actorLabel('market', '') === '市场' && actorLabel('admin-token', '') === '管理员' && actorLabel('user:alpha', '') === 'alpha');
const tg = groupTimeline([{ seq: 1, fact: 'ask', detail: '' }, { seq: 2, fact: 'note', detail: '{"note":"progress"}' }, { seq: 3, fact: 'note', detail: '{"note":"progress"}' }, { seq: 4, fact: 'note', detail: '{"note":"progress"}' }, { seq: 5, fact: 'note', detail: '{"note":"progress"}' }, { seq: 6, fact: 'answer', detail: '', rejected: 'terminal' }, { seq: 7, fact: 'answer', detail: '', rejected: 'terminal' }]).map((g) => g.kind === 'row' ? g.row.seq : g.kind + ':' + g.rows.map((r) => r.seq).join('+'));
ok('时间线收组：连续进展收一组、连续被拒收一组', JSON.stringify(tg) === '[1,"progress:2+3+4+5","rejected:6+7"]', JSON.stringify(tg));
ok('时间线：进展备注叫「进展」', timelineLabel({ fact: 'note', detail: '{"note":"progress"}' }, { note: '备注' }) === '进展');
ok('提示：在等放行，不说「你」', stateHint('held', '')?.text.startsWith('在等放行') && !stateHint('held', '').text.includes('你'));
ok('提示：能放行的人看「等你过目」', stateHint('held', '', false, V({ can: { release: true } }))?.text.startsWith('等你过目'));
const pa = (source, category, answers) => ({ source, source_id: '1', category, title: '', waiting_for: '', since: '', answers, object: '', phase: '', link: '/work-items/wi_a' });
const choicesNonAdmin = (x) => (x.source === 'work-items' && x.category === 'accept' ? x.answers : []);
ok('能做什么：取自看的人在「关注」里的条目和答法', JSON.stringify(canOf([pa('work-items', 'accept', ['verify', 'return']), pa('seat-asks', 'ask', ['answer'])], choicesNonAdmin)) === '{"release":false,"answer":true,"verify":true}' && JSON.stringify(canOf([pa('work-items', 'glance', ['release', 'withdraw'])], choicesNonAdmin)) === '{"release":false,"answer":false,"verify":false}' && canOf([pa('work-items', 'glance', ['release'])], (x) => x.answers).release);
ok('提示：在等答复、等验收、已转交各有一句', stateHint('blocked', 's')?.type === 'warning' && stateHint('ready', 's')?.type === 'success' && !!stateHint('delivered', ''));
ok('提示：已接手但没有席位时说明，有席位就不提示', !!stateHint('accepted', '') && stateHint('accepted', 'seat_a') === null);
ok('提示：最近的提问已答复，说在等席位', stateHint('blocked', '', true)?.type === 'info' && stateHint('blocked', '', true).text.includes('已经答复'));
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
const gr = groupTimeline([{ seq: 1, fact: 'x', detail: '' }, { seq: 2, fact: 'x', detail: '', rejected: 'terminal' }, { seq: 3, fact: 'x', detail: '' }, { seq: 4, fact: 'x', detail: '', rejected: 'terminal' }, { seq: 5, fact: 'x', detail: '', rejected: 'terminal' }]).map((g) => g.kind === 'row' ? g.row.seq : g.rows.map((r) => r.seq).join('+'));
ok('时间线：单独一条被拒行不收组，连续的才收', JSON.stringify(gr) === '[1,2,3,"4+5"]', JSON.stringify(gr));

ok('对端给的「谁」：字符串照用，对象取 name、没有取 seat，别的给空串，永远是字符串', who('seat_a') === 'seat_a' && who({ seat: 'dsh/d6f79e90', name: '成员一' }) === '成员一' && who({ seat: 'dsh/d6f79e90' }) === 'dsh/d6f79e90' && who({ role: 'x' }) === '' && who(null) === '' && who(['a']) === '');
ok('对端给的文字：字符串和数字照用，对象给空串', textOf('a') === 'a' && textOf(3) === '3' && textOf({ a: 1 }) === '' && textOf(undefined) === '');

ok('提问人：来源标记 receiver:<区> 换成承接席位，没有承接就去前缀；别的照用', askerLabel('receiver:dsh', '成员一 · dsh/d6f79e90') === '成员一（dsh/d6f79e90）' && askerLabel('receiver:dsh', '') === 'dsh' && askerLabel('seat:a', 'x') === 'a' && askerLabel({ name: '成员二' }, 'x') === '成员二');

const att = (source, link) => ({ source, source_id: '1', category: 'ask', title: '', waiting_for: '', since: '', answers: [], object: '', phase: '', link });
const mine = pendingFor([att('seat-asks', '/work-items/wi_a'), att('work-items', '/work-items/wi_b'), att('work-items', '/work-items/wi_a'), att('x', '/other')], 'wi_a');
ok('关注条目：只取链接到这件事项的', mine.length === 2 && mine.every((x) => x.link === '/work-items/wi_a'));

console.log(`\nwork-item-detail-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
