#!/usr/bin/env node
/**
 * 唯一 outbox 双写期（阶段七第 3 步，第一个 PR：双写 + 对账）。
 *
 * 一、回执的四个写（入队、重试、已发、dead）每写一次，a2a_outbox_items 里 kind=run-receipt 的镜像都和旧表逐字段一致；对账零差异。
 *    重复入队（INSERT OR IGNORE）不改镜像。
 * 二、对抗组：对账真能抓到差异——改新表字段、删新表行、新表多出行，各报一种；镜像写失败不挡旧写，失败计数涨、对账报缺。
 * 三、启动整表同步：旧版本进程直接写旧表（不经服务）、镜像失败漏掉的、被改过的，下次启动都补齐；新表多出的回执行删掉；
 *    旧表里状态不在新表允许范围内的行不让启动失败，对账照报。
 * 四、对账脚本：零差异退出 0、有差异退出 1、库不存在或新表没建退出 2；只读打开，不建表。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); } };

const DATA = resolve('tmp/a2a-outbox-dual');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.DATA_DIR = DATA;

/** 另起一个进程只 import db.ts：等于「用新版本重启一次」 */
function reboot() {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "await import('./server/src/db.ts')"], { env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
  return r.status === 0 ? '' : (r.stderr || r.stdout || `exit ${r.status}`);
}
function cli(dir, ...extra) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/a2a-outbox-reconcile.mjs', dir, ...extra], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

let mods = null;
try {
  const { db } = await import('../server/src/db.ts');
  const { root } = await import('../server/src/root-context.ts');
  const { SopService } = await import('../server/src/services/sop.ts');
  const outbox = await import('../server/src/services/a2a-outbox.ts');
  const { reconcileReceiptOutbox } = await import('../server/src/services/a2a-outbox-reconcile.ts');
  mods = { db, sop: new SopService(root), outbox, reconcileReceiptOutbox };
} catch (e) { ok('模块可加载（a2a-outbox.ts / a2a-outbox-reconcile.ts）', false, String(e?.message ?? e).slice(0, 200)); }

