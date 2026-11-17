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
  check(r1.code === 1 && ['odoo-only-people', 'no-full-admin-on-local-account', 'read-grants-only-via-odoo'].every((k) => r1.json?.red?.includes(k)),
    '三项都红：退出码 1，红的原因逐项列出', { code: r1.code, red: r1.json?.red });
  check(!/alice|carol|bob|dave/.test(r1.out), '输出只有人数，不出现名字、登录名', r1.out.slice(0, 200));
  check(sha(file) === before, '只读：跑完库文件逐字节没变');

  // 补上一个落在站内账号上的完整管理员、收回 alice 的读权
  const w = new DatabaseSync(file);
  w.exec("UPDATE grants SET status = 'active', approved_by = 'cli' WHERE principal_id = 'user:fay'");
  w.exec("UPDATE task_source_read_grants SET revoked_at = datetime('now') WHERE subject = 'user:alice'");
  w.exec("UPDATE sop_run_read_grants SET revoked_at = datetime('now') WHERE subject = 'user:alice'");
  w.close();
  const r2 = run(file);
  check(r2.code === 1 && r2.json?.full_admins_on_local_accounts === 1 && r2.json.red?.join() === 'odoo-only-people',
    '补上完整管理员、收回读权之后：只剩「只靠 Odoo 的人」这一项红', r2.json);
  const wrong = run(file, '--accept-odoo-only=1');
  const right = run(file, '--accept-odoo-only=2');
  check(wrong.code === 1 && right.code === 0 && right.json?.ok === true,
    '属主确认这些人不再需要登录：--accept-odoo-only 写的人数要和实际相等（写 1 仍红，写 2 才绿）', { wrong: wrong.code, right: [right.code, right.json?.red] });
  const human = spawnSync(process.execPath, [SCRIPT, '--db', file, '--accept-odoo-only=2'], { encoding: 'utf8' });
  check(human.status === 0 && /结论：绿/.test(human.stdout) && /一、.*2 人/.test(human.stdout), '人看的输出：三行结果加一行结论', human.stdout);

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
