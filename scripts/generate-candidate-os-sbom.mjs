#!/usr/bin/env node
/** CycloneDX OS-package inventory from immutable candidate image rootfs.
 * Inventories dpkg status entries; not a vulnerability scan or signature.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const targets = [
  { role: 'workbench', container: process.env.WORKBENCH_CONTAINER },
  { role: 'layerfs', container: process.env.LAYERFS_CONTAINER },
];
const run = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const parseStatus = (text) => text.split(/\n(?=Package: )/).filter(x => /^Package: /m.test(x)).map(block => {
  const field = (name) => new RegExp('^' + name + ': (.+)$', 'm').exec(block)?.[1];
  if (!field('Status')?.split(/\s+/).includes('installed')) return null;
  const name = field('Package'), version = field('Version'), arch = field('Architecture');
  if (!name || !version || !arch) throw new Error('Incomplete installed package entry: ' + (name ?? '(unknown)'));
  return { name, version, arch };
}).filter(Boolean);
const components = [], images = [];
for (const target of targets) {
  const inspected = JSON.parse(run(['inspect', target.container]))[0];
  if (!inspected?.Image?.startsWith('sha256:')) throw new Error('Cannot resolve immutable image digest for ' + target.container);
  const imageDigest = inspected.Image;
  const image = JSON.parse(run(['image', 'inspect', imageDigest]))[0];
  const os = image?.Os ?? 'unknown', architecture = image?.Architecture ?? 'unknown';
  const temp = mkdtempSync(join(tmpdir(), 'candidate-os-sbom-'));
  let probe = '';
  try {
    probe = run(['create', '--entrypoint', '/bin/true', imageDigest]).trim();
    if (!probe) throw new Error('Docker did not create immutable image probe container');
    const archive = join(temp, 'rootfs.tar');
    run(['export', '--output', archive, probe]);
    const status = execFileSync('tar', ['-xOf', archive, 'var/lib/dpkg/status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const rows = parseStatus(status);
    if (!rows.length) throw new Error('No installed packages in image dpkg status for ' + target.role);
    images.push({ role: target.role, container: target.container, imageDigest, os, architecture, installedDpkgPackages: rows.length, source: 'immutable image rootfs /var/lib/dpkg/status' });
    for (const row of rows) {
      const purl = 'pkg:deb/debian/' + encodeURIComponent(row.name) + '@' + encodeURIComponent(row.version) + '?arch=' + encodeURIComponent(row.arch);
      components.push({ type: 'operating-system', 'bom-ref': purl + '#image-' + target.role,
        name: row.name, version: row.version, purl,
        properties: [
          { name: 'dsh:sbom:image-role', value: target.role },
          { name: 'dsh:sbom:image-digest', value: imageDigest },
          { name: 'dsh:sbom:architecture', value: row.arch },
          { name: 'dsh:sbom:source', value: 'dpkg status from immutable image rootfs' },
        ],
      });
    }
  } finally {
    if (probe) { try { run(['rm', '--force', probe]); } catch {} }
    rmSync(temp, { recursive: true, force: true });
  }
}
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'generate-candidate-os-sbom.mjs', version: '1.0.0' }] },
    component: { type: 'application', name: 'workbench-layerfs-candidate-images', version: 'candidate' },
    properties: [
      { name: 'dsh:sbom:scope', value: 'Installed Debian dpkg package inventory only; excludes npm/pnpm packages, source/build dependencies no longer installed, files not registered in dpkg, LayerFS native Rust dependency metadata, and external services' },
      { name: 'dsh:sbom:assurance', value: 'inventory only; not a vulnerability scan, license review, reproducible build attestation, signature, or complete image SBOM' },
      { name: 'dsh:sbom:images', value: JSON.stringify(images) },
    ],
  },
  components: components.sort((a,b) => a['bom-ref'].localeCompare(b['bom-ref'])),
};
const out = resolve(process.argv[2] ?? resolve(process.env.CANDIDATE_SBOM_DIR ?? '/tmp/workbench-market-sbom', 'candidate-images-dpkg.cdx.json'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(bom, null, 2) + '\n');
console.log(JSON.stringify({ output: out, specVersion: bom.specVersion, components: components.length, images, scope: bom.metadata.properties[0].value, assurance: bom.metadata.properties[1].value }));
