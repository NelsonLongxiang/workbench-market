#!/usr/bin/env node
/**
 * #309 phase2 维护窗口离线播种：给指定旧 run 播种「有期限的」读授权。
 *
 * 目的：升级后旧 run 默认拒私有值；只对已确认仍在使用的旧 run 开一个到期自动失效的窗口，
 * 避免让 agent 拿管理口令在线补授权（admin 只属主本人用）。
 *
 * 默认 dry-run（只读、只算 plan 摘要）；--apply 需 --expected-plan 绑定 + --ack-maintenance-window。
 * 不打印任何密钥；grant 只存 subject（mcp:<会话名> / user:<Odoo登录名>）与到期时间。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const val = (n, d = '') => { const i = args.indexOf('--' + n); return i >= 0 ? String(args[i + 1] ?? '') : d; };
const has = (n) => args.includes('--' + n);
const fail = (m) => { console.error('ERROR: ' + m); process.exit(2); };

const dbPath = resolve(val('db'));
if (!val('db')) fail('--db <绝对路径> 必填');
if (!existsSync(dbPath)) fail('db 不存在: ' + dbPath);
const apply = has('apply');
const ttlDays = Number(val('ttl-days', '30'));
if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) fail('--ttl-days 必须是 1..365 的整数');
const subjects = args.reduce((acc, a, i) => (a === '--subject' ? acc.concat(String(args[i + 1] ?? '')) : acc), []);
if (!subjects.length) fail('至少一个 --subject mcp:<会话名> 或 user:<登录名>');
for (const s of subjects) if (!/^(user|mcp):[A-Za-z0-9_.@-]{1,128}$/.test(s)) fail('subject 形态非法: ' + s);
const role = val('role', 'reader');

const db = new DatabaseSync(dbPath, { readOnly: !apply });
if (!apply) db.exec('PRAGMA query_only=ON');
// 播种通常在服务已起（新包建表后）的窗口内执行：给写连接 busy_timeout，避免与运行中服务争锁
if (apply) db.exec('PRAGMA busy_timeout=5000');
const hasGrantsTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_run_read_grants'").get();
if (!hasGrantsTable) fail('本库没有 sop_run_read_grants 表——请先部署含 #309 phase2 的新包（建表），再在窗口内播种');

// run 范围：显式 --runs 或 --runs-from-a2a（取 a2a_run_ctx 的 run_id 去重）
let runIds = [];
if (val('runs')) runIds = val('runs').split(',').map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
if (has('runs-from-a2a')) {
  const rows = db.prepare('SELECT DISTINCT run_id FROM a2a_run_ctx WHERE run_id IS NOT NULL').all();
  runIds = runIds.concat(rows.map((r) => Number(r.run_id)));
}
runIds = [...new Set(runIds)].sort((a, b) => a - b);
if (!runIds.length) fail('没有 run 范围：用 --runs 1,2 或 --runs-from-a2a');

const existing = db.prepare('SELECT id FROM sop_runs WHERE id = ?');
const missing = runIds.filter((id) => !existing.get(id));
if (missing.length) fail('run 不存在: ' + missing.join(','));

// plan 摘要只覆盖「与时间无关的决策参数」：dry-run 与 apply 之间隔几分钟也必须一致
const plan = createHash('sha256').update(JSON.stringify({ db: dbPath, runIds, subjects: subjects.slice().sort(), role, ttlDays })).digest('hex');
const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

if (!apply) {
  console.log(JSON.stringify({
    dry_run: true, db: dbPath, runs: runIds.length, run_ids: runIds, subjects: subjects.slice().sort(),
    role, ttl_days: ttlDays, expires_at: expiresAt, plan,
    note: 'apply 需 --expected-plan ' + plan + ' --ack-maintenance-window',
  }));
  db.close();
  process.exit(0);
}

if (val('expected-plan') !== plan) fail('--expected-plan 与当前库状态不符（期望 ' + plan + '）');
if (!has('ack-maintenance-window')) fail('apply 需 --ack-maintenance-window（确认处于停机维护窗口）');

const ins = db.prepare("INSERT INTO sop_run_read_grants (run_id, subject, role, expires_at, granted_by) VALUES (?, ?, ?, ?, ?)");
let inserted = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const runId of runIds) for (const subject of subjects) { ins.run(runId, subject, role, expiresAt, 'maintenance-seed'); inserted++; }
  db.exec('COMMIT');
} catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }

console.log(JSON.stringify({
  dry_run: false, runs: runIds.length, subjects: subjects.slice().sort(), role, expires_at: expiresAt,
  inserted, revoke_hint: "撤销：管理面 POST /api/sop/runs/<id>/read-grants/revoke {subject}，或 SQL UPDATE sop_run_read_grants SET revoked_at=datetime('now') WHERE granted_by='maintenance-seed' AND revoked_at=''",
  rollback: "本操作只增行；回滚 = 把 granted_by='maintenance-seed' 且未撤销的行置 revoked_at",
}));
db.close();
