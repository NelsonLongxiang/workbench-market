#!/usr/bin/env node
/**
 * 只增表（留痕）在库这一层改不了：改、删、用 INSERT OR REPLACE 覆盖都被触发器拒绝，正常往后加照常。
 * 留痕的意义就是不能改：只有直接写库才做得到，但做得到就不算留痕。INSERT OR REPLACE 删旧行时不触发 DELETE 触发器
 * （除非开了 recursive_triggers），所以每张表要单独有一条「键已存在的插入一律拦下」的触发器。
 *
 *   一、逐张表：先正常写一行，再用同一个主键 INSERT OR REPLACE、REPLACE INTO、INSERT … ON CONFLICT DO UPDATE 换掉执行人和内容——
 *       都被拒、原来那行一个字没变；UPDATE、DELETE 被拒；不给主键再写一行照常写进去
 *   二、整库：凡是装了「不许改」「不许删」（都不带条件）两条触发器的表，都要有防覆盖的那一条——以后新加的只增表漏了也会在这里红
 *
 * 被测的就是启动建出来的库（server/src/db.ts，再加工作台事件那几张表的 initWorkbenchEvents），所以直接加载（不经接口）：
 * 这些是库这一层的防线，经接口造不出「直接写库」；库在临时目录里，跑完删掉。
 *
 *   node scripts/append-only-tables-test.mjs              测本仓库
 *   node scripts/append-only-tables-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `append-only-${process.pid}-${Date.now().toString(36)}`);

let pass = 0, fail = 0;
const check = (ok, label, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };
/** 跑一句写库的 SQL，交回被拒的那句话（没被拒交回 null） */
const refused = (db, sql, args = []) => { try { db.prepare(sql).run(...args); return null; } catch (e) { return String(e?.message ?? e); } };
const GUARD = /只增不改|append only/;

/**
 * 每张只增表：主键列、正常写一行要的列和值、用来覆盖的另一组值（换执行人和内容）。
 * 值都是合成的；主键不给（自增的）或给一个固定的号（custom_role_events 的 seq 由代码取）
 */
const TABLES = [
  { table: 'workbench_event_log', pk: 'id', cols: ['event_id', 'actor', 'action', 'detail'], row: ['wbe-0000000000000001', 'synthetic:a', 'created', '{"x":1}'], swap: ['wbe-0000000000000001', 'synthetic:b', 'created', '{"x":2}'] },
  { table: 'task_events', pk: 'id', cols: ['task_id', 'type', 'actor', 'payload_json'], row: [1, 'created', 'synthetic:a', '{}'], swap: [1, 'published', 'synthetic:b', '{"x":2}'], needsTask: true },
  { table: 'team_events', pk: 'seq', cols: ['host', 'team', 'kind', 'actor', 'detail', 'at'], row: ['0a1b2c3d', 'zone/canvas/syn', 'claim', 'synthetic:a', '', 1], swap: ['0a1b2c3d', 'zone/canvas/syn', 'release', 'synthetic:b', 'x', 2] },
  { table: 'custom_role_events', pk: 'seq', fixedPk: 1, cols: ['role_id', 'event', 'actor', 'after', 'at'], row: ['syn-role', 'create', 'synthetic:a', '{}', 1], swap: ['syn-role', 'delete', 'synthetic:b', '{"x":2}', 2] },
  { table: 'knowledge_project_dept_log', pk: 'id', cols: ['project', 'new_department', 'actor', 'at'], row: ['proj-syn', 'dept-syn-a', 'synthetic:a', 1], swap: ['proj-syn', 'dept-syn-b', 'synthetic:b', 2] },
];

