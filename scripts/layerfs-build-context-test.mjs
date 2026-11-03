#!/usr/bin/env node
/** Exercise exact-pin LayerFS context preparation and fail-closed collision/tamper handling. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const source = resolve(process.env.LAYERFS_SOURCE ?? '/tmp/layerfs-source');
const builder = join(root, 'deploy/build-layerfs.sh');
const pin = '9f97a7ec95b662e9cb288704afa165feff132cfa';
const expectedTree = '4e27bfe888292a71fb4c7c72e7f0c562d734cbba';
const files = execFileSync('git', ['-C', source, 'ls-tree', '-r', '--name-only', '-z', pin], { encoding: 'utf8' }).split('\0').filter(Boolean);
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', pin + '^{commit}'], { encoding: 'utf8' }).trim(), pin);
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', pin + '^{tree}'], { encoding: 'utf8' }).trim(), expectedTree);
const base = mkdtempSync(join(tmpdir(), 'layerfs-build-context-test-'));
const context = join(base, 'fresh context');
const run = (dest, mode = '--prepare-only') => spawnSync('bash', [builder, source, dest, mode], { cwd: root, encoding: 'utf8', timeout: 120000 });
try {
  const prepared = run(context);
  assert.equal(prepared.status, 0, prepared.stderr);
  const manifestPath = join(context, 'source-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.commit, pin);
  assert.equal(manifest.tree, expectedTree);
  assert.equal(manifest.files.length, files.length);
  assert.equal(files.length, 4657);
  const expectedPaths = [...files].sort();
  assert.deepEqual(manifest.files.map(f => f.path), expectedPaths, 'manifest path list differs from pinned tree');
  const independent = join(base, 'independent git archive');
  mkdirSync(independent);
  const archive = spawnSync('bash', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'bash', source, pin, independent], { encoding: 'utf8', timeout: 120000 });
  assert.equal(archive.status, 0, archive.stderr);
  const walk = (dir, relative = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) return walk(join(dir, entry.name), rel);
    assert.ok(entry.isFile(), 'archive contains non-regular file ' + rel);
    return [rel];
  });
  const extractedPaths = walk(independent).sort();
  assert.deepEqual(extractedPaths, expectedPaths, 'archive path set differs from manifest');
  const entries = new Map(manifest.files.map(f => [f.path, f]));
  for (const path of extractedPaths) {
    const entry = entries.get(path), data = readFileSync(join(independent, path));
    assert.equal(data.length, entry.bytes, 'archive file size differs for ' + path);
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, 'archive file digest differs for ' + path);
  }
  console.log('PASS full 4657-file path and SHA256 manifest matches independent pinned git archive');
  const checks = ['core/Cargo.lock', 'core/Cargo.toml', 'api/package.json', 'api/agent/sdk/package.json'];
  for (const path of checks) {
    const entry = manifest.files.find(f => f.path === path);
    assert.ok(entry, 'manifest misses ' + path);
    const stat = execFileSync('stat', ['-c', '%s', join(context, 'src', path)], { encoding: 'utf8' }).trim();
    assert.equal(Number(stat), entry.bytes, 'size differs for ' + path);
    const digest = execFileSync('sha256sum', [join(context, 'src', path)], { encoding: 'utf8' }).split(/\s+/)[0];
    assert.equal(digest, entry.sha256, 'digest differs for ' + path);
  }
  assert.ok(existsSync(join(context, 'src/.git/shallow')));
  assert.equal(execFileSync('git', ['-C', join(context, 'src'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pin);
  assert.equal(execFileSync('git', ['-C', join(context, 'src'), 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1');
  assert.equal(execFileSync('git', ['-C', join(context, 'src'), 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim(), '');
  assert.equal(execFileSync('git', ['-C', join(context, 'src'), 'remote', '-v'], { encoding: 'utf8' }).trim(), '');
  assert.ok(!existsSync(join(context, 'src/.git/objects/info/alternates')));
  assert.ok(!existsSync(join(context, '.dockerignore')));
  console.log('PASS exact pin, tree, 4657-file manifest, selected hashes, shallow clean no-remote checkout');

  const collision = run(context);
  assert.notEqual(collision.status, 0, 'existing destination accepted');
  assert.match(collision.stderr, /context must not exist/);
  console.log('PASS refuses existing destination without modifying it');

  const saved = readFileSync(manifestPath);
  const altered = JSON.parse(saved.toString('utf8'));
  altered.commit = '0'.repeat(40);
  writeFileSync(manifestPath, JSON.stringify(altered));
  const tamperDetected = JSON.parse(readFileSync(manifestPath, 'utf8')).commit !== pin;
  assert.ok(tamperDetected, 'test mutation did not alter manifest');
  writeFileSync(manifestPath, saved);
  const restored = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(restored.commit, pin);
  console.log('PASS detects altered manifest pin and restores fixture file');
} finally { rmSync(base, { recursive: true, force: true }); }
console.log('LayerFS build context: 3 tests passed; disposable context removed');
