/**
 * Test-only transaction stall for the T5 watchdog oracle in bench-store-smoke.
 * Explicit --import only: no product module imports this file. The worker acquires
 * its real BEGIN IMMEDIATE before the unmodified watchdog is armed. Budgets,
 * watchdog code, termination/next-write ordering and smoke assertions stay intact.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { isMainThread, Worker } from 'node:worker_threads';

const marker = 'synthetic-watchdog-locked-transaction';
if (isMainThread) {
  if (!String(process.argv[1]).replaceAll('\\', '/').endsWith('/scripts/bench-store-smoke.mjs')) throw new Error('watchdog fixture is restricted to the smoke test');
  const send = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...rest) {
    if (message?.method !== 'snapshot' || message.args?.[1]?.note !== marker) return send.call(this, message, ...rest);
    const gate = new SharedArrayBuffer(4), flag = new Int32Array(gate);
    const args = [...message.args]; args[1] = { ...args[1], syntheticWatchdogGate: gate };
    send.call(this, { ...message, args }, ...rest);
    const observed = Atomics.wait(flag, 0, 0, 10000);
    assert.equal(Atomics.load(flag, 0), 1, 'T5 must hold its real transaction before the watchdog starts: ' + observed);
    console.log('    T5 fixture: real transaction acquired; watchdog and queued-write assertions unchanged');
  };
}

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('/server/src/services/bench-store-core.ts')) return loaded;
    const source = String(loaded.source).replaceAll('\r\n', '\n');
    const anchor = "snapshot(name: string, ctx: WriteCtx) {\n    return this.tx(async () => {";
    assert.equal(source.split(anchor).length, 2, 'unique transaction fixture anchor');
    const stall = `
      if (ctx.note === '${marker}') {
        const gate = (ctx as unknown as { syntheticWatchdogGate: SharedArrayBuffer }).syntheticWatchdogGate;
        if (!(gate instanceof SharedArrayBuffer)) throw new Error('test transaction gate is absent');
        const flag = new Int32Array(gate);
        Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
        Atomics.wait(flag, 0, 1, 15000);
      }`;
    return { ...loaded, source: source.replace(anchor, anchor + stall) };
  },
});
