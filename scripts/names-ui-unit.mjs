#!/usr/bin/env node
/** 代号换名字的纯函数单测（web/src/names.ts）：名册拍平、句柄补名字、线和阶段的名字、查不到时不露代号。全是合成值。 */
import { cleanSeatName, lifecycleNames, lineName, rosterNames, stageName, withRoster } from '../web/src/names.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const roster = rosterNames([{ team: 'zone/canvas/t', seats: [{ seat: 'zone/98b94be9', name: '成员二 (98b94be9)' }, { seat: 'zone/00', name: '' }, null, { name: 'x' }] }, 'bad']);
ok('名册拍平：句柄 → 名字；没名字、形状不对的不收', roster['zone/98b94be9'] === '成员二' && Object.keys(roster).length === 1 && Object.keys(rosterNames(null)).length === 0);
ok('名字自带句柄后缀时去掉，别的括号不动', cleanSeatName('成员二 (98b94be9)') === '成员二' && cleanSeatName('成员二（98b94be9）') === '成员二' && cleanSeatName('小采 (三组)') === '小采 (三组)');
ok('只有句柄的席位补上名字，写成「名字 · 句柄」；已带名字的、查不到的原样', withRoster('zone/98b94be9', roster) === '成员二 · zone/98b94be9' && withRoster('小采 · zone/a1', roster) === '小采 · zone/a1' && withRoster('zone/ffff', roster) === 'zone/ffff' && withRoster('', roster) === '');
const n = lifecycleNames([{ type: 'pd', stages: [{ code: 'st_pd_05', name: '在售' }, { code: 'x' }, null] }, 'bad'], [{ id: 'run:pd-A', name: '示例产品 A' }, { id: 'run:pd-B', name: null }, 7]);
ok('线和阶段的名字从生命周期取', lineName('run:pd-A', n) === '示例产品 A' && stageName('st_pd_05', n) === '在售');
ok('查不到时不露代号：线写「未命名的线」，阶段不写；没挂线为空', lineName('run:pd-B', n) === '未命名的线' && lineName('zzz') === '未命名的线' && stageName('st_unknown', n) === '' && lineName(null, n) === '' && stageName('', n) === '');

console.log(`\nnames-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
