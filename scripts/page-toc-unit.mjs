#!/usr/bin/env node
/** #1099 块锚点、本页目录（web/src/page-toc-view.ts）：块键、目录条目、地址里的 #、本块链接、滚动高亮、回到顶部。数据都是合成的。 */
import { activeTocKey, anchorFromHash, anchorUrl, blockAnchor, reportTocEntries, showBackToTop, viewTocEntries, TOC_MIN_BLOCKS } from '../web/src/page-toc-view.ts';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = JSON.stringify;
ok('块键是 json-render 元素的 key：b<序号>', blockAnchor(0) === 'b0' && blockAnchor(12) === 'b12');
const blocks = [{ type: 'filter-bar' }, { type: 'stat', title: '本月' }, { type: 'bar', title: ' 各区 ' }, { type: 'table', title: '' }, { type: 'form', title: '登记' }];
ok('视图目录：有标题的块按次序进，键是原来的序号；没标题、空标题的不进', J(viewTocEntries(blocks).map((e) => [e.key, e.title])) === J([['b1', '本月'], ['b2', '各区'], ['b4', '登记']]));
ok(`视图目录：整页不超过 ${TOC_MIN_BLOCKS} 块不出目录`, viewTocEntries(blocks.slice(0, 3)).length === 0 && viewTocEntries(blocks.slice(0, 4)).length === 2 && viewTocEntries(null).length === 0);
const sec = (id, title, children = []) => ({ id, type: 'section', title, children });
const body = [{ id: 'cover', type: 'cover', title: '封面' }, sec('a', '一'), sec('b', '二', [sec('b1', '二·一'), { id: 'g', type: 'grid', children: [sec('b2', '二·二')] }]), sec('c', '三'), { id: 't', type: 'text', content: 'x' }];
ok('报告目录：章节按出现次序，嵌套的层级加一（经过 grid 不加），封面、正文不进', J(reportTocEntries(body).map((e) => [e.key, e.level])) === J([['a', 1], ['b', 1], ['b1', 2], ['b2', 2], ['c', 1]]));
ok(`报告目录：章节不超过 ${TOC_MIN_BLOCKS} 个不出目录；没标题的章节不进`, reportTocEntries([sec('a', '一'), sec('b', '二'), sec('c', '三')]).length === 0 && reportTocEntries([sec('a', ''), sec('b', '二'), sec('c', '三'), sec('d', '四')]).length === 0 && reportTocEntries('x').length === 0);
ok('地址里的 #：去掉井号、解码；空、坏编码、别的字符、太长的都不认', anchorFromHash('#b4') === 'b4' && anchorFromHash('sec-2') === 'sec-2' && anchorFromHash('#a%3Ab') === 'a:b'
  && anchorFromHash('') === null && anchorFromHash('#') === null && anchorFromHash('#%E0%A4%A') === null && anchorFromHash('#<img>') === null && anchorFromHash('#' + 'x'.repeat(81)) === null && anchorFromHash(undefined) === null);
ok('本块链接：保留路径和查询（视图、筛选），接上编码后的块键', anchorUrl('http://m.test', '/use/7', '?v=vk-board&p.site=东', 'b3') === 'http://m.test/use/7?v=vk-board&p.site=东#b3' && anchorUrl('http://m.test', '/use/7/reports', '?report=4', 'a:b') === 'http://m.test/use/7/reports?report=4#a%3Ab');
const tops = [{ key: 'b1', top: -400 }, { key: 'b2', top: 30 }, { key: 'b3', top: 300 }];
ok('滚动高亮：上沿到了阈值以内的最后一块；一块都没到是第一块；滚到底是最后一块；没有块是 null', activeTocKey(tops, 80, false) === 'b2' && activeTocKey([{ key: 'x', top: 200 }, { key: 'y', top: 500 }], 80, false) === 'x' && activeTocKey(tops, 80, true) === 'b3' && activeTocKey([], 80, false) === null);
ok('滚动高亮：地址里 # 指着的块还看得见就是它（靠近页底滚到底也不被抢走）；看不见了照常算', activeTocKey(tops, 80, true, 400, 'b2') === 'b2' && activeTocKey(tops, 80, false, 400, 'b3') === 'b3' && activeTocKey(tops, 80, false, 400, 'b1') === 'b2' && activeTocKey(tops, 80, true, 400, 'zz') === 'b3' && activeTocKey(tops, 80, false, 250, 'b3') === 'b2');
ok('回到顶部：滚过一屏才出现', showBackToTop(501, 500) && !showBackToTop(500, 500) && !showBackToTop(10, 0));
console.log(`\npage-toc-unit: ${pass} 过 / ${fail} 败`); process.exit(fail ? 1 : 0);
