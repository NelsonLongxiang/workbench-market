// F5 environment proof: deterministic corrupt source A, lossless argv B. No MSYS auto-conversion claim.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

export function prerequisiteState({ documented, dockerReady, platform }) {
  if (documented) return { status: 'NEEDS-MATERIAL', reason: 'F5_ENV_FACE_DOC defers live evidence; never PASS' };
  if (!dockerReady) return { status: 'NEEDS-MATERIAL', reason: 'Docker CLI/daemon unavailable' };
  if (platform !== 'win32') return { status: 'SKIP', reason: 'S2-WINDOWS-PATH-SHAPE: non-Windows platform' };
  return null;
}

function mountedSource(probe) {
  return probe.mounts?.find((m) => m.Destination === '/probe.sock');
}
function setupOK(probe) { return probe.setup?.exitCode === 0 && !probe.setup.error && probe.execTrue?.exitCode === 0 && !probe.execTrue.error && probe.inspectExit === 0 && probe.info?.State?.Running === true && !!probe.info.Id; }
function liveOK(probe, source) {
  const mount = mountedSource(probe);
  return setupOK(probe) && probe.exitCode === 0 && !probe.error && probe.inspectExit === 0 &&
    mount?.Type === 'bind' && mount.Source === source && probe.requestedSource === source &&
    probe.socketTestExit === 0 && probe.apiStatus === 200 && typeof probe.apiBody === 'string' && probe.apiBody.trim() === 'OK';
}
export function assessEvidence({ a, b, cleanupOK }) {
  const expected = '/var/run/docker.sock';
  const aMount = mountedSource(a);
  const badPathRefused = setupOK(a) && a.requestedSource !== expected && !a.error &&
    aMount?.Type === 'bind' && aMount.Source === a.requestedSource &&
    a.socketTestExit === 1 && a.exitCode === 42 && a.apiStatus !== 200;
  const goodPathAccepted = liveOK(b, expected);
  return {
    status: badPathRefused && goodPathAccepted && cleanupOK ? 'PASS' : 'FAIL',
    reason: JSON.stringify({ knownBadSourceRefused: badPathRefused, correctSourceAccepted: goodPathAccepted, ownedContainersRemoved: cleanupOK }),
  };
}

const inside = [
  "const {spawnSync}=require('node:child_process');",
  "const socket=spawnSync('sh',['-c','test -S /probe.sock']);",
  "if(socket.status!==0){console.log(JSON.stringify({socketTestExit:socket.status,apiStatus:null,apiBody:'',checkerError:socket.error?.message}));process.exit(socket.status===1&&!socket.error?42:43)}",
  "const req=require('node:http').request({socketPath:'/probe.sock',path:'/_ping',method:'GET'},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{console.log(JSON.stringify({socketTestExit:socket.status,apiStatus:res.statusCode,apiBody:body}));process.exitCode=res.statusCode===200&&body.trim()==='OK'?0:3})});",
  "req.on('error',e=>{console.log(JSON.stringify({socketTestExit:socket.status,apiStatus:null,apiBody:'',error:e.message}));process.exitCode=3});req.setTimeout(5000,()=>req.destroy(new Error('Docker API timeout')));req.end();",
].join('');

function docker(args) {
  // Direct argv bypasses MSYS; correctness does not depend on an environment toggle.
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  return { command: ['docker', ...args], exitCode: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
}
function probe(name, source, image, runID) {
  const setup = docker(['run', '-d', '--pull=never', '--name', name, '--label', 'wm.f5-run=' + runID,
    '--mount', 'type=bind,src=' + source + ',dst=/probe.sock,readonly', image, 'node', '-e', 'setInterval(()=>{},1000)']);
  const inspect = docker(['inspect', name]);
  let info = null, report = {};
  try { info = JSON.parse(inspect.stdout)[0]; } catch { /* retained raw inspect output below */ }
  const assertions = [];
  let execTrue = { exitCode: null, error: 'setup not verified' };
  let run = { exitCode: null, error: 'setup did not pass', stdout: '', stderr: '' };
  try {
    assert.equal(setup.exitCode, 0, 'docker setup exit');
    assert.equal(inspect.exitCode, 0, 'inspect exit');
    assert.equal(info?.State?.Running, true, 'created container must be running');
    const mount = info.Mounts.find(m => m.Destination === '/probe.sock');
    assert.equal(mount?.Type, 'bind', 'inspect mount type');
    assert.equal(mount?.Source, source, 'inspect actual Source must equal requested Source');
    assert.equal(mount?.Destination, '/probe.sock', 'inspect mount destination');
    execTrue = docker(['exec', info.Id, 'true']);
    assert.equal(execTrue.exitCode, 0, 'docker exec true must succeed before socket checker');
    assert.equal(execTrue.error, null, 'docker exec transport error');
    run = docker(['exec', info.Id, 'node', '-e', inside]);
  } catch (e) { assertions.push(e.message); }
  try { report = JSON.parse(run.stdout.trim()); } catch { /* malformed evidence cannot pass */ }
  return { ...run, setup, execTrue, assertions, socketTestExit: report.socketTestExit, apiStatus: report.apiStatus, apiBody: report.apiBody, requestedSource: source, inspectExit: inspect.exitCode, mounts: info?.Mounts ?? [], inspect, info };
}
function cleanup(probes, runID) {
  let ok = true;
  for (const p of probes) {
    if (!p.info) continue; // docker run rejected before creating a container
    const id = p.info.Id;
    if (!id || p.info.Config?.Labels?.['wm.f5-run'] !== runID) { ok = false; continue; }
    const removed = docker(['rm', '-f', id]); // exact ID verified against this run's ownership label
    p.cleanup = removed;
    if (removed.exitCode !== 0) ok = false;
  }
  return ok;
}
export function runEnvFace() {
  const version = docker(['version', '--format', '{{json .Server.Version}}']);
  const prerequisite = prerequisiteState({ documented: process.env.F5_ENV_FACE_DOC === '1', dockerReady: version.exitCode === 0 && !version.error, platform: process.platform });
  const id = Date.now().toString(36) + '-' + process.pid;
  const evidence = resolve('tmp', 'f5-env-face-' + id + '.json');
  mkdirSync(join(evidence, '..'), { recursive: true });
  let result;
  if (prerequisite) result = { ...prerequisite, version };
  else {
    const image = process.env.F5_ENV_FACE_IMAGE || 'node:22-bookworm-slim';
    const imageCheck = docker(['image', 'inspect', image]);
    if (imageCheck.exitCode !== 0) result = { status: 'NEEDS-MATERIAL', reason: 'Local probe image missing (no automatic pull): ' + image, version, imageCheck };
    else {
      // Explicit synthetic corruption, not noise or a claim that Node invoked MSYS conversion.
      const badSource = resolve('tmp', 'wm-x-msys-bad-' + id, 'var/run/docker.sock').replaceAll(String.fromCharCode(92), '/');
      mkdirSync(badSource, { recursive: true }); // existing wrong directory: A setup succeeds, test -S must then fail
      const a = probe('wm-x-f5-a-' + id, badSource, image, id);
      const b = probe('wm-x-f5-b-' + id, '/var/run/docker.sock', image, id);
      const cleanupOK = cleanup([a, b], id);
      result = { ...assessEvidence({ a, b, cleanupOK }), version, a, b, cleanupOK };
    }
  }
  writeFileSync(evidence, JSON.stringify(result, null, 2));
  return { status: result.status, reason: result.reason, evidence };
}
