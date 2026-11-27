/** Test-only ownership: POSIX process groups, Windows live roots reaped by taskkill /T /F. */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const WIN = process.platform === 'win32';
const preload = fileURLToPath(new URL('./test-process-preload.mjs', import.meta.url));
const trees = new Set();
const taskkill = () => join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
export const testProcessOptions = (platform = process.platform) => ({ detached: platform !== 'win32', windowsHide: true });
export function killTestTreeSync(child) {
  if (!child?.pid || !trees.has(child)) return;
  if (WIN) {
    const r = spawnSync(taskkill(), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
    if (r.status !== 0 && child.exitCode === null && child.signalCode === null) throw Error('test process tree termination failed');
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
}
export function spawnTestTree(executable, args, options = {}) {
  if (!WIN) return spawn(executable, args, { ...options, detached: true });
  const isNode = executable === process.execPath;
  const stdio = [...(options.stdio || ['ignore', 'pipe', 'pipe'])];
  if (!stdio.includes('ipc')) stdio.push('ipc');
  // A Node suite retains its original CLI/flags. Non-Node commands get a holding parent.
  const command = isNode ? ['--import', pathToFileURL(preload).href, ...args] : [fileURLToPath(new URL('./test-process-wrapper.mjs', import.meta.url)), executable, ...args];
  const child = spawn(process.execPath, command, { ...options, stdio, ...testProcessOptions() });
  trees.add(child);
  child.once('close', () => trees.delete(child));
  child.on('message', message => {
    if (message?.kind !== 'market-test-tree-finished') return;
    child.testResult = { code: message.code, signal: message.signal || undefined };
    try { killTestTreeSync(child); } catch (error) { child.testTreeError = error; }
  });
  return child;
}
export function testTreeResult(child, code, signal) {
  if (child.testTreeError) return { code: -1, signal: undefined, error: child.testTreeError.message };
  return child.testResult || { code, signal };
}
process.once('exit', () => { for (const child of trees) { try { killTestTreeSync(child); } catch { /* cannot await during exit */ } } });
