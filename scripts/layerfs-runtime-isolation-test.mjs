#!/usr/bin/env node
/** Read-only audit of the deployed Workbench/LayerFS candidate isolation boundary. */
import { execFileSync } from 'node:child_process';
const run = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const wbName = process.env.WORKBENCH_CONTAINER;
const lfName = process.env.LAYERFS_CONTAINER;
if (!wbName || !lfName) throw new Error('Set WORKBENCH_CONTAINER and LAYERFS_CONTAINER to disposable candidate containers');
const inspect = (name) => JSON.parse(run(['inspect', name]))[0];
const check = (label, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : '')); if (!ok) failures++; };
let failures = 0;
const wb = inspect(wbName), lf = inspect(lfName);
const wm = wb.Mounts ?? [], lm = lf.Mounts ?? [];
const wbSocket = wm.some(m => m.Destination === '/var/run/docker.sock');
const lfSocket = lm.find(m => m.Destination === '/var/run/docker.sock');
check('Workbench has no host Docker socket', !wbSocket);
check('LayerFS alone receives the expected writable host socket', !!lfSocket && lfSocket.Source === '/var/run/docker.sock' && lfSocket.RW === true, lfSocket ? JSON.stringify({source:lfSocket.Source,rw:lfSocket.RW}) : 'socket absent');
check('LayerFS data uses a named volume', lm.some(m => m.Destination === '/var/lib/layerfs' && m.Type === 'volume'));
const secretMount = wm.find(m => m.Destination === '/run/secrets/layerfs_service_token');
check('Workbench token secret is read-only file mount', !!secretMount && secretMount.Type === 'bind' && secretMount.RW === false);
const lfSecret = lm.find(m => m.Destination === '/run/secrets/layerfs_service_token');
check('LayerFS token secret is read-only file mount', !!lfSecret && lfSecret.Type === 'bind' && lfSecret.RW === false);
const portBindings = Object.values(lf.HostConfig?.PortBindings ?? {}).flat().filter(Boolean);
check('LayerFS has no host-published ports', portBindings.length === 0 && Object.keys(lf.NetworkSettings?.Ports ?? {}).every(k => (lf.NetworkSettings.Ports[k] ?? []).length === 0));
const nets = lf.NetworkSettings?.Networks ?? {};
const privateName = Object.keys(nets).find(n => n.endsWith('_layerfs-private')) ?? Object.keys(nets).find(n => n === 'layerfs-private');
let privateNetwork = null, endpoints = [];
if (privateName) {
  privateNetwork = JSON.parse(run(['network','inspect',privateName]))[0];
  endpoints = Object.values(privateNetwork.Containers ?? {}).map(c => c.Name).sort();
}
check('LayerFS attached to an internal private network', !!privateNetwork?.Internal, privateName ?? 'network absent');
check('Private LayerFS network contains only Workbench and LayerFS', endpoints.length === 2 && endpoints.includes(wb.Name.replace(/^\//,'')) && endpoints.includes(lf.Name.replace(/^\//,'')), JSON.stringify(endpoints));
const status = lf.State?.Health?.Status;
check('LayerFS healthcheck is healthy', status === 'healthy', status ?? 'no healthcheck');
const data = lm.find(m => m.Destination === '/var/lib/layerfs');
check('LayerFS data volume is writable and named', !!data && data.Type === 'volume' && data.RW === true, data?.Name ?? 'volume absent');
const user = run(['exec', wbName, 'id', '-u']).trim();
check('Workbench runs as non-root', user !== '0' && /^\d+$/.test(user), 'uid=' + user);
if (failures) process.exitCode = 1;
else console.log('LayerFS runtime isolation: all 11 checks passed');
