#!/usr/bin/env node
/** Inventory Rust packages in the exact LayerFS Cargo.lock source commit.
 * Lockfile components include locked workspace/dev packages; no CVE scan or signature.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const PIN = '9f97a7ec95b662e9cb288704afa165feff132cfa';
const SOURCE = process.env.LAYERFS_SOURCE ?? '/tmp/wm-layerfs-source';
const WORKBENCH = process.env.WORKBENCH_CONTAINER;
const LAYERFS = process.env.LAYERFS_CONTAINER;
if (!WORKBENCH || !LAYERFS) throw new Error('Set WORKBENCH_CONTAINER and LAYERFS_CONTAINER for the disposable candidate');
const run = (cmd, args, input) => execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe','pipe','pipe'] });
if (run('git', ['-C', SOURCE, 'rev-parse', PIN]).trim() !== PIN) throw new Error('LayerFS pinned commit object missing or mismatched');
const cargoLock = run('git', ['-C', SOURCE, 'show', PIN + ':core/Cargo.lock']);
const hash = run('sha256sum', ['-'], cargoLock).trim().split(/\s+/)[0];
const parsed = JSON.parse(run('python3', ['-c', 'import json,sys,tomllib; d=tomllib.loads(sys.stdin.read()); print(json.dumps(d))'], cargoLock));
const packages = parsed.package ?? [];
if (!packages.length) throw new Error('Pinned core/Cargo.lock has no package records');
const inspect = (name) => JSON.parse(run('docker', ['inspect', name]))[0];
const image = inspect(LAYERFS)?.Image;
if (!/^sha256:[0-9a-f]{64}$/.test(image ?? '')) throw new Error('LayerFS container has no immutable image digest');
const components = packages.map(pkg => {
  if (!pkg.name || !pkg.version) throw new Error('Cargo package is missing name/version');
  const purl = 'pkg:cargo/' + encodeURIComponent(pkg.name) + '@' + encodeURIComponent(pkg.version);
  const component = {
    type: 'library', 'bom-ref': 'urn:dsh:cargo:' + encodeURIComponent(pkg.name) + ':' + encodeURIComponent(pkg.version) + ':' + (pkg.checksum ?? 'workspace'),
    name: pkg.name, version: pkg.version, purl,
    properties: [
      { name: 'dsh:sbom:image-role', value: 'layerfs' },
      { name: 'dsh:sbom:image-digest', value: image },
      { name: 'dsh:sbom:lockfile-sha256', value: hash },
      { name: 'dsh:sbom:source', value: 'core/Cargo.lock at ' + PIN },
      { name: 'dsh:sbom:locked-dependency-count', value: String((pkg.dependencies ?? []).length) },
    ],
  };
  if (pkg.checksum) component.hashes = [{ alg: 'SHA-256', content: pkg.checksum }];
  if (pkg.source) component.externalReferences = [{ type: 'distribution', url: pkg.source }];
  return component;
});
const refs = new Set();
const refsByName = new Map();
for (const [index, c] of components.entries()) {
  if (refs.has(c['bom-ref'])) throw new Error('Duplicate Cargo component ' + c['bom-ref']);
  refs.add(c['bom-ref']);
  const pkg = packages[index];
  const list = refsByName.get(pkg.name) ?? [];
  list.push({ pkg, ref: c['bom-ref'] }); refsByName.set(pkg.name, list);
}
const dependencyNodes = packages.map((pkg, index) => {
  const dependsOn = new Set();
  for (const entry of pkg.dependencies ?? []) {
    const clean = entry.replace(/ \(.*\)$/, '');
    const parts = clean.split(/\s+/);
    const name = parts[0];
    const version = parts[1];
    if (!name) throw new Error('Unrecognized Cargo dependency record: ' + entry);
    let candidates = refsByName.get(name) ?? [];
    if (version) candidates = candidates.filter(x => x.pkg.version === version);
    if (candidates.length !== 1) throw new Error('Cargo dependency is ambiguous or missing in lockfile: ' + entry + ' (' + candidates.length + ' candidates)');
    dependsOn.add(candidates[0].ref);
  }
  return { ref: components[index]['bom-ref'], dependsOn: [...dependsOn].sort() };
});
const rootRef = 'urn:dsh:layerfs-root:' + PIN;
const rootCandidates = packages.map((pkg, index) => ({ pkg, index })).filter(x => x.pkg.name === 'layerfs-node');
if (rootCandidates.length !== 1) throw new Error('Expected exactly one layerfs-node root package');
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'generate-candidate-cargo-sbom.mjs', version: '1.0.0' }] },
    component: { type: 'application', 'bom-ref': rootRef, name: 'layerfs-rust-dependencies', version: PIN },
    properties: [
      { name: 'dsh:sbom:scope', value: 'All package records in pinned core/Cargo.lock; includes locked workspace/dev packages and does not assert build reachability or vendored native file inventory' },
      { name: 'dsh:sbom:layerfs-commit', value: PIN },
      { name: 'dsh:sbom:cargo-lock-sha256', value: hash },
      { name: 'dsh:sbom:layerfs-image-digest', value: image },
      { name: 'dsh:sbom:assurance', value: 'lockfile inventory only; not a vulnerability scan, license review, full filesystem inventory, reproducibility attestation, or signature' },
    ],
  },
  components,
  dependencies: [{ ref: rootRef, dependsOn: [components[rootCandidates[0].index]['bom-ref']] }, ...dependencyNodes],
};
const out = resolve(process.argv[2] ?? resolve(process.env.CANDIDATE_SBOM_DIR ?? '/tmp/workbench-market-sbom', 'layerfs-cargo-lockfile.cdx.json'));
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
console.log(JSON.stringify({ output: out, specVersion: bom.specVersion, packages: components.length, lockSha256: hash, layerfsCommit: PIN, layerfsImageDigest: image }));
