#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const runner = fileURLToPath(new URL('./worktree-review-env.mjs', import.meta.url));
const tmp = fileURLToPath(new URL('../tmp/', import.meta.url));
mkdirSync(tmp, { recursive: true });
const root = mkdtempSync(join(realpathSync(tmp), 'worktree-review-env-test-'));
after(() => rmSync(root, { recursive: true }));
let seq = 0;
const node = process.execPath;
const modules = ['node_modules', 'server/node_modules', 'web/node_modules'];
const lock = 'lockfileVersion: 9.0\n';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(dir, file, content, opts) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, opts);
}

function fixture() {
  const parent = join(root, 'case-' + ++seq);
  const source = join(parent, 'donor'), target = join(parent, 'review');
  mkdirSync(source, { recursive: true });
  git(source, 'init', '-q');
  write(source, '.gitignore', 'node_modules/\ntmp/\n');
  write(source, 'pnpm-workspace.yaml', 'packages: [server, web]\n');
  write(source, 'pnpm-lock.yaml', lock);
  for (const project of ['.', 'server', 'web']) write(source, join(project, 'package.json'), JSON.stringify({ name: project === '.' ? 'app' : project }));
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'fixture');
  git(source, 'worktree', 'add', '--detach', '-q', target, 'HEAD');
  for (const dir of modules) mkdirSync(join(source, dir));
  const pkg = 'node_modules/.pnpm/example@1/node_modules/example';
  write(source, pkg + '/package.json', '{"name":"example","main":"index.js"}');
  write(source, pkg + '/index.js', 'module.exports = "installed";\n');
  write(source, 'node_modules/.pnpm/lock.yaml', lock);
  write(source, 'node_modules/.pnpm-task-run-state-v1/sentinel', 'donor-only');
  write(source, 'node_modules/.pnpm-workspace-state-v1.json', 'donor-only');
  write(source, 'web/node_modules/.cache/sentinel', 'donor-only');
  symlinkSync(join(source, pkg), join(source, 'web/node_modules/example'));
  mkdirSync(join(source, 'node_modules/.pnpm/node_modules'));
  symlinkSync('../../../server', join(source, 'node_modules/.pnpm/node_modules/server'));
  write(source, 'web/node_modules/.bin/example', '#!/bin/sh\nbasedir=$(dirname "$0")\n  export NODE_PATH="' + join(source, pkg) + '"\nprintf "%s" "$NODE_PATH"\n', { mode: 0o755 });
  return { source, target, pkg };
}

function run(target, command = [node, '-e', ''], env = process.env) {
  return spawnSync(node, [runner, target, '--', ...command], { encoding: 'utf8', env });
}

function clean(target) {
  for (const dir of [...modules, 'tmp']) assert.equal(existsSync(join(target, dir)), false, dir);
}

function rejects(target, message) {
  const r = run(target, [node, '-e', 'console.log("unexpected child")']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, message);
  assert.equal(r.stdout, '');
  clean(target);
}

test('same locks give real local roots, relocated links and bins, and independent writes', () => {
  const { source, target, pkg } = fixture();
  const r = run(target, [node, '-e', [
    'const fs=require("node:fs"), a=require("node:assert/strict"), p=require("node:path");',
    'const {execFileSync}=require("node:child_process");',
    'const [target,pkg]=process.argv.slice(1);',
    'for (const dir of ["node_modules","server/node_modules","web/node_modules"]) a.ok(fs.lstatSync(dir).isDirectory());',
    'a.equal(process.env.npm_config_verify_deps_before_run,"false");',
    'a.equal(process.env.NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN,undefined);',
    'a.equal(process.env.NODE_PATH,undefined);',
    'for (const k of ["cache_dir","state_dir","store_dir"]) a.ok(process.env["npm_config_"+k].startsWith(p.join(target,"tmp")+p.sep));',
    'a.ok(!fs.existsSync("node_modules/.pnpm-task-run-state-v1"));',
    'a.ok(!fs.existsSync("node_modules/.pnpm-workspace-state-v1.json"));',
    'a.ok(!fs.existsSync("web/node_modules/.cache"));',
    'a.equal(fs.realpathSync("node_modules/.pnpm/node_modules/server"),p.join(target,"server"));',
    'a.equal(fs.realpathSync("web/node_modules/example"),p.join(target,pkg));',
    'a.equal(p.resolve(execFileSync("web/node_modules/.bin/example",{encoding:"utf8"})),p.join(target,pkg));',
    'a.equal(require("./web/node_modules/example"),"installed");',
    'fs.writeFileSync("web/node_modules/example/index.js","only target");',
    'fs.mkdirSync("node_modules/.pnpm-task-run-state-v1");',
    'fs.writeFileSync("node_modules/.pnpm-task-run-state-v1/sentinel","new child state");',
  ].join('\n'), target, pkg], { ...process.env, NODE_PATH: source, NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(source, pkg, 'index.js'), 'utf8'), 'module.exports = "installed";\n');
  assert.equal(readFileSync(join(source, 'node_modules/.pnpm-task-run-state-v1/sentinel'), 'utf8'), 'donor-only');
  assert.equal(readlinkSync(join(source, 'web/node_modules/example')), join(source, pkg));
  clean(target);
});

