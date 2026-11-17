#!/usr/bin/env node
/**
 * 红线清单（server/src/red-lines.ts）的核对：每一条红线都要有对抗例盯着。
 *   · 标识唯一、写法对；标题、说明不空；
 *   · 盯着它的对抗组脚本存在、接进了 CI，并且有一项检查的标题里带 `[red-line:<id>]`；
 *   · 「在代码里哪儿管着」写的文件都存在；
 *   · 反过来，脚本里出现的 `[red-line:…]` 标记都要在清单里（删了红线、对抗例里的标记没跟着改，也红）。
 * 不起实例，只读文件。
 *
 *   node scripts/red-lines-test.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { RED_LINES } = await import(pathToFileURL(join(ROOT, 'server/src/red-lines.ts')).href);

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);

const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const ids = RED_LINES.map((r) => r.id);
check(ids.length >= 1 && new Set(ids).size === ids.length && ids.every((id) => /^[a-z][a-z0-9-]{1,63}$/.test(id))
  && RED_LINES.every((r) => r.title.trim() && r.detail.trim()),
  `红线 ${ids.length} 条：标识唯一、写法对，标题和说明都不空`, show(ids));

const noTest = [], notInCi = [], noMarker = [], noCode = [];
for (const r of RED_LINES) {
  const p = join(ROOT, r.test);
  if (!existsSync(p)) { noTest.push(r.id); continue; }
  if (!ci.includes(`node ${r.test}`)) notInCi.push(`${r.id}（${r.test}）`);
  if (!readFileSync(p, 'utf8').includes(`[red-line:${r.id}]`)) noMarker.push(`${r.id}（${r.test}）`);
  for (const f of r.enforced_in.split('、')) if (!existsSync(join(ROOT, f.trim()))) noCode.push(`${r.id}：${f}`);
}
check(noTest.length === 0 && notInCi.length === 0, '每条红线指的对抗组脚本都存在、都接进了 CI', show({ noTest, notInCi }));
check(noMarker.length === 0, '每条红线在它的对抗组里都有一项检查的标题带 [red-line:<id>]', show(noMarker));
check(noCode.length === 0, '「在代码里哪儿管着」写的文件都存在', show(noCode));

// 反过来：脚本里的标记都在清单里
const stray = [];
for (const f of readdirSync(join(ROOT, 'scripts')).filter((n) => n.endsWith('.mjs') && n !== 'red-lines-test.mjs')) {
  for (const m of readFileSync(join(ROOT, 'scripts', f), 'utf8').matchAll(/\[red-line:([a-z0-9-]+)\]/g)) if (!ids.includes(m[1])) stray.push(`${f}：${m[1]}`);
}
check(stray.length === 0, '脚本里出现的 [red-line:…] 标记都在红线清单里（删了红线要把标记一起去掉）', show(stray));

console.log(`red-lines-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
