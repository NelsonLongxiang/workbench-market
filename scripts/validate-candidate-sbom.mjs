#!/usr/bin/env node
/** Offline provenance and graph validation for the candidate partial CycloneDX inventory. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const bomDir = resolve(process.env.CANDIDATE_SBOM_DIR ?? '/tmp/workbench-market-sbom');
const load = name => JSON.parse(readFileSync(join(bomDir, name), 'utf8'));
const npm = load('workbench-market-lockfile.cdx.json');
const os = load('candidate-images-dpkg.cdx.json');
const cargo = load('layerfs-cargo-lockfile.cdx.json');
const combined = load('candidate-combined-partial.cdx.json');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const allBoms = [npm, os, cargo, combined];
for (const [i, bom] of allBoms.entries()) check(bom.bomFormat === 'CycloneDX' && bom.specVersion === '1.5' && Array.isArray(bom.components), 'invalid CycloneDX 1.5 document #' + i);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const liveImageDigest = container => {
  const result = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
  check(digestPattern.test(result?.Image ?? ''), 'no immutable live image digest for ' + container);
  return result.Image;
};
const workbenchContainer = process.env.WORKBENCH_CONTAINER;
const layerfsContainer = process.env.LAYERFS_CONTAINER;
check(Boolean(workbenchContainer && layerfsContainer), 'set WORKBENCH_CONTAINER and LAYERFS_CONTAINER for the disposable candidate');
const liveImages = {
  workbench: liveImageDigest(workbenchContainer),
  layerfs: liveImageDigest(layerfsContainer),
};
const property = (bom, name) => bom.metadata?.properties?.find(p => p.name === name)?.value;
const imageRows = JSON.parse(property(os, 'dsh:sbom:images') ?? 'null');
check(Array.isArray(imageRows) && imageRows.length === 2, 'candidate OS BOM must record exactly two images');
for (const image of imageRows) {
  check(Object.hasOwn(liveImages, image.role), 'unexpected image role: ' + image.role);
  check(image.imageDigest === liveImages[image.role] && digestPattern.test(image.imageDigest), 'image digest differs from current candidate: ' + image.role);
  check(image.source === 'immutable image rootfs /var/lib/dpkg/status', 'unexpected image inventory provenance');
  const rows = os.components.filter(c => c.properties?.some(p => p.name === 'dsh:sbom:image-digest' && p.value === image.imageDigest));
  check(rows.length === image.installedDpkgPackages, 'installed package count mismatch: ' + image.role);
  check(rows.length > 0 && rows.every(c => c.properties.some(p => p.name === 'dsh:sbom:image-role' && p.value === image.role)), 'component image ownership mismatch: ' + image.role);
}
check(new Set(imageRows.map(x => x.role)).size === 2 && imageRows.every(x => Object.hasOwn(liveImages, x.role)), 'duplicate/missing image roles');
const require = createRequire(join(root, 'server/package.json'));
const { parse } = require('yaml');
const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const lockKeys = new Set(Object.keys(lock.packages ?? {}));
check(npm.components.length === lockKeys.size, 'npm components do not match lock package count');
const npmRefs = new Set(npm.components.map(c => c['bom-ref']));
check(npmRefs.size === npm.components.length && npm.components.every(c => c.purl === c['bom-ref']), 'duplicate or malformed npm purl/ref');
const cargoSource = process.env.LAYERFS_SOURCE ?? '/tmp/wm-layerfs-source';
const pin = '9f97a7ec95b662e9cb288704afa165feff132cfa';
const actualPin = execFileSync('git', ['-C', cargoSource, 'rev-parse', pin], { encoding: 'utf8' }).trim();
check(actualPin === pin, 'pinned LayerFS source is unavailable or mismatched');
const lockText = execFileSync('git', ['-C', cargoSource, 'show', pin + ':core/Cargo.lock'], { encoding: 'utf8' });
const lockHash = createHash('sha256').update(lockText).digest('hex');
check(property(cargo, 'dsh:sbom:layerfs-commit') === pin, 'Cargo BOM commit does not match pinned source');
check(property(cargo, 'dsh:sbom:cargo-lock-sha256') === lockHash, 'Cargo BOM lockfile hash differs from pinned source');
check(property(cargo, 'dsh:sbom:layerfs-image-digest') === liveImages.layerfs, 'Cargo BOM is not bound to current LayerFS image digest');
check(cargo.components.every(c => c.properties?.some(p => p.name === 'dsh:sbom:image-digest' && p.value === liveImages.layerfs)), 'Cargo component has wrong image provenance');
const refSets = [npm, os, cargo].map(b => new Set(b.components.map(c => c['bom-ref'])));
const expectedRefs = new Set([...refSets[0], ...refSets[1], ...refSets[2]]);
check(expectedRefs.size === refSets.reduce((sum, set) => sum + set.size, 0), 'source BOM component refs collide');
const combinedRefs = new Set(combined.components.map(c => c['bom-ref']));
check(combinedRefs.size === combined.components.length && combinedRefs.size === expectedRefs.size && [...expectedRefs].every(ref => combinedRefs.has(ref)), 'combined BOM component set differs from source inventories');
const roots = new Set([npm.metadata.component['bom-ref'], cargo.metadata.component['bom-ref']]);
const graphRefs = new Set([...combinedRefs, ...roots]);
for (const dep of combined.dependencies ?? []) {
  check(graphRefs.has(dep.ref), 'dependency graph contains dangling node ' + dep.ref);
  for (const child of dep.dependsOn ?? []) check(combinedRefs.has(child), 'dependency graph contains dangling edge ' + dep.ref + ' -> ' + child);
}
check(/partial inventory only/i.test(property(combined, 'dsh:sbom:scope') ?? ''), 'partial SBOM scope label is missing');
check(/not a vulnerability scan/i.test(property(os, 'dsh:sbom:assurance') ?? ''), 'OS inventory assurance warning missing');
console.log(JSON.stringify({ ok: true, candidateImageDigests: liveImages, npmComponents: npm.components.length, osComponents: os.components.length, cargoComponents: cargo.components.length, combinedComponents: combined.components.length, dependencyEntries: combined.dependencies.length, cargoLockSha256: lockHash, assurance: 'partial inventory integrity only; not a vulnerability/license scan, complete image SBOM, signature or attestation' }, null, 2));
