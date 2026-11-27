/** Windows-only holding root for an arbitrary test executable. */
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
if (process.platform !== 'win32' || typeof process.send !== 'function') throw Error('test wrapper requires Windows owned IPC');
const [executable, ...args] = process.argv.slice(2);
if (!executable) throw Error('test executable missing');
const hold = setInterval(() => {}, 1000);
const finish = (code, signal) => { process.send({ kind: 'market-test-tree-finished', code, signal }, error => { if (error) { clearInterval(hold); process.exit(1); } }); };
const child = spawn(executable, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: false, windowsHide: true });
child.once('error', error => { writeSync(2, String(error) + '\n'); finish(-1); });
child.once('exit', (code, signal) => finish(code, signal));
