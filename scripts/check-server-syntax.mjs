#!/usr/bin/env node
/** 服务器侧语法核（#164 假绿第六例根治）：tsc 只覆盖 web——server 源必须独立过语法/类型面。
 *  做法：对每个 server/src/**.ts 跑 esbuild transform（语法）+ node 解析（EMPTY 检查）。
 *  退出码非 0 即红（commit 前必跑：pnpm check）。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// esbuild 经 pnpm 存储动态解析（根无直接依赖·版本目录名不硬编码）
import { createRequire } from 'node:module';
import { existsSync as ex2 } from 'node:fs';
const require_ = createRequire(import.meta.url);
let esbuildPath = '';
try {
  esbuildPath = require_.resolve('esbuild');
} catch {
  const store = 'node_modules/.pnpm';
  const dirs = (await import('node:fs')).readdirSync(store).filter((d) => d.startsWith('esbuild@'));
  for (const d of dirs) {
    const c = `${process.cwd()}/${store}/${d}/node_modules/esbuild/lib/main.js`;
    if (ex2(c)) { esbuildPath = c; break; }
  }
}
if (!esbuildPath) { console.error('✗ 无 esbuild（先 pnpm install）'); process.exit(1); }
const { transform } = require_(esbuildPath);

const root = 'server/src';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) files.push(p);
  }
})(root);
let fail = 0;
for (const f of files) {
  try {
    await transform(readFileSync(f, 'utf8'), { loader: 'ts', format: 'esm', target: 'node24' });
  } catch (e) {
    fail++;
    console.error(`✗ 语法核失败：${f}\n  ${String(e.errors?.[0]?.text ?? e.message).split('\n')[0]}`);
  }
}
console.log(fail ? `\n服务器语法核：${fail}/${files.length} 文件失败` : `✓ 服务器语法核：${files.length} 文件全过`);
process.exit(fail ? 1 : 0);
