#!/usr/bin/env node
/** Use an existing same-lock pnpm install for a trusted, foreground check in a linked worktree. */
import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants as osConstants } from 'node:os';
import { copyFile, rm } from 'node:fs/promises';
import { setImmediate as yieldToSignals } from 'node:timers/promises';

// This repository's pnpm workspace layout. Reject changed workspace declarations instead of guessing.
const projects = ['.', 'server', 'web'];
const declarations = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs',
  ...projects.map(project => join(project, 'package.json'))];
const usage = 'Usage: node scripts/worktree-review-env.mjs <worktree> -- <check-command> [args...]';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function inside(path, root) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

function stat(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function directory(path) {
  if (!stat(path)?.isDirectory() || realpathSync(path) !== path) throw Error('Expected a real directory: ' + path);
}

function readRegular(path, optional = false) {
  const s = stat(path);
  if (optional && !s) return null;
  if (!s?.isFile() || realpathSync(path) !== path) throw Error('Expected a regular file: ' + path);
  return readFileSync(path);
}

function sameFile(source, target, name, optional = false) {
  const left = readRegular(join(source, name), optional);
  const right = readRegular(join(target, name), optional);
  if (left === null ? right !== null : right === null || !left.equals(right)) throw Error('Dependency declaration differs: ' + name);
}

function rootsFor(targetPath) {
  const target = realpathSync(targetPath);
  const root = realpathSync(git(target, 'rev-parse', '--show-toplevel').trimEnd());
  if (target !== root) throw Error('Use the root of a linked worktree');
  const entries = git(target, 'worktree', 'list', '--porcelain', '-z').split('\0');
  const worktrees = entries.filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  if (!worktrees.length || !worktrees.includes(target)) throw Error('Use a registered linked worktree');
  const source = realpathSync(worktrees[0]);
  if (source === target || !stat(join(target, '.git'))?.isFile()) throw Error('Use a linked worktree, separate from the main checkout');
  return { source, target };
}

function plan(targetPath) {
  const { source, target } = rootsFor(targetPath);
  for (const project of projects) {
    directory(resolve(source, project));
    directory(resolve(target, project));
  }
  for (const name of declarations) sameFile(source, target, name, name === '.npmrc' || name.startsWith('.pnpmfile.'));
  const sourceModules = projects.map(project => join(source, project, 'node_modules'));
  const modules = projects.map(project => join(target, project, 'node_modules'));
  for (const root of sourceModules) directory(root);
  const virtualStore = join(sourceModules[0], '.pnpm');
  directory(virtualStore);
  const lock = readRegular(join(source, 'pnpm-lock.yaml'));
  if (!lock.equals(readRegular(join(virtualStore, 'lock.yaml')))) throw Error('Installed virtual store lock differs: node_modules/.pnpm/lock.yaml');
  for (const root of modules) {
    if (stat(root)) throw Error('Worktree dependency path already exists: ' + root);
    // The tool owns only ignored directories it creates.
    git(target, 'check-ignore', '-q', root + sep);
  }
  const tmp = join(target, 'tmp');
  if (stat(tmp)) directory(tmp);
  git(target, 'check-ignore', '-q', join(tmp, 'worktree-review-env-probe'));
  return { source, target, sourceModules, modules, tmp };
}

async function materialize({ source, target, sourceModules, modules }, cancellation) {
  const links = [];
  const mapped = (path) => join(target, relative(source, path));
  const workspaceProjects = new Set(projects.slice(1).map(project => join(source, project)));
  const localProjects = new Set([...workspaceProjects].map(mapped));
  const allowedSource = path => workspaceProjects.has(path) || sourceModules.some(root => inside(path, root));
  for (const root of sourceModules) {
    for (const name of readdirSync(root)) {
      // Top-level hidden files are installation metadata or caches. Only bins and the virtual store are needed.
      if (name.startsWith('.') && name !== '.bin' && !(name === '.pnpm' && root === sourceModules[0])) continue;
      await copy(join(root, name));
    }
  }
  for (const link of links) {
    const actual = realpathSync(link);
    if (!localProjects.has(actual) && !modules.some(root => inside(actual, root))) throw Error('Generated dependency link leaves the worktree: ' + link);
  }

  async function copy(src) {
    await yieldToSignals();
    cancellation.check();
    const dst = mapped(src);
    const s = lstatSync(src);
    if (s.isSymbolicLink()) {
      const destination = resolve(dirname(src), readlinkSync(src));
      if (!allowedSource(destination) || !allowedSource(realpathSync(src))) throw Error('Dependency symlink leaves installed modules: ' + src);
      symlinkSync(relative(dirname(dst), mapped(destination)), dst);
      links.push(dst);
    } else if (s.isDirectory()) {
      mkdirSync(dst);
      for (const entry of readdirSync(src)) await copy(join(src, entry));
    } else if (s.isFile()) {
      if (basename(dirname(src)) === '.bin') copyShim(src, dst, s.mode);
      else await copyFile(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    } else {
      throw Error('Unsupported dependency entry: ' + src);
    }
  }

  function copyShim(src, dst, mode) {
    const text = readFileSync(src, 'utf8');
    // pnpm's POSIX shims use a double-quoted NODE_PATH and a $basedir-relative executable.
    // Rebase only those generated module paths; reject shims that still embed the donor path.
    const rebased = text.replace(/^(\s*export NODE_PATH=")([^"\r\n]*)(")$/gm, (_, start, value, end) =>
      start + value.split(':').map(part => {
        if (!isAbsolute(part)) return part;
        if (!sourceModules.some(root => inside(part, root))) throw Error('Unexpected absolute NODE_PATH in shim: ' + src);
        return '$basedir/' + relative(dirname(dst), mapped(part)).replace(/["$\x60\\]/g, '\\$&');
      }).join(':') + end);
    if (rebased.includes(source)) throw Error('Dependency shim embeds the main checkout path: ' + src);
    writeFileSync(dst, rebased, { mode, flag: 'wx' });
  }
}

function checkEnvironment(state) {
  const settings = {
    verify_deps_before_run: 'false',
    manage_package_manager_versions: 'false',
    modules_dir: 'node_modules',
    virtual_store_dir: 'node_modules/.pnpm',
    store_dir: join(state, 'store'),
    cache_dir: join(state, 'cache'),
    state_dir: join(state, 'state'),
  };
  const overrides = Object.fromEntries(Object.entries(settings).map(([name, value]) => ['npm_config_' + name, value]));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== 'node_path' && !Object.hasOwn(overrides, lower);
  }));
  return { ...env, ...overrides, COREPACK_ENABLE_NETWORK: '0' };
}

function findExecutable(executable, cwd, pathEnv) {
  const candidates = executable.includes(sep)
    ? [resolve(cwd, executable)]
    : (pathEnv ?? '').split(':').map(dir => resolve(cwd, dir, executable));
  return candidates.find(path => {
    try {
      accessSync(path, constants.X_OK);
      return stat(realpathSync(path))?.isFile();
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
      return false;
    }
  });
}

const pnpmEntry = (path) => /^pnpm(?:\.[cm]?js)?$/.test(basename(path));

function prepareCommand(command, cwd, state, env) {
  const name = basename(command[0]);
  if (name === 'npm' || name === 'npx' || name === 'corepack') {
    throw Error('Use the installed pnpm executable directly, without a package-manager wrapper');
  }
  const executable = findExecutable(command[0], cwd, env.PATH);
  // A bin link and the underlying entry (e.g. pnpm.mjs) must take the same path through the guard.
  const directPnpm = pnpmEntry(command[0]) || (executable && pnpmEntry(realpathSync(executable)));
  const pnpm = directPnpm ? executable : findExecutable('pnpm', cwd, env.PATH);
  if (!pnpm && !directPnpm) return command;
  if (!pnpm) throw Error('An already installed pnpm executable is required');
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  // pnpm 11 does not read verifyDepsBeforeRun from the npm_config environment.
  // Apply and verify the same explicit settings for the outer call and nested pnpm scripts.
  const cli = quote(pnpm) + ' --config.verifyDepsBeforeRun=false --config.managePackageManagerVersions=false --config.offline=true';
  const bin = join(state, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'pnpm');
  writeFileSync(shim, [
    '#!/bin/sh',
    'set -eu',
    'for arg do',
    '  case "$arg" in install|i|add|update|up|remove|uninstall|fetch|dlx|import|rebuild|--config.*)',
    '    echo "worktree-review-env: pnpm install or configuration override is outside this check" >&2; exit 1;;',
    '  esac',
    'done',
    'if [ "$('+cli+' config get verifyDepsBeforeRun)" != false ]; then',
    '  echo "worktree-review-env: pnpm did not adopt verifyDepsBeforeRun=false" >&2; exit 1',
    'fi',
    'exec '+cli+' "$@"',
    '',
  ].join('\n'), { mode: 0o755, flag: 'wx' });
  env.PATH = env.PATH ? bin + ':' + env.PATH : bin;
  return directPnpm ? [shim, ...command.slice(1)] : command;
}

class Cancelled extends Error {}

function watchCancellation() {
  let interrupted, child, timer;
  function signalGroup(signal) {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  }
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    if (interrupted) return;
    interrupted = signal;
    if (!child) return;
    signalGroup(signal);
    timer = setTimeout(() => signalGroup('SIGKILL'), 5000);
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return {
    check() { if (interrupted) throw new Cancelled(); },
    get exitCode() { return interrupted ? 128 + osConstants.signals[interrupted] : null; },
    setChild(value) { child = value; },
    finishChild() {
      if (interrupted) signalGroup('SIGKILL');
      clearTimeout(timer);
      child = undefined;
    },
    close() { for (const [signal, handler] of handlers) process.off(signal, handler); },
  };
}

async function runCheck(command, cwd, env, cancellation) {
  cancellation.check();
  const child = spawn(command[0], command.slice(1), { cwd, env, stdio: 'inherit', detached: true });
  cancellation.setChild(child);
  try {
    const { code, signal } = await new Promise((res, rej) => {
      child.once('error', rej);
      child.once('close', (code, signal) => res({ code, signal }));
    });
    return signal ? 128 + osConstants.signals[signal] : code;
  } finally {
    cancellation.finishChild();
  }
}

async function main(args) {
  if (args.length < 3 || args[1] !== '--') throw Error(usage);
  if (process.platform === 'win32') throw Error('This check entry supports POSIX pnpm layouts');
  const layout = plan(args[0]);
  const created = [];
  let madeTmp = false;
  let status;
  const cancellation = watchCancellation();
  try {
    try {
      for (const root of layout.modules) {
        await yieldToSignals();
        cancellation.check();
        mkdirSync(root);
        created.push({ path: root, stat: lstatSync(root) });
      }
      if (!stat(layout.tmp)) {
        mkdirSync(layout.tmp);
        madeTmp = true;
      }
      const state = mkdtempSync(join(layout.tmp, 'worktree-review-env-'));
      created.push({ path: state, stat: lstatSync(state) });
      await materialize(layout, cancellation);
      const env = checkEnvironment(state);
      const command = prepareCommand(args.slice(2), layout.target, state, env);
      await yieldToSignals();
      status = await runCheck(command, layout.target, env, cancellation);
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    } finally {
      const failed = [];
      for (const owned of created.reverse()) {
        try {
          directory(dirname(owned.path));
          const current = stat(owned.path);
          if (!current) continue;
          if (current.dev !== owned.stat.dev || current.ino !== owned.stat.ino || !current.isDirectory()) {
            throw Error('Directory was replaced during the check: ' + owned.path);
          }
          await rm(owned.path, { recursive: true });
        } catch (error) { failed.push(error.message); }
      }
      if (madeTmp && !failed.length) {
        try { rmdirSync(layout.tmp); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) failed.push(error.message); }
      }
      if (failed.length) throw Error('Cleanup incomplete: ' + failed.join(', '));
      await yieldToSignals();
    }
    return cancellation.exitCode ?? status;
  } finally {
    cancellation.close();
  }
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error('worktree-review-env: ' + error.message); process.exitCode = 1; }
