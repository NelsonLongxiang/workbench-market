#!/usr/bin/env node
// Read-only contract check for the LC bridge deployment; never runs compose up.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const deployDir = resolve(process.argv[2] ?? process.env.LIFECYCLE_OS_DEPLOY_DIR ?? resolve(scriptDir, '../../lifecycle-os/deploy'));
const run = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.workbench.yml', 'config', '--format', 'json'], {
  cwd: deployDir, encoding: 'utf8', timeout: 30000,
});
if (run.error) throw run.error;
assert.equal(run.status, 0, run.stderr || 'docker compose config failed');
const config = JSON.parse(run.stdout);
const services = config.services ?? {};
const workbench = services.workbench;
const layerfs = services.layerfs;
assert.ok(workbench && layerfs, 'LC overlay must include Workbench and LayerFS services');
assert.equal(layerfs.profiles?.length ?? 0, 0, 'LayerFS must be in the default profile');
assert.equal((layerfs.ports ?? []).length, 0, 'LayerFS must not publish host ports');
const networkNames = Object.keys(layerfs.networks ?? {});
assert.ok(networkNames.some(name => config.networks?.[name]?.internal === true), 'LayerFS must use an internal network');
assert.ok(networkNames.every(name => config.networks?.[name]?.internal === true), 'LayerFS must not join a non-internal network');
assert.ok((layerfs.volumes ?? []).some(v => v.source === '/var/run/docker.sock' && v.target === '/var/run/docker.sock'), 'LayerFS must have its explicitly accepted Docker socket mount');
assert.ok((layerfs.volumes ?? []).some(v => v.target === '/var/lib/layerfs' && v.type === 'volume'), 'LayerFS must persist data in its own named volume');
assert.equal((workbench.ports ?? []).some(p => (p.published ?? '').toString() === '8067'), false, 'Workbench must not publish the LayerFS API');
assert.equal((workbench.ports ?? []).some(p => (p.target ?? '').toString() === '9801'), false, 'base LC overlay must not publish optional control surface');
assert.equal(workbench.environment?.WM_CONTROL_PORT ?? '', '', 'base LC overlay must leave control surface disabled');
assert.match(JSON.stringify(workbench.healthcheck?.test ?? []), /9800/, 'base healthcheck must validate the business surface');
const controlRun = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.workbench.yml', '-f', 'docker-compose.control.yml', 'config', '--format', 'json'], { cwd: deployDir, encoding: 'utf8', timeout: 30000 });
assert.equal(controlRun.status, 0, controlRun.stderr || 'opt-in control overlay config failed');
const controlService = JSON.parse(controlRun.stdout).services?.workbench;
const controlPort = (controlService?.ports ?? []).find(p => (p.target ?? '').toString() === '9801');
assert.ok(controlPort, 'opt-in overlay must publish the control surface');
assert.equal(controlPort.host_ip, '127.0.0.1', 'opt-in control surface must bind loopback only');
assert.equal(String(controlService.environment?.WM_CONTROL_PORT ?? ''), '9801', 'opt-in port must enable the control listener');
assert.match(JSON.stringify(controlService.healthcheck?.test ?? []), /9801.*wm-surface.*control/s, 'opt-in healthcheck must validate control surface identity');
assert.equal((workbench.volumes ?? []).some(v => String(v.source ?? '').includes('docker.sock') || String(v.target ?? '').includes('docker.sock')), false, 'Workbench must not mount Docker socket');
assert.ok(workbench.environment?.LAYERFS_SERVICE_URL === 'http://layerfs:8067', 'Workbench must use LayerFS internal DNS');
assert.ok(Object.values(workbench.depends_on ?? {}).some(d => d.condition === 'service_healthy' && d.required !== false), 'Workbench must wait for healthy LayerFS');
assert.ok(layerfs.secrets?.some(s => s.source === 'layerfs_service_token'), 'LayerFS must receive token as a file secret');
assert.ok(workbench.secrets?.some(s => s.source === 'layerfs_service_token'), 'Workbench must receive the same token file secret');
for (const [name, svc] of Object.entries(services)) {
  const env = svc.environment ?? {};
  for (const [key, value] of Object.entries(env)) {
    assert.ok(!/LAYERFS_SERVICE_TOKEN$/.test(key), name + ' must not carry token value in environment');
    assert.ok(!(typeof value === 'string' && /^Bearer\s/.test(value)), name + ' contains bearer secret in environment');
  }
}
console.log('PASS LC default stack includes required LayerFS and Workbench');
console.log('PASS LayerFS is isolated, persistent, un-published; Workbench has no Docker socket');
console.log('PASS service-health dependency and file-secret wiring are present');
