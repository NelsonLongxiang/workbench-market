#!/usr/bin/env node
/** 事项的期限和附件（web/src/work-item-extras.ts）：字段没到不画、格式不对当没有、链接只认本站 /api/、大小怎么说。 */
import { attachmentsOf, dueLabel, dueOf, safeFileUrl, sizeLabel } from '../web/src/work-item-extras.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = JSON.stringify;

ok('期限：YYYY-MM-DD 才认；没有、空、null、格式不对都当没有（不写「不限」）', dueOf({ due: '2026-11-30' }) === '2026-11-30' && dueOf({ due: ' 2026-11-30 ' }) === '2026-11-30'
  && dueOf({}) === null && dueOf({ due: '' }) === null && dueOf({ due: null }) === null && dueOf({ due: '11/30' }) === null && dueOf(null) === null && dueOf({ due: 20261130 }) === null);
ok('期限说离今天多远：还有 N 天 / 今天到期 / 过了 N 天', dueLabel('2026-11-30', '2026-11-12') === '2026-11-30（还有 18 天）' && dueLabel('2026-11-12', '2026-11-12') === '2026-11-12（今天到期）'
  && dueLabel('2026-11-10', '2026-11-12') === '2026-11-10（过了 2 天）' && dueLabel('2026-12-01', '2026-11-30') === '2026-12-01（还有 1 天）');
ok('取件链接只认本站 /api/ 相对地址：外链、带协议、// 开头、带 .. 的都不认', safeFileUrl('/api/work-items/wi-1/files/3') === '/api/work-items/wi-1/files/3'
  && safeFileUrl('https://x.test/a') === null && safeFileUrl('//x.test/api/a') === null && safeFileUrl('javascript:alert(1)') === null && safeFileUrl('/api/../admin') === null && safeFileUrl('/files/a') === null && safeFileUrl(5) === null);
const list = attachmentsOf({ attachments: [
  { name: '报价单.xlsx', size: 23456, url: '/api/work-items/wi-1/files/1' },
  { name: '  ', size: 1, url: '/api/work-items/wi-1/files/2' },
  { name: '外链.pdf', size: 1, url: 'https://x.test/a.pdf' },
  { name: '不知道大小.png', size: -3, url: '/api/work-items/wi-1/files/4' },
  null, 'x',
] });
ok('附件：名字和安全链接都有才要；大小不是非负整数当不知道', J(list) === J([{ name: '报价单.xlsx', size: 23456, url: '/api/work-items/wi-1/files/1' }, { name: '不知道大小.png', size: null, url: '/api/work-items/wi-1/files/4' }]), J(list));
ok('附件字段没到（或不是数组）：一个都没有，详情不画附件', attachmentsOf({}).length === 0 && attachmentsOf({ attachments: 'x' }).length === 0 && attachmentsOf(null).length === 0);
ok('大小：B / KB / MB / GB，一位小数；不知道写空', sizeLabel(512) === '512 B' && sizeLabel(1536) === '1.5 KB' && sizeLabel(23456) === '23 KB' && sizeLabel(5 * 1024 * 1024) === '5 MB' && sizeLabel(3 * 1024 ** 3) === '3 GB' && sizeLabel(null) === '');

console.log(`\nwork-item-extras-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
