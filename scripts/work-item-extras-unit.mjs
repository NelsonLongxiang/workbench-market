#!/usr/bin/env node
/** 事项的期限和附件（web/src/work-item-extras.ts）：字段没到不画、格式不对当没有、链接只认本站 /api/、大小怎么说。 */
import { dueSavedText, listDueTag, attachmentsOf, attachProblem, uploadedId, dueEditable, dueErrorText, dueLabel, dueOf, hasDueField, overdueOf, safeFileUrl, sizeLabel, uploadErrorText, ATTACH_MAX_BYTES } from '../web/src/work-item-extras.ts';

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
ok('传附件没传成的说法（照 #733 的代号）：413 太大、429 两种上限、摘要不符 / 传一半断了重传、文件名不能用、可执行文件、账号不能传、断网；认不出的代号不说成「可执行文件」', uploadErrorText(413, 'attachment_too_large').includes('100 MB') && uploadErrorText(429, 'attachments_pending_bytes_limit').includes('500 MB') && uploadErrorText(429, 'attachments_pending_limit').includes('20 个')
  && uploadErrorText(400, 'sha256_mismatch').includes('重传') && uploadErrorText(400, 'attachment_upload_interrupted').includes('重传') && uploadErrorText(400, 'attachment_name_invalid').includes('文件名') && uploadErrorText(400, 'attachment_executable_refused').includes('可执行')
  && !uploadErrorText(400, 'x').includes('可执行') && uploadErrorText(403, 'work_items_principal_not_active').includes('账号') && !uploadErrorText(415, 'attachment_raw_body_required').includes('类型') && uploadErrorText(0).includes('连不上'));
ok('传上以后的 id：正整数才认（安排时服务端只收正整数）；字符串、0、小数、没给都当没传上', uploadedId({ id: 7 }) === 7 && uploadedId({ id: '7' }) === null && uploadedId({ id: 0 }) === null && uploadedId({ id: 1.5 }) === null && uploadedId({}) === null && uploadedId(null) === null);
ok('改期限没改成的说法：别人改 404、结束了 409、日期不对', dueErrorText(404).includes('建立人') && dueErrorText(409, 'work_item_ended').includes('结束') && dueErrorText(400, 'due_invalid') === '日期不对');
ok('期限能不能改：只照服务端的 can.due（建立人本人、没到终态；管理员不能代改）；没给 can.due 不给改', dueEditable({ can: { due: true } }) && !dueEditable({ can: { due: false } }) && !dueEditable({ can: {} }) && !dueEditable({ can: { due: 'true' } }) && !dueEditable(null));

const T = '2026-11-14';
ok('列表的期限标签：不限期 / 旧服务端没给不显示；过期照 overdue 用 error；今天到期、还剩 ≤3 天用 warning；更远的不上色', listDueTag({ due: null }, T, false) === null && listDueTag({}, T, false) === null
  && JSON.stringify(listDueTag({ due: '2026-11-12', overdue: true }, T, false)) === JSON.stringify({ text: '2026-11-12 · 已过期 2 天', tone: 'error' })
  && JSON.stringify(listDueTag({ due: '2026-11-14', overdue: false }, T, false)) === JSON.stringify({ text: '2026-11-14 · 今天到期', tone: 'warning' })
  && listDueTag({ due: '2026-11-17' }, T, false).tone === 'warning' && listDueTag({ due: '2026-11-18' }, T, false).tone === null && listDueTag({ due: '2026-11-18' }, T, false).text === '2026-11-18 · 还剩 4 天');
ok('列表的期限标签：已经结束的只写日期、不提醒；服务端说过期但本地日期还没过（时区差）照样标过期', JSON.stringify(listDueTag({ due: '2026-11-01', overdue: false }, T, true)) === JSON.stringify({ text: '期限 2026-11-01', tone: null })
  && JSON.stringify(listDueTag({ due: '2026-11-14', overdue: true }, T, false)) === JSON.stringify({ text: '2026-11-14 · 已过期', tone: 'error' }));
ok('列表的期限标签：本地日期已经过了、服务端还没算过期（overdue=false，服务端按 UTC 日期算，北京时间零点到八点之间会这样）照样标「已过期 1 天」，不写「还剩 -1 天」', JSON.stringify(listDueTag({ due: '2026-11-13', overdue: false }, T, false)) === JSON.stringify({ text: '2026-11-13 · 已过期 1 天', tone: 'error' }));
ok('改期限改成了的说法（#773）：告诉了在办的席位 / 还没派出的派出时带上 / 两个都有合成一句 / 都没有不提同步', dueSavedText('2026-12-01', { notified: 2, pending_release: false }) === '期限改成 2026-12-01，已告诉在办的席位'
  && dueSavedText('2026-12-01', { notified: 0, pending_release: true }) === '期限改成 2026-12-01，派出时会带上新期限'
  && dueSavedText('2026-12-01', { notified: 1, pending_release: true }) === '期限改成 2026-12-01；已告诉在办的席位，还没派出的派出时会带上新期限'
  && dueSavedText('2026-12-01', { notified: 0, pending_release: false }) === '期限改成 2026-12-01');
ok('清掉期限也照这个规矩说；不再写「已告诉在办的席位」除非 notified>0；pending_release 只认严格的 true、notified 只认正整数；旧服务端（没这两个键）不提同步', dueSavedText(null, { notified: 0, pending_release: true }) === '期限清掉了，派出时按不限期发'
  && dueSavedText(null, { notified: 3, pending_release: true }) === '期限清掉了；已告诉在办的席位，还没派出的派出时按不限期发' && dueSavedText(null, { notified: 1 }) === '期限清掉了，已告诉在办的席位'
  && dueSavedText('2026-12-01', { notified: '2', pending_release: 'true' }) === '期限改成 2026-12-01' && dueSavedText('2026-12-01', null) === '期限改成 2026-12-01');
console.log(`\nwork-item-extras-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
