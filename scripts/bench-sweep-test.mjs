#!/usr/bin/env node
/**
 * 台库的清扫（services/bench-sweep.ts，Cordis 服务 `benchSweep`；docs/data-views.md 第十三节第 5 条第 3 步）。
 * 子进程里装上服务容器，redis 包换成进程内的假 Redis（scripts/fixtures/state-layer-redis.mjs），不连网络：
 *
 *   W1 没有登记的库文件：先备份进 .deleted/，再删掉；登记着的不碰
 *   W2 .deleted/ 里过了 30 天的备份删掉，没过的留着
 *   W3 Redis 里卡片已经不在的台的键清掉，还在的不碰；Redis 不通时这一项是 null，别的照做
 *   W4 往后拨 31 天再扫：W1 留的那份备份也到期删掉
 *   W6 删卡片（属主、带确认）：这张卡片在 Redis 里的键一个不剩，库文件没了，别的卡片的键不碰
 *   W7 删卡片时 Redis 正好不通：卡片照删，键留着；清扫把它清掉
 *   W5 卸载根上下文：清扫的定时器停了
 *
 *   node scripts/bench-sweep-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = pathToFileURL(join(ROOT, 'scripts/fixtures/state-layer-redis.mjs')).href;
const DAY = 86_400_000;

if (process.env.BENCH_SWEEP_CHILD) await child();
else await parent();

async function child() {
  const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
  const fs = await import('node:fs');
  const { root } = await import(src('root-context.ts'));
  const { svc } = await import(src('context.ts'));
  const { db, dataDir } = await import(src('db.ts'));
  const { startRedis } = await import(src('redis.ts'));
  const { benchKey } = await import(src('services/state-layer.ts'));
  const { createBench } = await import(src('services/bench-registry.ts'));
  const { benchStore, closeBenchStores, BENCH_DELETED_DIR, benchBackupName } = await import(src('services/bench-store.ts'));
  startRedis();
  await new Promise((r) => setImmediate(r));
  const ctl = globalThis.__stateRedis, st = svc('state'), sweep = svc('benchSweep');
  const ctx = { actor: 'sweep-test', at: Date.now() };
  // 两张卡片（1、2 还在）；登记一个台；另有一个没登记的库（删卡片时没删掉的那种）
  db.prepare("INSERT INTO workbenches (id, name, url) VALUES (1, '合成甲', 'http://127.0.0.1:9/a'), (2, '合成乙', 'http://127.0.0.1:9/b')").run();
  createBench({ slug: 'keep-a', title: '登记着的' }, 'sweep-test', Date.now());
  for (const slug of ['keep-a', 'orphan-b']) {
    const s = await benchStore(slug);
    await s.defineDataset({ name: 'd', columns: [{ name: 'id', type: 'integer' }], key: ['id'] }, ctx);
    await s.append('d', [{ id: 1 }, { id: 2 }], ctx);
  }
  const now = Date.now();
  fs.mkdirSync(BENCH_DELETED_DIR, { recursive: true });
  fs.writeFileSync(`${BENCH_DELETED_DIR}/${benchBackupName('old-x', now - 31 * DAY)}`, 'x');
  fs.writeFileSync(`${BENCH_DELETED_DIR}/${benchBackupName('new-y', now - 29 * DAY)}`, 'y');
  fs.writeFileSync(`${BENCH_DELETED_DIR}/not-a-backup.txt`, 'z');
  await st.set(benchKey(1, 'var', 'a'), 'live');
  await st.set(benchKey(9, 'var', 'b'), 'dead');
  const files = () => fs.readdirSync(`${dataDir}/bench-stores`).filter((f) => f.endsWith('.sqlite')).sort();
  const deleted = () => fs.readdirSync(BENCH_DELETED_DIR).sort();
  const out = {};
  out.first = await sweep.run(now);
  out.afterFirst = { files: files(), deleted: deleted(), live: ctl.store.has('wm:bench:1:var:a'), dead: ctl.store.has('wm:bench:9:var:b') };
  const bk = deleted().find((f) => f.startsWith('orphan-b--'));
  if (bk) { const { DatabaseSync } = await import('node:sqlite'); const b = new DatabaseSync(`${BENCH_DELETED_DIR}/${bk}`, { readOnly: true }); out.backupRows = b.prepare('SELECT COUNT(*) AS n FROM ds_d').get().n; b.close(); }
  await st.set(benchKey(8, 'var', 'c'), 'dead2');
  ctl.offline();
  out.down = await sweep.run(now);
  ctl.back();
  out.later = await sweep.run(now + 31 * DAY);
  out.afterLater = { deleted: deleted(), files: files() };
  // W6、W7：删卡片连带清 Redis 键
  const { deleteCardWithBench } = await import(src('bench-card-delete.ts'));
  db.prepare("INSERT INTO workbenches (id, name, url) VALUES (3, '合成丙', 'http://127.0.0.1:9/c'), (4, '合成丁', 'http://127.0.0.1:9/d')").run();
  for (const id of [3, 4]) {
    const b = createBench({ workbench_id: id }, 'sweep-test', Date.now());
    const s = await benchStore(b.slug);
    await s.defineDataset({ name: 'd', columns: [{ name: 'id', type: 'integer' }], key: ['id'] }, ctx);
    await s.append('d', [{ id: 1 }], ctx);
    for (const k of ['a', 'b', 'c']) await st.set(benchKey(id, 'var', k), k);
  }
  const del = (id) => deleteCardWithBench({ id, deleter: { kind: 'owner' }, confirmBenchData: true, exists: () => !!db.prepare('SELECT 1 FROM workbenches WHERE id = ?').get(id), deleteCard: () => { db.prepare('DELETE FROM workbenches WHERE id = ?').run(id); } });
  const keysOf = (id) => [...ctl.store.keys()].filter((k) => k.startsWith(`wm:bench:${id}:`)).length;
  const d3 = await del(3);
  out.del3 = { ok: d3.ok, keys3: keysOf(3), keys4: keysOf(4), keys1: keysOf(1), file: files().includes('wb-3.sqlite') };
  ctl.offline();
  const d4 = await del(4);
  out.del4 = { ok: d4.ok, keysWhileDown: keysOf(4), file: files().includes('wb-4.sqlite') };
  ctl.back();
  out.sweep4 = await sweep.run(Date.now());
  out.del4.keysAfterSweep = keysOf(4);
  await closeBenchStores();
  await root.fiber.dispose();
  out.disposed = ctl.destroyed;
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function parent() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra === undefined ? '' : `（${JSON.stringify(extra)}）`}`); } };
  const dataDir = mkdtempSync(join(tmpdir(), 'wm-bench-sweep-'));
  const preload = `import{registerHooks}from'node:module';registerHooks({resolve(s,c,next){return s==='redis'?{url:${JSON.stringify(FAKE)},shortCircuit:true}:next(s,c)}});`;
  const env = { ...process.env, BENCH_SWEEP_CHILD: '1', DATA_DIR: dataDir, NODE_ENV: 'test', WM_VAULT_PATH: join(dataDir, 'vault.json'), REDIS_URL: 'redis://synthetic.invalid:1' };
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(import.meta.url)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => { const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{')); try { resolve(JSON.parse(line)); } catch { console.log(err.slice(-2000)); resolve({}); } });
  });
  rmSync(dataDir, { recursive: true, force: true });
  ok('W1 没有登记的库文件：先备份进 .deleted/、再删掉；登记着的不碰', r.first?.orphan_stores === 1 && JSON.stringify(r.afterFirst?.files) === '["keep-a.sqlite"]' && r.afterFirst.deleted.some((f) => f.startsWith('orphan-b--')) && r.backupRows === 2, { first: r.first, after: r.afterFirst, backupRows: r.backupRows });
  ok('W2 过了 30 天的备份删掉，没过的、不是备份的文件留着', r.first?.expired_backups === 1 && !r.afterFirst.deleted.some((f) => f.startsWith('old-x--')) && r.afterFirst.deleted.some((f) => f.startsWith('new-y--')) && r.afterFirst.deleted.includes('not-a-backup.txt'), r.afterFirst?.deleted);
  ok('W3 Redis 里卡片已经不在的台的键清掉（1 个），还在的不碰', r.first?.redis_keys === 1 && r.afterFirst.live && !r.afterFirst.dead, r.first);
  ok('W3 Redis 不通时这一项是 null，别的照做', r.down?.redis_keys === null && r.down.orphan_stores === 0, r.down);
  ok('W4 往后拨 31 天：W1 留的备份、29 天的那份都到期删掉；Redis 恢复后把不通时没清的键清掉；登记着的库照旧', r.later?.expired_backups === 2 && !r.afterLater.deleted.some((f) => f.endsWith('.sqlite')) && r.later.redis_keys === 1 && JSON.stringify(r.afterLater.files) === '["keep-a.sqlite"]', { later: r.later, after: r.afterLater });
  ok('W6 删卡片：这张卡片在 Redis 里的键一个不剩、库文件没了；别的卡片的键不碰', r.del3?.ok && r.del3.keys3 === 0 && r.del3.keys4 === 3 && r.del3.keys1 === 1 && !r.del3.file, r.del3);
  ok('W7 删卡片时 Redis 不通：卡片照删、库文件没了、键留着；清扫把它清掉', r.del4?.ok && r.del4.keysWhileDown === 3 && !r.del4.file && r.sweep4?.redis_keys === 3 && r.del4.keysAfterSweep === 0, { del4: r.del4, sweep4: r.sweep4 });
  ok('W5 卸载根上下文：Redis 连接断开（清扫的定时器在同一处停，timers-unload-test 守着没残留）', r.disposed === 1, r.disposed);
  console.log(`bench-sweep-test: ${pass} passed / ${fail} failed`);
  if (fail) process.exitCode = 1;
}
