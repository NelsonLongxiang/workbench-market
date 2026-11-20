#!/usr/bin/env node
/** 团队的决策卡（T8，「关注」来源 a2a-decisions）在「等你拍板」里怎么算、怎么写（web/src/attention-view.ts、review-view.ts）。
 *  统筹、验收 11-20 定的方案 A：带了宿主拍板地址（detail.decide_at，只认 http / https）的算进「等你拍板」的件数和侧栏计数；
 *  地址是空串或不能用的归「要到别处处理」，不计数。全是合成值。 */
const { decideCount, groupCards, hostDecideAt, isMyDecision } = await import('../web/src/attention-view.ts');
const { fileSize, hostDecisionCard, hostDecisionOf } = await import('../web/src/review-view.ts');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const J = JSON.stringify;

const card = (decide_at, extra = {}) => ({ source: 'a2a-decisions', source_id: `fp:team-a:${decide_at.length}`, category: 'ask', kind: 'a2a-decision', title: '[P1] 观察者（合成团队）：合成问题',
  waiting_for: 'team:synthetic.example/team-a', since: '2026-11-20T08:00:00Z', answers: [], object: '', phase: '', link: '', mine: true,
  detail: { host: '合成宿主', team: 'team-a', proposer_kind: 'observer', level: 'P1', question: '合成：下周先上哪个？', options: ['甲方案', '乙方案'], recommended: '乙方案', reason: '合成理由',
    files: [{ name: 'a.pdf', size: 2048 }], created_at: '2026-11-20T08:00:00Z', decide_at }, ...extra });
const none = () => []; // 决策卡没有当场的答法

ok('宿主地址：https、http 的绝对地址照用', hostDecideAt(card('https://host.example.invalid/decide/1')) === 'https://host.example.invalid/decide/1' && hostDecideAt(card('http://10.0.0.1:8080/d?x=1')) === 'http://10.0.0.1:8080/d?x=1');
ok('宿主地址：空串、空白当没给', hostDecideAt(card('')) === null && hostDecideAt(card('   ')) === null);
ok('宿主地址：javascript:、data:、file:、ftp: 之类的协议不认', ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/x', 'ftp://h.example.invalid/x'].every((u) => hostDecideAt(card(u)) === null));
ok('宿主地址：相对路径、写不成地址的不认', ['/decide/1', '//host.example.invalid/x', 'not a url', 'https//x'].every((u) => hostDecideAt(card(u)) === null));
ok('宿主地址：只认 a2a-decisions 来源；detail 不是对象、decide_at 不是字符串的不认', hostDecideAt({ source: 'tasks', detail: { decide_at: 'https://h.example.invalid/' } }) === null && hostDecideAt({ source: 'a2a-decisions', detail: 'x' }) === null && hostDecideAt(card(7)) === null);

const withLink = card('https://host.example.invalid/decide/1'), empty = card(''), bad = card('javascript:alert(1)');
ok('带宿主地址的决策卡：算「等你拍板」，计进侧栏角标的件数', isMyDecision(withLink, none) && decideCount([withLink], none) === 1);
ok('decide_at 为空串：不算「等你拍板」，不计数', !isMyDecision(empty, none) && decideCount([empty], none) === 0);
ok('decide_at 是 javascript: 之类不能用的地址：同空串，不计数', !isMyDecision(bad, none) && decideCount([bad], none) === 0);
const g = groupCards([withLink, empty, bad], none);
ok('分组：带地址的进「等你拍板」（now）；空串、不能用的归「要到别处处理」', g.now.length === 1 && g.now[0] === withLink && g.elsewhere.length === 2 && g.proxy.length === 0, J({ now: g.now.length, elsewhere: g.elsewhere.length }));
ok('没给这个来源（非属主：服务端不列，visible 为 false）：件数照旧是 0', decideCount([], none) === 0 && groupCards([], none).now.length === 0);
ok('不是轮到你的（mine 为假）：不计数', decideCount([card('https://host.example.invalid/d', { mine: false })], none) === 0);
ok('别的来源没有答法的：照旧不算（规则只放宽决策卡）', decideCount([{ ...withLink, source: 'change-requests' }], none) === 0);

const d = hostDecisionOf(withLink);
const c = hostDecisionCard(d, (t) => (t === 'team-a' ? '合成团队' : ''));
ok('卡片：标题是问题原文；写谁提的（观察者、宿主、团队名）', c.title === '合成：下周先上哪个？' && c.who === '观察者（合成宿主 · 合成团队） 提的', J(c));
ok('卡片：列选项并标出建议的那个；写理由；列附件和大小', c.lines[0] === '可选：甲方案 / 乙方案（建议）' && c.lines[1] === '理由：合成理由' && c.lines[2] === '附件 1 个：a.pdf（2 KB）', J(c.lines));
ok('卡片：有地址时不写「去哪办」；没地址时说到宿主上找这张卡', c.where === '' && hostDecisionCard(hostDecisionOf(empty), () => '').where.includes('到宿主上找这张卡'));
ok('总工提的写「总工」；急的程度只认 P0～P3', hostDecisionCard(hostDecisionOf(card('', { detail: { ...withLink.detail, proposer_kind: 'router', level: 'P9' } })), () => '').who.startsWith('总工') && hostDecisionOf(card('', { detail: { ...withLink.detail, level: 'P9' } })).level === '');
const odd = hostDecisionOf(card('', { detail: { options: ['', 3, ' 丙 '], files: [{ name: '' }, { name: 'b', size: 'x' }, null], decide_at: '' } }));
ok('字段缺了、形状不对：照实说，不崩', odd.options.length === 1 && odd.options[0] === '丙' && odd.files.length === 1 && odd.files[0].size === -1 && hostDecisionCard(odd, () => '').title === '（没写问题）');
ok('附件大小：B / KB / MB；认不出写「大小不明」', fileSize(10) === '10 B' && fileSize(2048) === '2 KB' && fileSize(3 * 1024 * 1024) === '3.0 MB' && fileSize(-1) === '大小不明');
ok('不是决策卡：hostDecisionOf 给 null', hostDecisionOf({ source: 'tasks', detail: {} }) === null && hostDecisionOf({ source: 'a2a-decisions' }) === null);

console.log(`\nhost-decision-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
