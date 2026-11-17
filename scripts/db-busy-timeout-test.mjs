#!/usr/bin/env node
/**
 * 库被别的连接锁着写时，市场的连接等一个有上限的时间（db-busy.ts 的 DB_BUSY_TIMEOUT_MS），短暂重叠不直接失败、超过上限照样报错：
 *
 *   市场主库、判定比对库：
 *     另一个进程持写锁 1 秒后放开：市场的写等得到、不报错，写完的时刻在对方放开之后（确实等了）
 *     同一时刻别的连接一直持着写锁：市场的写在上限前后报 database is locked，不无限等
 *   起实例：另一个连接正在写同一个库（持写锁 1.5 秒）时起服务，起得来、启动自检过（CI 上「起实例时 database is locked」那一类偶发）
 *   台库：每次读写的等待取上限和这一次的时限中较小的一个
 *     时限 800 毫秒、锁一直不放：800 毫秒左右报错（不等满上限，不至于被看门狗强行中止）
 *     不限时、另一个进程持锁 1 秒：等得到
 *   这不改变「多个进程同时写同一个库还不支持」：只是短暂重叠不直接失败。
 *
 *   node scripts/db-busy-timeout-test.mjs              测本仓库
 *   node scripts/db-busy-timeout-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `db-busy-timeout-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const node = (code, env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
/** 子进程的结果；子进程自己就崩了（比如引入库模块时碰上写锁当场报错）当成一次失败，带上它的报错 */
const result = (r) => { const m = /RESULT (.*)/.exec(r.stdout); return m ? JSON.parse(m[1]) : { ok: false, crashed: true, error: (/Error[^\n]*/.exec(r.stderr) ?? [r.stderr.slice(-300)])[0] }; };

