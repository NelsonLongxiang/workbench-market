#!/usr/bin/env node
/**
 * 工作台的常量、变量存进卡片的台库（workbench-vars.ts 的 WM_VARS_STORE 三档；docs/data-views.md 第十三节第 5 条第 5 步）。
 * 子进程里装上服务容器（临时数据目录），直接调存法和迁移的函数：
 *
 *   M1 迁移 dry-run 只数、不写、不建台库；正式跑搬完；再跑一次是零写入（两边一致的卡片跳过）
 *   M2 同步点（syncCard）：台库没在 bench 档写过 → 以主库为准；bench 档的写入没写回、主库没变 → 补写回主库；两边都改过 → 报分叉、不动，
 *      --resolve 按 keep 那边整份换掉并写审计；孤儿行（卡片已删）不搬、只报个数；hot. 开头的键报出来
 *   M3 档位 bench → main → bench：main 档期间的修改切回 bench 后看得见，接着写不会出现同一个 revision、不同的值；
 *      bench 档写入没写回（进程中断）→ 下次补写回；两边都改过 → bench 档拒绝服务（503 vars_diverged）；
 *      同一张卡片两笔并发写、后一笔写回主库失败：不丢（dirty 只在两边真一致时清；同一张卡片的写入排队）
 *   M4 shadow 档：主库写成之后台库跟着有一份；比对按摘要——条数一样、值不一样也算不同
 *   M5 bench 档写成之后尽力写回主库一份（留作回退）
 *   M6 回退安全：main 档下台库和原来一样（版本 1、没有 bs_vars，读和比对、迁移 dry-run 都不建表），关了再开还是这样；
 *      切到 shadow 第一次写才建 bs_vars，版本号仍是 1（旧代码照样能开）；没有 bs_vars 的旧库照常打开；比代码新的照旧拒绝打开
 *
 *   node scripts/vars-store-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.VARS_STORE_CHILD) await child(); else await parent();

async function child() {
  const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
  const { DatabaseSync } = await import('node:sqlite');
  const { root } = await import(src('root-context.ts'));
  const { svc } = await import(src('context.ts'));
  const { db, dataDir } = await import(src('db.ts'));
  const V = await import(src('workbench-vars.ts'));
  const { benchStore, closeBenchStores } = await import(src('services/bench-store.ts'));
  const { benchOfCard, createBench } = await import(src('services/bench-registry.ts'));
  const out = {};
  const CLI = { actor: 'cli', admin: true, cli: true };
  const ins = db.prepare('INSERT INTO workbench_vars (workbench_id, key, kind, value, revision, updated_by, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.prepare("INSERT INTO workbenches (id, name, url) VALUES (1, '合成甲', 'http://127.0.0.1:9/a'), (2, '合成乙', 'http://127.0.0.1:9/b'), (3, '合成丙', 'http://127.0.0.1:9/c'), (4, '合成丁', 'http://127.0.0.1:9/d'), (5, '合成戊', 'http://127.0.0.1:9/e'), (6, '合成己', 'http://127.0.0.1:9/f'), (7, '合成庚', 'http://127.0.0.1:9/g')").run();
  const T = '2026-11-01 08:00:00';
  ins.run(1, 'a', 'var', '1', 2, 'cli', '', T, T); ins.run(1, 'b', 'const', '"x"', 1, 'mcp:someone', 'mcp:someone', T, T);
  ins.run(2, 'hot.progress', 'var', '5', 1, 'cli', '', T, T);
  ins.run(99, 'gone', 'var', '0', 1, 'cli', '', T, T); // 孤儿：卡片 99 不存在
  const scope = (id) => V.workbenchScope(id);
  const raw = async (slug, fn) => { await closeBenchStores(); const f = new DatabaseSync(join(dataDir, 'bench-stores', `${slug}.sqlite`)); try { return fn(f); } finally { f.close(); } };
  const shape = (f) => ({ version: f.prepare("SELECT v FROM bs_meta WHERE k = 'schema_version'").get().v, tables: f.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).join(',') });

  // M6（先做，main 档）：卡片 6 开了台库；main 档下写变量、读台库里的变量、比对、迁移 dry-run，都不动台库的结构
  const slug6 = createBench({ workbench_id: 6 }, 'vars-store-test', Date.now()).slug;
  const s6 = await benchStore(slug6);
  await V.setVar(scope(6), 'm', { value: 'v', hasValue: true }, CLI);
  out.m6main = { list: (await s6.varsList('')).length, get: await s6.varGet('m'), count: await s6.varCount(), digest: (await s6.varsDigest()).count, same: (await V.compareCardVars(6)).same };
  await V.migrateVars({ dryRun: true });
  out.m6main.shape = await raw(slug6, shape);
  await benchStore(slug6).then((s) => s.datasets()); // 关了再开
  out.m6main.reopen = await raw(slug6, shape);
  db.prepare('DELETE FROM workbench_vars WHERE workbench_id = 6').run(); // 不影响下面 M1 的计数

  // M1
  out.dry = await V.migrateVars({ dryRun: true });
  out.dryStores = [benchOfCard(1), benchOfCard(2)].map((b) => b !== null);
  out.real = await V.migrateVars();
  out.again = await V.migrateVars();
  const s1 = await benchStore(benchOfCard(1).slug);
  out.benchRows1 = (await s1.varsList('')).map((r) => `${r.key}:${r.revision}:${r.value}:${r.updated_by}:${r.created_at}`);
  const { varsDigestOf } = await import(src('services/bench-store.ts'));
  const varsDigestOfMain = (id) => varsDigestOf(db.prepare('SELECT * FROM workbench_vars WHERE workbench_id = ? ORDER BY key').all(id));
  const mainRow = (id, key) => db.prepare('SELECT value, revision FROM workbench_vars WHERE workbench_id = ? AND key = ?').get(id, key) ?? null;
  const s2 = await benchStore(benchOfCard(2).slug);
  // M2a：台库被改过但不是 bench 档写的（没有 dirty），主库也变了 → 以主库为准
  await s1.varForce('a', { key: 'a', kind: 'var', value: '9', revision: 5, updated_by: 'cli', owner: '', created_at: T, updated_at: T });
  db.prepare("UPDATE workbench_vars SET value = '7', revision = 3 WHERE workbench_id = 1 AND key = 'a'").run();
  out.m2 = await V.migrateVars();
  out.m2a = await s1.varGet('a').then((r) => `${r?.revision}:${r?.value}`);
  // M2b：bench 档写过（dirty）、没写回，主库没变 → 补写回主库
  await s2.varUpdate({ key: 'hot.progress', expected: 1, kind: 'var', value: '6', by: 'cli', owner: '', at: T });
  out.m2b = { run: await V.migrateVars(), main: mainRow(2, 'hot.progress') };
  // M2c：bench 档写过（dirty）、主库也改了 → 分叉，不动；--resolve 以台库为准
  await s1.varUpdate({ key: 'b', expected: 1, kind: 'const', value: '"bench"', by: 'mcp:someone', owner: 'mcp:someone', at: T });
  db.prepare("UPDATE workbench_vars SET value = '\"main\"', revision = 2 WHERE workbench_id = 1 AND key = 'b'").run();
  out.m2c = { run: await V.migrateVars(), main: mainRow(1, 'b'), bench: await s1.varGet('b').then((r) => r?.value) };
  out.m2c.resolve = await V.resolveCardVars(1, 'bench', 'builtin:local-cli');
  out.m2c.after = { main: mainRow(1, 'b'), audit: db.prepare("SELECT action, reason FROM workbench_var_audit WHERE workbench_id = 1 AND key = 'b' ORDER BY id DESC").get(), again: await V.migrateVars() };
  // M3：档位 bench → main → bench（验收复现的那一串），卡片 3
  V.setVarsStoreMode('bench');
  await V.setVar(scope(3), 'a', { value: 1, hasValue: true }, CLI);
  V.setVarsStoreMode('main');
  await V.setVar(scope(3), 'a', { value: 2, hasValue: true, expected: 1 }, CLI);
  await V.setVar(scope(3), 'b', { value: 9, hasValue: true }, CLI);
  V.setVarsStoreMode('bench');
  const items3 = async () => Object.fromEntries((await V.listVars(scope(3))).items.map((i) => [i.key, `${i.revision}:${JSON.stringify(i.value)}`]));
  out.m3back = await items3();
  await V.setVar(scope(3), 'a', { value: 3, hasValue: true, expected: 2 }, CLI);
  out.m3write = { bench: await items3(), main: mainRow(3, 'a') };
  // bench 档的写入没写回（进程在写回之前中断）→ 下一个进程补写回
  const s3 = await benchStore(benchOfCard(3).slug);
  await s3.varUpdate({ key: 'b', expected: 1, kind: 'var', value: '10', by: 'cli', owner: '', at: T });
  V.setVarsStoreMode('bench');
  out.m3crash = { bench: await items3(), main: mainRow(3, 'b') };
  // 并发两笔（卡片 7，验收给的探针）：a 改成 2、新建 b = 9，b 写回主库时抛错 → 换进程后 b 还在，并补写回主库
  await V.setVar(scope(7), 'a', { value: 1, hasValue: true }, CLI);
  const S = svc('workbenchVars'), realForce = S.force.bind(S), realAudit = S.audit.bind(S);
  const order = [];
  S.audit = (r) => { if (r.workbench_id === 7) order.push(`audit:${r.key}`); return realAudit(r); };
  S.force = (id, key, row) => { if (id === 7) order.push(`force:${key}`); if (id === 7 && key === 'b') throw new Error('合成：写回失败'); return realForce(id, key, row); };
  // a 写进台库之后拖 50 毫秒再往下走：不排队的话，b 会在这段时间里插进来
  const st7 = await benchStore(benchOfCard(7).slug), realGet = st7.varGet.bind(st7);
  st7.varGet = async (k) => { const r = await realGet(k); if (k === 'a' && order.includes('audit:a') && !order.includes('force:a')) await new Promise((res) => setTimeout(res, 50)); return r; };
  const before = V.varsMirrorStats().fallbackFailures;
  const both = await Promise.allSettled([V.setVar(scope(7), 'a', { value: 2, hasValue: true, expected: 1 }, CLI), V.setVar(scope(7), 'b', { value: 9, hasValue: true }, CLI)]);
  S.force = realForce; S.audit = realAudit; st7.varGet = realGet;
  const failures = V.varsMirrorStats().fallbackFailures - before;
  V.setVarsStoreMode('bench');
  const items7 = Object.fromEntries((await V.listVars(scope(7))).items.map((i) => [i.key, `${i.revision}:${JSON.stringify(i.value)}`]));
  out.m3race = { ok: both.map((x) => x.status), failures, order, items: items7, main: mainRow(7, 'b') };
  // varsSynced 只在台库和给的主库摘要真一致时清 dirty：台库多一笔没写回的，记同步点之后 dirty 还在
  const s7 = await benchStore(benchOfCard(7).slug);
  await s7.varInsert({ key: 'c', kind: 'var', value: '1', by: 'cli', owner: '', at: T });
  const synced = await s7.varsSynced(varsDigestOfMain(7));
  out.m3clean = { synced, dirty: (await s7.varsSyncGet()).dirty };
  // 两边都改过 → bench 档拒绝服务
  await s3.varUpdate({ key: 'b', expected: 2, kind: 'var', value: '11', by: 'cli', owner: '', at: T });
  db.prepare("UPDATE workbench_vars SET value = '12', revision = 3 WHERE workbench_id = 3 AND key = 'b'").run();
  V.setVarsStoreMode('bench');
  out.m3div = await V.listVars(scope(3)).then(() => 'served', (e) => `${e.status}:${e.extra?.code ?? e.details?.code ?? e.code}`);
  // M5：bench 档写成之后写回主库
  await V.setVar(scope(4), 'w', { value: { n: 1 }, hasValue: true }, CLI);
  out.m5main = db.prepare("SELECT value, revision FROM workbench_vars WHERE workbench_id = 4 AND key = 'w'").get();
  out.m5audit = db.prepare("SELECT action FROM workbench_var_audit WHERE workbench_id = 4 AND key = 'w'").get()?.action;
  // M4：shadow 档
  V.setVarsStoreMode('shadow');
  await V.setVar(scope(5), 's', { value: 'v1', hasValue: true }, CLI);
  const b5 = benchOfCard(5);
  out.m4bench = b5 ? (await (await benchStore(b5.slug)).varGet('s'))?.value : null;
  out.m4same = (await V.compareCardVars(5)).same;
  // 条数一样、值不一样
  db.prepare("UPDATE workbench_vars SET value = '\"v2\"' WHERE workbench_id = 5 AND key = 's'").run();
  const c = await V.compareCardVars(5);
  out.m4diff = { same: c.same, countsEqual: c.main.count === c.bench?.count };
  out.hot = V.hotVarKeys();
  // M6（接着）：现在是 shadow 档，卡片 6 第一次写：建 bs_vars，版本号仍是 1
  await V.setVar(scope(6), 'n', { value: 'w', hasValue: true }, CLI);
  out.m6shadow = { ...(await raw(slug6, shape)), value: await benchStore(slug6).then((s) => s.varGet('n')).then((r) => r?.value) };
  // 没有 bs_vars 的旧库（旧代码或 main 档建的）：照常打开、读成空；写一次就建上
  const slug1 = benchOfCard(1).slug;
  await raw(slug1, (f) => f.exec('DROP TABLE bs_vars'));
  const re = await benchStore(slug1);
  out.m6 = { rows: (await re.varsList('')).length, put: await re.varsImport([{ key: 'z', kind: 'var', value: '1', revision: 1, updated_by: 'cli', owner: '', created_at: T, updated_at: T }]) };
  out.m6.after = await raw(slug1, shape);
  await raw(slug1, (f) => f.exec("UPDATE bs_meta SET v = '3' WHERE k = 'schema_version'"));
  out.m6.newer = await benchStore(slug1).then(async (s) => { try { await s.varsList(''); return 'opened'; } catch (e) { return e.code; } }, (e) => e.code);
  await closeBenchStores();
  await root.fiber.dispose();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function parent() {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x === undefined ? '' : `（${JSON.stringify(x)}）`}`); } };
  const dataDir = mkdtempSync(join(tmpdir(), 'wm-vars-store-'));
  const env = { ...process.env, VARS_STORE_CHILD: '1', DATA_DIR: dataDir, NODE_ENV: 'test', WM_VAULT_PATH: join(dataDir, 'vault.json') };
  delete env.REDIS_URL; delete env.WM_VARS_STORE;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => { const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{')); try { resolve(JSON.parse(line)); } catch { console.log(err.slice(-3000)); resolve({}); } });
  });
  rmSync(dataDir, { recursive: true, force: true });
  console.log('M1 迁移');
  ok('dry-run 只数：两张卡片、3 行、要写 3 行；孤儿 1 行；不建台库', r.dry?.cards === 2 && r.dry.rows === 3 && r.dry.written === 3 && r.dry.orphans === 1 && r.dryStores?.every((x) => x === false), { dry: r.dry, stores: r.dryStores });
  ok('正式跑：搬了 3 行，原样（值、revision、写的人、时间文本）', r.real?.written === 3 && JSON.stringify(r.benchRows1) === JSON.stringify(['a:2:1:cli:2026-11-01 08:00:00', 'b:1:"x":mcp:someone:2026-11-01 08:00:00']), { real: r.real, rows: r.benchRows1 });
  ok('再跑一次：零写入，两张卡片都一致、跳过', r.again?.written === 0 && r.again.skipped === 2, r.again);
  console.log('M2 同步点');
  ok('台库被改过但不是 bench 档写的：以主库为准（a 回到主库的 rev 3、值 7）', r.m2?.written === 2 && r.m2a === '3:7', { m2: r.m2, a: r.m2a });
  ok('bench 档写过、没写回、主库没变：补写回主库', r.m2b?.run.to_main === 1 && r.m2b.main?.value === '6' && r.m2b.main.revision === 2, r.m2b);
  ok('bench 档写过、主库也改了：报分叉，两边都不动', JSON.stringify(r.m2c?.run.diverged) === '[1]' && r.m2c.main?.value === '"main"' && r.m2c.bench === '"bench"', r.m2c);
  ok('--resolve 以台库为准：主库换成台库那份，按键写审计，之后再跑跳过', r.m2c?.resolve?.changed === 1 && r.m2c.after?.main?.value === '"bench"' && r.m2c.after.audit?.action === 'resolve' && r.m2c.after.again?.diverged.length === 0 && r.m2c.after.again.written === 0, { resolve: r.m2c?.resolve, after: r.m2c?.after });
  ok('hot. 开头的键报出来（卡片 2 的 hot.progress）', JSON.stringify(r.hot) === JSON.stringify([{ workbench_id: 2, key: 'hot.progress' }]) && r.real?.hot === 1, r.hot);
  console.log('M3 档位 bench → main → bench');
  ok('切回 bench：main 档期间的修改看得见（a 是 rev 2 的 2，b 是 9）', JSON.stringify(r.m3back) === '{"a":"2:2","b":"1:9"}', r.m3back);
  ok('接着在 bench 档按 rev 2 改 a：台库 rev 3、主库也是 rev 3 的同一个值', r.m3write?.bench.a === '3:3' && r.m3write.main?.revision === 3 && r.m3write.main.value === '3', r.m3write);
  ok('bench 档的写入没写回（进程中断）：下一个进程补写回主库', r.m3crash?.bench.b === '2:10' && r.m3crash.main?.value === '10' && r.m3crash.main.revision === 2, r.m3crash);
  ok('两边都改过：bench 档拒绝服务（503 vars_diverged），不静默以哪边为准', r.m3div === '503:vars_diverged', r.m3div);
  ok('同一张卡片两笔并发写、b 写回主库失败：换进程后 b 还在（rev 1 的 9），并补写回了主库', JSON.stringify(r.m3race?.ok) === '["fulfilled","fulfilled"]' && r.m3race.failures === 1 && r.m3race.items.a === '2:2' && r.m3race.items.b === '1:9' && r.m3race.main?.value === '9', r.m3race);
  ok('同一张卡片的写入排队：一笔的写台库（审计）、写回主库做完，下一笔才开始', JSON.stringify(r.m3race?.order) === '["audit:a","force:a","audit:b","force:b"]', r.m3race?.order);
  ok('记同步点时台库还有没写回的：dirty 不清', r.m3clean?.synced?.clean === false && r.m3clean.dirty === true, r.m3clean);
  console.log('M4 shadow 档');
  ok('主库写成之后台库跟着有一份；比对相同', r.m4bench === '"v1"' && r.m4same === true, { bench: r.m4bench, same: r.m4same });
  ok('比对按摘要：条数一样、值不一样也算不同', r.m4diff?.same === false && r.m4diff.countsEqual === true, r.m4diff);
  console.log('M5 bench 档写回主库');
  ok('写成之后主库里有一份一样的（值、revision），审计照旧记在主库', r.m5main?.value === '{"n":1}' && r.m5main.revision === 1 && r.m5audit === 'create', { main: r.m5main, audit: r.m5audit });
  console.log('M6 回退安全（台库结构）');
  // 第 1 版台库的表（main 上的代码建出来的那一套）
  const V1 = 'bs_changes,bs_dataset_versions,bs_datasets,bs_meta,bs_snapshot_rows,bs_snapshots,bs_view_versions,bs_writes,sqlite_sequence';
  const m = r.m6main;
  ok('main 档：写变量、读台库里的变量、比对、迁移 dry-run 都不建 bs_vars，版本号是 1，表和原来一样', m?.list === 0 && m.get === null && m.count === 0 && m.digest === 0 && m.shape?.version === '1' && m.shape.tables === V1, m);
  ok('main 档：关了再开还是版本 1、没有 bs_vars', m?.reopen?.version === '1' && m.reopen.tables === V1, m?.reopen);
  ok('切到 shadow 第一次写：建了 bs_vars、值写进去了，版本号仍是 1（旧代码照样能开）', r.m6shadow?.version === '1' && r.m6shadow.tables === [...V1.split(','), 'bs_vars'].sort().join(',') && r.m6shadow.value === '"w"', r.m6shadow);
  ok('没有 bs_vars 的旧库：照常打开、读成空；写一次就建上，版本号不变', r.m6?.rows === 0 && r.m6.put === 1 && r.m6.after?.version === '1' && r.m6.after.tables.includes('bs_vars'), r.m6);
  ok('比代码新的（第 3 版）照旧拒绝打开', r.m6?.newer === 'unsupported', r.m6);
  console.log(`vars-store-test: ${pass} passed / ${fail} failed`);
  if (fail) process.exitCode = 1;
}
