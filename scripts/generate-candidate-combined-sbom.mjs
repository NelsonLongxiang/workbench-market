#!/usr/bin/env node
/** Combine pinned pnpm graph with immutable-image Debian dpkg inventories.
 * This is a useful partial inventory, not a complete image SBOM.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const inputDir = resolve(process.env.CANDIDATE_SBOM_DIR ?? '/tmp/workbench-market-sbom');
const npm = JSON.parse(readFileSync(resolve(inputDir, 'workbench-market-lockfile.cdx.json'), 'utf8'));
const os = JSON.parse(readFileSync(resolve(inputDir, 'candidate-images-dpkg.cdx.json'), 'utf8'));
const cargo = JSON.parse(readFileSync(resolve(inputDir, 'layerfs-cargo-lockfile.cdx.json'), 'utf8'));
for (const [name, bom] of [['pnpm lock', npm], ['candidate OS', os], ['LayerFS Cargo', cargo]]) {
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5' || !Array.isArray(bom.components)) throw new Error('Invalid ' + name + ' CycloneDX input');
}
const imagesProperty = os.metadata?.properties?.find(p => p.name === 'dsh:sbom:images');
const images = JSON.parse(imagesProperty?.value ?? 'null');
if (!Array.isArray(images) || images.length !== 2) throw new Error('Expected two immutable candidate image records');
if (images.some(image => !/^sha256:[0-9a-f]{64}$/.test(image.imageDigest) || image.source !== 'immutable image rootfs /var/lib/dpkg/status')) throw new Error('Image evidence is not digest-pinned immutable rootfs inventory');
for (const image of images) {
  const expectedRole = image.role;
  const listed = os.components.filter(c => c.properties?.some(p => p.name === 'dsh:sbom:image-digest' && p.value === image.imageDigest));
  if (listed.length !== image.installedDpkgPackages || listed.some(c => !c.properties.some(p => p.name === 'dsh:sbom:image-role' && p.value === expectedRole))) throw new Error('OS component/image provenance mismatch: ' + expectedRole);
}
const cargoPin = cargo.metadata?.properties?.find(p => p.name === 'dsh:sbom:layerfs-commit')?.value;
const cargoDigest = cargo.metadata?.properties?.find(p => p.name === 'dsh:sbom:layerfs-image-digest')?.value;
const layerImageDigest = images.find(x => x.role === 'layerfs').imageDigest;
if (cargoPin !== '9f97a7ec95b662e9cb288704afa165feff132cfa' || cargoDigest !== layerImageDigest) throw new Error('Cargo SBOM does not match pinned LayerFS commit/image digest');
const components = [...npm.components, ...os.components, ...cargo.components];
const refs = new Set();
for (const component of components) {
  if (!component['bom-ref'] || refs.has(component['bom-ref'])) throw new Error('Missing or duplicate component bom-ref: ' + component['bom-ref']);
  refs.add(component['bom-ref']);
}
const rootRef = npm.metadata.component['bom-ref'];
const dependencyRoots = new Set([rootRef, cargo.metadata?.component?.['bom-ref']]);
const dependencies = [...(npm.dependencies ?? []), ...(cargo.dependencies ?? [])];
for (const dep of dependencies) {
  if (!refs.has(dep.ref) && !dependencyRoots.has(dep.ref)) throw new Error('Missing dependency node ' + dep.ref);
  for (const child of dep.dependsOn ?? []) if (!refs.has(child)) throw new Error('Dangling dependency edge ' + dep.ref + ' -> ' + child);
}
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'generate-candidate-combined-sbom.mjs', version: '1.0.0' }] },
    component: { ...npm.metadata.component, 'bom-ref': rootRef },
    properties: [
      { name: 'dsh:sbom:scope', value: 'Combined pnpm-lock dependency graph, Debian dpkg inventories from immutable candidate image rootfs, and pinned LayerFS Cargo.lock package records; partial inventory only, not a complete image SBOM' },
      { name: 'dsh:sbom:workbench-image', value: images.find(x => x.role === 'workbench').imageDigest },
      { name: 'dsh:sbom:layerfs-image', value: images.find(x => x.role === 'layerfs').imageDigest },
      { name: 'dsh:sbom:excluded', value: 'Vendored native source/license metadata, package files not registered in dpkg, vulnerability/license analysis, reproducibility attestation, signature, external services' },
      { name: 'dsh:sbom:layerfs-cargo-lock-sha256', value: cargo.metadata.properties.find(p => p.name === 'dsh:sbom:cargo-lock-sha256').value },
      { name: 'dsh:sbom:inputs', value: 'workbench-market-lockfile.cdx.json; candidate-images-dpkg.cdx.json; layerfs-cargo-lockfile.cdx.json' },
    ],
  },
  components: components.sort((a,b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  dependencies,
};
const out = resolve(process.argv[2] ?? resolve(inputDir, 'candidate-combined-partial.cdx.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
console.log(JSON.stringify({ output: out, specVersion: bom.specVersion, components: components.length, npmComponents: npm.components.length, osComponents: os.components.length, dependencyNodes: dependencies.length, cargoDependencyNodes: cargo.dependencies?.length ?? 0, imageDigests: images.map(i => [i.role, i.imageDigest]), scope: bom.metadata.properties[0].value }));
