#!/usr/bin/env node
/**
 * Odoo 下线预检（scripts/ops/odoo-offboard-preflight.mjs）：用真实建表建一个合成库，核三项判定、确认人数的开关、只读。
 *
 *   node scripts/odoo-offboard-preflight-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `odoo-offboard-preflight-${process.pid}-${Date.now().toString(36)}`);
const SCRIPT = join(ROOT, 'scripts', 'ops', 'odoo-offboard-preflight.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）`}`); };

/** 用服务端的建表建一个空库（和线上同一套表） */
function freshDb(name) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});`],
    { env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, NODE_ENV: 'test' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`建表没成：${r.stderr.slice(-400)}`);
  return join(dir, 'workbench-market.db');
}
const run = (file, ...extra) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--db', file, '--json', ...extra], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 不是 JSON */ }
  return { code: r.status, json, out: r.stdout, err: r.stderr };
};
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

rmSync(OUT, { recursive: true, force: true });
try {
  // ---------- 空库 ----------
  const empty = freshDb('empty');
  const e = run(empty);
  check(e.code === 1 && e.json?.odoo_only_people === 0 && e.json.full_admins_on_local_accounts === 0 && e.json.red?.join() === 'no-full-admin-on-local-account',
    '空库：没有只靠 Odoo 的人，但也没有落在站内账号上的完整管理员 → 红（只剩口令能管）', e.json ?? e.err);

  // ---------- 合成库 ----------
  const file = freshDb('mixed');
  const d = new DatabaseSync(file);
  const now = Date.now();
  const person = (id, status = 'active') => d.prepare("INSERT INTO principals (id, id_key, kind, display_name, status) VALUES (?, ?, 'person', ?, ?)").run(id, id, id.slice(5), status);
  const bind = (provider, ext, id) => d.prepare('INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES (?, ?, ?, ?)').run(provider, ext, ext.toLowerCase(), id);
  const account = (u) => d.prepare("INSERT INTO local_accounts (username, password_hash, created_at, updated_at) VALUES (?, 'x', ?, ?)").run(u, now, now);
  const grant = (principal, role, scope, status = 'active', expires = null) => {
    const id = Number(d.prepare("INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, '合成', 'cli', ?, ?)").run(principal, role, scope, expires, now, now).lastInsertRowid);
    if (status === 'draft') return;
    d.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(id);
    if (status === 'pending') return;
    d.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(id);
  };
  // 只靠 Odoo：alice（有项目读权、运行读权）、carol（另绑着飞书）
  person('user:alice'); bind('odoo', 'alice', 'user:alice');
  d.prepare("INSERT INTO task_source_read_grants (subject, source, project, workspace_sha256, expires_at, granted_by) VALUES ('user:alice', 'ygl-trees', 'p1', 'w', datetime('now', '+1 day'), 'admin')").run();
  d.prepare("INSERT INTO sop_run_read_grants (run_id, subject) VALUES (1, 'user:alice')").run();
  person('user:carol'); bind('odoo', 'carol', 'user:carol'); bind('feishu', 'ou_carol', 'user:carol');
  // 不算：停用的、读权撤销或过期的、两边都绑着的
  person('user:dave', 'disabled'); bind('odoo', 'dave', 'user:dave');
  d.prepare("INSERT INTO task_source_read_grants (subject, source, project, workspace_sha256, expires_at, granted_by) VALUES ('user:dave', 'ygl-trees', 'p1', 'w', datetime('now', '+1 day'), 'admin')").run();
  d.prepare("INSERT INTO sop_run_read_grants (run_id, subject, revoked_at) VALUES (2, 'user:carol', datetime('now'))").run();
  d.prepare("INSERT INTO task_source_read_grants (subject, source, project, workspace_sha256, expires_at, granted_by) VALUES ('user:carol', 'ygl-trees', 'p1', 'w', datetime('now', '-1 day'), 'admin')").run();
  person('user:bob'); bind('odoo', 'bob', 'user:bob'); bind('local', 'bob', 'user:bob'); account('bob');
  // 完整管理员的几种不算数的：落在只靠 Odoo 的人身上、范围不是 *、还没放行、过期了、绑着站内身份但账号已删、角色是 admin
  grant('user:alice', 'owner', '*');
  person('user:erin'); bind('local', 'erin', 'user:erin'); /* 没有 local_accounts 行 */ grant('user:erin', 'owner', '*');
  person('user:fay'); bind('local', 'fay', 'user:fay'); account('fay'); grant('user:fay', 'owner', '*', 'pending');
  person('user:gus'); bind('local', 'gus', 'user:gus'); account('gus'); grant('user:gus', 'owner', '*', 'active', Date.now() + 2000); // 放行时期限还没到；下面等它过期（状态还没被周期任务标成 expired）
  person('user:hal'); bind('local', 'hal', 'user:hal'); account('hal'); grant('user:hal', 'admin', '*');
  // 四：作者是 odoo: 的常量。bob 对得回（启用、绑着 odoo/bob，大小写不同也算）；ghost 没人绑、dave 停用了，对不回；mcp: 的不算
  const wb = (url) => Number(d.prepare("INSERT INTO workbenches (name, url) VALUES ('合成', ?)").run(url).lastInsertRowid);
  const board = wb('http://market.synthetic.invalid/owner-pending/'), other = wb('http://web.synthetic.invalid/');
  const konst = (w, key, owner) => d.prepare("INSERT INTO workbench_vars (workbench_id, key, kind, value, owner) VALUES (?, ?, 'const', '{}', ?)").run(w, key, owner);
  konst(board, 'config.owner', 'odoo:BOB');
  konst(other, 'k1', 'odoo:ghost');
  konst(other, 'k2', 'odoo:dave');
  konst(other, 'k3', 'mcp:session-1');
  d.prepare("INSERT INTO workbench_vars (workbench_id, key, kind, value, owner) VALUES (?, 'v1', 'var', '{}', 'odoo:ghost')").run(other); // 变量不算
  d.close();
  await new Promise((r) => setTimeout(r, 2500));

  const before = sha(file);
  const r1 = run(file);
  check(r1.json?.odoo_only_people === 2 && r1.json.odoo_only_people_with_feishu === 1,
    '一、只靠 Odoo 登录的人：alice、carol 两人（其中 carol 绑着飞书）；停用的 dave、两边都绑的 bob 不算', r1.json);
  check(r1.json?.full_admins_on_local_accounts === 0,
    '二、完整管理员不算数的几种：落在只靠 Odoo 的人身上、站内账号已删、还没放行、过期、角色是 admin', r1.json);
  check(r1.json?.odoo_only_read_grants?.task_source === 1 && r1.json.odoo_only_read_grants.sop_run === 1 && r1.json.odoo_only_read_grants.people === 1,
    '三、只靠 Odoo 才用得上的待办读权：alice 的项目读权、运行读权各一条（停用的人、撤销的、过期的不算）', r1.json?.odoo_only_read_grants);
  check(r1.json?.odoo_owned_consts?.total === 3 && r1.json.odoo_owned_consts.unmapped === 2 && r1.json.odoo_owned_consts.owner_board === 'mapped',
    '四、作者仍是 odoo: 的常量 3 条（变量、mcp: 的不算），对不回的 2 条（没人绑的、绑着的人停用了）；看板配置对得回（大小写不同也算）', r1.json?.odoo_owned_consts);
  check(r1.code === 1 && ['odoo-only-people', 'no-full-admin-on-local-account', 'read-grants-only-via-odoo', 'odoo-owned-consts-unmapped'].every((k) => r1.json?.red?.includes(k)),
    '四项都红：退出码 1，红的原因逐项列出', { code: r1.code, red: r1.json?.red });
  check(!/alice|carol|bob|dave/.test(r1.out), '输出只有人数，不出现名字、登录名', r1.out.slice(0, 200));
  check(sha(file) === before, '只读：跑完库文件逐字节没变');

  // 补上一个落在站内账号上的完整管理员、收回 alice 的读权
  const w = new DatabaseSync(file);
  w.exec("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE principal_id = 'user:fay'");
  w.exec("UPDATE task_source_read_grants SET revoked_at = datetime('now') WHERE subject = 'user:alice'");
  w.exec("UPDATE sop_run_read_grants SET revoked_at = datetime('now') WHERE subject = 'user:alice'");
  w.exec("UPDATE workbench_vars SET owner = 'odoo:bob' WHERE key IN ('k1', 'k2')"); // 属主重新保存（这里直接改成对得回的作者）
  w.exec("UPDATE workbench_vars SET owner = 'odoo:ghost' WHERE key = 'config.owner'");
  w.close();
  const rb = run(file);
  check(rb.json?.odoo_owned_consts?.unmapped === 1 && rb.json.odoo_owned_consts.owner_board === 'unmapped' && rb.json.red?.includes('odoo-owned-consts-unmapped'),
    '四、看板配置的作者对不回主体：单独点名（unmapped），算红', rb.json?.odoo_owned_consts);
  const w2 = new DatabaseSync(file); w2.exec("UPDATE workbench_vars SET owner = 'user:bob' WHERE key = 'config.owner'"); w2.close();
  const r2 = run(file);
  check(r2.code === 1 && r2.json?.full_admins_on_local_accounts === 1 && r2.json.red?.join() === 'odoo-only-people',
    '补上完整管理员、收回读权之后：只剩「只靠 Odoo 的人」这一项红', r2.json);
  const wrong = run(file, '--accept-odoo-only=1');
  const right = run(file, '--accept-odoo-only=2');
  check(wrong.code === 1 && right.code === 0 && right.json?.ok === true,
    '属主确认这些人不再需要登录：--accept-odoo-only 写的人数要和实际相等（写 1 仍红，写 2 才绿）', { wrong: wrong.code, right: [right.code, right.json?.red] });
  const human = spawnSync(process.execPath, [SCRIPT, '--db', file, '--accept-odoo-only=2'], { encoding: 'utf8' });
  check(human.status === 0 && /结论：绿/.test(human.stdout) && /一、.*2 人/.test(human.stdout) && /四、.*2 条.*0 条.*作者不是 odoo: 写法/.test(human.stdout), '人看的输出：四行结果加一行结论', human.stdout);

  // 登记了两张看板：常量都对得回，也算红（不知道认哪一张）
  const two = freshDb('two-boards');
  const t = new DatabaseSync(two);
  t.prepare("INSERT INTO principals (id, id_key, kind, display_name) VALUES ('user:bob', 'user:bob', 'person', 'bob')").run();
  for (const [p, e] of [['odoo', 'bob'], ['local', 'bob']]) t.prepare('INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES (?, ?, ?, ?)').run(p, e, e, 'user:bob');
  t.prepare("INSERT INTO local_accounts (username, password_hash, created_at, updated_at) VALUES ('bob', 'x', 1, 1)").run();
  const gid = Number(t.prepare("INSERT INTO grants (principal_id, role, scope, reason, created_by, created_at, updated_at) VALUES ('user:bob', 'owner', '*', '合成', 'cli', 1, 1)").run().lastInsertRowid);
  t.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(gid); t.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(gid);
  for (const host of ['a', 'b']) {
    const id = Number(t.prepare("INSERT INTO workbenches (name, url) VALUES ('合成', ?)").run(`http://${host}.synthetic.invalid/owner-pending`).lastInsertRowid);
    t.prepare("INSERT INTO workbench_vars (workbench_id, key, kind, value, owner) VALUES (?, 'config.owner', 'const', '{}', 'odoo:bob')").run(id);
  }
  t.close();
  const r3 = run(two);
  check(r3.code === 1 && r3.json?.odoo_owned_consts?.unmapped === 0 && r3.json.odoo_owned_consts.owner_board === 'ambiguous' && r3.json.red?.join() === 'odoo-owned-consts-unmapped',
    '四、登记了两张看板（作者都对得回）：看板认不准，也算红', r3.json);

  // 验收补的口径和缺口：一个专门的库
  const g = freshDb('gaps');
  const q = new DatabaseSync(g);
  const nowG = Date.now();
  const P = (id, status = 'active') => q.prepare("INSERT INTO principals (id, id_key, kind, display_name, status) VALUES (?, ?, 'person', ?, ?)").run(id, id, id.slice(5), status);
  const B = (provider, ext, id) => q.prepare('INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES (?, ?, ?, ?)').run(provider, ext, ext.toLowerCase(), id);
  const A = (u) => q.prepare("INSERT INTO local_accounts (username, password_hash, created_at, updated_at) VALUES (?, 'x', ?, ?)").run(u, nowG, nowG);
  const G = (principal, role, scope) => {
    const id = Number(q.prepare("INSERT INTO grants (principal_id, role, scope, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, '合成', 'cli', ?, ?)").run(principal, role, scope, nowG, nowG).lastInsertRowid);
    q.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(id); q.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(id);
  };
  // kim：绑着 Odoo 和站内身份，但站内账号已经删了 → 算只靠 Odoo；他的运行读权（只有运行读权，没有项目读权）也算只靠 Odoo 得来
  P('user:kim'); B('odoo', 'kim', 'user:kim'); B('local', 'kim', 'user:kim');
  q.prepare("INSERT INTO sop_run_read_grants (run_id, subject) VALUES (7, 'user:kim')").run();
  // 过期的运行读权不算
  q.prepare("INSERT INTO sop_run_read_grants (run_id, subject, expires_at) VALUES (8, 'user:kim', datetime('now', '-1 day'))").run();
  // 完整管理员不算数的：范围不是 *（lou）、人已停用（mia，停用前放行的）
  P('user:lou'); B('local', 'lou', 'user:lou'); A('lou'); q.prepare("INSERT INTO departments (id, name, created_at, updated_at) VALUES ('d1', '合成', 1, 1)").run(); G('user:lou', 'owner', 'dept:d1');
  P('user:mia'); B('local', 'mia', 'user:mia'); A('mia'); G('user:mia', 'owner', '*'); q.prepare("UPDATE principals SET status = 'disabled' WHERE id = 'user:mia'").run();
  // 期限被直接写成文本日期（列是 INTEGER，SQLite 原样存文本）：不能当成永不过期
  P('user:nia'); B('local', 'nia', 'user:nia'); A('nia');
  { const id = Number(q.prepare("INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_at, updated_at) VALUES ('user:nia', 'owner', '*', '2000-01-01', '合成', 'cli', ?, ?)").run(nowG, nowG).lastInsertRowid);
    q.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(id); q.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(id); }
  // 第四项：作者 odoo:fsonly 的常量，名下只有同名的飞书身份、没有 Odoo 身份 → 对不回
  P('user:fsonly'); B('feishu', 'fsonly', 'user:fsonly');
  const w9 = Number(q.prepare("INSERT INTO workbenches (name, url) VALUES ('合成', 'http://x.synthetic.invalid/')").run().lastInsertRowid);
  q.prepare("INSERT INTO workbench_vars (workbench_id, key, kind, value, owner) VALUES (?, 'k', 'const', '{}', 'odoo:fsonly')").run(w9);
  q.close();
  const rg = run(g);
  check(rg.json?.odoo_only_people === 1 && rg.json.odoo_only_read_grants.sop_run === 1 && rg.json.odoo_only_read_grants.task_source === 0 && rg.json.red?.includes('read-grants-only-via-odoo'),
    '口径统一：绑着站内身份、站内账号却已经删了的人算只靠 Odoo；他名下的运行读权（过期的不算）算只靠 Odoo 得来，只有运行读权也判红', rg.json);
  check(rg.json?.full_admins_on_local_accounts === 0, '完整管理员不算数：范围不是 *、人已停用、期限被写成文本', rg.json?.full_admins_on_local_accounts);
  check(rg.json?.odoo_owned_consts?.unmapped === 1, '第四项只按 Odoo 身份对：名下只有同名飞书身份的对不回', rg.json?.odoo_owned_consts);
  check(rg.json?.odoo_owned_consts?.scope?.includes('bench'), 'JSON 也说明第四项只数主库（bench 模式要另查）', rg.json?.odoo_owned_consts?.scope);

  // 确认数：给了就必须严格相等；实际 0 人时给了别的数也红
  const zero = freshDb('zero');
  const z = new DatabaseSync(zero);
  z.prepare("INSERT INTO principals (id, id_key, kind, display_name) VALUES ('user:ann', 'user:ann', 'person', 'ann')").run();
  z.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('local', 'ann', 'ann', 'user:ann')").run();
  z.prepare("INSERT INTO local_accounts (username, password_hash, created_at, updated_at) VALUES ('ann', 'x', 1, 1)").run();
  const zid = Number(z.prepare("INSERT INTO grants (principal_id, role, scope, reason, created_by, created_at, updated_at) VALUES ('user:ann', 'owner', '*', '合成', 'cli', 1, 1)").run().lastInsertRowid);
  z.prepare("UPDATE grants SET status = 'pending' WHERE id = ?").run(zid); z.prepare("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE id = ?").run(zid);
  z.close();
  const z0 = run(zero), z5 = run(zero, '--accept-odoo-only=5'), zz = run(zero, '--accept-odoo-only=0');
  const zHuman = spawnSync(process.execPath, [SCRIPT, '--db', zero, '--accept-odoo-only=5'], { encoding: 'utf8' });
  check(z0.code === 0 && z5.code === 1 && z5.json?.red?.join() === 'odoo-only-people' && z5.json.accept?.match === false && zz.code === 0 && /实际 0，参数 5/.test(zHuman.stdout),
    '确认数严格相等：实际 0 人时不给参数绿、给 0 绿、给 5 红（人看的输出写明「实际 0，参数 5」）', { z0: z0.code, z5: [z5.code, z5.json?.accept], zz: zz.code });
  const more = run(file, '--accept-odoo-only=3');
  check(more.code === 1 && more.json?.accept?.match === false, '确认数比实际多（实际 2，给 3）也红：不是「大于等于就绿」', more.json?.accept);
  const usage = ['03', '3.0', '+3', '-3', ' 3', '', '3e0', '0x3'].map((v) => spawnSync(process.execPath, [SCRIPT, '--db', file, `--accept-odoo-only=${v}`], { encoding: 'utf8' }).status);
  const twice = spawnSync(process.execPath, [SCRIPT, '--db', file, '--accept-odoo-only=2', '--accept-odoo-only=2'], { encoding: 'utf8' }).status;
  check(usage.every((c) => c === 2) && twice === 2, '确认数写法不对（前导零、小数、正负号、空白、空、科学计数、十六进制）、重复给：都是用法错误（2）', { usage, twice });
  const humanAll = spawnSync(process.execPath, [SCRIPT, '--db', file], { encoding: 'utf8' }).stdout + spawnSync(process.execPath, [SCRIPT, '--db', g], { encoding: 'utf8' }).stdout;
  check(!/alice|carol|bob|dave|kim|lou|mia|nia|fsonly|ghost|BOB/i.test(humanAll), '人看的输出也只有人数：不出现名字、登录名', humanAll.slice(0, 200));

  // 用法错误
  const missing = spawnSync(process.execPath, [SCRIPT, '--db', join(OUT, 'nope.db')], { encoding: 'utf8' });
  const badArg = spawnSync(process.execPath, [SCRIPT, '--db', file, '--accept-odoo-only=x'], { encoding: 'utf8' });
  const unknown = spawnSync(process.execPath, [SCRIPT, '--db', file, '--write'], { encoding: 'utf8' });
  check(missing.status === 2 && badArg.status === 2 && unknown.status === 2, '用法错误（库不存在、确认数不是整数、不认识的参数）：退出码 2，不当成绿', [missing.status, badArg.status, unknown.status]);
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`odoo-offboard-preflight-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
