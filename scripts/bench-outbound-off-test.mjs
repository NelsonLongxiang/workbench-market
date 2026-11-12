#!/usr/bin/env node
/**
 * 对外断开（WM_OUTBOUND=off）时的台库工作线程（设计稿 docs/data-views.md 第十一节「出站闸和工作线程」）：
 *   · 出站闸只放行登记过的那一个线程入口；别的文件、eval 的代码、字符串路径、带查询串的照旧被拒；
 *   · 放行的线程自己装了出站闸：在线程里真的往外连，连之前就被拦下；
 *   · 台库在对外断开的实例上照常读写。
 * 用法：node scripts/bench-outbound-off-test.mjs（它会带上 WM_OUTBOUND=off 把自己再起一遍）
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.WM_OUTBOUND !== 'off') {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', new URL(import.meta.url).pathname], { env: { ...process.env, WM_OUTBOUND: 'off' }, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const DATA = mkdtempSync(resolve('tmp/bench-outbound-'));
process.env.DATA_DIR = DATA;
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
const root = pathToFileURL(resolve('.') + '/');
const ENTRY = new URL('server/src/services/bench-store-worker.ts', root);
try {
  const gate = await import(new URL('server/src/outbound-gate.ts', root).href);
  const { Worker } = await import('node:worker_threads');
  const { benchSqlKit } = await import(new URL('server/src/db.ts', root).href);
  const tryNew = (file, opts) => { try { const w = new Worker(file, opts); void w.terminate(); return 'started'; } catch (e) { return e.code ?? e.message; } };
  ok('对外断开已生效', gate.outboundOff() === true);
  ok('eval 的代码：拒', tryNew('process.exit(0)', { eval: true }) === 'EOUTBOUNDOFF');
  ok('别的文件：拒', tryNew(new URL(import.meta.url)) === 'EOUTBOUNDOFF' && tryNew(new URL('server/src/services/bench-store-core.ts', root)) === 'EOUTBOUNDOFF');
  ok('登记的入口但给的是字符串路径：拒', tryNew(ENTRY.pathname) === 'EOUTBOUNDOFF' && tryNew(ENTRY.href) === 'EOUTBOUNDOFF');
  ok('登记的入口带查询串、带片段：拒', tryNew(new URL(`${ENTRY.href}?x=1`)) === 'EOUTBOUNDOFF' && tryNew(new URL(`${ENTRY.href}#a`)) === 'EOUTBOUNDOFF');
  ok('登记的入口加 eval：拒', tryNew(ENTRY, { eval: true }) === 'EOUTBOUNDOFF');

  // 冒名：对象自己报的地址是登记的入口，实际要起的是别的文件。放行必须只按核对过的那个地址起，不用调用方给的对象
  const net = await import('node:net');
  let hits = 0;
  const srv = net.createServer((c) => { hits++; c.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { writeFileSync } = await import('node:fs');
  const evil = join(DATA, 'evil-worker.mjs');
  writeFileSync(evil, `import net from 'node:net'; import { parentPort, workerData } from 'node:worker_threads'; const s = net.connect(workerData?.port ?? ${srv.address().port}, '127.0.0.1'); s.on('connect', () => { s.destroy(); parentPort?.postMessage('leaked'); }); s.on('error', () => parentPort?.postMessage('blocked'));`);
  const evilUrl = pathToFileURL(evil);
  const outcome = (file) => new Promise((res) => {
    let w; try { w = new Worker(file, { workerData: { root: join(DATA, 'imp'), kit: benchSqlKit('sqlite'), port: srv.address().port } }); } catch (e) { return res(e.code ?? e.message); }
    const t = setTimeout(() => { void w.terminate(); res('no-leak'); }, 1200);
    w.once('message', (m) => { clearTimeout(t); void w.terminate(); res(m === 'leaked' ? 'leaked' : 'no-leak'); });
    w.once('error', () => { clearTimeout(t); res('no-leak'); });
  });
  class Liar extends URL { get href() { return ENTRY.href; } }
  let flip = 0;
  class Flipper extends URL { get href() { return flip++ === 0 ? ENTRY.href : super.href; } }
  const forged = Object.setPrototypeOf({ href: ENTRY.href, protocol: 'file:', pathname: evilUrl.pathname, hostname: '', host: '', search: '', hash: '', origin: 'null' }, URL.prototype);
  const imp = [await outcome(new Liar(evilUrl.href)), await outcome(new Flipper(evilUrl.href)), await outcome(forged)];
  await new Promise((r) => setTimeout(r, 200));
  ok('冒名的三种写法（子类改写地址、第一次读和第二次读不一样、伪造的对象）：起的都不是那个别的文件，没有一个字节连出去', imp.every((x) => x !== 'leaked' && x !== 'started') && hits === 0, { imp, hits });
  // 调用方给的启动参数不带进线程：--import 的文件会在线程入口装闸之前先跑，带进去就能在闸装上之前往外连
  const before = hits;
  const pre = new Worker(ENTRY, { workerData: { root: join(DATA, 'pre'), kit: benchSqlKit('sqlite'), port: srv.address().port }, execArgv: ['--import', evilUrl.href], env: { WM_OUTBOUND: 'on' } });
  const preSt = await new Promise((res) => { const t = setTimeout(() => res('没有回话'), 5000); pre.on('message', (r) => { if (r === 'leaked' || r === 'blocked') return; clearTimeout(t); res(r); }); pre.once('error', (e) => { clearTimeout(t); res(`线程出错：${e.message}`); }); pre.postMessage({ id: 9, slug: '', method: '@outbound', args: [], budgetMs: 0 }); });
  await new Promise((r) => setTimeout(r, 300));
  await pre.terminate();
  ok('调用方给的 execArgv（--import 一个往外连的文件）和 env 都不带进线程：没有一个字节连出去，线程里对外断开仍开着', hits === before && preSt?.ok === true && preSt.value?.off === true && preSt.value?.blocked === true, { hits: hits - before, preSt });
  srv.close();

  // 放行的线程：就算调用方想把对外断开关掉（env）或者塞启动参数，也不带过去；线程里往外连被拦
  const w = new Worker(ENTRY, { workerData: { root: join(DATA, 'direct'), kit: benchSqlKit('sqlite') }, env: { WM_OUTBOUND: 'on' }, execArgv: ['--no-warnings'], argv: ['x'] });
  const ask = (msg) => new Promise((res) => { const t = setTimeout(() => res('没有回话'), 5000); w.once('message', (r) => { clearTimeout(t); res(r); }); w.once('error', (e) => { clearTimeout(t); res(`线程出错：${e.message}`); }); w.postMessage(msg); });
  const st = await ask({ id: 1, slug: '', method: '@outbound', args: [], budgetMs: 0 });
  ok('登记的入口：起得来；线程里对外断开是开着的，往外连在连之前就被拦下（调用方给的 env 不算数）', st?.ok === true && st.value?.off === true && st.value?.blocked === true, st);
  await w.terminate();

  // 台库照常读写
  const { benchStore, closeBenchStores } = await import(new URL('server/src/services/bench-store.ts', root).href);
  const s = await benchStore('pre');
  await s.defineDataset({ name: 'a', columns: [{ name: 'id', type: 'integer' }, { name: 'v', type: 'text' }], key: ['id'] }, { actor: 't', at: 1 });
  await s.append('a', [{ id: 1, v: 'x' }], { actor: 't', at: 2 });
  ok('对外断开的实例上台库照常读写', (await s.query({ dataset: 'a' })).rows.length === 1);
  await closeBenchStores();
  const blocked = gate.outboundStatus(true);
  ok('被拒的那几次都记了数', Number(blocked?.blocked?.worker ?? blocked?.counts?.worker ?? 0) >= 6, blocked);
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nbench-outbound-off-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
