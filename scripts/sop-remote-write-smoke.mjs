#!/usr/bin/env node
/** SOP 远程写面冒烟：只使用本地隔离实例及合成 SOP，经开建接口取得 run 专用上传令牌。 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { instanceStartError, startWithEnvironmentRetry } from './lib/self-probe-env.mjs';

if (process.argv.length !== 2) throw new Error('本脚本使用自建合成 SOP，请直接运行，不传源库或地址');

const ROOT = join(import.meta.dirname, '..');
const SLUG = 'remote-write-fixture';
// 和写守卫冒烟一样，用回环上的反代请求形状走远程分支。
const REMOTE = { 'x-forwarded-for': '192.0.2.91' };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const tmp = join(ROOT, 'tmp');
mkdirSync(tmp, { recursive: true });
const fixture = mkdtempSync(join(tmp, 'sop-remote-write-'));

async function freePort() {
  const probe = createServer();
  const listening = once(probe, 'listening');
  probe.listen(0, '127.0.0.1');
  await listening;
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

// 业务面默认监听所有网卡。把本次实例绑在回环，路由与授权保持原入口。
const loopbackOnly = "import net from 'node:net'; const listen = net.Server.prototype.listen; net.Server.prototype.listen = function (...args) { if (args[0] === Number(process.env.PORT) && typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1'); return listen.apply(this, args); };";

async function start(attempt) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const data = join(fixture, String(attempt));
  mkdirSync(data, { recursive: true });
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: data, USERPROFILE: data,
    DATA_DIR: data, NODE_ENV: 'test', PORT: String(port), WM_CONTROL_PORT: '0',
    ADMIN_TOKEN: 'synthetic-sop-remote-write-admin', MCP_GATEWAY: 'off', WM_LOGIN_GATE: 'off',
    WM_OUTBOUND: 'off', WM_SOP_RUN_WRITE: 'enforce', REDIS_URL: '',
  };
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(loopbackOnly), 'server/src/index.ts'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '', startError;
  child.on('error', error => { startError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
  try {
    const deadline = Date.now() + 40000;
    while (!startError && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      const ready = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (ready?.ok) return { child, data, base };
      await sleep(200);
    }
    throw startError ?? instanceStartError('SOP 冒烟隔离实例未就绪', log);
  } catch (error) {
    await stop(child);
    throw error;
  }
}

function seedSop(data) {
  const dir = join(data, 'apps', SLUG, 'v1');
  mkdirSync(dir, { recursive: true });
  const manifest = 'title: 合成 SOP\nsteps:\n  - key: step_a\n    title: 合成步骤\n';
  writeFileSync(join(dir, 'sop.yaml'), manifest);
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
  try {
    const app = db.prepare("INSERT INTO apps (slug, title, kind, status, active_version) VALUES (?, '合成 SOP', 'sop', 'published', 1)").run(SLUG);
    db.prepare('INSERT INTO app_versions (app_id, version, file_count, total_bytes) VALUES (?, 1, 1, ?)').run(app.lastInsertRowid, Buffer.byteLength(manifest));
  } finally { db.close(); }
}

let child;
let pass = 0;
const check = (label, result) => {
  assert.ok(result, label);
  console.log('  ✓ ' + label);
  pass++;
};
try {
  const instance = await startWithEnvironmentRetry(start, { label: 'SOP 远程写冒烟' });
  ({ child } = instance);
  seedSop(instance.data);
  const request = async (method, path, headers, body) => {
    const response = await fetch(instance.base + path, {
      method, headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const startRun = (headers, startedBy) => request('POST', '/api/sop/runs', headers, { slug: SLUG, started_by: startedBy });
  const local = await startRun({}, 'fixture-local');
  check('本机建单返回 201 和 run ID', local.status === 201 && Number.isInteger(local.body.id));
  const created = await startRun(REMOTE, 'fixture-remote');
  check('远程建单返回 201、run ID 和上传令牌', created.status === 201 && Number.isInteger(created.body.id)
    && typeof created.body.upload_token === 'string' && created.body.upload_token.length > 0);
  const path = '/api/sop/runs/' + created.body.id;
  const upload = { ...REMOTE, 'x-run-upload-token': created.body.upload_token };
  const read = { ...REMOTE, 'x-run-read-capability': created.body.read_capability };
  const value = { note: 'fixture-write' };
  const save = headers => request('PUT', path, headers, { stepKey: 'step_a', value });
  const finish = headers => request('POST', path + '/finish', headers, {});

  const deniedSave = await save(REMOTE);
  check('无上传票据远程保存返回 403 / run_write_denied', deniedSave.status === 403 && deniedSave.body.error === 'run_write_denied');
  const deniedFinish = await finish(REMOTE);
  check('无上传票据远程完成返回 403 / run_write_denied', deniedFinish.status === 403 && deniedFinish.body.error === 'run_write_denied');
  const untouched = await request('GET', path, read);
  check('拒绝后仍在执行且没有保存步骤', untouched.status === 200 && untouched.body.status === 'running'
    && untouched.body.data && Object.keys(untouched.body.data).length === 0);

  for (const [label, endpoint, body] of [
    ['publish', '/api/sops/' + SLUG + '/publish', {}],
    ['assign', path + '/assign', { node: 'dsh/00000000' }],
  ]) {
    const anonymous = await request('POST', endpoint, REMOTE, body);
    const withToken = await request('POST', endpoint, upload, body);
    check('远程控制面 ' + label + ' 在无票据及持上传票据时均返回 403', anonymous.status === 403 && withToken.status === 403);
  }
  const saved = await save(upload);
  check('开建接口签发的上传票据允许保存', saved.status === 200 && saved.body.ok === true);
  const finished = await finish(upload);
  check('开建接口签发的上传票据允许完成', finished.status === 200 && finished.body.status === 'finished');
  const persisted = await request('GET', path, read);
  check('读回已完成状态和保存的合成步骤内容', persisted.status === 200 && persisted.body.status === 'finished'
    && persisted.body.data?.step_a?.note === value.note);
} finally {
  try { if (child) await stop(child); } finally { rmSync(fixture, { recursive: true, force: true }); }
}
console.log('sop-remote-write-smoke: ' + pass + ' 通过 / 0 失败');
