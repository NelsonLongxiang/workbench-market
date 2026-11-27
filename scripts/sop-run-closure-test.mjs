#!/usr/bin/env node
/** #1087: run the operator CLI on an isolated DB, then read it through the real HTTP surface. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { CLOSE_REASON, previewStaleSopRuns, updateStaleSopRuns } from '../server/src/services/sop-run-closure.ts';

const root = process.cwd();
const task = join(root, 'tmp', 'sop-run-closure-test');
mkdirSync(task, { recursive: true });
const fixture = mkdtempSync(join(task, 'run-'));
const data = join(fixture, 'data');
mkdirSync(data);
process.env.DATA_DIR = data;
const file = join(data, 'workbench-market.db');
const now = Date.UTC(2026, 10, 27, 0);
const old = '2026-11-01 00:00:00', cutoff = '2026-11-13 00:00:00';
const rows = [
  [1,'first-sop','running','{}',0,old,old,''], [2,'first-sop','running',' { } ',0,old,old,''],
  [3,'second-sop','running','{}',0,old,old,''], [4,'first-sop','running','{"step":null}',0,old,old,''],
  [5,'first-sop','running','{}',0,old,'2026-11-26 00:00:00',''], [6,'first-sop','running','{}',0,old,cutoff,''],
  [7,'first-sop','finished','{}',0,old,old,old], [8,'first-sop','running','{}',1,old,old,''],
  [9,'first-sop','running','[]',0,old,old,''], [10,'first-sop','running','bad-data',0,old,old,''],
  [11,'first-sop','running','{}',0,old,'bad-time',''], [12,'first-sop','running','{}',0,'2026-11-26 00:00:00',old,''],
  [13,'second-sop','expired','{}',0,old,old,''], [14,'first-sop','running','{}',0,old,old,old],
];
const operator = (mode, batch = undefined) => spawnSync(process.execPath,
  ['scripts/sop-run-closure.mjs', mode, '--db', file, ...(batch ? ['--batch', batch] : [])], { cwd: root, encoding: 'utf8' });
const run = (mode, batch) => {
  const result = operator(mode, batch);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
function allRuns() {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT * FROM sop_runs ORDER BY id').all().map(row => ({ ...row })); }
  finally { db.close(); }
}
function edit(fn) {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}
async function readSurfaces() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const preload = 'import net from "node:net"; const listen=net.Server.prototype.listen; net.Server.prototype.listen=function(...args){if(typeof args[0]==="number"&&typeof args[1]!=="string")args.splice(1,0,"127.0.0.1");return listen.apply(this,args)};';
  const child = spawn(process.execPath, ['--import','data:text/javascript,'+encodeURIComponent(preload),'server/src/index.ts'], {
    cwd: root, stdio: ['ignore','pipe','pipe'],
    env: { PATH: process.env.PATH, HOME: fixture, TMPDIR: fixture, DATA_DIR: data, PORT: String(port), WM_CONTROL_PORT: '0',
      NODE_ENV: 'test', WM_OUTBOUND: 'off', MCP_GATEWAY: 'off', REDIS_URL: '', WM_LOGIN_GATE: 'off', ADMIN_TOKEN: 'closure-synthetic-admin' },
  });
  const exited = once(child, 'exit');
  let errors = '';
  child.stdout.resume();
  child.stderr.on('data', bytes => { errors += bytes; });
  const get = async path => {
    const response = await fetch('http://127.0.0.1:' + port + path, { headers: { 'x-admin-token': 'closure-synthetic-admin', 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  try {
    const until = Date.now() + 15_000;
    while (true) {
      try { await get('/api/health'); break; }
      catch (error) {
        if (Date.now() >= until || child.exitCode !== null) throw new Error('isolated market not ready: ' + errors.slice(-1000), { cause: error });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const [active, attention, first, second, detail] = await Promise.all([
      get('/api/sop/runs/active'), get('/api/attention'), get('/api/sops/first-sop/timeline'),
      get('/api/sops/second-sop/timeline'), get('/api/sop/runs/1'),
    ]);
    return { active: active.map(row => row.id), attention: attention.items.map(row => row.source_id),
      timeline: [first.closure_events ?? [], second.closure_events ?? []], status: detail.status };
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
}

try {
  const { db } = await import('../server/src/db.ts');
  db.prepare('INSERT INTO sop_runs(id,sop_slug,sop_version,started_at,updated_at) VALUES(15,?,1,?,?)').run('boundary-sop', cutoff, cutoff);
  const close = (batch, at) => edit(conn => updateStaleSopRuns(conn, 'close', batch, at));
  const first = close('empty-1087', now);
  assert.deepEqual(first, { mode: 'close', batch: 'empty-1087', reason: CLOSE_REASON, changed: 0, matched: 0, by_sop: [] });
  const runAtBoundary = () => ({ ...db.prepare('SELECT status,cache_revision FROM sop_runs WHERE id = 15').get() });
  assert.deepEqual(close('empty-1087', now + 1000), { ...first, repeated: true }, 'successful empty batch must stay empty across cutoff');
  assert.deepEqual(runAtBoundary(), { status: 'running', cache_revision: 0 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM sop_run_closure_events WHERE batch = 'empty-1087'").get().n, 0);
  const batchReceipts = () => db.prepare("SELECT action FROM sop_run_closure_batches WHERE batch = 'empty-1087' ORDER BY action").all().map(row => row.action);
  assert.deepEqual(batchReceipts(), ['close']);
  assert.throws(() => db.exec('DELETE FROM sop_run_closure_batches'));
  assert.throws(() => db.exec("UPDATE sop_run_closure_batches SET at = 'changed'"));
  assert.throws(() => db.exec('INSERT OR REPLACE INTO sop_run_closure_batches SELECT * FROM sop_run_closure_batches'));
  const undoEmpty = () => edit(conn => updateStaleSopRuns(conn, 'undo', 'empty-1087', now + 1000));
  assert.deepEqual(undoEmpty(), { ...first, mode: 'undo' });
  assert.deepEqual(undoEmpty(), { ...first, mode: 'undo', repeated: true });
  assert.deepEqual(batchReceipts(), ['close', 'undo']);
  assert.throws(() => close('empty-1087', now + 1000), /批次已撤销/);
  assert.equal(close('new-1087', now + 1000).changed, 1);
  assert.deepEqual(runAtBoundary(), { status: 'expired', cache_revision: 1 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM sop_run_closure_events WHERE batch = 'new-1087'").get().n, 1);
  console.log('B1: zero-match close survives reopen and cutoff, zero undo is idempotent, and a fresh batch matches');
  const app = db.prepare("INSERT INTO apps(slug,title,kind,status,active_version) VALUES(?,?,'sop','published',1)");
  for (const slug of ['first-sop','second-sop']) app.run(slug, slug);
  const insert = db.prepare('INSERT INTO sop_runs(id,sop_slug,sop_version,status,data,hot_pending,started_at,updated_at,finished_at) VALUES(?,?,1,?,?,?,?,?,?)');
  // The save trigger watches UPDATE OF data. These synthetic rows are inserted with their durable flag.
  for (const row of rows) insert.run(...row);
  const preview = previewStaleSopRuns(db, now);
  assert.deepEqual(preview.by_sop, [{ sop_slug: 'first-sop', runs: 2 }, { sop_slug: 'second-sop', runs: 1 }]);
  db.close();
  const beforeHash = createHash('sha256').update(readFileSync(file)).digest('hex');
  assert.equal(run('dry-run').mode, 'dry-run');
  // Use a wall-clock-independent fixture for the executable commands.
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), beforeHash);
  edit(db => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    db.prepare('UPDATE sop_runs SET updated_at = ? WHERE id IN (5,6,12)').run(fresh);
    db.prepare("UPDATE sop_runs SET started_at='2001-01-01 00:00:00',updated_at='2001-01-01 00:00:00' WHERE id IN (1,2,3,4,7,8,9,10,11,13,14)").run();
    db.prepare('UPDATE sop_runs SET updated_at = ? WHERE id = 11').run('bad-time');
  });
  const initial = allRuns();
  const before = await readSurfaces();
  for (const id of [1,2,3]) {
    assert.ok(before.active.includes(id));
    assert.ok(before.attention.includes('market:run-' + id));
  }
  assert.equal(run('dry-run').matched, 3);
  const closed = run('close', 'test-1087');
  assert.equal(closed.changed, 3);
  assert.deepEqual(closed.by_sop, preview.by_sop);
  assert.equal(run('close', 'test-1087').changed, 0);
  assert.deepEqual(allRuns(), initial.map(row => [1,2,3].includes(row.id) ? { ...row, status: 'expired', cache_revision: row.cache_revision + 1 } : row));
  const after = await readSurfaces();
  for (const id of [1,2,3]) {
    assert.ok(!after.active.includes(id));
    assert.ok(!after.attention.includes('market:run-' + id));
  }
  assert.equal(after.status, 'expired');
  assert.deepEqual(after.timeline.map(events => events.map(({ batch, action, run_count, reason }) => [batch, action, run_count, reason])),
    [[['test-1087','close',2,CLOSE_REASON]],[['test-1087','close',1,CLOSE_REASON]]]);
  assert.ok(after.timeline.flat().every(event => !Object.hasOwn(event,'entries_json')));
  edit(db => {
    assert.throws(() => db.exec('DELETE FROM sop_run_closure_events'));
    assert.throws(() => db.exec("UPDATE sop_run_closure_events SET reason = 'changed'"));
    assert.throws(() => db.exec('INSERT OR REPLACE INTO sop_run_closure_events (batch,action,sop_slug,entries_json,run_count,reason,at) SELECT batch,action,sop_slug,entries_json,run_count,reason,at FROM sop_run_closure_events'));
    db.prepare('UPDATE sop_runs SET cache_revision = 99 WHERE id = 3').run();
  });
  assert.equal(operator('undo','test-1087').status, 1);
  assert.ok(allRuns().filter(row => [1,2,3].includes(row.id)).every(row => row.status === 'expired'));
  edit(db => { db.prepare('UPDATE sop_runs SET cache_revision = 1 WHERE id = 3').run(); });
  assert.equal(run('undo','test-1087').changed, 3);
  assert.equal(run('undo','test-1087').changed, 0);
  assert.equal(operator('close','test-1087').status, 1);
  assert.equal(operator('undo','no-such-batch').status, 1);
  assert.deepEqual(allRuns(), initial.map(row => [1,2,3].includes(row.id) ? { ...row, cache_revision: row.cache_revision + 2 } : row));
  const restored = await readSurfaces();
  for (const id of [1,2,3]) {
    assert.ok(restored.active.includes(id));
    assert.ok(restored.attention.includes('market:run-' + id));
  }
  assert.deepEqual(restored.timeline.map(events => events.map(event => event.action).sort()), [['close','undo'],['close','undo']]);
  console.log('SOP run closure: dry-run, strict cutoff, hot-state exclusion, two read surfaces, append-only timeline, idempotency and atomic undo passed');
} finally { rmSync(fixture, { recursive: true, force: true }); }
