#!/usr/bin/env node
/**
 * 表结构探查函数的单测（server/src/db.ts 的 tableColumns、hasColumn、hasTable、hasIndex；数据库规划第 0 步）。
 *
 *   · 正例：建好的库上，表、列、索引在的说在，不在的说不在；表不存在时列一律不在
 *   · 等价：每张表 tableColumns 给出的列名，和直接查表结构给出的逐个相同、顺序相同
 *   · 对抗：表名、列名、索引名不是小写标识符的一律抛错，不碰库——拼 SQL、引号、换行、空格、大写、空串、非字符串；
 *     试完之后库里的表一张不少、行数不变
 *
 * 只在临时目录里开库，不读写任何真实数据。
 *   node scripts/db-schema-probe-test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'db-schema-probe-'));
process.env.DATA_DIR = dir;
let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
try {
  const { db, tableColumns, hasColumn, hasTable, hasIndex } = await import('../server/src/db.ts');

  check(hasTable('apps') && hasTable('workbenches'), '在的表：说在');
  check(!hasTable('no_such_table'), '不在的表：说不在');
  check(hasColumn('apps', 'slug') && hasColumn('workbenches', 'cookie_set_id'), '在的列（含迁移加上的列）：说在');
  check(!hasColumn('apps', 'no_such_column'), '不在的列：说不在');
  check(!hasColumn('no_such_table', 'slug') && tableColumns('no_such_table').length === 0, '表不存在：列说不在，列清单为空');
  check(hasIndex('uq_bindings_natural'), '在的索引：说在');
  check(!hasIndex('no_such_index'), '不在的索引：说不在');
  check(!hasTable('uq_bindings_natural') && !hasIndex('apps'), '表和索引不串：索引名问表、表名问索引都说不在');

  // 等价：每张表的列名和原样查表结构的一致
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const differ = tables.filter((t) => JSON.stringify(tableColumns(t).map((c) => c.name)) !== JSON.stringify(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)));
  check(tables.length > 40 && differ.length === 0, `每张表的列名和直接查表结构的逐个相同（${tables.length} 张）`, differ.join('、'));

  // 对抗：名字不合法就抛错，不碰库
  const before = { tables: tables.length, apps: db.prepare('SELECT COUNT(*) AS n FROM apps').get().n };
  const evil = ['apps); DROP TABLE apps; --', 'apps)', "apps'", 'apps"', 'apps\nPRAGMA writable_schema = 1', 'a b', 'Apps', 'APPS', '', ' apps', 'apps ', '1apps', 'apps;', 'apps--', '表', null, undefined, 123, {}, ['apps']];
  const threw = (fn) => { try { fn(); return false; } catch (e) { return /不是合法的表名或列名/.test(String(e?.message)); } };
  const leaks = [];
  for (const name of evil) {
    for (const [label, fn] of [['tableColumns', () => tableColumns(name)], ['hasTable', () => hasTable(name)], ['hasIndex', () => hasIndex(name)], ['hasColumn 表名', () => hasColumn(name, 'slug')], ['hasColumn 列名', () => hasColumn('apps', name)]]) {
      if (!threw(fn)) leaks.push(`${label}(${JSON.stringify(name)})`);
    }
  }
  check(leaks.length === 0, `不合法的名字（${evil.length} 种 × 5 个入口）一律抛错`, leaks.slice(0, 6).join('，'));
  const after = { tables: db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n, apps: db.prepare('SELECT COUNT(*) AS n FROM apps').get().n };
  check(JSON.stringify(before) === JSON.stringify(after) && hasTable('apps'), '试完以后表一张不少、行数不变');
  db.close();
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
