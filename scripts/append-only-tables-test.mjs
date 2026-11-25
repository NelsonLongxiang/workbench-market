#!/usr/bin/env node
/**
 * 只增表（留痕）在库这一层改不了：改、删、用同一个键覆盖式插入（OR REPLACE）都被触发器拒绝，正常往后加照常。
 * 留痕的意义就是不能改：只有直接写库才做得到，但做得到就不算留痕。覆盖式插入删旧行时不触发 DELETE 触发器
 * （除非开了 recursive_triggers），所以每张表要单独有一条「键已存在的插入一律拦下」的触发器（键是表上全部的唯一键）。
 *
 *   一、逐张表：先正常写一行，再用同一个键 INSERT OR REPLACE、REPLACE INTO、INSERT … ON CONFLICT DO UPDATE 换掉执行人和内容——
 *       都被拒、原来那行一个字没变；UPDATE、DELETE 照这张表的规矩被拒（删照旧的表反过来断言删得掉：留给按时间清理）；
 *       不给主键再写一行照常写进去。workbench_events 另有唯一键 event_id：不给 id、同一个 event_id 的覆盖也被拒
 *   二、整库：凡是装了不带条件的「不许改」「不许删」两条的表，都要有防覆盖；装了「不许改」的表，除了靠「已存在就跳过」去重的
 *       login_events_seen，也都要有防覆盖——以后新加的只增表漏了会在这里红
 *   三、不加防覆盖的两张照常：login_events_seen 同一个事件再记一次被跳过、不报错，改被拒、按时间删得掉；
 *       attention_answers 抢占（已存在就跳过）照常、第二个抢不到也不报错，待办行能改成办完、能删，办完的那一行不许改、不许删
 *   四、补充裁定的三类：a2a_inbound_receipts 去重照常、改删被拒；a2a_rosters、a2a_roster_seats（冻结）新增、覆盖、改、删都被拒；
 *       work_item_requests 同一个键再写、改、删都被拒，换一个键照常
 *   五、启动自检用的检查（appendOnlySelfCheck，按错误码判断）：库是好的就通过、不留痕；缺一条点名；同名但不拦的（WHEN 0）靠真试一次覆盖抓到
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
const GUARD = /只增不改|append only|never changed|never deleted|已冻结|治理审计不可(?:改写|覆盖)/;
const REPORT_GOVERNANCE_GUARDS = [
  'report_governance_no_replace', 'report_governance_audit_no_update', 'report_governance_audit_no_replace',
];

/**
 * 每张只增表：主键列、正常写一行要的列和值、用来覆盖的另一组值（换执行人和内容）、要拦哪几样（缺省改、删、覆盖都拦）。
 * 值都是合成的；主键不给（自增的）或给一个固定的号（custom_role_events 的 seq 由代码取）
 */
