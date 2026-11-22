#!/usr/bin/env node
/**
 * 只增表（留痕）在库这一层改不了：改、删、用 INSERT OR REPLACE 覆盖都被触发器拒绝，正常往后加照常。
 * 留痕的意义就是不能改：只有直接写库才做得到，但做得到就不算留痕。INSERT OR REPLACE 删旧行时不触发 DELETE 触发器
 * （除非开了 recursive_triggers），所以每张表要单独有一条「键已存在的插入一律拦下」的触发器。
 *
 *   一、逐张表：先正常写一行，再用同一个主键 INSERT OR REPLACE、REPLACE INTO、INSERT … ON CONFLICT DO UPDATE 换掉执行人和内容——
 *       都被拒、原来那行一个字没变；UPDATE、DELETE 被拒；不给主键再写一行照常写进去
 *   二、整库：凡是装了「不许改」「不许删」（都不带条件）两条触发器的表，都要有防覆盖的那一条——以后新加的只增表漏了也会在这里红
 *   三、启动自检用的检查（appendOnlySelfCheck，按错误码判断）：库是好的就通过、不留痕；缺一条点名；同名但不拦的（WHEN 0）靠真试一次覆盖抓到
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
  const dbm = await import(pathToFileURL(join(ROOT, 'server', 'src', 'db.ts')).href);
  const { db } = dbm;
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

  console.log('三、启动自检用的检查（appendOnlySelfCheck，启动自检那一行 market.db.append-only-guarded 调的就是它）');
  const logRows = () => db.prepare('SELECT COUNT(*) AS n FROM workbench_event_log').get().n;
  const seqOf = () => db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workbench_event_log'").get()?.seq ?? null;
  const n0 = logRows(), s0 = seqOf();
  const good = dbm.appendOnlySelfCheck();
  check(good.ok === true && good.reason === null && logRows() === n0 && seqOf() === s0,
    '库是好的：通过；核对用的那一行整个回滚掉，事件日志行数、行号都没变', { good, n0, n: logRows(), s0, s: seqOf() });
  const names = dbm.APPEND_ONLY_TRIGGERS;
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));
  check(Array.isArray(names) && names.length >= 15 && names.every((n) => have.has(n)) && TABLES.every((t) => names.some((n) => n.startsWith(t.table === 'workbench_event_log' ? 'wbe_log_' : `${t.table}_`))),
    `名单（${names.length} 条）里的触发器库里都有，上面逐张测的表都在名单里`, names.filter((n) => !have.has(n)));
  // 反过来：库里只增表（不带条件的不许改、不许删都有）上的每一条改、删、覆盖触发器都要在名单里——名单漏一条，启动自检就少守一条
  const guards = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
    .filter((x) => appendOnly.includes(x.tbl_name) && /_no_(update|delete|replace)$/.test(x.name)) // 只看防改、删、覆盖的；同表上的业务规则（比如不许审自己的）不算
    .map((x) => x.name);
  check(guards.length > 0 && guards.every((n) => names.includes(n)), `只增表上的改、删、覆盖触发器（${guards.length} 条）都在名单里`, guards.filter((n) => !names.includes(n)));
  // 拿掉一条：点名缺的是哪条
  const rsql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wbe_log_no_replace'").get().sql;
  db.exec('DROP TRIGGER wbe_log_no_replace');
  const gone = dbm.appendOnlySelfCheck();
  // 同名但不拦的（名字在、防线没了）：要靠真试一次覆盖才抓得到
  db.exec("CREATE TRIGGER wbe_log_no_replace BEFORE INSERT ON workbench_event_log WHEN 0 BEGIN SELECT RAISE(ABORT, 'x'); END");
  const hollow = dbm.appendOnlySelfCheck();
  // 同名、也拦，只是报的话不一样：照样算被触发器拒了（按错误码 1811 认，不看文字）
  db.exec('DROP TRIGGER wbe_log_no_replace');
  db.exec("CREATE TRIGGER wbe_log_no_replace BEFORE INSERT ON workbench_event_log WHEN EXISTS (SELECT 1 FROM workbench_event_log WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'synthetic other'); END");
  const odd = dbm.appendOnlySelfCheck();
  db.exec('DROP TRIGGER wbe_log_no_replace'); db.exec(rsql);
  const back = dbm.appendOnlySelfCheck();
  check(gone.ok === false && gone.reason === 'missing:wbe_log_no_replace' && hollow.ok === false && hollow.reason === 'replace-accepted' && back.ok === true && !back.warn && logRows() === n0,
    '缺一条：不通过、点名缺的那条；同名但不拦的：不通过（覆盖被接受）；装回去照常通过；都不留痕', { gone, hollow, back });
  check(odd.ok === true && !odd.warn && odd.reason === null && logRows() === n0,
    '触发器只是换了报错的话：照样通过（按错误码认，不看文字），不留痕', odd);
  // 只读、盘满、开保存点失败、已经在事务里：试写那一步做不了，记 warn、照常启动；回滚两句哪句失败都整个回滚，事务不一直开着；都不留痕
  const { DatabaseSync: DS } = await import('node:sqlite');
  const file = join(OUT, 'data', 'workbench-market.db');
  const ro = new DS(file, { readOnly: true });
  const readonly = dbm.appendOnlySelfCheck(ro); const roOpen = ro.isTransaction; ro.close();
  const synthetic = (code) => Object.assign(new Error('synthetic'), { errcode: code });
  // 包一层主库连接：碰到指定的语句就抛带错误码的错（盘满、开保存点失败、回滚失败这些造不出来的情况用它）
  const failing = (rule) => ({
    get isTransaction() { return db.isTransaction; },
    exec(sql) { if (rule.exec?.test(sql)) throw synthetic(rule.code); return db.exec(sql); },
    prepare(sql) { if (rule.prepare?.test(sql)) { const boom = () => { throw synthetic(rule.code); }; return { get: boom, run: boom, all: boom }; } return db.prepare(sql); },
  });
  const full = dbm.appendOnlySelfCheck(failing({ prepare: /^INSERT INTO workbench_event_log/, code: 13 })); const fullOpen = db.isTransaction;
  const spBusy = dbm.appendOnlySelfCheck(failing({ exec: /^SAVEPOINT/, code: 5 })); const spOpen = db.isTransaction;
  db.exec('BEGIN'); const inTx = dbm.appendOnlySelfCheck(); const outerKept = db.isTransaction; db.exec('ROLLBACK');
  const rbFail = dbm.appendOnlySelfCheck(failing({ exec: /^ROLLBACK TO/, code: 1 })); const rbOpen = db.isTransaction;
  const relFail = dbm.appendOnlySelfCheck(failing({ exec: /^RELEASE/, code: 1 })); const relOpen = db.isTransaction;
  // 错误码按低 8 位归类（扩展码也认）：517（SQLITE_BUSY_SNAPSHOT）、6（SQLITE_LOCKED）归库忙，1032（SQLITE_READONLY_DBMOVED）归只读
  const ext = Object.fromEntries([517, 6, 1032].map((code) => [code, dbm.appendOnlySelfCheck(failing({ prepare: /^INSERT INTO workbench_event_log/, code }))]));
  const extOpen = db.isTransaction;
  // 覆盖时被触发器以外的约束先拒（1299 SQLITE_CONSTRAINT_NOTNULL、275 SQLITE_CONSTRAINT_CHECK，主码都是 19）：没测出结论，记 warn，不能算通过
  const otherCon = Object.fromEntries([1299, 275].map((code) => [code, dbm.appendOnlySelfCheck(failing({ prepare: /^INSERT OR REPLACE INTO workbench_event_log/, code }))]));
  const otherOpen = db.isTransaction;
  check(ext[517].ok === true && ext[517].warn === true && ext[517].reason === 'write-test-skipped:busy'
    && ext[6].ok === true && ext[6].warn === true && ext[6].reason === 'write-test-skipped:busy'
    && ext[1032].ok === true && ext[1032].warn === true && ext[1032].reason === 'write-test-skipped:readonly' && extOpen === false,
    '扩展错误码按低 8 位归类：写那一行报 517、6 记 warn「busy」，报 1032 记 warn「readonly」，照常启动', { ext, extOpen });
  check(otherCon[1299].ok === true && otherCon[1299].warn === true && otherCon[1299].reason === 'write-test-inconclusive:error'
    && otherCon[275].ok === true && otherCon[275].warn === true && otherCon[275].reason === 'write-test-inconclusive:error' && otherOpen === false && logRows() === n0,
    '覆盖被别的约束先拒（1299、275，主码也是 19）：不算被触发器拦，记 warn「write-test-inconclusive」，不能算通过；不留痕', { otherCon, otherOpen });
  check(readonly.ok === true && readonly.warn === true && readonly.reason === 'write-test-skipped:readonly' && roOpen === false,
    '库只读：记 warn「write-test-skipped:readonly」，照常启动；事务没开着', { readonly, roOpen });
  check(full.ok === true && full.warn === true && full.reason === 'write-test-skipped:full' && fullOpen === false,
    '盘满（写那一行报 13）：记 warn「write-test-skipped:full」，照常启动；事务没开着', { full, fullOpen });
  check(spBusy.ok === true && spBusy.warn === true && spBusy.reason === 'write-test-skipped:busy' && spOpen === false,
    '开保存点失败（报 5）：记 warn「write-test-skipped:busy」，照常启动', { spBusy, spOpen });
  check(inTx.ok === true && inTx.warn === true && inTx.reason === 'write-test-skipped:in-transaction' && outerKept === true,
    '连接已经在一个事务里：不做试写（整个回滚会连带别人的写），记 warn；外层事务原样开着', { inTx, outerKept });
  check(rbFail.ok === true && !rbFail.warn && rbOpen === false && relFail.ok === true && !relFail.warn && relOpen === false && logRows() === n0 && seqOf() === s0,
    '回滚到保存点失败、释放保存点失败：都整个回滚，事务不一直开着，不留痕', { rbFail, rbOpen, relFail, relOpen, n: logRows(), seq: seqOf() });
  // 别的进程锁着写、超过等锁上限：试写那一步做不了——记 warn，照常启动；不留痕。用第二个连接占住写锁冒充
  const { DatabaseSync } = await import('node:sqlite');
  const other = new DatabaseSync(join(OUT, 'data', 'workbench-market.db'));
  other.exec('BEGIN IMMEDIATE');
  const t0 = Date.now(); const busy = dbm.appendOnlySelfCheck(); const waited = Date.now() - t0;
  other.exec('ROLLBACK'); other.close();
  const after = dbm.appendOnlySelfCheck();
  check(busy.ok === true && busy.warn === true && busy.reason === 'write-test-skipped:busy' && waited < 15000 && after.ok === true && !after.warn && logRows() === n0,
    `别的连接锁着写：等满上限（这次 ${waited} 毫秒）以后记 warn「write-test-skipped:busy」，不拦启动；锁放开以后照常通过；不留痕`, { busy, waited, after });
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`append-only-tables-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