rmSync(OUT, { recursive: true, force: true });
try {
  mkdirSync(join(OUT, 'data'), { recursive: true });
  process.env.DATA_DIR = join(OUT, 'data');
  process.env.NODE_ENV = 'test';
  const { db } = await import(pathToFileURL(join(ROOT, 'server', 'src', 'db.ts')).href);
  // 真实启动时 db.ts 之后还会建工作台事件那几张表：照样走一遍，测的是启动完的库
  (await import(pathToFileURL(join(ROOT, 'server', 'src', 'workbench-events.ts')).href)).initWorkbenchEvents();

  console.log('一、逐张表：改、删、覆盖都被拒');
  for (const t of TABLES) {
    if (t.needsTask) refused(db, "INSERT INTO tasks (id, title) VALUES (1, '合成任务')"); // task_events 引用 tasks(id)
    const cols = [...(t.fixedPk ? [t.pk] : []), ...t.cols];
    const vals = (v) => [...(t.fixedPk ? [t.fixedPk] : []), ...v];
    const ph = cols.map(() => '?').join(', ');
    const first = refused(db, `INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${ph})`, vals(t.row));
    const pk = db.prepare(`SELECT ${t.pk} AS k FROM ${t.table} ORDER BY ${t.pk} DESC LIMIT 1`).get()?.k;
    check(first === null && pk != null, `${t.table}：（准备）正常写一行`, first);
    const snap = () => JSON.stringify(db.prepare(`SELECT * FROM ${t.table} WHERE ${t.pk} = ?`).get(pk));
    const before = snap();
    const allCols = [t.pk, ...t.cols], allPh = allCols.map(() => '?').join(', '), swapVals = [pk, ...t.swap];
    const set = t.cols.map((c) => `${c} = excluded.${c}`).join(', ');
    const tries = {
      'INSERT OR REPLACE': refused(db, `INSERT OR REPLACE INTO ${t.table} (${allCols.join(', ')}) VALUES (${allPh})`, swapVals),
      'REPLACE INTO': refused(db, `REPLACE INTO ${t.table} (${allCols.join(', ')}) VALUES (${allPh})`, swapVals),
      'ON CONFLICT DO UPDATE': refused(db, `INSERT INTO ${t.table} (${allCols.join(', ')}) VALUES (${allPh}) ON CONFLICT (${t.pk}) DO UPDATE SET ${set}`, swapVals),
    };
    check(Object.values(tries).every((m) => m && GUARD.test(m)) && snap() === before,
      `${t.table}：同一个主键 INSERT OR REPLACE、REPLACE INTO、ON CONFLICT DO UPDATE 换执行人和内容——都被拒，原来那行没变`, { tries, before, after: snap() });
    const upd = refused(db, `UPDATE ${t.table} SET ${t.cols[t.cols.indexOf('actor')] ?? t.cols[0]} = 'synthetic:b' WHERE ${t.pk} = ?`, [pk]);
    const del = refused(db, `DELETE FROM ${t.table} WHERE ${t.pk} = ?`, [pk]);
    check(upd && GUARD.test(upd) && del && GUARD.test(del) && snap() === before, `${t.table}：UPDATE、DELETE 被拒`, { upd, del });
    const n0 = db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get().n;
    const nextVals = t.fixedPk ? [t.fixedPk + 1, ...t.swap] : t.swap;
    const more = refused(db, `INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${ph})`, nextVals);
    check(more === null && db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get().n === n0 + 1, `${t.table}：再正常写一行（新的主键）照常写进去`, more);
  }

  console.log('二、整库：装了不许改、不许删的表都要有防覆盖');
  const trg = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  const plain = (kind) => (x) => new RegExp(`BEFORE\\s+${kind}\\s+ON\\s`, 'i').test(x.sql) && !/\bWHEN\b/i.test(x.sql);
  const appendOnly = [...new Set(trg.filter(plain('UPDATE')).map((x) => x.tbl_name))].filter((t) => trg.some((x) => x.tbl_name === t && plain('DELETE')(x))).sort();
  const noReplace = appendOnly.filter((t) => !trg.some((x) => x.tbl_name === t && /BEFORE\s+INSERT\s+ON\s/i.test(x.sql) && /WHEN\s+EXISTS/i.test(x.sql)));
  check(appendOnly.length >= TABLES.length && TABLES.every((t) => appendOnly.includes(t.table)), `认出 ${appendOnly.length} 张只增表（不带条件的不许改、不许删都有）`, appendOnly);
  check(noReplace.length === 0, '这些表每张都有防覆盖的触发器（键已存在的插入一律拦下）', { noReplace, appendOnly });
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`append-only-tables-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
