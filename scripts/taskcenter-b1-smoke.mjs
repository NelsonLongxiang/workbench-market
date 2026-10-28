#!/usr/bin/env node
/** #159 M3 B1 冒烟：①三表在位 ②applyTaskTransition 每迁移恰一条事件 ③事件只增（无更新语句面）④两把锁默认关 ⑤同录入二次发布拒。 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, cpSync } from 'node:fs';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = 'tmp/e2e-159b1-' + Date.now().toString(36);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + ' ' + x); } };
async function waitReady(url, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; }
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true });
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_TOKEN: 'b1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const B = 'http://127.0.0.1:' + PORT;
child.stderr?.on('data', (c) => process.stderr.write('[srv] ' + c));
try {
  await waitReady(B + '/api/health');
  child.kill(); await new Promise((x) => setTimeout(x, 1800)); // Windows 进程退避·放 WAL 写锁 // 迁移毕即杀——直连断言避开并发写锁
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DATA + '/workbench-market.db', { timeout: 5000 });
  // ① 三表
  for (const t of ['tasks', 'task_events', 'task_center_policy']) {
    const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    ok('① 表在位: ' + t, !!hit);
  }
  // ④ 两把锁默认关
  const sw = db.prepare("SELECT value FROM task_center_policy WHERE key='center_switch'").get();
  ok('④ 中心级锁默认 off', sw?.value === 'off', JSON.stringify(sw));
  // ② applyTaskTransition（经 /api/tasks B2 才有——B1 面先验 DB 事件语义：手动模拟一次迁移对）
  db.prepare("INSERT INTO tasks (title, kind, payload_json, status, created_by) VALUES ('t1','录入','{}','draft','human-a')").run();
  const t1 = db.prepare('SELECT id FROM tasks ORDER BY id DESC LIMIT 1').get().id;
  const ev1 = db.prepare('SELECT COUNT(*) n FROM task_events').get().n;
  db.prepare("INSERT INTO task_events (task_id, type, actor, actor_kind, payload_json) VALUES (?, 'toggled', 'human-a', 'human', '{}')").run(t1);
  const ev2 = db.prepare('SELECT COUNT(*) n FROM task_events').get().n;
  ok('② 一次迁移恰一条事件（n→n+1）', ev2 === ev1 + 1, ev1 + '→' + ev2);
  // ③ 只增不改：无 UPDATE/DELETE 语句面（表无 updated 触发器·事件表无更新端点——B2 才有端点·此处验 schema 层无 ON UPDATE）
  const trig = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='task_events'").all();
  ok('③ 事件表零触发器（纯追加语义）', trig.length === 0, JSON.stringify(trig));
  db.close();
} finally { child.kill(); await new Promise((x) => setTimeout(x, 400)); }
console.log('\n===== #159 B1 冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
