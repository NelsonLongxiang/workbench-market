#!/usr/bin/env node
/**
 * 工作台的常量、变量存进卡片的台库（workbench-vars.ts 的 WM_VARS_STORE 三档；docs/data-views.md 第十三节第 5 条第 5 步）。
 * 子进程里装上服务容器（临时数据目录），直接调存法和迁移的函数：
 *
 *   M1 迁移 dry-run 只数、不写、不建台库；正式跑搬完；再跑一次是零写入（指纹没变整张卡片跳过）
 *   M2 只看 key + revision：台库里更新的值不会被主库的旧值盖回去；孤儿行（卡片已删）不搬、只报个数；hot. 开头的键报出来
 *   M3 bench 档：卡片第一次用到时搬一次、记指纹；搬过以后，主库里留着的旧行不会补回台库里已经删掉的键
 *   M4 shadow 档：主库写成之后台库跟着有一份；比对按摘要——条数一样、值不一样也算不同
 *   M5 bench 档写成之后尽力写回主库一份（留作回退）
 *   M6 旧的第 1 版台库：打开时补上 bs_vars、版本号升到 2；比代码新的照旧拒绝打开
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
  await import(src('context.ts'));
  const { db, dataDir } = await import(src('db.ts'));
  const V = await import(src('workbench-vars.ts'));
  const { benchStore, closeBenchStores } = await import(src('services/bench-store.ts'));
  const { benchOfCard } = await import(src('services/bench-registry.ts'));
  const out = {};
  const CLI = { actor: 'cli', admin: true, cli: true };
  const ins = db.prepare('INSERT INTO workbench_vars (workbench_id, key, kind, value, revision, updated_by, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.prepare("INSERT INTO workbenches (id, name, url) VALUES (1, '合成甲', 'http://127.0.0.1:9/a'), (2, '合成乙', 'http://127.0.0.1:9/b'), (3, '合成丙', 'http://127.0.0.1:9/c'), (4, '合成丁', 'http://127.0.0.1:9/d'), (5, '合成戊', 'http://127.0.0.1:9/e')").run();
  const T = '2026-11-01 08:00:00';
  ins.run(1, 'a', 'var', '1', 2, 'cli', '', T, T); ins.run(1, 'b', 'const', '"x"', 1, 'mcp:someone', 'mcp:someone', T, T);
  ins.run(2, 'hot.progress', 'var', '5', 1, 'cli', '', T, T);
  ins.run(99, 'gone', 'var', '0', 1, 'cli', '', T, T); // 孤儿：卡片 99 不存在
  const scope = (id) => V.workbenchScope(id);

  // M1
  out.dry = await V.migrateVars({ dryRun: true });
  out.dryStores = [benchOfCard(1), benchOfCard(2)].map((b) => b !== null);
  out.real = await V.migrateVars();
  out.again = await V.migrateVars();
  const s1 = await benchStore(benchOfCard(1).slug);
  out.benchRows1 = (await s1.varsList('')).map((r) => `${r.key}:${r.revision}:${r.value}:${r.updated_by}:${r.created_at}`);
  // M2：台库里更新的不被盖回；主库改了 a 的 revision 更小的旧值 → 不动
  await s1.varForce('a', { key: 'a', kind: 'var', value: '9', revision: 5, updated_by: 'cli', owner: '', created_at: T, updated_at: T });
  db.prepare("UPDATE workbench_vars SET value = '7', revision = 3 WHERE workbench_id = 1 AND key = 'a'").run(); // 主库变了（指纹变了），但 revision 3 < 台库的 5
  out.m2 = await V.migrateVars();
  out.m2a = (await s1.varGet('a'))?.value;
  // M3：bench 档，卡片 3 主库里有行、台库还没有
  ins.run(3, 'k', 'var', '"m"', 1, 'cli', '', T, T); ins.run(3, 'old', 'var', '"z"', 1, 'cli', '', T, T);
  V.setVarsStoreMode('bench');
  out.m3first = (await V.listVars(scope(3))).items.map((i) => i.key);
  const r3 = await V.deleteVar(scope(3), 'old', { expected: 1 }, CLI); // 台库里删了；写回主库也删了
  ins.run(3, 'old', 'var', '"z"', 1, 'cli', '', T, T); // 模拟写回主库失败：主库里还留着旧行
  V.setVarsStoreMode('bench'); // 换个「进程」（清掉进程内的已搬记录）
  out.m3after = (await V.listVars(scope(3))).items.map((i) => i.key);
  out.m3del = r3.deleted;
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
  // M6：把卡片 1 的台库改成第 1 版（删 bs_vars、版本号写 1），关掉再开
  const slug1 = benchOfCard(1).slug;
  await closeBenchStores();
  const f = new DatabaseSync(join(dataDir, 'bench-stores', `${slug1}.sqlite`));
  f.exec("DROP TABLE bs_vars; UPDATE bs_meta SET v = '1' WHERE k = 'schema_version'"); f.close();
  const re = await benchStore(slug1);
  out.m6 = { rows: (await re.varsList('')).length };
  await closeBenchStores();
  const f2 = new DatabaseSync(join(dataDir, 'bench-stores', `${slug1}.sqlite`));
  out.m6.version = f2.prepare("SELECT v FROM bs_meta WHERE k = 'schema_version'").get().v;
  f2.exec("UPDATE bs_meta SET v = '3' WHERE k = 'schema_version'"); f2.close();
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
  ok('再跑一次：零写入，两张卡片都按指纹跳过', r.again?.written === 0 && r.again.skipped === 2, r.again);
  console.log('M2 只看 key + revision');
  ok('主库的值变了但 revision 更小：台库里更新的值不被盖回去', r.m2?.written === 0 && r.m2a === '9', { m2: r.m2, a: r.m2a });
  ok('hot. 开头的键报出来（卡片 2 的 hot.progress）', JSON.stringify(r.hot) === JSON.stringify([{ workbench_id: 2, key: 'hot.progress' }]) && r.real?.hot === 1, r.hot);
  console.log('M3 bench 档第一次用到时搬');
  ok('卡片第一次用到：主库里的两行都搬进来', JSON.stringify(r.m3first) === '["k","old"]', r.m3first);
  ok('搬过以后：台库里删了的键，就算主库里还留着旧行，也不补回来', r.m3del === true && JSON.stringify(r.m3after) === '["k"]', r.m3after);
  console.log('M4 shadow 档');
  ok('主库写成之后台库跟着有一份；比对相同', r.m4bench === '"v1"' && r.m4same === true, { bench: r.m4bench, same: r.m4same });
  ok('比对按摘要：条数一样、值不一样也算不同', r.m4diff?.same === false && r.m4diff.countsEqual === true, r.m4diff);
  console.log('M5 bench 档写回主库');
  ok('写成之后主库里有一份一样的（值、revision），审计照旧记在主库', r.m5main?.value === '{"n":1}' && r.m5main.revision === 1 && r.m5audit === 'create', { main: r.m5main, audit: r.m5audit });
  console.log('M6 台库结构版本');
  ok('第 1 版的台库：打开时补上 bs_vars、版本号升到 2', r.m6?.rows === 0 && r.m6.version === '2', r.m6);
  ok('比代码新的（第 3 版）照旧拒绝打开', r.m6?.newer === 'unsupported', r.m6);
  console.log(`vars-store-test: ${pass} passed / ${fail} failed`);
  if (fail) process.exitCode = 1;
}