if (mods) {
  const { db, sop, outbox, reconcileReceiptOutbox } = mods;
  const rec = () => reconcileReceiptOutbox(db);
  const mirrorOf = (runId) => db.prepare("SELECT * FROM a2a_outbox_items WHERE kind = 'run-receipt' AND ref = ?").get(String(runId));
  const oldOf = (runId) => db.prepare('SELECT * FROM a2a_outbox WHERE run_id = ?').get(runId);

  console.log('一、四个写都镜像');
  sop.outboxInsert({ runId: 11, taskId: 'task-11', contextId: 'ctx-11', targetUrl: 'http://peer.invalid/a', payload: 'receipt-11' });
  let m = mirrorOf(11);
  ok('入队 → 镜像 pending，字段一致', m?.status === 'pending' && m.task_id === 'task-11' && m.context_id === 'ctx-11' && m.target_url === 'http://peer.invalid/a' && m.payload === 'receipt-11' && m.next_at === oldOf(11).next_at, JSON.stringify(m));
  ok('对账零差异', rec().ok, JSON.stringify(rec()));
  sop.outboxInsert({ runId: 11, taskId: 'task-11b', contextId: 'ctx-x', targetUrl: 'http://peer.invalid/b', payload: 'other' });
  ok('重复入队（旧表 OR IGNORE）不改镜像', mirrorOf(11)?.payload === 'receipt-11' && rec().ok);
  const id11 = oldOf(11).id;
  sop.outboxMarkRetry(id11, 1, '2026-11-11 12:00:00', 'HTTP 502');
  m = mirrorOf(11);
  ok('重试 → attempts / next_at / last_error 同步', m?.attempts === 1 && m.next_at === '2026-11-11 12:00:00' && m.last_error === 'HTTP 502' && rec().ok, JSON.stringify(m));
  sop.outboxMarkSent(id11);
  m = mirrorOf(11);
  ok('已发 → sent、sent_at 同步、last_error 清空', m?.status === 'sent' && m.sent_at !== '' && m.sent_at === oldOf(11).sent_at && m.last_error === '' && rec().ok, JSON.stringify(m));
  sop.outboxInsert({ runId: 12, taskId: 'task-12', contextId: 'ctx-12', targetUrl: 'http://peer.invalid/c', payload: 'receipt-12' });
  sop.outboxMarkDead(oldOf(12).id, 'x'.repeat(400));
  m = mirrorOf(12);
  ok('dead → 同步，错误截到 300 字', m?.status === 'dead' && m.last_error.length === 300 && rec().ok, JSON.stringify(rec()));
  const r0 = rec();
  ok('对账按状态计数两边一致', JSON.stringify(r0.by_status.old) === JSON.stringify({ dead: 1, sent: 1 }) && JSON.stringify(r0.by_status.new) === JSON.stringify(r0.by_status.old), JSON.stringify(r0.by_status));

  console.log('二、对抗组：对账抓得到差异，镜像失败不挡旧写');
  db.prepare("UPDATE a2a_outbox_items SET status = 'pending' WHERE kind = 'run-receipt' AND ref = '11'").run();
  let r = rec();
  ok('改新表 status → 报 mismatched', !r.ok && r.mismatched.length === 1 && r.mismatched[0].ref === '11' && r.mismatched[0].fields.join() === 'status', JSON.stringify(r));
  db.prepare("DELETE FROM a2a_outbox_items WHERE kind = 'run-receipt' AND ref = '12'").run();
  r = rec();
  ok('删新表行 → 报 missing', !r.ok && r.missing.join() === '12', JSON.stringify(r));
  db.prepare("INSERT INTO a2a_outbox_items (kind, ref, target_url, payload) VALUES ('run-receipt', '999', 'http://peer.invalid/z', 'ghost')").run();
  r = rec();
  ok('新表多出行 → 报 extra', !r.ok && r.extra.join() === '999', JSON.stringify(r));
  db.prepare("INSERT INTO a2a_outbox_items (kind, ref, target_url, payload) VALUES ('notify', '11', 'http://peer.invalid/n', 'n')").run();
  ok('别的 kind 同 ref 不算进回执对账', rec().extra.join() === '999');

  db.exec("CREATE TRIGGER block_mirror BEFORE INSERT ON a2a_outbox_items WHEN NEW.ref = '13' BEGIN SELECT RAISE(ABORT, 'mirror blocked'); END");
  const before = outbox.receiptMirrorFailures();
  let threw = '';
  try { sop.outboxInsert({ runId: 13, taskId: 'task-13', contextId: 'ctx-13', targetUrl: 'http://peer.invalid/d', payload: 'receipt-13' }); } catch (e) { threw = String(e?.message ?? e); }
  ok('镜像写失败：旧写照常、不抛错', threw === '' && oldOf(13)?.status === 'pending', threw);
  ok('镜像失败计数涨一', outbox.receiptMirrorFailures() === before + 1);
  ok('对账报 run 13 缺', rec().missing.includes('13'));
  db.exec('DROP TRIGGER block_mirror');

  console.log('三、启动整表同步');
  db.prepare("INSERT INTO a2a_outbox (run_id, task_id, context_id, target_url, payload) VALUES (14, 'task-14', 'ctx-14', 'http://peer.invalid/e', 'receipt-14')").run();
  ok('旧版本进程直写旧表 → 对账报缺', rec().missing.includes('14'));
  const err = reboot();
  ok('重启成功', err === '', err.slice(0, 300));
  r = rec();
  ok('重启后补齐缺的（12 / 13 / 14）、改回被改的（11）、删掉多的回执行（999）：零差异', r.ok && r.old_rows === 4 && r.new_rows === 4, JSON.stringify(r));
  ok('别的 kind 的行不动', !!db.prepare("SELECT 1 FROM a2a_outbox_items WHERE kind = 'notify' AND ref = '11'").get());

  db.prepare("INSERT INTO a2a_outbox (run_id, target_url, payload, status) VALUES (15, 'http://peer.invalid/f', 'p', 'weird')").run();
  const err2 = reboot();
  ok('旧表有不认识的状态：启动不失败', err2 === '', err2.slice(0, 300));
  r = rec();
  ok('……对账照报缺', !r.ok && r.missing.join() === '15', JSON.stringify(r));
  db.prepare('DELETE FROM a2a_outbox WHERE run_id = 15').run();

  console.log('四、对账脚本');
  let c = cli(DATA);
  ok('零差异退出 0', c.status === 0 && c.out.includes('零差异'), c.out);
  db.prepare("UPDATE a2a_outbox_items SET attempts = 7 WHERE kind = 'run-receipt' AND ref = '14'").run();
  c = cli(DATA, '--json');
  let parsed = null; try { parsed = JSON.parse(c.out); } catch { /* 非 JSON */ }
  ok('有差异退出 1，--json 列出字段', c.status === 1 && parsed?.mismatched?.[0]?.ref === '14' && parsed.mismatched[0].fields.join() === 'attempts', c.out);
  c = cli(join(DATA, 'nope'));
  ok('库不存在退出 2', c.status === 2, c.out);
  const bare = resolve('tmp/a2a-outbox-bare');
  rmSync(bare, { recursive: true, force: true }); mkdirSync(bare, { recursive: true });
  const b = new DatabaseSync(join(bare, 'workbench-market.db'));
  b.exec('CREATE TABLE a2a_outbox (run_id INTEGER, target_url TEXT, task_id TEXT, context_id TEXT, payload TEXT, status TEXT, attempts INTEGER, next_at TEXT, last_error TEXT, created_at TEXT, sent_at TEXT)');
  b.close();
  c = cli(bare);
  const tables = (() => { const d = new DatabaseSync(join(bare, 'workbench-market.db'), { readOnly: true }); try { return d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name); } finally { d.close(); } })();
  ok('新表没建（旧版本的库）退出 2，且只读：不建表', c.status === 2 && tables.join() === 'a2a_outbox', `${c.status} ${tables.join()} ${c.out}`);
}

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
