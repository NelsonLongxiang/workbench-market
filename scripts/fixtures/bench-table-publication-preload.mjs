/** Observe or pause a real table read after completion; test-owned IPC only, no mocked results. */
import { isMainThread } from 'node:worker_threads';
if (process.env.NODE_ENV !== 'test') throw new Error('table publication fixture is test-only');
// Node workers inherit --import; observe only the HTTP process, not the underlying store worker.
if (isMainThread) {
  if (typeof process.send !== 'function') throw new Error('table publication fixture requires a test-owned IPC child');
  const { BenchStore } = await import('../../server/src/services/bench-store.ts');
  let armed = null, release = null;
  process.on('message', (message) => {
    if (message?.kind === 'table-test-arm') {
      if (armed || release || !['tableRow', 'tableExport'].includes(message.method) || !['observe', 'hold'].includes(message.mode)) throw new Error('invalid table publication arm');
      armed = { method: message.method, mode: message.mode };
      process.send({ kind: 'table-test-armed', method: message.method });
    } else if (message?.kind === 'table-test-release') {
      release?.(); release = null;
    }
  });
  for (const method of ['tableRow', 'tableExport']) {
    const read = BenchStore.prototype[method];
    BenchStore.prototype[method] = async function (...args) {
      const selected = armed?.method === method ? armed : null;
      if (selected) armed = null;
      const result = await read.apply(this, args);
      if (selected) {
        const notice = { kind: selected.mode === 'hold' ? 'table-test-held' : 'table-test-observed', method,
          originalRequested: method === 'tableRow' ? args[3] === true : null,
          originalRows: method === 'tableRow' ? result.source_rows.length : null };
        if (selected.mode === 'hold') await new Promise((resolve) => { release = resolve; process.send(notice); });
        else process.send(notice);
      }
      return result;
    };
  }
}
