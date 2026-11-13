#!/usr/bin/env node
/** 经验库页（web/src/knowledge-view.ts）的纯数据单测：四类的先后和说法、认不出的类别不露代号。 */
import { KNOWLEDGE_EMPTY, KNOWLEDGE_INTRO, KNOWLEDGE_KINDS, kindLabel } from '../web/src/knowledge-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

ok('四类，先后照原型：依据、经验、方法、检查', KNOWLEDGE_KINDS.map((k) => k.label).join() === '依据,经验,方法,检查');
ok('每类都有一句说法，类别键不重复', KNOWLEDGE_KINDS.every((k) => k.meaning.trim().length > 0) && new Set(KNOWLEDGE_KINDS.map((k) => k.key)).size === 4);
ok('类别名：认得的写名字，认不出的写「其他」（不露代号）', kindLabel('claim') === '依据' && kindLabel('verify') === '检查' && kindLabel('weird') === '其他' && kindLabel(undefined) === '其他' && kindLabel('toString') === '其他');
ok('顶上那一句照原型；空态不说在等哪个接口', KNOWLEDGE_INTRO.startsWith('公司越用越聪明') && !/接口|API|还在做/.test(KNOWLEDGE_EMPTY));

console.log(`\nknowledge-ui-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
