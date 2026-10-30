import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeLegacyTokenFixture } from './token-smoke-db.mjs';
mkdirSync('tmp', { recursive: true });
const dir = mkdtempSync(resolve('tmp/token-lock-'));
const file = join(dir, 'fixture.db');
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('admin_token_sha256','original')");
db.close();
async function withLock(ms, action) {
  const worker = new Worker(
    "const {DatabaseSync}=require('node:sqlite'); const {parentPort,workerData}=require('node:worker_threads'); const db=new DatabaseSync(workerData.file); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked'); setTimeout(()=>{db.exec('COMMIT');db.close();},workerData.ms);",
    { eval: true, workerData: { file, ms } });
  const ended = once(worker, 'exit');
  try { await once(worker, 'message'); action(); } finally { await ended; }
}
function value() { const d = new DatabaseSync(file, {readOnly:true}); try { return d.prepare('SELECT value FROM settings').get().value; } finally { d.close(); } }
await withLock(350, () => writeLegacyTokenFixture(file, 'legacy'));
assert.equal(value(), 'legacy'); console.log('PASS short competing write lock waits then succeeds');
await withLock(400, () => {
  const start = Date.now();
  assert.throws(() => writeLegacyTokenFixture(file, 'must-not-write', 50), /locked|busy/i);
  assert.ok(Date.now()-start < 2000, 'bounded timeout');
});
assert.equal(value(), 'legacy'); console.log('PASS bounded timeout preserves failure and original row');
writeLegacyTokenFixture(file, 'after-lock'); assert.equal(value(), 'after-lock');
console.log('PASS connection usable after failed write; fixture=' + dir);