test('rejects changed worktree lock and stale installed virtual-store lock separately', () => {
  const { source, target } = fixture();
  write(target, 'pnpm-lock.yaml', lock + '# target\n');
  rejects(target, /declaration differs: pnpm-lock.yaml/);
  write(target, 'pnpm-lock.yaml', lock);
  write(source, 'node_modules/.pnpm/lock.yaml', lock + '# installed\n');
  rejects(target, /Installed virtual store lock differs/);
});

test('rejects drift in a workspace package declaration', () => {
  const { target } = fixture();
  write(target, 'server/package.json', '{"name":"changed"}');
  rejects(target, /Dependency declaration differs: server\/package.json/);
});

test('rejects links outside installed packages and cleans a partial setup', () => {
  const { source, target } = fixture();
  symlinkSync(join(source, '.gitignore'), join(source, 'web/node_modules/unexpected'));
  rejects(target, /Dependency symlink leaves installed modules/);
  assert.equal(readFileSync(join(source, '.gitignore'), 'utf8'), 'node_modules/\ntmp/\n');
});

test('rejects a shim still pointing at the donor', () => {
  const { source, target } = fixture();
  write(source, 'web/node_modules/.bin/example', '#!/bin/sh\nexec "' + join(source, 'web/node_modules/example/index.js') + '" "$@"\n', { mode: 0o755 });
  rejects(target, /Dependency shim embeds the main checkout path/);
});

test('preserves unrelated files in an existing worktree tmp directory', () => {
  const { target } = fixture();
  write(target, 'tmp/unrelated', 'keep');
  assert.equal(run(target).status, 0);
  assert.equal(readFileSync(join(target, 'tmp/unrelated'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(join(target, 'tmp')), ['unrelated']);
  for (const dir of modules) assert.equal(existsSync(join(target, dir)), false);
});

test('preserves an existing dependency root and rejects the main checkout', () => {
  const { source, target } = fixture();
  symlinkSync(join(source, 'web/node_modules'), join(target, 'web/node_modules'));
  const r = run(target);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.equal(readlinkSync(join(target, 'web/node_modules')), join(source, 'web/node_modules'));
  assert.equal(existsSync(join(target, 'node_modules')), false);
  assert.match(run(source).stderr, /linked worktree/);
});

test('cleans its dependency roots after a failing check or missing executable', () => {
  const { target } = fixture();
  assert.equal(run(target, [node, '-e', 'process.exit(23)']).status, 23);
  clean(target);
  assert.match(run(target, [join(target, 'no-such-check')]).stderr, /ENOENT/);
  clean(target);
});

test('forwards cancellation to the running check before cleanup', async () => {
  const { target } = fixture();
  const child = spawn(node, [runner, target, '--', node, '-e', 'console.log("check-ready"); setInterval(()=>{},500)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let killed = false;
  child.stdout.on('data', data => {
    output += data;
    if (!killed && output.includes('check-ready')) { killed = true; child.kill('SIGTERM'); }
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 5000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(killed, true, errors);
    assert.equal(status, 143, errors);
    clean(target);
  } finally { clearTimeout(timeout); }
});
