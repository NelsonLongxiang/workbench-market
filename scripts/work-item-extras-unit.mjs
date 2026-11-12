#!/usr/bin/env node
/** 事项的期限和附件（web/src/work-item-extras.ts）：字段没到不画、格式不对当没有、链接只认本站 /api/、大小怎么说。 */
import { attachmentsOf, attachProblem, dueEditable, dueErrorText, dueLabel, dueOf, hasDueField, overdueOf, safeFileUrl, sizeLabel, uploadErrorText, ATTACH_MAX_BYTES } from '../web/src/work-item-extras.ts';

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

ok('服务端给没给期限字段：有 due 键（哪怕 null）才算给了；过期照服务端的 overdue', hasDueField({ due: null }) && !hasDueField({}) && !hasDueField(null) && overdueOf({ overdue: true }) && !overdueOf({ overdue: 'true' }) && !overdueOf({}));
ok('详情里服务端给的附件链接 /api/work-items/<事项>/attachments/<附件> 认得', attachmentsOf({ attachments: [{ id: 'a1', name: 'x.pdf', size: 3, mime: 'application/pdf', sha256: 'ab', url: '/api/work-items/wi-1/attachments/a1' }] }).length === 1);
ok('传之前先挡：超过 5 个、超过 100 MB、空文件', attachProblem(10, 5) === '最多挂 5 个附件' && attachProblem(ATTACH_MAX_BYTES + 1, 0).includes('100 MB') && attachProblem(0, 0) === '这个文件是空的' && attachProblem(ATTACH_MAX_BYTES, 4) === null);
ok('传附件没传成的说法：413 太大、415 类型、429 两种上限、摘要不符、可执行文件、断网', uploadErrorText(413).includes('100 MB') && uploadErrorText(415).includes('类型') && uploadErrorText(429, 'attachments_pending_bytes_limit').includes('500 MB') && uploadErrorText(429, 'attachments_pending_limit').includes('20 个')
  && uploadErrorText(400, 'sha256_mismatch').includes('重传') && uploadErrorText(400, 'x').includes('可执行') && uploadErrorText(0).includes('连不上'));
ok('改期限没改成的说法：别人改 404、结束了 409、日期不对', dueErrorText(404).includes('建立人') && dueErrorText(409, 'work_item_ended').includes('结束') && dueErrorText(400, 'due_invalid') === '日期不对');
const T = ['done', 'failed', 'dropped', 'cancelled'];
const d = (state, extra = {}) => ({ item: { state, creator_principal: 'user:a' }, creator: { principal: 'user:a' }, ...extra });
ok('期限能不能改：服务端给了 can.due 照它；没给看登录的人是不是建立人；终态不能改；没登录不能改', dueEditable(d('progress'), 'user:a', T) && !dueEditable(d('progress'), 'user:b', T) && !dueEditable(d('done'), 'user:a', T)
  && !dueEditable(d('progress'), null, T) && dueEditable(d('progress', { can: { due: true } }), 'user:b', T) && !dueEditable(d('progress', { can: { due: false } }), 'user:a', T) && !dueEditable(null, 'user:a', T));

console.log(`\nwork-item-extras-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
