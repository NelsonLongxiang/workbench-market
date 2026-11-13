#!/usr/bin/env node
/**
 * 台库分道（services/bench-store.ts；docs/data-views.md 第十三节第 5 条第 2 步）：台按标识固定落在一道上，一道一个工作线程。
 *
 *   L1 同一个标识永远同一道；只有 1 道时全在第 0 道；道数只能在空闲时改，写法不对的拒
 *   L2 不同道的台互不排队：慢台排着几件事时，另一道上的台先做完；只有 1 道时（对照）它排在最后
 *   L3 大写入全局一次一件：两道上各来一份，第二份等许可；同时第三道上的小读不受影响。
 *      「大」按体量估，不按行数：不到一千行的宽行（每行 8 格长文本）照样算大写入
 *   L4 做完大写入就换线程（下一件事在新线程上照常）
 *   L5 一道上强行终止，别的道的线程不受影响
 *   L6 排队上限是各道加起来的
 *
 *   node scripts/bench-store-lanes-test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA = mkdtempSync(resolve('tmp/bench-store-lanes-'));
process.env.DATA_DIR = DATA;
const { benchStore, closeBenchStores, configureBenchRuntime, benchRuntimeStats, benchLaneOf } = await import('../server/src/services/bench-store.ts');
const { BENCH_LIMITS } = await import('../server/src/bench-query.ts');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x === undefined ? '' : ` ${JSON.stringify(x)}`}`); } };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, message: String(e.message) }; } };
const ctx = () => ({ actor: 'lanes-test', at: Date.now() });
/** 在给定道数下，挑出 n 个各在不同道上的标识 */
const distinct = (prefix, n) => {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    if (i > 1000) throw new Error(`挑不出 ${n} 个落在不同道上的标识：分道没有生效`);
    const s = `${prefix}-${i}`;
    if (!out.some((x) => benchLaneOf(x) === benchLaneOf(s))) out.push(s);
  }
  return out;
};
// 整个测试最多跑两分钟：分道出错时可能挂住，到点算失败
setTimeout(() => { console.log('  ✗ 两分钟没跑完，算失败'); console.log(`bench-store-lanes-test: ${pass} passed / ${fail + 1} failed`); process.exit(1); }, 120_000).unref();
const wideRows = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, body: `r${from + i}-` + 'x'.repeat(600), grp: (from + i) % 7 }));
async function slowBench(slug) {
  const s = await benchStore(slug);
  await s.defineDataset({ name: 'wide', columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }, { name: 'grp', type: 'integer' }], key: ['id'] }, ctx());
  for (let b = 0; b < 4; b++) await s.append('wide', wideRows(2000, b * 2000 + 1), ctx()); // 每批约 1.2 MB，不到大写入，不触发换线程
  return s;
}
const SLOW = { dataset: 'wide', measures: [{ as: 'd', fn: 'count_distinct', col: 'body' }] };
const COUNT = { dataset: 'wide', measures: [{ as: 'c', fn: 'count' }] };

