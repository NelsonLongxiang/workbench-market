#!/usr/bin/env node
/** Usage: node scripts/bugfix-delivery-preflight-test.mjs. Synthetic files and injected CLI results; no network/database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliveryPreflight, parseOptions } from './ops/bugfix-delivery-preflight.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'tmp', 'bugfix-preflight-' + process.pid + '-' + Date.now().toString(36));
if (fs.existsSync(out)) throw Error('test_directory_already_exists');
fs.mkdirSync(out, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
let pass = 0;
const check = async (name, run) => { await run(); pass++; console.log('✓ ' + name); };
let seq = 0;
function fixture() {
  const dir = path.join(out, String(++seq)), home = path.join(dir, 'home'), submission = path.join(dir, 'submission');
  fs.mkdirSync(submission, { recursive: true });
  for (const rel of ['verify/specs/spec_test', 'verify/submission-scans', 'verify/archives']) fs.mkdirSync(path.join(home, rel), { recursive: true });
  fs.writeFileSync(path.join(home, 'ygl-trees.db'), 'synthetic-workspace');
  const file = path.join(submission, 'delivery.tar'), database = path.join(dir, 'snapshot.sqlite'), specPath = path.join(home, 'verify/specs/spec_test/spec.json');
  const bytes = Buffer.from('synthetic-delivery'); fs.writeFileSync(file, bytes); fs.writeFileSync(database, 'synthetic-snapshot');
  const expected = sha(bytes), spec = { spec_id: 'spec_test', spec_version: 1, vu: [{ id: 'V1', role: 'assert', checker: { type: 'file', glob: 'delivery.tar', sha256: { 'delivery.tar': expected } } }] };
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const runId = 'run_0123456789abcdef', archive = path.join(home, 'verify/archives/synthetic.zip'), archiveBytes = Buffer.from('synthetic-archive'); fs.writeFileSync(archive, archiveBytes);
  const scanPath = path.join(home, 'verify/submission-scans', runId + '.json');
  fs.writeFileSync(scanPath, JSON.stringify({ run_id: runId, spec_id: 'spec_test', scans: [{ vu_id: 'V1', matched: [{ path: 'delivery.tar', sha256: expected }] }] }));
  const run = { run_id: runId, spec_id: 'spec_test', spec_version: 1, overall: 'PASS', archive: { path: archive, archive_id: 'arc_test', archive_sha256: 'sha256:' + 'b'.repeat(64), zip_sha256: sha(archiveBytes) } };
  fs.writeFileSync(path.join(home, 'verify/archives', runId + '.json'), JSON.stringify({ run_id: runId, spec_id: 'spec_test', spec_version: 1, archives: [run.archive] }));
  const report = { run_id: runId, spec_id: 'spec_test', verifier: { spec_version: 1 }, overall: 'PASS', data_source: { sha256: 'sha256:' + sha(Buffer.from('synthetic-snapshot')) } };
  const options = { home, submission, file: 'delivery.tar', sha256: expected, spec: 'spec_test', 'spec-version': '1', 'spec-sha256': sha(fs.readFileSync(specPath)), db: database };
  const calls = [];
  const execute = async (args, opts) => {
    calls.push(args); assert.equal(opts.home, home); assert.equal(args.at(-1), '--json');
    if (args[1] === 'run') return { ok: true, code: 0, json: structuredClone(run) };
    if (args[1] === 'report') return { ok: true, code: 0, json: structuredClone(report) };
    if (args[1] === 'archive') return { ok: true, code: 0, json: { ok: true, archive_id: run.archive.archive_id, archive_sha256: run.archive.archive_sha256 } };
    throw Error('unexpected_command');
  };
  return { dir, home, file, database, specPath, scanPath, archive, options, run, report, calls, execute };
}
try {
  await check('explicit valid input composes native run, report, archive; never approves', async () => {
    const f = fixture(), result = await deliveryPreflight(f.options, f.execute);
    assert.equal(result.status, 'PRECHECK_PASSED'); assert.equal(result.human_acceptance, false); assert.equal(result.work_item_changed, false);
    assert.deepEqual(f.calls.map(x => x[1]), ['run', 'report', 'archive']);
    assert.ok(f.calls[0].includes('--spec-version')); assert.equal(f.calls[0][f.calls[0].indexOf('--submission') + 1], path.dirname(f.file));
  });
  await check('changed delivery is refused before any CLI call', async () => {
    const f = fixture(); fs.appendFileSync(f.file, 'changed'); const result = await deliveryPreflight(f.options, f.execute);
    assert.equal(result.reason, 'delivery_hash_mismatch'); assert.equal(f.calls.length, 0);
  });
  await check('missing package is not ready and does not run verifier', async () => {
    const f = fixture(); fs.renameSync(f.file, f.file + '.retained'); const result = await deliveryPreflight(f.options, f.execute);
    assert.equal(result.status, 'NOT_READY'); assert.equal(f.calls.length, 0);
  });
  await check('frozen spec hash change cannot silently select another requirement', async () => {
    const f = fixture(); fs.appendFileSync(f.specPath, '\n'); const result = await deliveryPreflight(f.options, f.execute);
    assert.equal(result.reason, 'frozen_spec_changed'); assert.equal(f.calls.length, 0);
  });
  await check('same spec id with wrong version is refused', async () => {
    const f = fixture(); f.options['spec-version'] = '2'; assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'spec_version_mismatch');
  });
  await check('spec that does not bind this delivery hash is refused', async () => {
    const f = fixture(), spec = JSON.parse(fs.readFileSync(f.specPath)); spec.vu[0].checker.sha256['delivery.tar'] = 'f'.repeat(64); fs.writeFileSync(f.specPath, JSON.stringify(spec)); f.options['spec-sha256'] = sha(fs.readFileSync(f.specPath));
    assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'delivery_not_bound_by_spec');
  });
  await check('rc0 with FAIL is rejected, no report/archive lookup', async () => {
    const f = fixture(); f.run.overall = 'FAIL'; assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'verification_not_pass'); assert.equal(f.calls.length, 1);
  });
  await check('runtime/process failure is unavailable, never a passed precheck', async () => {
    const f = fixture(); const result = await deliveryPreflight(f.options, async () => ({ ok: false, code: 1, json: { overall: 'PASS' }, error: 'exit' })); assert.equal(result.status, 'UNAVAILABLE');
  });
  await check('wrong run identity is refused', async () => {
    const f = fixture(); f.run.spec_id = 'other'; assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'run_identity_mismatch');
  });
  await check('report for a different source snapshot cannot be reused', async () => {
    const f = fixture(); f.report.data_source.sha256 = 'sha256:' + '0'.repeat(64); assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'report_binding_mismatch');
  });
  await check('report verdict changed after run summary cannot pass', async () => {
    const f = fixture(); f.report.overall = 'FAIL'; assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'report_binding_mismatch');
  });
  await check('observed scan hash mismatch cannot pass', async () => {
    const f = fixture(), s = JSON.parse(fs.readFileSync(f.scanPath)); s.scans[0].matched[0].sha256 = 'f'.repeat(64); fs.writeFileSync(f.scanPath, JSON.stringify(s)); assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'observed_delivery_mismatch');
  });
  await check('archive absent from native summary is not ready', async () => {
    const f = fixture(); delete f.run.archive; assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'archive_missing');
  });
  await check('archive byte change is refused before verification lookup', async () => {
    const f = fixture(); fs.appendFileSync(f.archive, 'tampered'); assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'archive_identity_mismatch');
  });
  await check('native archive verification failure does not pass', async () => {
    const f = fixture(); const result = await deliveryPreflight(f.options, async (args, opts) => args[1] === 'archive' ? { ok: true, code: 0, json: { ok: false } } : f.execute(args, opts)); assert.equal(result.reason, 'archive_not_verified');
  });
  await check('delivery change during verifier call is refused at the end', async () => {
    const f = fixture(); const result = await deliveryPreflight(f.options, async (args, opts) => { const r = await f.execute(args, opts); if (args[1] === 'archive') fs.appendFileSync(f.file, 'changed-during-check'); return r; }); assert.equal(result.reason, 'inputs_changed_during_precheck');
  });
  await check('source snapshot change during verification is refused', async () => {
    const f = fixture(); const result = await deliveryPreflight(f.options, async (args, opts) => { const r = await f.execute(args, opts); if (args[1] === 'archive') fs.appendFileSync(f.database, 'changed'); return r; }); assert.equal(result.reason, 'inputs_changed_during_precheck');
  });
  await check('invalid options fail before any filesystem or CLI work', async () => {
    for (const args of [[], ['--home', 'relative'], ['--file', '../escape'], ['--unknown', 'x'], ['--help', 'extra']]) assert.throws(() => parseOptions(args)); assert.equal(parseOptions(['--help']), null);
    const f = fixture(); await assert.rejects(() => deliveryPreflight({ ...f.options, file: '../escape' }, f.execute)); assert.equal(f.calls.length, 0);
  });
  await check('external database configuration is refused without touching it', async () => {
    const f = fixture(), previous = process.env.YGL_DB_URL;
    try {
      process.env.YGL_DB_URL = 'postgres://synthetic.invalid/not-contacted';
      assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'external_database_configured'); assert.equal(f.calls.length, 0);
    } finally { if (previous === undefined) delete process.env.YGL_DB_URL; else process.env.YGL_DB_URL = previous; }
  });
  await check('multi-purpose spec with executable or additional units is refused', async () => {
    const f = fixture(), spec = JSON.parse(fs.readFileSync(f.specPath)); spec.vu.push({ id: 'V2', role: 'assert', checker: { type: 'command', argv: ['not-executed'] } }); fs.writeFileSync(f.specPath, JSON.stringify(spec)); f.options['spec-sha256'] = sha(fs.readFileSync(f.specPath));
    assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'spec_not_delivery_identity_only'); assert.equal(f.calls.length, 0);
  });
  await check('drive-relative, stream, control and duplicate options are rejected', async () => {
    const f = fixture();
    for (const file of ['C:relative', 'delivery.tar:stream', 'bad\u0000name', '..\\escape', '*.tar', 'delivery?.tar', 'file[12].tar', '{a,b}.tar']) await assert.rejects(() => deliveryPreflight({ ...f.options, file }, f.execute));
    const argv = Object.entries(f.options).flatMap(([k, v]) => ['--' + k, v]); assert.throws(() => parseOptions([...argv, '--file', 'other']));
    await assert.rejects(() => deliveryPreflight({ ...f.options, extra: 'not-allowed' }, f.execute)); assert.equal(f.calls.length, 0);
  });
  await check('archive from a different run cannot satisfy this run', async () => {
    const f = fixture(), record = path.join(f.home, 'verify/archives', f.run.run_id + '.json');
    const j = JSON.parse(fs.readFileSync(record)); j.run_id = 'run_ffffffffffff'; fs.writeFileSync(record, JSON.stringify(j));
    assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'archive_run_mismatch');
  });
  await check('a missing archive sidecar leaves verification unavailable', async () => {
    const f = fixture(), file = path.join(f.home, 'verify/archives', f.run.run_id + '.json'); fs.renameSync(file, file + '.retained');
    assert.equal((await deliveryPreflight(f.options, f.execute)).status, 'UNAVAILABLE');
  });
  await check('extra spec views are refused before running any native command', async () => {
    const f = fixture(), j = JSON.parse(fs.readFileSync(f.specPath)); j.views = [{ name: 'not_run' }]; fs.writeFileSync(f.specPath, JSON.stringify(j)); f.options['spec-sha256'] = sha(fs.readFileSync(f.specPath));
    assert.equal((await deliveryPreflight(f.options, f.execute)).reason, 'spec_not_delivery_identity_only'); assert.equal(f.calls.length, 0);
  });
  await check('CLI help and invalid arguments work without loading invalid native configuration', async () => {
    const script = path.join(root, 'scripts/ops/bugfix-delivery-preflight.mjs');
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WM_YGL_CLI: 'invalid-relative-native-entry' };
    const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8' }); assert.equal(help.status, 0); assert.match(help.stdout, /Usage:/);
    const bad = spawnSync(process.execPath, [script, '--unexpected', 'x'], { env, encoding: 'utf8' }); assert.equal(bad.status, 2); assert.equal(JSON.parse(bad.stdout).status, 'INVALID_ARGUMENTS'); assert.equal(bad.stderr, '');
  });
  for (const [name, alter] of [
    ['extra hash key', (checker, f) => { fs.writeFileSync(path.join(path.dirname(f.file), 'extra.txt'), 'extra'); checker.sha256['extra.txt'] = sha(Buffer.from('extra')); }],
    ['parent-directory hash key', (checker, f) => { fs.writeFileSync(path.join(f.dir, 'sibling.txt'), 'synthetic sibling'); checker.sha256['../sibling.txt'] = sha(Buffer.from('synthetic sibling')); }],
    ['absolute hash key', (checker, f) => { checker.sha256[path.join(f.dir, 'outside.txt')] = 'a'.repeat(64); }],
    ['empty hash map', (checker) => { checker.sha256 = {}; }],
    ['array hash map', (checker) => { checker.sha256 = []; }],
    ['null hash map', (checker) => { checker.sha256 = null; }],
    ['string hash map', (checker) => { checker.sha256 = 'not-a-map'; }],
    ['extra required file', (checker) => { checker.require = ['delivery.tar', 'extra.txt']; }],
    ['parent-directory required file', (checker) => { checker.require = ['../sibling.txt']; }],
    ['duplicate required file', (checker) => { checker.require = ['delivery.tar', 'delivery.tar']; }],
    ['empty required list', (checker) => { checker.require = []; }],
    ['ignore conditions', (checker) => { checker.ignore = ['extra.txt']; }],
    ['empty ignore field', (checker) => { checker.ignore = []; }],
    ['different minimum', (checker) => { checker.min = 0; }],
    ['different maximum', (checker) => { checker.max = 2; }],
    ['string minimum', (checker) => { checker.min = '1'; }],
    ['unknown checker field', (checker) => { checker.extra = 'not allowed'; }],
    ['prototype-named extra hash', (checker) => { Object.defineProperty(checker.sha256, '__proto__', { value: 'f'.repeat(64), enumerable: true }); }],
  ]) {
    await check('single-file boundary refuses ' + name + ' before native execution', async () => {
      const f = fixture(), spec = JSON.parse(fs.readFileSync(f.specPath));
      alter(spec.vu[0].checker, f); fs.writeFileSync(f.specPath, JSON.stringify(spec)); f.options['spec-sha256'] = sha(fs.readFileSync(f.specPath));
      const result = await deliveryPreflight(f.options, f.execute);
      assert.equal(result.reason, 'spec_not_delivery_identity_only'); assert.equal(f.calls.length, 0);
    });
  }
  await check('equivalent one-file require and counts are permitted without changing frozen bytes', async () => {
    const f = fixture(), spec = JSON.parse(fs.readFileSync(f.specPath)); spec.vu[0].checker.require = ['delivery.tar']; spec.vu[0].checker.min = 1; spec.vu[0].checker.max = 1;
    fs.writeFileSync(f.specPath, JSON.stringify(spec)); const before = fs.readFileSync(f.specPath); f.options['spec-sha256'] = sha(before);
    assert.equal((await deliveryPreflight(f.options, f.execute)).status, 'PRECHECK_PASSED'); assert.deepEqual(fs.readFileSync(f.specPath), before);
  });
} finally {
  const absolute = path.resolve(out); if (!absolute.startsWith(path.join(root, 'tmp') + path.sep)) throw Error('unsafe_cleanup_target'); fs.rmSync(absolute, { recursive: true, force: true });
}
console.log(pass + ' preflight checks passed');
