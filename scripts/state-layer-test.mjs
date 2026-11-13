#!/usr/bin/env node
/**
 * 共用状态层（services/state-layer.ts，Cordis 服务 `state`）：Redis 可选，没有就以 SQLite 为准（docs/data-views.md 第十三节）。
 * 子进程里装上服务容器，把 redis 包换成进程内的假 Redis（scripts/fixtures/state-layer-redis.mjs），不连网络：
 *
 *   S1 没配 Redis：mode off；读 off、写 false、清台 0——调用方据此直接用 SQLite
 *   S2 配了、连着：读写、到期时间、删键；键只认 benchKey() 拼的（台 id、段的写法；SOP 的键不归这里）
 *   S3 删台时按前缀清：只清这个台的（台 1 不碰台 10），SOP 的键不碰，分批扫也清干净；清完按前缀一个都找不到
 *   S4 中途断开：mode down；读 down（不是 miss）、写 false、清台 null；恢复后照常
 *   S5 这次出错：读 error、写 false
 *   S3b 清台扫到第二批时 Redis 下线：返回 null（不是已清的个数），没清完的键还在
 *   S3c 清扫：卡片已经不在的台的键清掉，还在的不碰；不通时返回 null
 *   S7 别的域的句柄（SOP）：没配是 null、连着时命令原样转给连接、不通是 null；只许碰 wm:sop:，碰台的键当场拒；台的方法也碰不到它的键
 *   S6 卸载根上下文：连接断开，之后 mode off
 *
 *   node scripts/state-layer-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = pathToFileURL(join(ROOT, 'scripts/fixtures/state-layer-redis.mjs')).href;

if (process.env.STATE_LAYER_CHILD) await child(process.env.STATE_LAYER_CHILD);
else await parent();

async function child(mode) {
  const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
  const { root } = await import(src('root-context.ts'));
  const { svc } = await import(src('context.ts'));
  const { startRedis } = await import(src('redis.ts'));
  const { benchKey, stateDomain } = await import(src('services/state-layer.ts'));
  const st = svc('state');
  const out = {};
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof TypeError; } };
  const rejects = async (fn) => { try { await fn(); return false; } catch (e) { return e instanceof TypeError; } };
  startRedis();
  await new Promise((r) => setImmediate(r));
  if (mode === 'off') {
    const k = benchKey(1, 'var', 'x');
    out.off = { mode: st.mode(), get: await st.get(k), set: await st.set(k, 'v'), del: await st.del(k), clear: await st.clearBench(1), sopConfigured: stateDomain('sop').configured(), sopOps: stateDomain('sop').ops() };
  } else {
    const ctl = globalThis.__stateRedis;
    const k1 = benchKey(1, 'var', 'progress'), k2 = benchKey(1, 'const', 'limit'), k10 = benchKey(10, 'var', 'progress');
    out.up = { mode: st.mode(), key: k1 };
    out.up.set = await st.set(k1, '42');
    out.up.get = await st.get(k1);
    out.up.miss = await st.get(benchKey(1, 'var', 'nothing'));
    out.up.ttl = [await st.set(k2, 'a', 30), ctl.lastSetOpts];
    out.up.del = [await st.del(k2), await st.get(k2)];
    out.up.badKeys = [
      throws(() => benchKey(0, 'a')), throws(() => benchKey(1.5, 'a')), throws(() => benchKey(1)), throws(() => benchKey(1, 'a:b')),
      throws(() => benchKey(1, 'a*')), throws(() => benchKey(1, '')),
      await rejects(() => st.get('wm:sop:run:1:data')), await rejects(() => st.set('wm:bench:1', 'v')), await rejects(() => st.del('wm:bench:1:*')),
      await rejects(() => st.clearBench(0)),
    ];
    // S3：台 1 有 5 个键（分三批扫），台 10 一个，SOP 一个
    for (const p of ['a', 'b', 'c', 'd']) await st.set(benchKey(1, 'var', p), p);
    await st.set(k10, 'ten');
    ctl.store.set('wm:sop:run:1:data', 'sop');
    out.clear = { n: await st.clearBench(1), left1: [...ctl.store.keys()].filter((k) => k.startsWith('wm:bench:1:')), ten: await st.get(k10), sop: ctl.store.get('wm:sop:run:1:data') };
    // S3b：清台扫到第二批时下线（台 3 有 4 个键，两个一批）
    for (const p of ['a', 'b', 'c', 'd']) await st.set(benchKey(3, 'var', p), p);
    ctl.offlineAfterBatches = 1;
    const mid = await st.clearBench(3);
    const left3 = [...ctl.store.keys()].filter((k) => k.startsWith('wm:bench:3:')).length;
    ctl.back();
    out.midScan = { result: mid, left3 };
    // S3c：清扫。卡片 3、10 还在，5、6 已经不在
    for (const [id, p] of [[5, 'x'], [6, 'y'], [3, 'z']]) await st.set(benchKey(id, 'var', p), p);
    const swept = await st.sweepBenches(new Set([3, 10]));
    out.sweep = { swept, gone: ['wm:bench:5:var:x', 'wm:bench:6:var:y'].every((k) => !ctl.store.has(k)), kept: ctl.store.has('wm:bench:3:var:z') && ctl.store.has('wm:bench:10:var:progress'), sop: ctl.store.get('wm:sop:run:1:data') };
    ctl.offline();
    out.sweep.down = await st.sweepBenches(new Set());
    ctl.back();
    // S4：中途断开
    await st.set(k10, 'ten');
    ctl.offline();
    out.down = { mode: st.mode(), get: await st.get(k10), set: await st.set(k10, 'x'), del: await st.del(k10), clear: await st.clearBench(10), kept: ctl.store.get(k10) };
    ctl.back();
    out.back = { mode: st.mode(), get: await st.get(k10) };
    // S5：这次出错
    ctl.failNext = true; const e1 = await st.get(k10);
    ctl.failNext = true; const e2 = await st.set(k10, 'y');
    out.error = { get: e1, set: e2, after: await st.get(k10) };
    // S7：SOP 句柄
    const sop = st.domain('sop');
    const ops = sop.ops();
    await ops.hSet('wm:sop:run:7:meta', { slug: 's', status: 'running' });
    await ops.hSet('wm:sop:run:7:meta', 'status', 'finished');
    await ops.sAdd('wm:sop:runs:active', '7'); await ops.sAdd('wm:sop:runs:active', '8'); await ops.sRem('wm:sop:runs:active', '8');
    await ops.expire('wm:sop:run:7:meta', 3600);
    const guardErr = (fn) => { try { fn(); return false; } catch (e) { return e instanceof TypeError; } };
    out.sop = {
      configured: sop.configured(), meta: await ops.hGetAll('wm:sop:run:7:meta'), active: await ops.sMembers('wm:sop:runs:active'), expire: ctl.expires?.['wm:sop:run:7:meta'],
      guards: [guardErr(() => ops.hSet('wm:bench:1:var:x', 'a', 'b')), guardErr(() => ops.hGetAll('wm:sopx:1')), guardErr(() => ops.sMembers('wm:sop:')), guardErr(() => ops.expire('other', 1))],
      benchCantTouch: await (async () => { try { await st.get('wm:sop:run:7:meta'); return false; } catch (e) { return e instanceof TypeError; } })(),
    };
    ctl.failNext = true;
    out.sop.errorThrown = await ops.hGetAll('wm:sop:run:7:meta').then(() => false, () => true);
    await st.clearBench(7);
    out.sop.afterClearBench = ctl.store.has('wm:sop:run:7:meta');
    // 清扫：扫的是 wm:bench:*，卡片一张都不在也碰不到 SOP 的键
    out.sop.swept = await st.sweepBenches(new Set());
    out.sop.afterSweep = ctl.store.has('wm:sop:run:7:meta') && ctl.store.has('wm:sop:runs:active') && ![...ctl.store.keys()].some((k) => k.startsWith('wm:bench:'));
    ctl.offline();
    out.sop.down = { ops: sop.ops(), configured: sop.configured() };
    ctl.back();
    // S6：卸载根上下文
    await root.fiber.dispose();
    out.dispose = { destroyed: ctl.destroyed, mode: st.mode() };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function parent() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra === undefined ? '' : `（${JSON.stringify(extra)}）`}`); } };
  const run = (mode) => new Promise((resolve) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wm-state-layer-'));
    const preload = `import{registerHooks}from'node:module';registerHooks({resolve(s,c,next){return s==='redis'?{url:${JSON.stringify(FAKE)},shortCircuit:true}:next(s,c)}});`;
    const env = { ...process.env, STATE_LAYER_CHILD: mode, DATA_DIR: dataDir, NODE_ENV: 'test', WM_VAULT_PATH: join(dataDir, 'vault.json') };
    delete env.REDIS_URL;
    if (mode === 'on') env.REDIS_URL = 'redis://synthetic.invalid:1';
    const p = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(import.meta.url)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => {
      rmSync(dataDir, { recursive: true, force: true });
      const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
      try { resolve(JSON.parse(line)); } catch { console.log(err.slice(-2000)); resolve({ code }); }
    });
  });

  console.log('S1 没配 Redis');
  const a = (await run('off')).off;
  ok('mode off；读 off、写 false、删 false、清台 0：调用方直接用 SQLite', a?.mode === 'off' && a.get?.kind === 'off' && a.set === false && a.del === false && a.clear === 0, a);
  ok('S7 没配：SOP 句柄 configured 为 false、ops 为 null（SOP 回落 SQLite）', a?.sopConfigured === false && a.sopOps === null, a);

  const r = await run('on');
  console.log('S2 配了、连着');
  ok('mode up；键是 wm:bench:<台 id>:<段>', r.up?.mode === 'up' && r.up.key === 'wm:bench:1:var:progress', r.up);
  ok('写了读得到；没有的键是 miss', r.up?.set === true && r.up.get?.kind === 'hit' && r.up.get.value === '42' && r.up.miss?.kind === 'miss', r.up);
  ok('到期时间照传（EX 秒）；删了之后是 miss', r.up?.ttl?.[0] === true && r.up.ttl[1]?.EX === 30 && r.up.del?.[0] === true && r.up.del[1]?.kind === 'miss', r.up);
  ok('键只认 benchKey() 拼的：台 id 不是正整数、没有段、段里有冒号或通配符、空段都拒；SOP 的键、没段的、带通配的、台 id 0 也拒', r.up?.badKeys?.every(Boolean), r.up?.badKeys);
  console.log('S3 删台时按前缀清');
  ok('台 1 的 5 个键分批扫、全清掉；按这个台的前缀一个都找不到', r.clear?.n === 5 && r.clear.left1?.length === 0, r.clear);
  ok('台 10 的键不碰（前缀不会把 1 当成 10 的开头），SOP 的键不碰', r.clear?.ten?.kind === 'hit' && r.clear.sop === 'sop', r.clear);
  ok('S3b 清台扫到第二批时下线：返回 null（不是已清的个数），没清完的键还在', r.midScan?.result === null && r.midScan.left3 === 2, r.midScan);
  ok('S3c 清扫：卡片已经不在的台的键清掉（2 个），还在的、SOP 的不碰；不通时返回 null', r.sweep?.swept === 2 && r.sweep.gone && r.sweep.kept && r.sweep.sop === 'sop' && r.sweep.down === null, r.sweep);
  console.log('S4 中途断开');
  ok('mode down；读 down（不是 miss）、写 false、删 false、清台 null；Redis 里原有的不动', r.down?.mode === 'down' && r.down.get?.kind === 'down' && r.down.set === false && r.down.del === false && r.down.clear === null && r.down.kept === 'ten', r.down);
  ok('恢复之后 mode up，照常读到', r.back?.mode === 'up' && r.back.get?.kind === 'hit' && r.back.get.value === 'ten', r.back);
  console.log('S5 这次出错');
  ok('读 error（不是 miss）、写 false；下一次照常', r.error?.get?.kind === 'error' && r.error.set === false && r.error.after?.kind === 'hit' && r.error.after.value === 'ten', r.error);
  console.log('S7 SOP 的句柄');
  ok('连着：hash 整份写、按字段写、读；set 加、删、列；到期——都原样转给连接', r.sop?.configured === true && r.sop.meta?.slug === 's' && r.sop.meta.status === 'finished' && JSON.stringify(r.sop.active) === '["7"]' && r.sop.expire === 3600, r.sop);
  ok('只许碰 wm:sop:：台的键、像前缀的别的键、光有前缀、别的键都当场拒；台的方法也碰不到 SOP 的键；清台不动 SOP 的键', r.sop?.guards?.every(Boolean) && r.sop.benchCantTouch && r.sop.afterClearBench, r.sop);
  ok('清扫（卡片一张都不在）把台的键清光，SOP 的键一个不碰', typeof r.sop?.swept === 'number' && r.sop.swept > 0 && r.sop.afterSweep === true, r.sop);
  ok('这次出错照样抛给调用方（SOP 自己的兜底照旧）；不通时 ops 是 null、configured 仍是 true', r.sop?.errorThrown && r.sop.down?.ops === null && r.sop.down.configured === true, r.sop);
  console.log('S6 卸载根上下文');
  ok('连接断开一次，之后 mode off', r.dispose?.destroyed === 1 && r.dispose.mode === 'off', r.dispose);

  console.log(`state-layer-test: ${pass} passed / ${fail} failed`);
  if (fail) process.exitCode = 1;
}
