#!/usr/bin/env node
/** 驾驶舱左栏紧凑行（web/src/cockpit-attention.ts）：键、标签怎么说、选中的那条还在不在。 */
import { rowKey, rowTag, stillThere, TAG_COLOR } from '../web/src/cockpit-attention.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

ok('一条的键：来源 + 编号（同一件事项的验收和提问是两条）', rowKey({ source: 'work-items', source_id: 'wi-1' }) === 'work-items:wi-1' && rowKey({ source: 'seat-asks', source_id: '7' }) !== rowKey({ source: 'work-items', source_id: '7' }));
ok('标签：等你验收 / 等你过目 / 等你核准 / 等你审核；认不出的写等你处理', rowTag({ category: 'accept' }) === '等你验收' && rowTag({ category: 'glance' }) === '等你过目' && rowTag({ category: 'grant' }) === '等你核准' && rowTag({ category: 'review' }) === '等你审核' && rowTag({ category: 'zzz' }) === '等你处理');
ok('在问你：有名字写「某某 在问你」，没有就只写「在问你」（不露标识）', rowTag({ category: 'ask' }, '合成甲') === '合成甲 在问你' && rowTag({ category: 'ask' }, '  ') === '在问你' && rowTag({ category: 'ask' }) === '在问你');
ok('标签颜色和全景卡片同一组', TAG_COLOR.accept === 'green' && TAG_COLOR.ask === 'gold' && TAG_COLOR.grant === 'purple');
const rows = [{ source: 'work-items', source_id: 'a' }, { source: 'mcp-access', source_id: '3' }];
ok('选中的那条还在：在就是 true；答完消失了、没选都是 false', stillThere('work-items:a', rows) && !stillThere('work-items:b', rows) && !stillThere(null, rows) && !stillThere('work-items:a', []));

console.log(`\ncockpit-attention-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
