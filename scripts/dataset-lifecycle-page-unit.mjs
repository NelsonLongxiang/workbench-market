#!/usr/bin/env node
/** 数据集退役与恢复页（web/src/dataset-lifecycle-view.ts，#1015）的纯函数单测：应答整形、阻断的说法、占用、确认检查、凭据剩余、没成的说法。数据都是合成的。 */
import { asActive, asPrecheck, asRetired, blockerText, bytesText, confirmProblem, lifecycleError, newOperationId, ticketLeft } from '../web/src/dataset-lifecycle-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const J = (x) => JSON.stringify(x);

const active = asActive({ datasets: [{ name: 'zeta', title: 'Z', columns: [{}, {}] }, { name: 'alpha', title: 'A', columns: [{}] }] });
ok('在用清单：按名字排序，列数取列定义个数', J(active) === J([{ name: 'alpha', title: 'A', columns: 1 }, { name: 'zeta', title: 'Z', columns: 2 }]));
ok('在用清单：应答不像样当读取出错，不显示成空', asActive(null) === null && asActive({ datasets: 'x' }) === null && asActive({ datasets: [{ title: '没名字' }] }) === null);
ok('在用清单：空数组就是没有', J(asActive({ datasets: [] })) === '[]');
const retired = asRetired({ datasets: [{ name: 'old', title: '旧', row_count: 2, data_bytes: 2048, revision: 3 }] });
ok('已退役清单：保留行数、占用、修订', retired?.[0]?.row_count === 2 && retired[0].data_bytes === 2048 && retired[0].revision === 3);
ok('已退役清单：缺行数或占用当读取出错', asRetired({ datasets: [{ name: 'old', title: '旧', data_bytes: 1, revision: 1 }] }) === null && asRetired({}) === null);

const good = { bench: 'b', dataset: 'old', title: '旧', rows: 2, bytes: 10, state: 'active', blockers: [], ticket: 't'.repeat(43), ticket_ref: 'rt-12345678', expires_at: 1000 };
ok('预检：没有阻断、有票和到期时刻', asPrecheck(good)?.ticket === good.ticket && asPrecheck(good)?.expires_at === 1000);
ok('预检：有票却没到期时刻，当不像样', asPrecheck({ ...good, expires_at: undefined }) === null);
ok('预检：有阻断又有票，当不像样（不给确认）', asPrecheck({ ...good, blockers: [{ kind: 'view', view: 'v', block: 0 }] }) === null);
const blocked = asPrecheck({ ...good, ticket: undefined, ticket_ref: undefined, expires_at: undefined, blockers: [{ kind: 'view', view: 'v', block: 0 }, { kind: 'report', dimension: 'weekly', reason: 'unresolvable' }] });
ok('预检：有阻断时没有票，阻断照原样保留', blocked?.ticket === null && blocked.expires_at === null && blocked.blockers.length === 2 && blocked.blockers[1].reason === 'unresolvable');
ok('预检：阻断里有坏条目当不像样（不能当成没有阻断）', asPrecheck({ ...good, ticket: undefined, blockers: [{ kind: 'view' }, 7] }) === null);

ok('阻断说法：视图块从 1 数，写下一步', blockerText({ kind: 'view', view: 'sales', block: 0 }) === '视图「sales」第 1 个块在用它：先在视图里改指别的数据集或删掉这个块，再预检');
ok('阻断说法：报告绑定用到、解析不了分开说', blockerText({ kind: 'report', dimension: 'w' }).includes('现行绑定用到它') && blockerText({ kind: 'report', dimension: 'w', reason: 'unresolvable' }).includes('解析不了'));
ok('阻断说法：已退役、没退役、公共区', blockerText({ kind: 'state', reason: 'already_retired' }) === '它已经退役了，不用再退役' && blockerText({ kind: 'state', reason: 'not_retired' }) === '它没有退役，不用恢复' && blockerText({ kind: 'public_area', reason: 'public_area_not_retirable' }) === '公共区的数据集首版不能退役');
ok('阻断说法：认不出的照实写，仍是阻断', blockerText({ kind: 'job', reason: 'x' }).includes('job') && blockerText({ kind: 'job' }).includes('先处理'));

ok('占用：字节、KB、MB', bytesText(0) === '0 B' && bytesText(1023) === '1023 B' && bytesText(2048) === '2.0 KB' && bytesText(5 * 1024 * 1024) === '5.0 MB' && bytesText(200 * 1024) === '200 KB');

ok('确认检查：名字要一字不差（大小写、空格都算）', confirmProblem('old', 'Old', '理由') !== '' && confirmProblem('old', 'old ', '理由') !== '' && confirmProblem('old', 'old', '理由') === '');
ok('确认检查：理由不能只有空白，最多 500 字', confirmProblem('old', 'old', '   ') !== '' && confirmProblem('old', 'old', 'x'.repeat(501)) === '理由最多 500 个字' && confirmProblem('old', 'old', 'x'.repeat(500)) === '');

const id = newOperationId(new Uint8Array(16).fill(171));
ok('操作号：符合服务端写法（8～64 位字母数字、下划线、连字符）', /^[A-Za-z0-9_-]{8,64}$/.test(id) && id === 'op-' + 'ab'.repeat(16));
ok('凭据剩余：分:秒，过期回 null', ticketLeft(301_000, 1_000) === '5:00' && ticketLeft(60_500, 1_000) === '0:59' && ticketLeft(1_000, 1_000) === null && ticketLeft(0, 1_000) === null);

ok('没成：400、409 照服务端说', lifecycleError(400, { message: '确认需要复述数据集名' }) === '确认需要复述数据集名' && lifecycleError(409, { message: '预检凭据无效' }) === '预检凭据无效');
ok('没成：403 不透露台在不在，说要什么授予', lifecycleError(403, { error: 'forbidden' }).includes('专用授予'));
ok('没成：401、断网、429、未开数据视图各一句', lifecycleError(401, null) === '请先登录' && lifecycleError(0, null) === '连不上服务，稍后再试' && lifecycleError(429, null).includes('太多') && lifecycleError(404, { error: 'bench_views_off' }) === '这个实例没有开数据视图');
ok('没成：500 不透露原文', lifecycleError(500, { message: 'stack trace secret' }) === '这次没成，稍后再试');

console.log(`dataset-lifecycle-page-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
