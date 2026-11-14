#!/usr/bin/env node
/** 答法按钮不露英文代号（统筹 11-14：对端公钥那张卡片的两个按钮直接显示 confirm-key、disable）。
 *  守两件事：①「关注」各来源会给的答法（从 server/src/attention-providers.ts 里读出来，新加来源也跟着进来）都有中文说法；
 *  ② 认不出的答法、「我处理过的」里服务端原样给的代号，也换成中文，不露出来。全是合成值。 */
import { readFileSync } from 'node:fs';
import { ANSWER_LABEL, answerLabel, confirmButtonText, looksLikeCode, viaInputLabel } from '../web/src/attention-view.ts';
import { recentOf } from '../web/src/remember-view.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };
const latin = (s) => /[A-Za-z]/.test(s);

// ① 服务端「关注」各来源列的答法：answers 数组里的、answer_via.answers 的键
const src = readFileSync(new URL('../server/src/attention-providers.ts', import.meta.url), 'utf8');
const codes = new Set();
for (const m of src.matchAll(/answers\b[^\n]*/g)) for (const q of m[0].matchAll(/\[([^\]]*)\]/g)) for (const t of q[1].matchAll(/'([a-z][a-z0-9_-]*)'/g)) codes.add(t[1]);
for (const m of src.matchAll(/^\s*'?([a-z][a-z0-9_-]*)'?: \{ (?:path|body)\b/gm)) codes.add(m[1]);
ok('从服务端读出了答法（读法失灵时这里先红，不会空过）', codes.size >= 10 && codes.has('confirm-key') && codes.has('disable') && codes.has('release') && codes.has('finish'), [...codes].join(','));
const missing = [...codes].filter((c) => !Object.prototype.hasOwnProperty.call(ANSWER_LABEL, c));
ok('「关注」各来源会给的答法都有中文说法', missing.length === 0, missing.join(','));
ok('所有答法说法里没有英文字母', Object.values(ANSWER_LABEL).every((v) => v && !latin(v)), J(ANSWER_LABEL));
ok('对端公钥那张卡片：确认新公钥 / 停用这个对端（和卡片上「填入完整指纹确认，或者停用这个对端」对得上）', answerLabel('confirm-key') === '确认新公钥' && answerLabel('disable') === '停用这个对端');
ok('认不出的答法写「办这一步」，不露代号', answerLabel('rotate-key') === '办这一步' && answerLabel('toString') === '办这一步' && answerLabel('__proto__') === '办这一步');
ok('确认新公钥要填的是指纹，提示不写「理由」；停用要写理由', viaInputLabel({ to: 'fingerprint', required: true }).includes('指纹') && !viaInputLabel({ to: 'fingerprint', required: true }).includes('理由') && viaInputLabel({ to: 'reason', required: true }) === '写一句理由（必填）' && viaInputLabel({ to: 'note', required: false }) === '留一句（可不填）');

ok('填完以后的确定按钮：确定不给、确定停用这个对端；「确认新公钥」不叠成「确定确认新公钥」', confirmButtonText('不给') === '确定不给' && confirmButtonText(answerLabel('disable')) === '确定停用这个对端' && confirmButtonText(answerLabel('confirm-key')) === '确认新公钥');

// ② 「我处理过的」：服务端说法表里没有的答法会原样给代号
const rec = recentOf({ items: [
  { source: 'a2a-peers', source_id: 'p-syn', title: null, answer: 'confirm-key', answer_text: 'confirm-key', answered_at: '2026-11-14T08:00:00Z' },
  { source: 'a2a-peers', source_id: 'p-syn2', title: null, answer: 'disable', answered_at: '2026-11-14T08:00:00Z' },
  { source: 'work-items', source_id: 'wi-syn', title: '合成', answer: 'release', answer_text: '放行', answered_at: '2026-11-14T08:00:00Z' },
] });
ok('「我处理过的」：服务端给的是代号或没给，换成按钮上的说法；给了中文照用', rec[0].answer_text === '确认新公钥' && rec[1].answer_text === '停用这个对端' && rec[2].answer_text === '放行', JSON.stringify(rec.map((r) => r.answer_text)));
ok('像代号的判断：小写英文、短横线算；中文不算', looksLikeCode('confirm-key') && looksLikeCode('ack') && !looksLikeCode('放行') && !looksLikeCode(''));

function J(x) { return JSON.stringify(x); }
console.log(`\nanswer-label-unit: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
