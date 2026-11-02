#!/usr/bin/env node
/** #322 内联样式与散落色值计数（只统计、不拦：属主裁定设计规范 CI 不做门禁）。
 *  每个迁移 PR 跑一次，把前后计数写进 PR 描述。用法：node scripts/inline-style-count.mjs [--json] */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'web/src';
const SKIP = new Set(['tokens.css', 'design-tokens.ts']);
const files = [];
(function walk(d) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(n) && !SKIP.has(n)) files.push(p); } })(ROOT);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const COLOR = /#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![0-9])|rgba?\(\s*\d/g;
const rows = files.map((f) => {
  const src = stripComments(readFileSync(f, 'utf8'));
  return {
    file: relative(ROOT, f),
    style: (src.match(/style=\{\{/g) ?? []).length,
    colors: (src.match(COLOR) ?? []).filter((c) => !/^#\d{3}$/.test(c)).length,
    offScaleFont: (src.match(/fontSize:\s*(11|11\.5|13)\b|font-size:\s*(11|13)px/g) ?? []).length,
  };
}).filter((r) => r.style || r.colors || r.offScaleFont).sort((a, b) => b.style - a.style);
const total = rows.reduce((t, r) => ({ style: t.style + r.style, colors: t.colors + r.colors, offScaleFont: t.offScaleFont + r.offScaleFont }), { style: 0, colors: 0, offScaleFont: 0 });
if (process.argv.includes('--json')) { console.log(JSON.stringify({ total, rows }, null, 2)); process.exit(0); }
console.log('文件'.padEnd(34) + 'style={{'.padStart(10) + '色值'.padStart(6) + '11/13号'.padStart(8));
for (const r of rows) console.log(r.file.padEnd(34) + String(r.style).padStart(10) + String(r.colors).padStart(8) + String(r.offScaleFont).padStart(8));
console.log('合计'.padEnd(34) + String(total.style).padStart(10) + String(total.colors).padStart(8) + String(total.offScaleFont).padStart(8));
