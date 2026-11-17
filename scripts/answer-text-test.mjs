#!/usr/bin/env node
/**
 * 「我处理过的」里答法的说法（knowledge-remember.ts 的 ANSWER_TEXT）要盖住「关注」各来源的全部答法（单测，不起服务）：
 *   · 答复入口的转发表、直接实现的（attention-answers.ts 的 answersOf，按来源逐个问）；
 *   · 条目上列的答法（attention-providers.ts 里 answers: [...] 写到的每一个，含只经 answer_via 答的，比如对端公钥的 confirm-key、disable）。
 * 漏了就会把代号原样给到页面上。只用临时数据目录。
 *
 *   node scripts/answer-text-test.mjs
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `answer-text-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { ANSWER_TEXT } = await import(at('server/src/knowledge-remember.ts'));
  const { answersOf } = await import(at('server/src/attention-answers.ts'));
  const providers = readFileSync(join(ROOT, 'server/src/attention-providers.ts'), 'utf8');
  const sources = [...new Set([...providers.matchAll(/source: '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]))];
  const listed = [...providers.matchAll(/answers: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)].map((x) => x[1]));
  const all = new Set([...sources.flatMap((s) => answersOf(s)), ...listed]);
  const missing = [...all].filter((a) => typeof ANSWER_TEXT[a] !== 'string' || !ANSWER_TEXT[a].trim());
  check(sources.length >= 8 && all.size >= 11 && missing.length === 0,
    `「我处理过的」的答法说法盖住「关注」全部 ${all.size} 种答法（${sources.length} 个来源的转发表、直接实现的，和条目上列的）`, `缺：${missing.join('、')}`);
  check(ANSWER_TEXT['confirm-key'] === '确认新公钥' && ANSWER_TEXT.disable === '停用这个对端' && ANSWER_TEXT.finish === '验收通过',
    '只经 answer_via 答的、SOP 验收的说法和卡片按钮一致', JSON.stringify({ k: ANSWER_TEXT['confirm-key'], d: ANSWER_TEXT.disable, f: ANSWER_TEXT.finish }));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`answer-text-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