/** 另一个进程：开一个连接持写锁 ms 毫秒后放开。返回在持锁的那一刻 resolve 的 promise 和放开时刻 */
function holdLock(file, ms) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const d = new DatabaseSync(${JSON.stringify(file)});
    d.exec('CREATE TABLE IF NOT EXISTS busy_probe_hold (x)');
    d.exec('BEGIN IMMEDIATE');
    d.exec('INSERT INTO busy_probe_hold VALUES (1)');
    console.log('LOCKED');
    setTimeout(() => { d.exec('COMMIT'); console.log('RELEASED ' + Date.now()); d.close(); }, ${ms});`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const locked = new Promise((ok, no) => { child.stdout.on('data', (b) => { out += b; if (out.includes('LOCKED')) ok(); }); child.on('exit', () => no(new Error('持锁进程没锁上就退出了'))); });
  const released = new Promise((ok) => child.on('exit', () => ok(Number(/RELEASED (\d+)/.exec(out)?.[1] ?? 0))));
  return { locked, released };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
try {
  const data = join(OUT, 'data');
  mkdirSync(data, { recursive: true });
  const env = { DATA_DIR: data };
  // 先把两个库建好（表结构在引入时建），之后的写只碰我们自己的表
  result(node(`
    const { db, judgmentCompareDb } = await import(${JSON.stringify(at('server/src/db.ts'))});
    db.exec('CREATE TABLE IF NOT EXISTS busy_probe (x)'); judgmentCompareDb().exec('CREATE TABLE IF NOT EXISTS busy_probe (x)');
    console.log('RESULT {}');`, env));

  for (const [label, file, conn] of [['市场主库', 'workbench-market.db', 'db'], ['判定比对库', 'judgment-compare.db', 'judgmentCompareDb()']]) {
    // ---------- 短暂持锁：等得到 ----------
    const h = holdLock(join(data, file), 1000);
    await h.locked;
    const w = result(node(`
      const m = await import(${JSON.stringify(at('server/src/db.ts'))});
      const c = m.${conn};
      try { c.prepare('INSERT INTO busy_probe VALUES (1)').run(); console.log('RESULT ' + JSON.stringify({ ok: true, done: Date.now() })); }
      catch (e) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(e?.message ?? e), done: Date.now() })); }`, env));
    const releasedAt = await h.released;
    check(w.ok === true && releasedAt > 0 && w.done >= releasedAt, `${label}：另一个进程持写锁 1 秒，市场的写等到它放开再写成，不报错`, show({ w, releasedAt }));
    // ---------- 一直持锁：上限前后报错，不无限等 ----------
    const k = result(node(`
      import { DatabaseSync } from 'node:sqlite';
      const m = await import(${JSON.stringify(at('server/src/db.ts'))});
      const c = m.${conn};
      const other = new DatabaseSync(${JSON.stringify(join(data, file))});
      other.exec('BEGIN IMMEDIATE'); other.exec('INSERT INTO busy_probe VALUES (2)');
      const t = Date.now();
      try { c.prepare('INSERT INTO busy_probe VALUES (3)').run(); console.log('RESULT ' + JSON.stringify({ ok: true, ms: Date.now() - t })); }
      catch (e) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(e?.message ?? e), ms: Date.now() - t })); }
      other.exec('ROLLBACK');`, env));
    check(k.ok === false && /locked/.test(k.error) && k.ms >= 4500 && k.ms < 8000, `${label}：写锁一直不放，市场的写在上限（5 秒）前后报 database is locked，不无限等`, show(k));
  }

  // ---------- 起实例：另一个连接正在写同一个库 ----------
  {
    const port = await new Promise((ok) => { const v = createServer(); v.listen(0, '127.0.0.1', () => { const { port: p } = v.address(); v.close(() => ok(p)); }); });
    mkdirSync(join(OUT, 'ext'), { recursive: true });
    const h = holdLock(join(data, 'workbench-market.db'), 1500);
    await h.locked;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { PATH: process.env.PATH, HOME: data, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN: 'busy-synthetic', REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let health = null;
    for (const t0 = Date.now(); Date.now() - t0 < 90000 && child.exitCode === null;) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) }); const j = await r.json(); if (j.self_probe?.at) { health = j; break; } } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const releasedAt = await h.released;
    check(health?.self_probe?.passed === true && child.exitCode === null && releasedAt > 0,
      '起实例：另一个进程正持着同一个库的写锁（1.5 秒）时起服务，等到它放开、起得来，启动自检过', show({ exit: child.exitCode, passed: health?.self_probe?.passed, err: child.exitCode !== null ? log.split('\n').filter((l) => !l.includes('"verdict":"pass"')).slice(-12).join(' | ') : '' }));
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  }

  // ---------- 台库 ----------
  {
    const root = join(OUT, 'benches');
    const prep = result(node(`
      const { BenchHost } = await import(${JSON.stringify(at('server/src/services/bench-store-core.ts'))});
      const { benchSqlKit } = await import(${JSON.stringify(at('server/src/db.ts'))});
      const host = new BenchHost(${JSON.stringify(root)}, benchSqlKit('sqlite'));
      const s = await host.store('busy');
      await s.defineDataset({ name: 'rows', columns: [{ name: 'id', type: 'integer' }], key: ['id'] }, { actor: 'test', at: Date.now() });
      await host.closeAll();
      console.log('RESULT {}');`, { DATA_DIR: join(OUT, 'bench-main') }));
    void prep;
    const file = join(root, 'busy.sqlite');
    const write = (budget, holdInProcess) => node(`
      import { DatabaseSync } from 'node:sqlite';
      const { BenchHost } = await import(${JSON.stringify(at('server/src/services/bench-store-core.ts'))});
      const { benchSqlKit } = await import(${JSON.stringify(at('server/src/db.ts'))});
      const host = new BenchHost(${JSON.stringify(root)}, benchSqlKit('sqlite'));
      const s = await host.store('busy');
      ${holdInProcess ? `const other = new DatabaseSync(${JSON.stringify(file)}); other.exec('BEGIN IMMEDIATE'); other.exec("CREATE TABLE IF NOT EXISTS busy_probe_hold (x)");` : ''}
      const t = Date.now();
      try { await s.withBudget(${budget}, () => s.replace('rows', [{ id: 1 }], { actor: 'test', at: Date.now() })); console.log('RESULT ' + JSON.stringify({ ok: true, ms: Date.now() - t, done: Date.now() })); }
      catch (e) { console.log('RESULT ' + JSON.stringify({ ok: false, error: String(e?.message ?? e), ms: Date.now() - t })); }
      ${holdInProcess ? `other.exec('ROLLBACK');` : ''}
      await host.closeAll();`, { DATA_DIR: join(OUT, 'bench-main') });
    const capped = result(write(800, true));
    check(capped.ok === false && capped.ms >= 600 && capped.ms < 3000, '台库：这一次时限 800 毫秒、写锁一直不放：800 毫秒左右报错（不等满 5 秒的上限）', show(capped));
    const h = holdLock(file, 1000);
    await h.locked;
    const waited = result(write(0, false));
    const releasedAt = await h.released;
    check(waited.ok === true && waited.done >= releasedAt, '台库：不限时、另一个进程持写锁 1 秒：等到它放开再写成', show({ waited, releasedAt }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