const ALL = ['update', 'delete', 'replace'];
const TABLES = [
  // 第一批（#975）
  { table: 'workbench_event_log', pk: 'id', cols: ['event_id', 'actor', 'action', 'detail'], row: ['wbe-0000000000000001', 'synthetic:a', 'created', '{"x":1}'], swap: ['wbe-0000000000000001', 'synthetic:b', 'created', '{"x":2}'] },
  { table: 'task_events', pk: 'id', cols: ['task_id', 'type', 'actor', 'payload_json'], row: [1, 'created', 'synthetic:a', '{}'], swap: [1, 'published', 'synthetic:b', '{"x":2}'], needsTask: true },
  { table: 'team_events', pk: 'seq', cols: ['host', 'team', 'kind', 'actor', 'detail', 'at'], row: ['0a1b2c3d', 'zone/canvas/syn', 'claim', 'synthetic:a', '', 1], swap: ['0a1b2c3d', 'zone/canvas/syn', 'release', 'synthetic:b', 'x', 2] },
  { table: 'custom_role_events', pk: 'seq', fixedPk: 1, cols: ['role_id', 'event', 'actor', 'after', 'at'], row: ['syn-role', 'create', 'synthetic:a', '{}', 1], swap: ['syn-role', 'delete', 'synthetic:b', '{"x":2}', 2] },
  { table: 'knowledge_project_dept_log', pk: 'id', cols: ['project', 'new_department', 'actor', 'at'], row: ['proj-syn', 'dept-syn-a', 'synthetic:a', 1], swap: ['proj-syn', 'dept-syn-b', 'synthetic:b', 2] },
  // 第二批（#976 裁定）：审计、变更记录
  { table: 'bench_bind_audit', pk: 'id', cols: ['slug', 'action', 'after', 'actor', 'at'], row: ['syn-bench', 'workbench', '1', 'synthetic:a', 1], swap: ['syn-bench', 'workbench', '2', 'synthetic:b', 2] },
  { table: 'bench_mcp_audit', pk: 'id', cols: ['bench', 'session_id', 'action', 'tools', 'actor', 'at'], row: ['syn-bench', 1, 'approve', '["list_rows"]', 'synthetic:a', 1], swap: ['syn-bench', 1, 'revoke', '["put_rows"]', 'synthetic:b', 2] },
  { table: 'mcp_grant_audit', pk: 'id', cols: ['session_id', 'action', 'actor', 'grants_after'], row: [1, 'approve', 'synthetic:a', '["read"]'], swap: [1, 'revoke', 'synthetic:b', '["write"]'] },
  { table: 'sop_run_file_audit', pk: 'id', cols: ['run_id', 'name', 'size', 'sha256', 'source'], row: [1, 'syn.txt', 5, 'aa', 'synthetic:a'], swap: [1, 'syn-b.txt', 6, 'bb', 'synthetic:b'] },
  { table: 'sop_run_upgrade_audit', pk: 'id', cols: ['run_id', 'from_version', 'to_version', 'actor', 'reason'], row: [1, 1, 2, 'synthetic:a', '合成'], swap: [1, 1, 3, 'synthetic:b', '换掉'] },
  { table: 'workbench_var_audit', pk: 'id', cols: ['workbench_id', 'key', 'action', 'actor', 'new_sha256'], row: [1, 'syn_key', 'set', 'synthetic:a', 'aa'], swap: [1, 'syn_key', 'set', 'synthetic:b', 'bb'] },
  { table: 'a2a_roster_changes', pk: 'id', cols: ['host', 'kind', 'team', 'detail', 'at'], row: ['0a1b2c3d', 'seat-added', 'zone/canvas/syn', 'synthetic:a', '2026-11-22T00:00:00.000Z'], swap: ['0a1b2c3d', 'seat-removed', 'zone/canvas/syn', 'synthetic:b', '2026-11-22T00:00:01.000Z'] },
  { table: 'task_center_events', pk: 'id', cols: ['actor', 'action', 'detail'], row: ['synthetic:a', 'policy_changed', '{"x":1}'], swap: ['synthetic:b', 'policy_changed', '{"x":2}'] },
  // 删照旧（留给按时间清理）：拦改和覆盖
  { table: 'mcp_calls', pk: 'id', cols: ['session_name', 'method', 'tool', 'seat'], row: ['synthetic:a', 'tools/call', 'list_rows', 'synthetic:a'], swap: ['synthetic:b', 'tools/call', 'put_rows', 'synthetic:b'], deny: ['update', 'replace'] },
  { table: 'a2a_seat_token_log', pk: 'id', cols: ['at', 'host', 'outcome', 'reason'], row: [1, 'synthetic:a', 'issued', ''], swap: [2, 'synthetic:b', 'refused', 'x'], deny: ['update', 'replace'] },
  { table: 'report_governance_audit', pk: 'id', cols: ['at', 'proposal_id', 'action', 'channel', 'session_id', 'principal_id', 'actor_id', 'status'],
    row: [1, 1, 'report.governance-propose', 'rest', 1, 'synthetic:a', null, 'pending'],
    swap: [2, 1, 'report.governance-confirmed', 'market', 1, 'synthetic:a', 'synthetic:b', 'confirmed'], deny: ['update', 'replace'] },
  // 发出去就不变：不删（原有）、不改、不覆盖；另有唯一键 event_id
  { table: 'workbench_events', pk: 'id', cols: ['event_id', 'source', 'workbench', 'item', 'context_id', 'submitter_kind', 'submitter', 'data_sha256', 'dispatch', 'routed'],
    row: ['wbe-00000000000000a1', 'task-center', 'syn-bench', 'syn-item', 'ctx-a', 'human', 'synthetic:a', 'aa', 1, 'target'],
    swap: ['wbe-00000000000000a1', 'task-center', 'syn-bench', 'syn-item', 'ctx-b', 'human', 'synthetic:b', 'bb', 1, 'target'], uniqueOnly: 'event_id' },
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

  console.log('一、逐张表：照各自的规矩，改、删、覆盖被拒');
  for (const t of TABLES) {
    const deny = new Set(t.deny ?? ALL);
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
    // 别的唯一键：不给主键、同一个唯一键的覆盖（workbench_events 的 event_id）
    if (t.uniqueOnly) tries[`不给主键、同一个 ${t.uniqueOnly} 的 INSERT OR REPLACE`] = refused(db, `INSERT OR REPLACE INTO ${t.table} (${t.cols.join(', ')}) VALUES (${t.cols.map(() => '?').join(', ')})`, t.swap);
    check(Object.values(tries).every((m) => m && GUARD.test(m)) && snap() === before,
      `${t.table}：同一个键 INSERT OR REPLACE、REPLACE INTO、ON CONFLICT DO UPDATE${t.uniqueOnly ? `（还有只撞 ${t.uniqueOnly} 的）` : ''} 换执行人和内容——都被拒，原来那行没变`, { tries, before, after: snap() });
    const upd = refused(db, `UPDATE ${t.table} SET ${t.cols[t.cols.indexOf('actor')] ?? t.cols[0]} = ? WHERE ${t.pk} = ?`, [t.swap[t.cols.indexOf('actor')] ?? t.swap[0], pk]);
    if (deny.has('delete')) {
      const del = refused(db, `DELETE FROM ${t.table} WHERE ${t.pk} = ?`, [pk]);
      check(upd && GUARD.test(upd) && del && GUARD.test(del) && snap() === before, `${t.table}：UPDATE、DELETE 被拒`, { upd, del });
    } else check(upd && GUARD.test(upd) && snap() === before, `${t.table}：UPDATE 被拒`, { upd });
    const n0 = db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get().n;
    const swapNext = t.uniqueOnly ? t.swap.map((v, i) => (t.cols[i] === t.uniqueOnly ? `${v}-next` : v)) : t.swap;
    const nextVals = t.fixedPk ? [t.fixedPk + 1, ...swapNext] : swapNext;
    const more = refused(db, `INSERT INTO ${t.table} (${cols.join(', ')}) VALUES (${ph})`, nextVals);
    check(more === null && db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get().n === n0 + 1, `${t.table}：再正常写一行（新的键）照常写进去`, more);
    if (!deny.has('delete')) {
      const del = refused(db, `DELETE FROM ${t.table} WHERE ${t.pk} = ?`, [pk]);
      check(del === null && snap() === undefined, `${t.table}：删照旧（留给按时间清理）`, del);
    }
  }

  // 提案允许合法状态流转。防覆盖须同时认主键和幂等唯一键。
  db.prepare("INSERT INTO principals (id, id_key, kind) VALUES ('user:governance-fixture', 'user:governance-fixture', 'person')").run();
  const session = db.prepare("INSERT INTO mcp_sessions (name, token_sha256, responsible_principal) VALUES ('append-only-governance-fixture', ?, 'user:governance-fixture') RETURNING id").get('a'.repeat(64)).id;
  const cols = 'session_id, principal_id, op, target_key, idempotency_key, request_sha256, snapshot_sha256, frozen, created_at, expires_at';
  const values = [session, 'user:governance-fixture', 'bench-bind', '["bench","report"]', 'first', 'a'.repeat(64), 'b'.repeat(64), '{}', 1, 2];
  const restoreValues = [...values.slice(0, 4), 'different', ...values.slice(5)];
  const insert = 'INSERT INTO report_governance_proposals (' + cols + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const id = db.prepare(insert + ' RETURNING id').get(...values).id;
  const proposal = () => JSON.stringify(db.prepare('SELECT * FROM report_governance_proposals WHERE id = ?').get(id));
  const original = proposal();
  const samePrimary = refused(db, 'INSERT OR REPLACE INTO report_governance_proposals (id, ' + cols + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, ...restoreValues]);
  const sameIdempotency = refused(db, insert.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), values);
  const reason = '报告治理提案不可覆盖';
  check(samePrimary === reason && sameIdempotency === reason && proposal() === original,
    'report_governance_no_replace：主键及幂等键各自冲突均拒绝覆盖，保留原提案', { samePrimary, sameIdempotency });
  const settled = db.prepare("UPDATE report_governance_proposals SET status = 'rejected', decided_at = ? WHERE id = ?").run(2, id).changes;
  const fresh = refused(db, insert, restoreValues);
  check(settled === 1 && fresh === null && db.prepare('SELECT status FROM report_governance_proposals WHERE id = ?').get(id)?.status === 'rejected',
    'report_governance_proposals：合法状态流转与新键提案仍允许', { settled, fresh });

  console.log('二、整库：只增表都要有防覆盖');
  const trg = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  const plain = (kind) => (x) => new RegExp(`BEFORE\\s+${kind}\\s+ON\\s`, 'i').test(x.sql) && !/\bWHEN\b/i.test(x.sql);
  // 防覆盖：键已存在的插入拦下（WHEN EXISTS），或者冻结的表干脆不许新增（不带条件）
  const hasReplace = (t) => trg.some((x) => x.tbl_name === t && /BEFORE\s+INSERT\s+ON\s/i.test(x.sql) && (/WHEN\s+EXISTS/i.test(x.sql) || !/\bWHEN\b/i.test(x.sql)));
  // 靠「已存在就跳过」去重的表故意不拦覆盖（按键拦下的触发器会把去重变成报错）
  const DEDUPE = ['login_events_seen', 'a2a_inbound_receipts'];
  const noUpdate = [...new Set(trg.filter(plain('UPDATE')).map((x) => x.tbl_name))].sort();
  const appendOnly = noUpdate.filter((t) => trg.some((x) => x.tbl_name === t && plain('DELETE')(x)));
  check(TABLES.every((t) => (t.deny ?? ALL).includes('delete') === appendOnly.includes(t.table)), `认出 ${appendOnly.length} 张只增表（不带条件的不许改、不许删都有），和上面逐张测的对得上`, appendOnly);
  check(appendOnly.filter((t) => !DEDUPE.includes(t)).every(hasReplace) && DEDUPE.filter((t) => appendOnly.includes(t)).every((t) => !hasReplace(t)),
    '这些表除了去重表（a2a_inbound_receipts，故意不拦覆盖），每张都有防覆盖（键已存在的插入拦下，或冻结的表不许新增）', { noReplace: appendOnly.filter((t) => !hasReplace(t)) });
  // 装了不许改、没拦删的（删照旧，留给按时间清理）：也要有防覆盖，只有靠「已存在就跳过」去重的 login_events_seen 例外
  const updOnly = noUpdate.filter((t) => !appendOnly.includes(t));
  check(updOnly.filter((t) => !DEDUPE.includes(t)).every(hasReplace) && updOnly.includes('login_events_seen') && !hasReplace('login_events_seen'),
    `装了不许改的另外 ${updOnly.length} 张：除了去重表 login_events_seen（它故意不拦覆盖），都有防覆盖`, { updOnly, noReplace: updOnly.filter((t) => !hasReplace(t)) });

  console.log('三、不加防覆盖的两张照常');
  // login_events_seen：同一个登录事件再记一次被跳过（照 login-session.ts 的写法），不报错；改被拒；按时间删得掉
  const seen = (ev, at) => db.prepare('INSERT OR IGNORE INTO login_events_seen (flow, event_id, seen_at) VALUES (?, ?, ?)').run('syn-flow', ev, at).changes;
  let s1 = null, s2 = null, dupErr = null;
  try { s1 = seen('syn-ev-1', 1); s2 = seen('syn-ev-1', 2); } catch (e) { dupErr = String(e?.message ?? e); }
  const seenUpd = refused(db, "UPDATE login_events_seen SET seen_at = 9 WHERE flow = 'syn-flow' AND event_id = 'syn-ev-1'");
  const seenDel = refused(db, 'DELETE FROM login_events_seen WHERE seen_at < ?', [5]);
  check(s1 === 1 && s2 === 0 && dupErr === null && seenUpd && GUARD.test(seenUpd) && seenDel === null,
    'login_events_seen：头一次记上、同一个事件再记一次被跳过（不报错），改被拒，按时间删得掉', { s1, s2, dupErr, seenUpd, seenDel });
  // attention_answers：照 attention.ts 的写法抢占、办完
  const claim = (by) => db.prepare("INSERT OR IGNORE INTO attention_answers (source, source_id, answer, state, answered_by) VALUES ('syn-src', ?, 'approve', 'pending', ?)");
  let c1 = null, c2 = null, claimErr = null;
  try { c1 = claim().run('syn-1', 'synthetic:a').changes; c2 = claim().run('syn-1', 'synthetic:b').changes; } catch (e) { claimErr = String(e?.message ?? e); }
  const pendingDel = refused(db, "DELETE FROM attention_answers WHERE source = 'syn-src' AND source_id = 'syn-1' AND state = 'pending'");
  claim().run('syn-1', 'synthetic:a');
  const toDone = refused(db, "UPDATE attention_answers SET state = 'done', status = 200, body = '{}' WHERE source = 'syn-src' AND source_id = 'syn-1'");
  const row = () => JSON.stringify(db.prepare("SELECT * FROM attention_answers WHERE source = 'syn-src' AND source_id = 'syn-1'").get());
  const done = row();
  const doneUpd = refused(db, "UPDATE attention_answers SET answered_by = 'synthetic:b', body = '{\"x\":2}' WHERE source = 'syn-src' AND source_id = 'syn-1'");
  const doneDel = refused(db, "DELETE FROM attention_answers WHERE source = 'syn-src' AND source_id = 'syn-1'");
  let c3 = null; try { c3 = claim().run('syn-1', 'synthetic:b').changes; } catch (e) { claimErr = claimErr ?? String(e?.message ?? e); }
  check(c1 === 1 && c2 === 0 && claimErr === null && pendingDel === null && toDone === null,
    'attention_answers：抢占（已存在就跳过）照常，第二个抢不到也不报错；待办行能删、能改成办完', { c1, c2, claimErr, pendingDel, toDone });
  check(doneUpd && /不改/.test(doneUpd) && doneDel && /不删/.test(doneDel) && c3 === 0 && row() === done,
    'attention_answers：办完的那一行不许改、不许删，再来抢也只是跳过，那一行没变', { doneUpd, doneDel, c3 });

  console.log('四、补充裁定的三类');
  // a2a_inbound_receipts：入站回执去重（照 a2a-receipts.ts 的写法），同一个回执再来一次被跳过、不报错；改、删被拒
  const rcpt = () => db.prepare("INSERT OR IGNORE INTO a2a_inbound_receipts (task_id, class, disposition, outcome) VALUES ('syn-task-1', 'ack', 'acknowledged', '')").run().changes;
  let r1 = null, r2 = null, rcptErr = null;
  try { r1 = rcpt(); r2 = rcpt(); } catch (e) { rcptErr = String(e?.message ?? e); }
  const rcptUpd = refused(db, "UPDATE a2a_inbound_receipts SET outcome = 'x' WHERE task_id = 'syn-task-1'");
  const rcptDel = refused(db, "DELETE FROM a2a_inbound_receipts WHERE task_id = 'syn-task-1'");
  check(r1 === 1 && r2 === 0 && rcptErr === null && rcptUpd && GUARD.test(rcptUpd) && rcptDel && GUARD.test(rcptDel),
    'a2a_inbound_receipts：头一次记上、同一个回执再来一次被跳过（不报错），改、删被拒', { r1, r2, rcptErr, rcptUpd, rcptDel });
  // a2a_rosters、a2a_roster_seats：冻结的旧表。旧库里本来就有行：临时拿掉「不许新增」那条、写一行冒充存量，再原样装回去
  const frozen = [
    ['a2a_rosters', "INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, 'https://syn.invalid', 'z', 't', 't')", 'host'],
    ['a2a_roster_seats', "INSERT INTO a2a_roster_seats (host, team, seat, first_seen_at) VALUES (?, 'z/canvas/syn', 'z/0000000a', 't')", 'host'],
  ];
  for (const [table, ins, key] of frozen) {
    const insName = `${table}_frozen_insert`;
    const insSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(insName)?.sql;
    let seeded = null;
    if (insSql) { db.exec(`DROP TRIGGER ${insName}`); seeded = refused(db, ins, ['0a1b2c3d']); db.exec(insSql); }
    const snapF = () => JSON.stringify(db.prepare(`SELECT * FROM ${table} WHERE ${key} = '0a1b2c3d'`).all());
    const beforeF = snapF();
    const fIns = refused(db, ins, ['0e0e0e0e']);
    const fRep = refused(db, ins.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), ['0a1b2c3d']);
    const fUpd = refused(db, `UPDATE ${table} SET ${key} = ${key} WHERE ${key} = '0a1b2c3d'`);
    const fDel = refused(db, `DELETE FROM ${table} WHERE ${key} = '0a1b2c3d'`);
    check(insSql && seeded === null && [fIns, fRep, fUpd, fDel].every((m) => m && /已冻结/.test(m)) && snapF() === beforeF && beforeF !== '[]',
      `${table}：冻结的旧表——新增、覆盖、改、删都被拒，存量那一行没变`, { insSql: Boolean(insSql), seeded, fIns, fRep, fUpd, fDel });
  }
  // work_item_requests：安排一件事的幂等记账。照 services/task-center.ts 的写法先查再写；同一个键再写（普通插入、覆盖、ON CONFLICT）都被拒，换一个键照常
  const wir = "INSERT INTO work_item_requests (requester, idem_key, body_sha256, task_id, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  const w1 = refused(db, wir, ['person:syn-a', 'syn-key-000000000001', 'aa', 1, 'wbe-0000000000000001', '2026-11-22 00:00:00']);
  const wSnap = () => JSON.stringify(db.prepare("SELECT * FROM work_item_requests WHERE requester = 'person:syn-a' AND idem_key = 'syn-key-000000000001'").get());
  const wBefore = wSnap();
  const wDup = refused(db, wir, ['person:syn-a', 'syn-key-000000000001', 'bb', 2, 'wbe-0000000000000002', '2026-11-22 00:00:01']);
  const wRep = refused(db, wir.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), ['person:syn-a', 'syn-key-000000000001', 'bb', 2, 'wbe-0000000000000002', '2026-11-22 00:00:01']);
  const wOn = refused(db, wir + ' ON CONFLICT (requester, idem_key) DO UPDATE SET body_sha256 = excluded.body_sha256', ['person:syn-a', 'syn-key-000000000001', 'bb', 2, 'wbe-0000000000000002', '2026-11-22 00:00:01']);
  const wUpd = refused(db, "UPDATE work_item_requests SET body_sha256 = 'bb' WHERE requester = 'person:syn-a'");
  const wDel = refused(db, "DELETE FROM work_item_requests WHERE requester = 'person:syn-a'");
  const w2 = refused(db, wir, ['person:syn-a', 'syn-key-000000000002', 'cc', 3, 'wbe-0000000000000003', '2026-11-22 00:00:02']);
  check(w1 === null && [wDup, wRep, wOn, wUpd, wDel].every((m) => m && GUARD.test(m)) && wSnap() === wBefore && w2 === null,
    'work_item_requests：同一个键再写（普通插入、覆盖、ON CONFLICT）、改、删都被拒，原来那行没变；换一个键照常写进去', { w1, wDup, wRep, wOn, wUpd, wDel, w2 });
  console.log('五、启动自检用的检查（appendOnlySelfCheck，启动自检那一行 market.db.append-only-guarded 调的就是它）');
  const logRows = () => db.prepare('SELECT COUNT(*) AS n FROM workbench_event_log').get().n;
  const seqOf = () => db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'workbench_event_log'").get()?.seq ?? null;
  const n0 = logRows(), s0 = seqOf();
  const good = dbm.appendOnlySelfCheck();
  check(good.ok === true && good.reason === null && logRows() === n0 && seqOf() === s0,
    '库是好的：通过；核对用的那一行整个回滚掉，事件日志行数、行号都没变', { good, n0, n: logRows(), s0, s: seqOf() });
  const names = dbm.APPEND_ONLY_TRIGGERS;
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));
  check(Array.isArray(names) && names.length >= 15 && names.every((n) => have.has(n)) && TABLES.every((t) => names.some((n) => n.startsWith({ workbench_event_log: 'wbe_log_', workbench_events: 'wbe_events_' }[t.table] ?? `${t.table}_`))),
    `名单（${names.length} 条）里的触发器库里都有，上面逐张测的表都在名单里`, names.filter((n) => !have.has(n)));
  // 反过来：库里每一条按命名规则的防改、删、覆盖触发器都要在名单里——名单漏一条，启动自检就少守一条。
  //   不只只增表：可以改的主表（授予、事项、领域、报告维度）上的「不删、不能覆盖」也算（以后谁在别的表上加 _no_delete / _no_replace，也得进名单）
  const guards = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
    // 只看防改、删、覆盖的（加上冻结表的、答复账「办完的不动」的）；同表上的业务规则（比如不许审自己的）不算
    .filter((x) => /_no_(update|delete|replace)$/.test(x.name) || /_frozen_(insert|update|delete)$|^attention_answers_done_(fixed|kept)$/.test(x.name))
    .map((x) => x.name);
  // 可以改的主表上的守护（不删、不能覆盖）在名单里：授予、事项、领域、报告维度
  const MAIN = ['grants', 'work_items', 'areas', 'report_dimensions'].flatMap((t) => [`${t}_no_delete`, `${t}_no_replace`]);
  check(MAIN.every((n) => names.includes(n) && have.has(n)), '可以改的主表（授予、事项、领域、报告维度）上不删、不能覆盖那八条在名单里，库里也有', MAIN.filter((n) => !names.includes(n) || !have.has(n)));
  check(guards.length > 0 && guards.every((n) => names.includes(n)), `库里防改、删、覆盖的触发器（${guards.length} 条）都在名单里`, guards.filter((n) => !names.includes(n)));
  for (const name of REPORT_GOVERNANCE_GUARDS) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)?.sql;
    if (!sql) { check(false, name + '：库里有已定义的保护触发器'); continue; }
    db.exec('DROP TRIGGER ' + name);
    const missing = dbm.appendOnlySelfCheck();
    db.exec(sql);
    const restored = dbm.appendOnlySelfCheck();
    check(!missing.ok && missing.reason === 'missing:' + name && restored.ok && !restored.warn && logRows() === n0 && seqOf() === s0,
      name + '：启动自检精确点名，恢复后通过且不留痕', { missing, restored });
  }
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
