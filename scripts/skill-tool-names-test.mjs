#!/usr/bin/env node
/**
 * 技能正文里写到的 MCP 工具名都得是真有的（冷读第二组：入门技能里写的 app_publish 早就移除了，席位照着找不到）。
 *
 * 工具目录取 surfaces/mcp-tools.json（市场自己的工具的快照；它和代码对不上时 surface-snapshot 会先红）。
 * 扫 skills/ 下全部 .md：凡是「目录里某个工具名的头一段 + 下划线 + …」这种写法（app_…、workbench_…、dataset_…），
 * 都当成工具名来核，不在目录里就报出来（文件、行号、名字）。不是工具名、只是碰巧长得像的（比如字段 workbench_id），登记在下面的 NOT_TOOLS 里，写明是什么。
 * 上游聚合进来的工具（taste__* 这类）不在本地目录里，头一段也不和本地工具撞，不受这条检查。
 *
 *   node scripts/skill-tool-names-test.mjs                 测本仓库
 *   node scripts/skill-tool-names-test.mjs --root DIR      测另一棵目录树（变异测试用）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
/** 长得像工具名、其实不是的：名字 → 是什么 */
const NOT_TOOLS = new Map([
  ['workbench_id', '数据视图台对应的市场台号（GET /api/bench-views 的字段）'],
]);

const tools = new Set(JSON.parse(readFileSync(join(ROOT, 'surfaces/mcp-tools.json'), 'utf8')).map((x) => String(x).split(/\s+/)[0]));
const heads = [...new Set([...tools].map((n) => n.split('_')[0]))].sort((a, b) => b.length - a.length);
const RE = new RegExp(`(?<![A-Za-z0-9_./-])((?:${heads.join('|')})_[a-z0-9_]+)`, 'g');
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.md')) files.push(p); } };
walk(join(ROOT, 'skills'));

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
const bad = [];
let seen = 0;
for (const f of files.sort()) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(RE)) {
      seen++;
      if (!tools.has(m[1]) && !NOT_TOOLS.has(m[1])) bad.push(`${relative(ROOT, f)}:${i + 1} ${m[1]}`);
    }
  });
}
ok(`工具目录读到了（${tools.size} 个），技能文件扫到了（${files.length} 份）`, tools.size > 20 && files.length > 5);
ok(`技能正文里写到的工具名（${seen} 处）都在工具目录里`, bad.length === 0, bad.join('；'));
ok('登记为「不是工具名」的，确实不是工具名', [...NOT_TOOLS.keys()].every((n) => !tools.has(n)));
console.log(`skill-tool-names-test: ${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
