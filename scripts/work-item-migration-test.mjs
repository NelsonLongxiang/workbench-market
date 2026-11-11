#!/usr/bin/env node
/**
 * 事项日志的迁移单测（阶段八 8c 前）：8b 时被拒的原因写在 detail.rejected 里，现在改成单独的 rejected 列。
 * 先用 8b 时的表结构建一个库、写几行，再让现在的 db.ts 打开它：原因搬到列上、detail 里的键拿掉、
 * 只增不改的触发器还在；再打开一次不重复搬。进程内，临时数据目录，不起服务。
 *
 *   node scripts/work-item-migration-test.mjs              测本仓库
 *   node scripts/work-item-migration-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-migration-${process.pid}-${Date.now().toString(36)}`);

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e?.message ?? e) || 'threw'; } };

/** 8b 合并时（7be9ea3）work_item_log 的样子：没有 rejected 列，被拒的原因在 detail.rejected */
const OLD = `
CREATE TABLE work_item_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  fact TEXT NOT NULL CHECK (fact <> ''),
  fact_source TEXT NOT NULL CHECK (fact_source <> ''),
  fact_id TEXT NOT NULL CHECK (fact_id <> ''),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, fact_source, fact_id)
);
CREATE TRIGGER work_item_log_no_update BEFORE UPDATE ON work_item_log BEGIN SELECT RAISE(ABORT, 'work_item_log 只增不改'); END;
CREATE TRIGGER work_item_log_no_delete BEFORE DELETE ON work_item_log BEGIN SELECT RAISE(ABORT, 'work_item_log 只增不改'); END;
INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, detail) VALUES
  ('wi_a', 'create', 'market', 'wi_a', 'draft', 'draft', '{}'),
  ('wi_a', 'release', 'test', 'r1', 'draft', 'draft', '{"rejected":"not_allowed","note":"收到，未采信"}'),
  ('wi_a', 'eval', 'test', 'r2', 'failed', 'failed', '{"verdict":"accept","rejected":"terminal","note":"收到，未采信"}'),
  ('wi_a', 'report', 'test', 'r3', 'accepted', 'progress', '{"status":"progress","summary":"做了一半"}');
`;

const open = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
  `await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)}); console.log('OPENED');`],
  { env: { ...process.env, DATA_DIR: OUT }, encoding: 'utf8' });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  const file = join(OUT, 'workbench-market.db');
  { const old = new DatabaseSync(file); old.exec(OLD); old.close(); }
  const first = open();
  check(first.stdout.includes('OPENED'), '现在的 db.ts 打开 8b 时的库：照常启动', first.stderr.slice(-400));
  const db = new DatabaseSync(file);
  const rows = db.prepare('SELECT fact_id, rejected, detail FROM work_item_log ORDER BY seq').all();
  const by = Object.fromEntries(rows.map((r) => [r.fact_id, r]));
  check(by.r1?.rejected === 'not_allowed' && by.r2?.rejected === 'terminal', '被拒的原因搬到 rejected 列', JSON.stringify(rows));
  check(rows.every((r) => JSON.parse(r.detail).rejected === undefined) && JSON.parse(by.r2.detail).verdict === 'accept' && JSON.parse(by.r1.detail).note === '收到，未采信', 'detail 里只拿掉 rejected 这个键，别的键原样');
  check(by.wi_a?.rejected === '' && by.r3?.rejected === '' && JSON.parse(by.r3.detail).summary === '做了一半', '没被拒的行：rejected 是空的，detail 原样');
  check(/只增不改/.test(throws(() => db.prepare("UPDATE work_item_log SET rejected = '' WHERE fact_id = 'r1'").run())), '搬完之后改写触发器装回来了：改 rejected 列被拒');
  check(/CHECK/i.test(throws(() => db.prepare("INSERT INTO work_item_log (item_id, fact, fact_source, fact_id, from_state, to_state, rejected) VALUES ('wi_a', 'x', 'test', 'r9', 'draft', 'draft', 'whatever')").run())), 'rejected 列只认空、not_allowed、terminal');
  db.close();
  const snapshot = JSON.stringify(new DatabaseSync(file, { readOnly: true }).prepare('SELECT * FROM work_item_log ORDER BY seq').all());
  const second = open();
  const after = JSON.stringify(new DatabaseSync(file, { readOnly: true }).prepare('SELECT * FROM work_item_log ORDER BY seq').all());
  check(second.stdout.includes('OPENED') && after === snapshot, '再打开一次：不再搬，表逐行相同', second.stderr.slice(-300));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
