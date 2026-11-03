#!/usr/bin/env node
/** Prove the candidate partial-SBOM validator rejects isolated provenance and graph tampering. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const source = resolve(process.env.CANDIDATE_SBOM_DIR ?? '/tmp/workbench-market-sbom');
const validator = join(root, 'scripts/validate-candidate-sbom.mjs');
const temp = mkdtempSync(join(tmpdir(), 'candidate-sbom-test-'));
const run = (dir) => spawnSync(process.execPath, [validator], { cwd: root, env: { ...process.env, CANDIDATE_SBOM_DIR: dir }, encoding: 'utf8', timeout: 30000 });
try {
  const valid = join(temp, 'valid'); cpSync(source, valid, { recursive: true });
  const ok = run(valid);
  assert.equal(ok.status, 0, ok.stderr);
  console.log('PASS authentic partial candidate SBOM accepted');

  const provenance = join(temp, 'provenance'); cpSync(source, provenance, { recursive: true });
  const osPath = join(provenance, 'candidate-images-dpkg.cdx.json');
  const os = JSON.parse(readFileSync(osPath, 'utf8'));
  const imagesProperty = os.metadata.properties.find(p => p.name === 'dsh:sbom:images');
  const images = JSON.parse(imagesProperty.value); images[0].imageDigest = 'sha256:' + '0'.repeat(64); imagesProperty.value = JSON.stringify(images);
  writeFileSync(osPath, JSON.stringify(os));
  const badProvenance = run(provenance);
  assert.notEqual(badProvenance.status, 0, 'tampered image provenance was accepted');
  assert.match(badProvenance.stderr, /image digest differs from current candidate/);
  console.log('PASS mutated image provenance rejected');

  const graph = join(temp, 'graph'); cpSync(source, graph, { recursive: true });
  const combinedPath = join(graph, 'candidate-combined-partial.cdx.json');
  const combined = JSON.parse(readFileSync(combinedPath, 'utf8'));
  combined.dependencies.find(d => d.dependsOn?.length)?.dependsOn.push('pkg:npm/not-a-real-dependency@0');
  writeFileSync(combinedPath, JSON.stringify(combined));
  const badGraph = run(graph);
  assert.notEqual(badGraph.status, 0, 'dangling dependency edge was accepted');
  assert.match(badGraph.stderr, /dangling edge/);
  console.log('PASS dangling dependency edge rejected');
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log('Candidate SBOM validator: 3 tests passed; temporary copies removed');
