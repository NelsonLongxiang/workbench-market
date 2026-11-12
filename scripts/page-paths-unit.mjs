#!/usr/bin/env node
/** 站内页面路径的单测（web/src/page-paths.ts）：卡片上只把站内真有的页面做成链接；路由表和 App.tsx 一致。全是合成值。 */
import { readFileSync } from 'node:fs';
import { PAGE_SEGMENTS, pageLink } from '../web/src/page-paths.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
const pages = [...new Set([...app.matchAll(/<Route path="\/([a-z0-9-]+)/g)].map((m) => m[1]))].sort();
ok('页面首段和 App.tsx 的路由一致（加删页面没跟上就红）', JSON.stringify(pages) === JSON.stringify([...PAGE_SEGMENTS].sort()), JSON.stringify({ pages, listed: PAGE_SEGMENTS }));
ok('站内页面原样给：带子路径、查询串、锚点的也算；「/」本身也算', pageLink('/work-items/wi_1') === '/work-items/wi_1' && pageLink('/mcp-gateways?access_request=3') === '/mcp-gateways?access_request=3'
  && pageLink('/team#x') === '/team#x' && pageLink('/') === '/' && pageLink('/?a=1') === '/?a=1');
ok('接口地址不给：/api/…', pageLink('/api/principals/pending') === null && pageLink('/api') === null);
ok('路由表里没有的页面不给（/teams、/a2a-peers）', pageLink('/teams') === null && pageLink('/a2a-peers?peer=1') === null);
ok('不是站内路径的不给：外链、//主机、相对路径、空、不是字符串、带控制字符', pageLink('https://evil.invalid/team') === null && pageLink('//evil.invalid/team') === null
  && pageLink('team') === null && pageLink('') === null && pageLink(null) === null && pageLink(7) === null && pageLink('/team\n') === null && pageLink('/team\\x') === null);

console.log(`\npage-paths-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
