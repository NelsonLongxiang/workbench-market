#!/usr/bin/env node
/** #1086 台和主页卡片的对应（web/src/bench-link-view.ts）：本站台页面地址怎么认、卡片状态怎么显示、选卡片清单、改对应的结果怎么说；
 *  加上 market-view 的卡片说法跟着走。数据都是合成的。 */
import { benchUseRef, benchUseText, cardHealthKey, cardOptions, linkOutcome, PENDING_LINK_PREFIX } from '../web/src/bench-link-view.ts';
import { workbenchCards } from '../web/src/market-view.ts';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = JSON.stringify;
const O = 'http://market.example.test:9800';
ok('本站台页面：同源或相对的 /use/<台>（带子路径、查询、编码）', benchUseRef(`${O}/use/demo`, O) === 'demo' && benchUseRef('/use/demo/reports?v=a', O) === 'demo' && benchUseRef(`${O}/use/%E5%8F%B0`, O) === '台');
ok('别的来源、别的路径、坏编码、空都不算', benchUseRef('http://other.example.test/use/demo', O) === null && benchUseRef('http://market.example.test:9801/use/demo', O) === null && benchUseRef(`${O}/apps/x/`, O) === null && benchUseRef(`${O}/use/`, O) === null && benchUseRef(`${O}/use/%E0%A4%A`, O) === null && benchUseRef('', O) === null && benchUseRef(5, O) === null);
ok('卡片状态：服务端记了「待对应」就是待对应（哪怕地址读不出）', cardHealthKey('unknown', PENDING_LINK_PREFIX + '……', 'x', O) === 'pending');
ok('卡片状态：地址是本站台页面、不在线——待对应，不是离线；在线照在线', cardHealthKey('down', '', `${O}/use/demo`, O) === 'pending' && cardHealthKey('unknown', '', `${O}/use/demo`, O) === 'pending' && cardHealthKey('up', '', `${O}/use/demo`, O) === 'up');
ok('卡片状态：别的卡片照原来（在线 / 离线 / 不知道）', cardHealthKey('up', '', 'http://x.test/', O) === 'up' && cardHealthKey('down', 'timeout', 'http://x.test/', O) === 'down' && cardHealthKey('', '', 'http://x.test/', O) === 'unknown');
const cards = workbenchCards([{ id: 1, name: '台卡', url: `${O}/use/demo`, last_status: 'down', last_error: '' }, { id: 2, name: '外卡', url: 'http://x.test/', last_status: 'down', last_error: 'timeout' }], O);
ok('主页卡片：本站台页面的卡片写「待对应」，别的离线照写离线', J(cards.map((c) => [c.name, c.usage])) === J([['台卡', '待对应'], ['外卡', '离线']]), J(cards.map((c) => c.usage)));
ok('主页卡片：不传来源时照原来（旧调用方不变）', workbenchCards([{ id: 2, name: '外卡', url: 'http://x.test/', last_status: 'down' }])[0].usage === '离线');
ok('打开说明：写了下一步；有台名写台名，没有不写台标识', benchUseText('合成台').includes('「合成台」') && benchUseText('合成台').includes('对应卡片') && benchUseText(null).includes('数据视图台，') && !benchUseText(null).includes('数据视图台「'));
ok('选卡片清单：只要启用的、id 正整数、有名字的，按名字排，写「名字（#id）」', J(cardOptions([{ id: 3, name: '乙' }, { id: 1, name: '甲' }, { id: 2, name: '停用的', enabled: false }, { id: 0, name: 'x' }, { id: 'a', name: 'y' }, null])) === J([{ value: 1, label: '甲（#1）' }, { value: 3, label: '乙（#3）' }]) && J(cardOptions(null)) === '[]');
ok('改对应：办成了说变没变；409、403、404、断网各有说法；服务端中文句子照说', J(linkOutcome(200, { changed: true })) === J({ kind: 'ok', changed: true }) && linkOutcome(200, {}).changed === false
  && linkOutcome(409, { error: 'conflict' }).text.includes('已经对应了别的视图台') && linkOutcome(403, null).text.includes('管理层') && linkOutcome(404, null).text.includes('找不到') && linkOutcome(0, null).text.includes('连不上')
  && linkOutcome(409, { error: 'conflict', message: '登记的台 3 已经对应了别的视图台' }).text === '登记的台 3 已经对应了别的视图台');
console.log(`\nbench-link-ui-unit: ${pass} 过 / ${fail} 败`); process.exit(fail ? 1 : 0);
