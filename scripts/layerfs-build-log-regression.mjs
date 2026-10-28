#!/usr/bin/env node
// #215 X3: isolated copies; shell stubs prevent Docker or git writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ? resolve(process.argv[2]) : join(root, 'deploy/build-layerfs.sh');
mkdirSync(join(root, 'tmp'), { recursive: true });
const work = mkdtempSync(join(root, 'tmp/layerfs-log-test-'));
const sha = '0123456789abcdef0123456789abcdef01234567';
const nl = String.fromCharCode(10), bs = String.fromCharCode(92), sq = String.fromCharCode(39);
const tag = 'wm-x-log:' + JSON.stringify('quoted') + bs + 'backslash';
const quote = (s) => sq + String(s).replaceAll(sq, sq + bs + sq + sq) + sq;
const posix = (s) => s.replaceAll(bs, '/');
const failures = [];
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('FAIL ' + name + ': ' + e.message); }
}
for (const existing of [false, true]) {
  const dir = join(work, existing ? 'existing tmp' : 'clean tree');
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  writeFileSync(join(dir, 'deploy/build-layerfs.sh'), readFileSync(source));
  const log = join(dir, 'tmp/layerfs-commit-overrides.jsonl');
  if (existing) { mkdirSync(dirname(log)); writeFileSync(log, JSON.stringify({ previous: true }) + nl); }
  const calls = join(dir, 'docker-calls.log');
  const env = { ...process.env, LAYERFS_IMAGE: tag, LAYERFS_COMMIT: sha, MSYS_NO_PATHCONV: '1' };
  const shell = [
    'set -euo pipefail',
    'git() { echo ' + quote(sha) + '; }',
    'docker() { echo CALL >> ' + quote(posix(calls)) + '; }',
    'set -- ' + quote(posix(dir)),
    'source ' + quote(posix(join(dir, 'deploy/build-layerfs.sh'))),
  ].join(nl);
  const run = spawnSync('bash', ['-c', shell, posix(join(dir, 'deploy/build-layerfs.sh'))], { env, cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.ifError(run.error);
  const prefix = existing ? 'existing tmp' : 'clean tree';
  check(prefix + ': script succeeds', () => assert.equal(run.status, 0, run.stderr));
  check(prefix + ': creates/appends parseable JSONL', () => {
    assert.ok(existsSync(log), 'audit file missing');
    const rows = readFileSync(log, 'utf8').trim().split(nl).map((line) => JSON.parse(line));
    assert.equal(rows.length, existing ? 2 : 1);
    if (existing) assert.deepEqual(rows[0], { previous: true });
    assert.equal(rows.at(-1).override, sha);
    assert.equal(rows.at(-1).source, 'env:LAYERFS_COMMIT');
    assert.equal(rows.at(-1).tag, tag, 'quotes/backslashes must round-trip');
  });
  check(prefix + ': override announced and only two stub builds', () => {
    assert.match(run.stdout, /override/);
    assert.equal(readFileSync(calls, 'utf8').trim().split(nl).length, 2);
  });
}
console.log('Isolated fixtures: ' + work);
if (failures.length) { console.error(failures.join(nl)); process.exitCode = 1; }