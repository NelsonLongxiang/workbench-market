#!/usr/bin/env node
/** 经验库页（web/src/knowledge-view.ts）的纯函数单测：四类的先后和说法、认不出的类别不露代号；读接口（#717）的应答怎么读、状态和读不到怎么说。数据都是合成的。 */
import { KNOWLEDGE_EMPTY, KNOWLEDGE_FORBIDDEN, KNOWLEDGE_INTRO, KNOWLEDGE_KINDS, SOURCE_DEGRADED, SOURCE_NOT_READY, asItem, asList, countsOf, emptyKindText, itemsOf, kindLabel, problemOf, safeUrl, stanceLabel, statusOf, tabFromQuery } from '../web/src/knowledge-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

ok('四类，先后照原型：依据、经验、方法、检查', KNOWLEDGE_KINDS.map((k) => k.label).join() === '依据,经验,方法,检查');
ok('每类都有一句说法，类别键不重复', KNOWLEDGE_KINDS.every((k) => k.meaning.trim().length > 0) && new Set(KNOWLEDGE_KINDS.map((k) => k.key)).size === 4);
ok('类别名：认得的写名字，认不出的写「其他」（不露代号）', kindLabel('claim') === '依据' && kindLabel('verify') === '检查' && kindLabel('weird') === '其他' && kindLabel(undefined) === '其他' && kindLabel('toString') === '其他');
ok('顶上那一句照原型；空态不说在等哪个接口', KNOWLEDGE_INTRO.startsWith('公司越用越聪明') && !/接口|API|还在做/.test(KNOWLEDGE_EMPTY));


// 读接口（#717）
const it = (key, kind, more = {}) => ({ key, kind, title: `合成${key}`, summary: '', status: null, tags: [], created: '2026-11-12 08:00:00', updated: '2026-11-13 08:00:00', scope_label: '全公司', ...more });
const L = asList({ items: [it('k1', 'claim', { status: 'supported' }), it('k2', 'kb'), { key: '', title: 'x' }, null, it('k3', 'verify', { status: 'PASS', tags: ['a', 3, ' ', 'b'] }), it('k4', 'claim')], source: 'degraded' });
ok('列表：形状不对的条目丢掉（没有 key、没有标题、不是对象）；tags 只留文字', L.items.map((x) => x.key).join() === 'k1,k2,k3,k4' && JSON.stringify(L.items[2].tags) === '["a","b"]');
ok('来源：not_ready / degraded 照认；认不出、没给的当 ok', L.source === 'degraded' && asList({ items: [], source: 'not_ready' }).source === 'not_ready' && asList({ items: [] }).source === 'ok' && asList({ source: 'weird' }).source === 'ok' && asList(null).items.length === 0);
ok('一条：缺字段给空，status 空串当没有', asItem({ key: 'k', title: 't', status: '' }).status === null && asItem({ key: 'k', title: 't' }).scope_label === '' && asItem({ key: 'k' }) === null);
const c = countsOf(L.items);
ok('各类条数：全部 4、依据 2、经验 1、方法 0、检查 1；认不出的类别只算进全部', c.all === 4 && c.claim === 2 && c.kb === 1 && c.skill === 0 && c.verify === 1 && countsOf([it('x', 'weird')]).all === 1);
ok('按类别筛：全部原样，别的只留那一类', itemsOf(L.items, 'all').length === 4 && itemsOf(L.items, 'claim').map((x) => x.key).join() === 'k1,k4' && itemsOf(L.items, 'skill').length === 0);
ok('地址里的类别：认得的照用，认不出、没写的当全部', tabFromQuery('kb') === 'kb' && tabFromQuery('weird') === 'all' && tabFromQuery(null) === 'all' && tabFromQuery('toString') === 'all');
ok('状态：依据的仲裁、检查的结论各有说法；认不出的不显示', statusOf('supported').text === '有依据支持' && statusOf('refuted').tone === 'error' && statusOf('PASS').text === '通过' && statusOf('NEEDS-MATERIAL').text === '缺材料' && statusOf('weird') === null && statusOf(null) === null);
ok('依据原文：支持 / 反驳；别的不写', stanceLabel('supports') === '支持' && stanceLabel('refutes') === '反驳' && stanceLabel('x') === '');
ok('读不到：401 请先登录；403 管理口令写「经验库是业务内容」；详情 404 一律「没有这一条」；503 暂时读不到可再试；断网、别的读不到', problemOf(401, 'list').text === '请先登录。' && problemOf(403, 'list').text === KNOWLEDGE_FORBIDDEN && KNOWLEDGE_FORBIDDEN.includes('业务内容') && problemOf(404, 'detail').text === '没有这一条。' && !problemOf(404, 'detail').retry && problemOf(503, 'detail').retry && problemOf(503, 'list').text.includes('暂时读不到') && problemOf(0, 'list').text.includes('连不上') && problemOf(200, 'list') === null);
ok('列表的 404 不说「没有这一条」（列表只有详情才说这句）', problemOf(404, 'list').text !== '没有这一条。');
ok('空着：全部用四类的说明；某一类说这一类还没有', emptyKindText('all') === KNOWLEDGE_EMPTY && emptyKindText('skill') === '「方法」这一类还没有内容。');
ok('出处链接只认 http / https', safeUrl('https://a.example/x') === 'https://a.example/x' && safeUrl('http://a.example') !== null && safeUrl('javascript:alert(1)') === null && safeUrl('/api/x') === null && safeUrl(null) === null);
ok('说法里没有开发用语、不露代号', [SOURCE_NOT_READY, SOURCE_DEGRADED, KNOWLEDGE_FORBIDDEN, ...[401, 403, 503, 0, 500].map((x) => problemOf(x, 'detail').text)].every((t) => !/接口|字段|ygl|dept:|not_ready|degraded|null/i.test(t)));

console.log(`\nknowledge-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
