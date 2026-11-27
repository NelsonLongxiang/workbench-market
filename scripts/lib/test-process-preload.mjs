/** Windows test-only preload: preserve suite exit hooks, then hold the root until its parent reaps its tree. */
import { writeSync } from 'node:fs';
if (process.platform !== 'win32' || typeof process.send !== 'function') throw Error('test tree preload requires Windows owned IPC');
let finishing = false;
function finish(code) {
  if (finishing) return;
  finishing = true;
  const exitCode = Number.isInteger(Number(code)) ? Number(code) : 1;
  process.exitCode = exitCode;
  // Existing test exit hooks must still run before their root is kept alive for taskkill.
  try { process.emit('exit', exitCode); } catch (error) { writeSync(2, String(error) + '\n'); process.exitCode = 1; }
  setInterval(() => {}, 1000);
  process.send({ kind: 'market-test-tree-finished', code: process.exitCode });
}
// Do not return to code after process.exit(): only the owner may end this held root.
process.exit = code => { finish(code ?? process.exitCode ?? 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
process.once('beforeExit', code => finish(code));
process.once('uncaughtException', error => { writeSync(2, String(error?.stack || error) + String.fromCharCode(10)); finish(1); });
process.once('unhandledRejection', error => { writeSync(2, String(error?.stack || error) + String.fromCharCode(10)); finish(1); });
process.channel.unref();