try {
  console.log('L1 分道');
  configureBenchRuntime({ lanes: 4 });
  ok('同一个标识永远同一道；道号在 0～道数-1', ['a', 'demo', 'pilot-inspect', 'x-1'].every((s) => benchLaneOf(s) === benchLaneOf(s) && benchLaneOf(s) >= 0 && benchLaneOf(s) < 4));
  configureBenchRuntime({ lanes: 1 });
  ok('只有 1 道时全在第 0 道', ['a', 'b', 'c', 'demo'].every((s) => benchLaneOf(s) === 0));
  const bad = [await refused(async () => configureBenchRuntime({ lanes: 0 })), await refused(async () => configureBenchRuntime({ lanes: 1.5 })), await refused(async () => configureBenchRuntime({ lanes: 17 }))];
  ok('道数写法不对的拒（0、小数、超过 16）', bad.every((e) => e?.code === 'invalid'), bad);
  await benchStore('open-one');
  const busy = await refused(async () => configureBenchRuntime({ lanes: 2 }));
  ok('还有开着的库时不许改道数', busy?.code === 'conflict', busy);
  await closeBenchStores();

  // L2：同一份做法，1 道（对照）和 2 道各跑一次
  const race = async (lanes) => {
    await closeBenchStores();
    configureBenchRuntime({ lanes });
    const [a, b] = lanes === 1 ? ['slow-l1', 'fast-l1'] : distinct(`l${lanes}`, 2);
    const A = await slowBench(a), B = await slowBench(b);
    const order = [];
    const slow = Array.from({ length: 4 }, (_, i) => A.query(SLOW).then(() => order.push(`A${i}`)));
    const fast = B.query(COUNT).then(() => order.push('B'));
    await Promise.all([...slow, fast]);
    return order;
  };
  console.log('L2 不同道的台互不排队');
  const o1 = await race(1);
  ok('（对照）1 道：B 排在 A 的四件慢事后面', o1.indexOf('B') === 4, o1);
  const o2 = await race(2);
  ok('2 道、两个台在不同道：B 在 A 的第一件慢事做完之前就做完了', o2[0] === 'B', o2);

  console.log('L3 大写入全局一次一件');
  await closeBenchStores();
  configureBenchRuntime({ lanes: 3 });
  const [p, q, r] = distinct('big', 3);
  const P = await benchStore(p), Q = await benchStore(q), R = await slowBench(r);
  for (const s of [P, Q]) await s.defineDataset({ name: 'wide', columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }, { name: 'grp', type: 'integer' }], key: ['id'] }, ctx());
  let st = benchRuntimeStats();
  const big = Buffer.from(JSON.stringify(wideRows(9000)));
  const done = [];
  const bigs = [P, Q].map((s, i) => s.replace('wide', big, ctx()).then(() => done.push(`big${i}`)));
  const small = R.query(COUNT).then(() => done.push('small'));
  await Promise.all([...bigs, small]);
  const after = benchRuntimeStats();
  ok(`两份大写入（各 ${(big.length / 1048576).toFixed(1)} MB）在不同道上：第二份等了许可，两份都写成`, after.bigWaits > st.bigWaits && (await P.query(COUNT)).rows[0].c === 9000 && (await Q.query(COUNT)).rows[0].c === 9000, { st, after });
  ok('同时第三道上的小读不用等大写入', done.indexOf('small') < 2, done);

  // 宽行：行数远不到 2000，但每行 8 格各 600 字符，一份约 4.8 MB（行数组，不是原始字节）
  const fat = (n) => Array.from({ length: n }, (_, i) => Object.fromEntries([['id', i + 1], ...Array.from({ length: 8 }, (_, c) => [`c${c}`, `${i}-${c}-` + 'w'.repeat(600)])]));
  const fatCols = [{ name: 'id', type: 'integer' }, ...Array.from({ length: 8 }, (_, c) => ({ name: `c${c}`, type: 'text' }))];
  for (const s of [P, Q]) await s.defineDataset({ name: 'fat', columns: fatCols, key: ['id'] }, ctx());
  const st3 = benchRuntimeStats();
  await Promise.all([P, Q].map((s) => s.replace('fat', fat(1000), ctx())));
  const af3 = benchRuntimeStats();
  ok(`宽行：1000 行、每行 8 格长文本（约 ${(JSON.stringify(fat(1000)).length / 1048576).toFixed(1)} MB，行数组）也算大写入：第二份等许可，两份都换线程`, af3.bigWaits > st3.bigWaits && af3.recycles === st3.recycles + 2 && (await P.query({ dataset: 'fat', measures: [{ as: 'c', fn: 'count' }] })).rows[0].c === 1000, { st3, af3 });
  const st3b = benchRuntimeStats();
  await P.replace('fat', fat(100), ctx());
  ok('窄的整份替换（100 行）不算大写入：不换线程', benchRuntimeStats().recycles === st3b.recycles);

  console.log('L4 做完大写入就换线程');
  ok('两份大写入各换一次线程，下一件事在新线程上照常', after.recycles === st.recycles + 2 && (await P.query(COUNT)).rows[0].c === 9000 && benchRuntimeStats().spawns > after.spawns, { after, now: benchRuntimeStats() });
  st = benchRuntimeStats();
  await R.append('wide', wideRows(10, 900001), ctx());
  ok('小写入不换线程', benchRuntimeStats().recycles === st.recycles);

  console.log('L5 一道上强行终止，别的道不受影响');
  st = benchRuntimeStats();
  const base = configureBenchRuntime({ writeMs: 1, graceMs: 1 });
  const killed = refused(() => P.replace('wide', Buffer.from(JSON.stringify(wideRows(2000))), ctx()));
  configureBenchRuntime(base);
  const other = await refused(() => R.query(COUNT));
  const e = await killed;
  const mid = benchRuntimeStats();
  ok('被终止的那一道报 timeout；另一道上的读照常', e?.code === 'timeout' && other === null, { e, other });
  ok('只终止了一个线程', mid.kills === st.kills + 1, { st, mid });

  console.log('L6 排队上限是各道加起来的');
  await closeBenchStores();
  configureBenchRuntime({ lanes: 2 });
  const [f1, f2] = distinct('flood', 2);
  const F1 = await benchStore(f1), F2 = await benchStore(f2);
  const flood = await Promise.all(Array.from({ length: 150 }, (_, i) => refused(() => (i % 2 ? F1 : F2).viewVersions())).concat(Array.from({ length: 150 }, (_, i) => refused(() => (i % 2 ? F2 : F1).viewVersions()))));
  const nBusy = flood.filter((x) => x?.code === 'busy').length;
  ok(`两道一共排了 ${300 - nBusy} 件：上限 ${BENCH_LIMITS.queue} 件排着加上两道各一件在做，其余报 busy`, nBusy === 300 - BENCH_LIMITS.queue - 2 && flood.filter((x) => x === null).length === BENCH_LIMITS.queue + 2, { nBusy });
  ok('之后照常可用、队是空的', (await F1.viewVersions()) !== undefined && benchRuntimeStats().queued === 0);
} catch (e) {
  ok(`没有中途抛错：${e?.message ?? e}`, false);
} finally {
  await closeBenchStores();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`bench-store-lanes-test: ${pass} passed / ${fail} failed`);
if (fail) process.exitCode = 1;
