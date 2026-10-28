#!/usr/bin/env node
import assert from 'node:assert/strict';
import { prerequisiteState, assessEvidence } from './security-env-face.mjs';

let count = 0;
const test = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
for (const platform of ['win32', 'linux']) {
  test(platform + ': documentation cannot produce PASS', () => assert.equal(prerequisiteState({ documented: true, dockerReady: true, platform }).status, 'NEEDS-MATERIAL'));
  test(platform + ': missing Docker needs material', () => assert.equal(prerequisiteState({ documented: false, dockerReady: false, platform }).status, 'NEEDS-MATERIAL'));
}
test('Linux with Docker is named SKIP', () => assert.match(prerequisiteState({ documented: false, dockerReady: true, platform: 'linux' }).reason, /S2-WINDOWS/));
test('Windows with Docker is eligible, not automatically PASS', () => assert.equal(prerequisiteState({ documented: false, dockerReady: true, platform: 'win32' }), null));
const setup = { exitCode: 0, error: null };
const info = { Id: 'owned-probe-id', State: { Running: true } };
const execTrue = { exitCode: 0, error: null };
const a = { requestedSource: 'C:/wm-x-bad/var/run/docker.sock', setup, info, execTrue, exitCode: 42, error: null, inspectExit: 0, mounts: [{ Type: 'bind', Source: 'C:/wm-x-bad/var/run/docker.sock', Destination: '/probe.sock' }], socketTestExit: 1, apiStatus: null, stderr: '', stdout: '' };
const b = { setup, info, execTrue, requestedSource: '/var/run/docker.sock', exitCode: 0, error: null, inspectExit: 0, mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/probe.sock' }], socketTestExit: 0, apiStatus: 200, apiBody: 'OK', stdout: '{}' };
const judge = (aa = a, bb = b, cleanupOK = true) => assessEvidence({ a: aa, b: bb, cleanupOK }).status;
test('known bad source refuses and complete B evidence passes', () => assert.equal(judge(), 'PASS'));
for (const [name, patch] of [
  ['nonzero B exit despite MOUNTED', { exitCode: 1, stdout: 'MOUNTED' }],
  ['B timeout despite success text', { exitCode: null, error: 'timeout', stdout: 'MOUNTED' }],
  ['wrong inspected mount source', { mounts: [{ Type: 'bind', Source: 'C:/wrong', Destination: '/probe.sock' }] }],
  ['missing inspect evidence', { inspectExit: 1, mounts: [] }],
  ['socket test failure', { socketTestExit: 1 }],
  ['Docker API not 200', { apiStatus: 500 }],
  ['Docker API body not OK', { apiBody: 'MOUNTED' }],
  ['missing Docker API body', { apiBody: undefined }],
]) test(name, () => assert.equal(judge(a, { ...b, ...patch }), 'FAIL'));
test('A failed setup is not successful negative control', () => assert.equal(judge({ ...a, setup: { exitCode: 125 }, inspectExit: 1, info: null, exitCode: 125 }), 'FAIL'));
test('A container not running is not proof', () => assert.equal(judge({ ...a, info: { ...info, State: { Running: false } } }), 'FAIL'));
test('A wrong inspected mount source is not proof', () => assert.equal(judge({ ...a, mounts: [{ Type: 'bind', Source: '/unrelated', Destination: '/probe.sock' }] }), 'FAIL'));
test('B failed setup is not proof', () => assert.equal(judge(a, { ...b, setup: { exitCode: 1 } }), 'FAIL'));
test('A docker exec transport failure is not ABSENT', () => assert.equal(judge({ ...a, execTrue: { exitCode: 126 } }), 'FAIL'));
test('A checker error 43 is not ABSENT 42', () => assert.equal(judge({ ...a, exitCode: 43 }), 'FAIL'));
test('B wrong mount destination is not proof', () => assert.equal(judge(a, { ...b, mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/wrong' }] }), 'FAIL'));
test('B wrong mount type is not proof', () => assert.equal(judge(a, { ...b, mounts: [{ Type: 'volume', Source: '/var/run/docker.sock', Destination: '/probe.sock' }] }), 'FAIL'));
test('stdout noise is not A/B proof', () => assert.equal(judge({ ...a, exitCode: 0, stderr: 'random noise' }), 'FAIL'));
test('failed cleanup cannot report PASS', () => assert.equal(judge(a, b, false), 'FAIL'));
console.log('Offline verdict tests: ' + count + '/' + count);
