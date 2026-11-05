#!/usr/bin/env node
/** 待属主看板纯逻辑单测：看板台按 URL 路径找、config.owner 只认作者本人、事项只认登记身份、答复只认属主、来源不符点名不丢、状态排序。 */
import { answerBody, buildBoard, findBoardWorkbench, parseConfig } from '../web/src/owner-pending.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const v = (key, value, owner, extra = {}) => ({ key, kind: 'const', value, revision: 1, owner, updated_by: owner, updated_at: '2026-11-05 08:00:00', ...extra });
const BASE = 'http://market.example:9800';

// 看板台
ok('按路径找到唯一看板台（忽略主机与末尾斜杠）', JSON.stringify(findBoardWorkbench([{ id: 3, url: 'http://other/' }, { id: 7, url: 'http://10.0.0.1:9800/owner-pending/' }], BASE)) === '{"id":7}');
ok('相对地址也认', JSON.stringify(findBoardWorkbench([{ id: 5, url: '/owner-pending' }], BASE)) === '{"id":5}');
ok('没有看板台报错', 'error' in findBoardWorkbench([{ id: 3, url: 'http://x/owner-pending-old' }], BASE));
const two = findBoardWorkbench([{ id: 1, url: '/owner-pending' }, { id: 2, url: 'http://y/owner-pending' }], BASE);
ok('两张看板台报错并点名 id', 'error' in two && /1、2/.test(two.error), JSON.stringify(two));
ok('坏 URL 不抛', 'error' in findBoardWorkbench([{ id: 1, url: 'http://[bad' }], BASE));

// config.owner
const cfgVar = v('config.owner', { owner_login: 'boss', writers: ['mcp:owner-board', 'bad writer', 'odoo:x'] }, 'odoo:boss', { revision: 2 });
const cfg = parseConfig(cfgVar);
ok('config 作者与 owner_login 一致才采信', cfg && !('error' in cfg) && cfg.ownerLogin === 'boss' && cfg.revision === 2);
ok('writers 只收 mcp:<名>', cfg && !('error' in cfg) && JSON.stringify(cfg.writers) === '["mcp:owner-board"]', JSON.stringify(cfg));
ok('没有 config 返回 null', parseConfig(undefined) === null);
ok('作者不是 owner_login 本人不采信', 'error' in parseConfig(v('config.owner', { owner_login: 'boss', writers: ['mcp:a'] }, 'odoo:mallory')));
ok('口令身份写的（作者为空）不采信', 'error' in parseConfig(v('config.owner', { owner_login: 'boss', writers: ['mcp:a'] }, '')));
ok('不是常量不采信', 'error' in parseConfig(v('config.owner', { owner_login: 'boss', writers: ['mcp:a'] }, 'odoo:boss', { kind: 'var' })));
ok('缺 writers 不采信', 'error' in parseConfig(v('config.owner', { owner_login: 'boss' }, 'odoo:boss')));

// 看板
const C = { ownerLogin: 'boss', writers: ['mcp:owner-board'], revision: 1 };
const item = (no, extra = {}) => v(`item.${no}`, { question: `问题 ${no}`, checked: '记忆', waiting_for: '属主', first_raised: '2026-11-05', last_change: '2026-11-05', source: '监督席', ...extra }, 'mcp:owner-board');
const vars = [
  item(1),
  item(2),
  item(3, { status: 'withdrawn' }),
  item(6, { history_answer: { summary: '普通 PR 修', date: '2026-11-05' } }),
  item(10),
  v('answer.2', { summary: '可以', date: '2026-11-06' }, 'odoo:boss', { revision: 3 }),
  v('answer.1', { summary: '假答复' }, 'mcp:someone'),
  v('item.4', { question: '冒名事项' }, 'mcp:other'),
  v('item.5', { question: '变量' }, 'mcp:owner-board', { kind: 'var' }),
  v('item.x1', { question: '坏编号' }, 'mcp:owner-board'),
  v('answer.9', { summary: '孤儿答复' }, 'odoo:boss'),
  v('config.owner', {}, 'odoo:boss'),
  v('other.key', 1, ''),
];
const { rows, anomalies } = buildBoard(vars, C);
const byNo = Object.fromEntries(rows.map((r) => [r.no, r]));
ok('只收登记身份写的常量事项', JSON.stringify(rows.map((r) => r.no).sort()) === '["1","10","2","3","6"]', JSON.stringify(rows.map((r) => r.no)));
ok('属主答复 → 已答复，带修订号', byNo[2].status === 'answered' && byNo[2].answer.summary === '可以' && byNo[2].answer.date === '2026-11-06' && byNo[2].answer.revision === 3 && !byNo[2].answer.historical);
ok('非属主写的答复不算，事项仍待办', byNo[1].status === 'open' && byNo[1].answer === null);
ok('答复编号被占：标出占用者，页面据此禁用答复', byNo[1].answerTakenBy === 'mcp:someone' && byNo[2].answerTakenBy === null && byNo[10].answerTakenBy === null);
ok('撤回优先', byNo[3].status === 'withdrawn');
ok('历史答复算已答复、标历史', byNo[6].status === 'answered' && byNo[6].answer.historical && byNo[6].answer.revision === null);
ok('排序：待办在前按编号数值，再已答复，再撤回', JSON.stringify(rows.map((r) => r.no)) === '["1","10","2","6","3"]', JSON.stringify(rows.map((r) => r.no)));
const why = Object.fromEntries(anomalies.map((a) => [a.key, a.reason]));
ok('冒名答复点名作者', /mcp:someone/.test(why['answer.1'] || ''));
ok('冒名事项点名作者', /mcp:other/.test(why['item.4'] || ''));
ok('变量形式的事项不采信', /常量/.test(why['item.5'] || ''));
ok('坏编号点名', /编号/.test(why['item.x1'] || ''));
ok('孤儿答复点名', /item\.9/.test(why['answer.9'] || ''));
ok('无关键不进异常', !('other.key' in why) && !('config.owner' in why));
ok('答复缺日期时用写入日期', buildBoard([item(7), v('answer.7', { summary: '行' }, 'odoo:boss')], C).rows[0].answer.date === '2026-11-05');

// 写入体
const b1 = answerBody('  好的 ', '2026-11-06', null);
ok('新答复是常量、不带 override', b1.kind === 'const' && b1.override === undefined && b1.value.summary === '好的' && b1.value.date === '2026-11-06');
const b2 = answerBody('改', '2026-11-07', 3);
ok('改答复带 override 与期望 revision', b2.override === true && b2.revision === 3 && b2.kind === 'const' && typeof b2.reason === 'string' && b2.reason.length > 0);

console.log(`\nowner-pending-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
