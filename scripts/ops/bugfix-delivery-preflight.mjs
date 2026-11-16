#!/usr/bin/env node
/** Delivery-version precheck only. Usage: node scripts/ops/bugfix-delivery-preflight.mjs --help */
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { passEnv } from '../../server/src/config.ts';

const HELP = 'Usage: node scripts/ops/bugfix-delivery-preflight.mjs --home <absolute-existing-ygl-home> --submission <directory> --file <relative-file> --sha256 <64hex> --spec <id> --spec-version <N> --spec-sha256 <64hex> --db <snapshot.sqlite>\nUses the installed WM_YGL_CLI entry. Writes native verification reports/archives only to the explicit home; never dispatches, changes a work item, or approves anything. PASS means version precheck passed, not human acceptance.\n';
const KEYS = ['home', 'submission', 'file', 'sha256', 'spec', 'spec-version', 'spec-sha256', 'db'];
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const RUN = /^run_[a-f0-9]{12,64}$/;
const normalizedHash = x => typeof x === 'string' ? x.replace(/^sha256:/, '') : '';
const outcome = (status, reason, extra = {}) => ({ contract: 'bugfix-delivery-precheck/1', status, reason, human_acceptance: false, work_item_changed: false, ...extra });

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !KEYS.includes(key) || key in options || !value || value.startsWith('--')) throw Error('invalid_options');
    options[key] = value;
  }
  if (KEYS.some(k => !(k in options)) || !isAbsolute(options.home) || !HEX.test(options.sha256) || !HEX.test(options['spec-sha256']) || !ID.test(options.spec) || !/^[1-9][0-9]{0,7}$/.test(options['spec-version'])) throw Error('invalid_options');
  if (isAbsolute(options.file) || /[\\:*?\[\]{}\u0000-\u001f\u007f]/.test(options.file) || options.file.split('/').some(x => !x || x === '.' || x === '..')) throw Error('invalid_file_path');
  return options;
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const inside = (root, file) => { const rel = relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
async function regularFile(file) { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw Error('not_regular_file'); }

const plainObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const identityChecker = (checker, file) => {
  if (!plainObject(checker) || Object.keys(checker).some(key => !['type', 'glob', 'sha256', 'require', 'min', 'max'].includes(key))) return false;
  if (checker.type !== 'file' || checker.glob !== file || !plainObject(checker.sha256)) return false;
  const hashes = Object.keys(checker.sha256);
  if (hashes.length !== 1 || hashes[0] !== file) return false;
  if (Object.hasOwn(checker, 'require') && (!Array.isArray(checker.require) || checker.require.length !== 1 || checker.require[0] !== file)) return false;
  return ['min', 'max'].every(key => !Object.hasOwn(checker, key) || checker[key] === 1);
};

const nativeExecute = async (args, options) => {
  const { execYgl } = await import('../../server/src/ygl-cli.ts');
  return execYgl(args, options);
};

/** Trusted local CLI composition, not a security boundary or a lock on mutable files. */
export async function deliveryPreflight(options, execute = nativeExecute) {
  if (!options || Object.keys(options).some(k => !KEYS.includes(k))) throw Error('invalid_options');
  const o = parseOptions(KEYS.flatMap(k => ['--' + k, String(options[k] ?? '')]));
  // A database URL selects a different backend even when home is explicit. Refuse it rather than touching that target.
  if (Object.values(passEnv(['YGL_DB_URL', 'YGL_PG_URL'])).some(v => v.trim() !== '')) return outcome('NOT_READY', 'external_database_configured');
  let home, submission, file, database, specPath, frozen, snapshotSha;
  try {
    home = await realpath(o.home); submission = await realpath(resolve(o.submission)); database = await realpath(resolve(o.db));
    await regularFile(join(home, 'ygl-trees.db')); await regularFile(database);
    if (!(await stat(submission)).isDirectory()) throw Error('not_directory');
    file = join(submission, ...o.file.split('/')); await regularFile(file);
    if (!inside(submission, await realpath(file))) throw Error('file_outside_submission');
    specPath = join(home, 'verify', 'specs', o.spec, 'spec.json'); await regularFile(specPath);
    if (await digest(specPath) !== o['spec-sha256']) return outcome('NOT_READY', 'frozen_spec_changed');
    frozen = await json(specPath);
    if (frozen.spec_id !== o.spec || frozen.spec_version !== Number(o['spec-version'])) return outcome('NOT_READY', 'spec_version_mismatch');
    if (frozen.views?.length || !Array.isArray(frozen.vu) || frozen.vu.length !== 1 || frozen.vu[0].role !== 'assert' || !identityChecker(frozen.vu[0].checker, o.file)) return outcome('NOT_READY', 'spec_not_delivery_identity_only');
    if (frozen.vu[0].checker.sha256?.[o.file] !== o.sha256) return outcome('NOT_READY', 'delivery_not_bound_by_spec');
    if (await digest(file) !== o.sha256) return outcome('NOT_READY', 'delivery_hash_mismatch');
    snapshotSha = await digest(database);
  } catch { return outcome('NOT_READY', 'input_unavailable'); }
  const call = args => execute([...args, '--json'], { home, timeoutMs: 60_000 });
  try {
    const run = await call(['verify', 'run', o.spec, '--spec-version', o['spec-version'], '--db', database, '--submission', submission]);
    if (!run.ok) return outcome('UNAVAILABLE', 'verifier_' + run.error);
    const r = run.json;
    if (!r || !RUN.test(r.run_id) || r.spec_id !== o.spec || r.spec_version !== Number(o['spec-version'])) return outcome('UNAVAILABLE', 'run_identity_mismatch');
    if (r.overall !== 'PASS') return outcome('NOT_READY', 'verification_not_pass', { run_id: r.run_id, verdict: r.overall ?? 'UNKNOWN' });
    const detail = await call(['verify', 'report', r.run_id]);
    if (!detail.ok) return outcome('UNAVAILABLE', 'report_unavailable');
    const report = detail.json;
    if (!report || report.run_id !== r.run_id || report.spec_id !== o.spec || report.verifier?.spec_version !== Number(o['spec-version']) || report.overall !== 'PASS' || normalizedHash(report.data_source?.sha256) !== snapshotSha) return outcome('NOT_READY', 'report_binding_mismatch');
    const scan = await json(join(home, 'verify', 'submission-scans', r.run_id + '.json'));
    if (scan.run_id !== r.run_id || scan.spec_id !== o.spec || !Array.isArray(scan.scans) || !scan.scans.some(s => frozen.vu.some(v => v.id === s.vu_id && v.checker?.sha256?.[o.file] === o.sha256) && s.matched?.some(f => f.path === o.file && f.sha256 === o.sha256))) return outcome('NOT_READY', 'observed_delivery_mismatch');
    if (!r.archive || typeof r.archive.path !== 'string' || !HEX.test(r.archive.zip_sha256)) return outcome('NOT_READY', 'archive_missing');
    const archive = await realpath(r.archive.path), archiveRoot = await realpath(join(home, 'verify', 'archives'));
    if (!inside(archiveRoot, archive) || await digest(archive) !== r.archive.zip_sha256) return outcome('NOT_READY', 'archive_identity_mismatch');
    const archiveRecord = await json(join(archiveRoot, r.run_id + '.json'));
    if (archiveRecord.run_id !== r.run_id || archiveRecord.spec_id !== o.spec || archiveRecord.spec_version !== Number(o['spec-version']) || !archiveRecord.archives?.some(a => a.archive_id === r.archive.archive_id && a.archive_sha256 === r.archive.archive_sha256 && a.zip_sha256 === r.archive.zip_sha256)) return outcome('NOT_READY', 'archive_run_mismatch');
    const verified = await call(['verify', 'archive', 'verify', archive]);
    if (!verified.ok || verified.json?.ok !== true || verified.json.archive_id !== r.archive.archive_id || verified.json.archive_sha256 !== r.archive.archive_sha256) return outcome('NOT_READY', 'archive_not_verified');
    if (await digest(file) !== o.sha256 || await digest(specPath) !== o['spec-sha256'] || await digest(database) !== snapshotSha) return outcome('NOT_READY', 'inputs_changed_during_precheck');
    return outcome('PRECHECK_PASSED', 'exact_delivery_and_native_report_match', { spec_id: o.spec, spec_version: Number(o['spec-version']), delivery_sha256: o.sha256, run_id: r.run_id, archive_id: r.archive.archive_id, next: 'Independent verification and an authorized human decision remain required.' });
  } catch { return outcome('UNAVAILABLE', 'verification_evidence_unavailable'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (!options) { process.stdout.write(HELP); } else {
      const result = await deliveryPreflight(options); console.log(JSON.stringify(result));
      process.exitCode = result.status === 'PRECHECK_PASSED' ? 0 : result.status === 'NOT_READY' ? 1 : 3;
    }
  } catch { console.log(JSON.stringify(outcome('INVALID_ARGUMENTS', 'invalid_options'))); process.exitCode = 2; }
}
