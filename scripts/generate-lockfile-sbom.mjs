#!/usr/bin/env node
/** Offline CycloneDX inventory for the exact pnpm-lock.yaml graph.
 * This is a package-lock SBOM, not an OS/base-image inventory.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'server/package.json'));
const { parse } = require('yaml');
const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const pkgs = lock.packages ?? {};
const snaps = lock.snapshots ?? {};
const nameVersion = (key) => {
  const match = key.match(/^((?:@[^/]+\/)?[^@]+)@([^([]+)/);
  if (!match) throw new Error('Unexpected pnpm package key: ' + key);
  return { name: match[1], version: match[2] };
};
const purl = (name, version) => 'pkg:npm/' + name.split('/').map(encodeURIComponent).join('/') + '@' + encodeURIComponent(version);
const ref = (name, version) => purl(name, version);
const components = Object.entries(pkgs).map(([key, metadata]) => {
  const { name, version } = nameVersion(key);
  const resolution = metadata?.resolution ?? {};
  const component = { type: 'library', 'bom-ref': ref(name, version), name, version, purl: purl(name, version), scope: 'required' };
  if (resolution.integrity) {
    const [algorithm, encoded] = resolution.integrity.split('-', 2);
    if (algorithm && encoded) component.hashes = [{ alg: algorithm.toUpperCase().replace('SHA', 'SHA-'), content: Buffer.from(encoded.split('?')[0], 'base64').toString('hex') }];
  }
  if (resolution.tarball) component.externalReferences = [{ type: 'distribution', url: resolution.tarball }];
  return component;
});
const packageById = new Map(Object.keys(pkgs).map((key) => [key, nameVersion(key)]));
const componentKeys = new Set(Object.keys(pkgs));
const deps = Object.entries(snaps).map(([snapshotKey, snapshot]) => {
  const { name, version } = nameVersion(snapshotKey);
  const dependsOn = new Set();
  for (const group of ['dependencies', 'optionalDependencies']) {
    for (const [depName, depVersionRaw] of Object.entries(snapshot?.[group] ?? {})) {
      const depVersion = String(depVersionRaw).split('(')[0];
      const depKey = depName + '@' + depVersion;
      if (componentKeys.has(depKey)) {
        const dep = packageById.get(depKey);
        dependsOn.add(ref(dep.name, dep.version));
      }
    }
  }
  return { ref: ref(name, version), dependsOn: [...dependsOn].sort() };
});
const rootRef = 'pkg:npm/workbench-market@0.1.0';
const rootDeps = new Set();
for (const importer of Object.values(lock.importers ?? {})) {
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, entry] of Object.entries(importer?.[group] ?? {})) {
      const version = String(entry.version).split('(')[0];
      const key = name + '@' + version;
      if (componentKeys.has(key)) {
        const pkg = packageById.get(key);
        rootDeps.add(ref(pkg.name, pkg.version));
      }
    }
  }
}
if (!components.length || !rootDeps.size) throw new Error('Lockfile produced no package components or root dependencies');
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'generate-lockfile-sbom.mjs', version: '1.0.0' }] },
    component: { type: 'application', 'bom-ref': rootRef, name: 'workbench-market', version: '0.1.0', purl: rootRef },
    properties: [
      { name: 'dsh:sbom:scope', value: 'pnpm-lockfile-only; includes runtime and build/dev npm graph; excludes Node base-image OS packages, LayerFS Rust/native image packages, and runtime-mounted external services' },
      { name: 'dsh:sbom:source', value: 'pnpm-lock.yaml' },
      { name: 'dsh:sbom:lockfileVersion', value: String(lock.lockfileVersion) },
      { name: 'dsh:sbom:reproducibility', value: 'component set and graph derive from committed lockfile; metadata timestamp varies by generation' },
    ],
  },
  components: components.sort((a,b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  dependencies: [{ ref: rootRef, dependsOn: [...rootDeps].sort() }, ...deps.sort((a,b) => a.ref.localeCompare(b.ref))],
};
const out = resolve(process.argv[2] ?? join(process.env.CANDIDATE_SBOM_DIR ?? '/tmp/workbench-market-sbom', 'workbench-market-lockfile.cdx.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
console.log(JSON.stringify({ output: out, specVersion: bom.specVersion, components: components.length, rootDependencies: rootDeps.size, graphNodes: deps.length + 1, scope: bom.metadata.properties[0].value }));
