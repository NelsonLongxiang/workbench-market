#!/usr/bin/env node
/**
 * 把视图描述的完整契约（server/src/bench-mcp-tools.ts 的 VIEW_DOC_SCHEMA，从 VIEW_DOC_CONTRACT 生成）写进技能 wm-data-views：
 * skills/wm-data-views/references/view-doc-schema.json。view_put 的工具定义里只留最小形状，要写视图的会话按需读这份。
 *
 *   node scripts/gen-view-doc-schema.mjs           重新生成
 *   node scripts/gen-view-doc-schema.mjs --check   只核对：技能里的文件和代码生成的不一致就退出 1（scripts/bench-view-contract-test.mjs 也核这一条）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEW_DOC_SCHEMA } from '../server/src/bench-mcp-tools.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'wm-data-views', 'references', 'view-doc-schema.json');
export const render = () => `${JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'view_put 的 doc 参数（视图描述）', ...VIEW_DOC_SCHEMA }, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = render();
  if (process.argv.includes('--check')) {
    const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (have !== want) { console.error('view-doc-schema.json 和代码不一致：跑 node scripts/gen-view-doc-schema.mjs 重新生成'); process.exit(1); }
    console.log('view-doc-schema.json 和代码一致');
  } else {
    writeFileSync(OUT, want);
    console.log(`已写 ${OUT}（${Buffer.byteLength(want)} 字节）`);
  }
}
