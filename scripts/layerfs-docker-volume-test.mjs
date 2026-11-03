// Isolated Docker Engine volume lifecycle contract tests; no real socket or daemon calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = readFileSync('deploy/layerfs-svc.mjs', 'utf8');
const start = src.indexOf("const volName = (project)");
const end = src.indexOf("// 侧车（契约形读面·同卷持久）", start);
assert.ok(start >= 0 && end > start, 'volume lifecycle functions found');
const calls = [];
const replies = [];
const ctx = vm.createContext({
  dockerCall: async (...args) => { calls.push(args); return replies.shift(); },
});
vm.runInContext(src.slice(start, end) + '\nthis.testApi={volName,ensureVolume,dropVolume};', ctx);
const api = ctx.testApi;
assert.equal(api.volName('canary'), 'wm-canary-store');

replies.push({ status: 201, body: {} });
assert.equal(await api.ensureVolume('canary'), true);
assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['POST', '/v1.41/volumes/create', {
  Name: 'wm-canary-store', Labels: { 'layerfs.role': 'store', 'layerfs.project': 'canary' },
}]));
console.log('PASS volume create uses deterministic name and ownership labels');

for (const status of [0, 403, 500]) {
  replies.push({ status, body: null });
  await assert.rejects(api.ensureVolume('canary'), new RegExp('Docker volume create failed'));
}
console.log('PASS volume create fails closed on socket, permission, and daemon errors');

replies.push({ status: 204 });
assert.equal(await api.dropVolume('canary'), true);
assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['DELETE', '/v1.41/volumes/wm-canary-store']));
replies.push({ status: 404 });
assert.equal(await api.dropVolume('canary'), true);
for (const status of [0, 403, 409, 500]) {
  replies.push({ status });
  assert.equal(await api.dropVolume('canary'), false, 'status ' + status);
}
console.log('PASS deletion recognizes absent volume but never masks other API failures');

const dirStart = src.indexOf('function parentDirs(files)');
const dirEnd = src.indexOf('function nativeRef(project, branch)', dirStart);
assert.ok(dirStart >= 0 && dirEnd > dirStart, 'native parent directory helper found');
const dirCtx = vm.createContext({});
vm.runInContext(src.slice(dirStart, dirEnd) + '\nthis.testApi={parentDirs};', dirCtx);
const dirs = Array.from(dirCtx.testApi.parentDirs([{path:'assets/css/app.css'}, {path:'index.html'}, {path:'assets/img/logo.svg'}]));
assert.deepEqual(dirs, ['assets', 'assets/css', 'assets/img']);
console.log('PASS nested publish scaffolds unique parent directories in topological order');
