#!/usr/bin/env node
/**
 * 高频变量（键名以 hot. 开头；workbench-vars.ts，docs/data-views.md 第十三节第 5 条第 5 步）。
 * 子进程里装上服务容器，把 redis 包换成进程内的假 Redis（scripts/fixtures/state-layer-redis.mjs），不连网络；临时数据目录，合成数据：
 *
 *   H1 hot. 开头的键不能是常量（main、bench 两档一样拒）
 *   H2 bench 档、Redis 连着：写进 Redis、不进台库也不进主库；读、列表读到的是 Redis 那份；台库记上「有待落盘」；审计照旧当场记在主库
 *   H3 落盘：Redis 那份进台库、写回主库，Redis 那份删掉，「有待落盘」清掉，两边一致
 *   H4 删高频变量：Redis 里记删除，读 404、列表里没有；落盘后台库、主库都删了
 *   H5 Redis 不通、有待落盘：高频变量的读写回 503（可重试），普通变量照常；读完、写之前断开，写也回 503、不落进台库
 *   H6 Redis 不通、没有待落盘：高频变量照普通变量直接写台库和主库
 *   H7 换进程（没落盘就退了）：Redis 连着时第一次用到先落盘、再对同步点，值和主库都对
 *   H8 换进程、Redis 不通、有待落盘：整张卡片回 503（可重试），不拿台库里可能旧的值对同步点；恢复后照常
 *   H9 换进程、Redis 里的高频变量没落盘，主库在 main 档期间又改了：报分叉（503 vars_diverged），不静默以哪边为准
 *   H10 Redis 整个丢了（有待落盘、hash 没了）：落盘时什么也没有，清掉「有待落盘」，值回到上一次落盘的（最多丢一个周期）
 *   H11 没配 Redis：高频变量就是普通变量（直接写台库和主库），不记待落盘
 *   H12 bench 档写回主库时，主库那行版本一样、值不同：算写回失败，dirty 留着（不静默跳过）
 *   H13 bench 档退出前没落完盘、以 main / shadow 档起来：启动时报出卡片号；这些卡片的高频变量读写、可能含高频变量的列表回 503，
 *       不悄悄读主库里的旧值；普通变量照常。回到 bench 档落完盘以后，main 档照常
 *   H14 删卡片和落盘撞在一起：卡片删了以后落盘、落盘读台库的那一刻卡片被删，都不往主库补孤儿行，待落盘的记录清掉
 *
 *   node scripts/vars-hot-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = pathToFileURL(join(ROOT, 'scripts/fixtures/state-layer-redis.mjs')).href;
if (process.env.VARS_HOT_CHILD) await child(process.env.VARS_HOT_CHILD); else await parent();

async function child(mode) {
  const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
  const { root } = await import(src('root-context.ts'));
  const { svc } = await import(src('context.ts'));
  const { db } = await import(src('db.ts'));
  const { startRedis } = await import(src('redis.ts'));
  const V = await import(src('workbench-vars.ts'));
  const { benchStore, closeBenchStores } = await import(src('services/bench-store.ts'));
  const { benchOfCard } = await import(src('services/bench-registry.ts'));
  startRedis();
  await new Promise((r) => setImmediate(r));
  const ctl = globalThis.__stateRedis;
  const out = {};
  const CLI = { actor: 'cli', admin: true, cli: true };
  db.prepare("INSERT INTO workbenches (id, name, url) VALUES (1, '合成甲', 'http://127.0.0.1:9/a'), (2, '合成乙', 'http://127.0.0.1:9/b'), (3, '合成丙', 'http://127.0.0.1:9/c'), (4, '合成丁', 'http://127.0.0.1:9/d'), (5, '合成戊', 'http://127.0.0.1:9/e'), (6, '合成己', 'http://127.0.0.1:9/f'), (7, '合成庚', 'http://127.0.0.1:9/g'), (8, '合成辛', 'http://127.0.0.1:9/h')").run();
  const scope = (id) => V.workbenchScope(id);
  const err = (e) => `${e.status}:${e.extra?.code ?? ''}${e.extra?.retryable ? ':retry' : ''}`;
  const tryIt = (p) => p.then((r) => r, (e) => err(e));
  const mainRow = (id, key) => db.prepare('SELECT value, revision FROM workbench_vars WHERE workbench_id = ? AND key = ?').get(id, key) ?? null;
  const audit = (id, key) => db.prepare('SELECT action FROM workbench_var_audit WHERE workbench_id = ? AND key = ? ORDER BY id').all(id, key).map((r) => r.action);
  const benchRow = async (id, key) => { const b = benchOfCard(id); return b ? (await (await benchStore(b.slug)).varGet(key)) : null; };
  const sync = async (id) => (await (await benchStore(benchOfCard(id).slug)).varsSyncGet());
  const hotHash = (id) => ctl.store.get(`wm:bench:${id}:vars:hot`);
  const restart = () => V.setVarsStoreMode('bench'); // 换个「进程」：清掉进程内的记录（已对过同步点的卡片、有待落盘的卡片）

  if (mode === 'off') {
    V.setVarsStoreMode('bench');
    await V.setVar(scope(1), 'hot.p', { value: 1, hasValue: true }, CLI);
    out.h11 = { bench: (await benchRow(1, 'hot.p'))?.value, main: mainRow(1, 'hot.p'), pending: (await sync(1)).hotPending };
  } else {
    // H1
    V.setVarsStoreMode('main');
    const h1main = await tryIt(V.setVar(scope(1), 'hot.c', { value: 1, hasValue: true, kind: 'const' }, CLI));
    V.setVarsStoreMode('bench');
    const h1bench = await tryIt(V.setVar(scope(1), 'hot.c', { value: 1, hasValue: true, kind: 'const' }, CLI));
    out.h1 = { main: h1main, bench: h1bench };
    // H2：卡片 1 先有一个普通变量（台库、主库都有），再写高频变量
    await V.setVar(scope(1), 'plain', { value: 'x', hasValue: true }, CLI);
    await V.setVar(scope(1), 'hot.p', { value: 1, hasValue: true }, CLI);
    const w2 = await V.setVar(scope(1), 'hot.p', { value: 2, hasValue: true, expected: 1 }, CLI);
    out.h2 = {
      rev: w2.revision, get: (await V.getVar(scope(1), 'hot.p')).value, list: (await V.listVars(scope(1))).items.map((i) => `${i.key}:${i.revision}`),
      prefix: (await V.listVars(scope(1), 'hot.')).items.map((i) => i.key), redis: Object.keys(hotHash(1) ?? {}),
      bench: await benchRow(1, 'hot.p'), main: mainRow(1, 'hot.p'), pending: (await sync(1)).hotPending, audit: audit(1, 'hot.p'),
    };
    // H3
    out.h3flush = await V.flushHotVars();
    const s3 = await sync(1);
    out.h3 = { bench: (await benchRow(1, 'hot.p'))?.revision, main: mainRow(1, 'hot.p'), redis: hotHash(1) ?? null, pending: s3.hotPending, dirty: s3.dirty, same: (await V.compareCardVars(1)).same };
    // H4
    const d4 = await V.deleteVar(scope(1), 'hot.p', { expected: 2 }, CLI);
    out.h4 = { del: d4.deleted, get: await tryIt(V.getVar(scope(1), 'hot.p')), list: (await V.listVars(scope(1))).items.map((i) => i.key), benchBefore: (await benchRow(1, 'hot.p'))?.revision };
    await V.flushHotVars();
    out.h4.after = { bench: await benchRow(1, 'hot.p'), main: mainRow(1, 'hot.p'), pending: (await sync(1)).hotPending };
    // H5：卡片 2 有待落盘，Redis 下线
    await V.setVar(scope(2), 'plain', { value: 'y', hasValue: true }, CLI);
    await V.setVar(scope(2), 'hot.q', { value: 1, hasValue: true }, CLI);
    ctl.offline();
    out.h5 = {
      get: await tryIt(V.getVar(scope(2), 'hot.q')), list: await tryIt(V.listVars(scope(2))), set: await tryIt(V.setVar(scope(2), 'hot.q', { value: 9, hasValue: true, expected: 1 }, CLI)),
      plain: (await V.getVar(scope(2), 'plain')).value, flush: await V.flushHotVars(),
    };
    // H6：卡片 3 没有待落盘，Redis 还是下线
    await V.setVar(scope(3), 'hot.r', { value: 5, hasValue: true }, CLI);
    out.h6 = { bench: (await benchRow(3, 'hot.r'))?.value, main: mainRow(3, 'hot.r')?.value, pending: (await sync(3)).hotPending, redis: hotHash(3) ?? null };
    ctl.back();
    out.h5.back = { get: (await V.getVar(scope(2), 'hot.q')).value };
    // 读完、写之前 Redis 断开（卡片 2 还有待落盘）：写也回 503，不落进台库
    // 新建要先读这一行（hGet）、再数键（hGetAll）：数完键之后断开
    const st = svc('state'), realAll = st.hGetAll.bind(st);
    st.hGetAll = async (...a) => { const r = await realAll(...a); st.hGetAll = realAll; ctl.offline(); return r; };
    out.h5.midway = { set: await tryIt(V.setVar(scope(2), 'hot.new', { value: 8, hasValue: true }, CLI)), bench: await benchRow(2, 'hot.new'), main: mainRow(2, 'hot.new') };
    ctl.back();
    // H7：卡片 4 写了高频变量没落盘就「退出」，Redis 连着
    await V.setVar(scope(4), 'hot.s', { value: 'a', hasValue: true }, CLI);
    restart();
    out.h7 = { get: (await V.getVar(scope(4), 'hot.s')).value, bench: (await benchRow(4, 'hot.s'))?.value, main: mainRow(4, 'hot.s')?.value, redis: hotHash(4) ?? null, pending: (await sync(4)).hotPending };
    // H8：卡片 5 写了没落盘就「退出」，起来时 Redis 不通
    await V.setVar(scope(5), 'plain', { value: 'z', hasValue: true }, CLI);
    await V.setVar(scope(5), 'hot.t', { value: 'b', hasValue: true }, CLI);
    restart();
    ctl.offline();
    out.h8 = { plain: await tryIt(V.getVar(scope(5), 'plain')), hot: await tryIt(V.getVar(scope(5), 'hot.t')) };
    ctl.back();
    out.h8.back = { plain: (await V.getVar(scope(5), 'plain')).value, hot: (await V.getVar(scope(5), 'hot.t')).value, main: mainRow(5, 'hot.t')?.value };
    // H9：卡片 6 写了没落盘；main 档期间主库又改了别的键
    await V.setVar(scope(6), 'plain', { value: 1, hasValue: true }, CLI);
    await V.setVar(scope(6), 'hot.u', { value: 1, hasValue: true }, CLI);
    V.setVarsStoreMode('main');
    await V.setVar(scope(6), 'plain', { value: 2, hasValue: true, expected: 1 }, CLI);
    restart();
    out.h9 = await tryIt(V.listVars(scope(6)));
    // H10：卡片 2 再写一笔（有待落盘），Redis 整个丢了
    await V.setVar(scope(2), 'hot.q', { value: 3, hasValue: true, expected: 1 }, CLI);
    ctl.store.clear();
    out.h10 = { get: (await V.getVar(scope(2), 'hot.q')).value, flush: await V.flushHotVars(), pending: (await sync(2)).hotPending, after: (await V.getVar(scope(2), 'hot.q')).value };
    // H12：卡片 3 的普通变量 k（rev 1，两边一样）；主库那行被别处改成 rev 2、值不同；bench 档按 rev 1 改 k → 台库 rev 2 → 写回时主库也是 rev 2、值不同
    await V.setVar(scope(3), 'k', { value: 1, hasValue: true }, CLI);
    db.prepare("UPDATE workbench_vars SET revision = 2, value = '99' WHERE workbench_id = 3 AND key = 'k'").run();
    const before = V.varsMirrorStats().fallbackFailures;
    await V.setVar(scope(3), 'k', { value: 7, hasValue: true, expected: 1 }, CLI);
    // H13：卡片 7 写了高频变量、没落盘（Redis 正好断开），以 main 档、shadow 档起来
    await V.setVar(scope(7), 'plain', { value: 1, hasValue: true }, CLI);
    await V.setVar(scope(7), 'hot.v', { value: 1, hasValue: true }, CLI);
    ctl.offline(); await V.flushHotVars(); ctl.back();
    const h13 = {};
    for (const m of ['main', 'shadow']) {
      V.setVarsStoreMode(m);
      h13[m] = {
        report: V.reportHotPending(), get: await tryIt(V.getVar(scope(7), 'hot.v')), list: await tryIt(V.listVars(scope(7))), listHot: await tryIt(V.listVars(scope(7), 'hot.')),
        listPlain: (await V.listVars(scope(7), 'pl')).count, set: await tryIt(V.setVar(scope(7), 'hot.v', { value: 2, hasValue: true, expected: 1 }, CLI)),
        plain: (await V.getVar(scope(7), 'plain')).value,
      };
    }
    restart();
    await V.listVars(scope(7)); // 回到 bench 档：第一次用到先落盘
    V.setVarsStoreMode('main');
    h13.after = { report: V.reportHotPending(), get: (await V.getVar(scope(7), 'hot.v')).value };
    restart();
    out.h13 = h13;
    // H14：卡片 8 写了高频变量，落盘之前卡片被删（主库的卡片、常量变量都没了）
    await V.setVar(scope(8), 'hot.w', { value: 1, hasValue: true }, CLI);
    db.prepare('DELETE FROM workbenches WHERE id = 8').run(); V.dropWorkbenchVars(8);
    out.h14 = { flush: await V.flushHotVars(), orphans: db.prepare('SELECT COUNT(*) AS n FROM workbench_vars WHERE workbench_id = 8').get().n, report: V.reportHotPending() };
    // H14b：落盘已经开始（Redis 那份落进了台库），读台库准备写回主库的那一刻卡片被删
    db.prepare("INSERT INTO workbenches (id, name, url) VALUES (9, '合成壬', 'http://127.0.0.1:9/i')").run();
    await V.setVar(scope(9), 'hot.x', { value: 1, hasValue: true }, CLI);
    const s9 = await benchStore(benchOfCard(9).slug), realList = s9.varsList.bind(s9);
    let hit = 0;
    s9.varsList = async (...a) => { const r = await realList(...a); if (!hit++) { db.prepare('DELETE FROM workbenches WHERE id = 9').run(); V.dropWorkbenchVars(9); } return r; };
    await V.flushHotVars();
    s9.varsList = realList;
    // H14c：对同步点要补写回主库（bench 档的写入没写回），读台库的那一刻卡片被删
    db.prepare("INSERT INTO workbenches (id, name, url) VALUES (10, '合成癸', 'http://127.0.0.1:9/j')").run();
    await V.setVar(scope(10), 'k', { value: 1, hasValue: true }, CLI);
    const s10 = await benchStore(benchOfCard(10).slug), realList10 = s10.varsList.bind(s10);
    await s10.varUpdate({ key: 'k', expected: 1, kind: 'var', value: '2', by: 'cli', owner: '', at: '2026-11-01 08:00:00' }); // 记 dirty、没写回
    let hit10 = 0;
    s10.varsList = async (...a) => { const r = await realList10(...a); if (!hit10++) { db.prepare('DELETE FROM workbenches WHERE id = 10').run(); V.dropWorkbenchVars(10); } return r; };
    const m10 = await V.migrateVars();
    s10.varsList = realList10;
    out.h14c = { hit: hit10, toMain: m10.to_main, orphans: db.prepare('SELECT COUNT(*) AS n FROM workbench_vars WHERE workbench_id = 10').get().n };
    out.h14b = { hit, orphans: db.prepare('SELECT COUNT(*) AS n FROM workbench_vars WHERE workbench_id = 9').get().n, report: V.reportHotPending() };
    out.h12 = { failures: V.varsMirrorStats().fallbackFailures - before, dirty: (await sync(3)).dirty, main: mainRow(3, 'k')?.value };
  }
  await closeBenchStores();
  await root.fiber.dispose();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function parent() {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x === undefined ? '' : `（${JSON.stringify(x)}）`}`); } };
  const run = (mode) => new Promise((resolve) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wm-vars-hot-'));
    const preload = `import{registerHooks}from'node:module';registerHooks({resolve(s,c,next){return s==='redis'?{url:${JSON.stringify(FAKE)},shortCircuit:true}:next(s,c)}});`;
    const env = { ...process.env, VARS_HOT_CHILD: mode, DATA_DIR: dataDir, NODE_ENV: 'test', WM_VAULT_PATH: join(dataDir, 'vault.json') };
    delete env.REDIS_URL; delete env.WM_VARS_STORE;
    if (mode === 'on') env.REDIS_URL = 'redis://synthetic.invalid:1';
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(import.meta.url)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => { rmSync(dataDir, { recursive: true, force: true }); const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{')); try { resolve(JSON.parse(line)); } catch { console.log(err.slice(-3000)); resolve({}); } });
  });
  const [on, off] = await Promise.all([run('on'), run('off')]);
  console.log('H1 hot. 不能是常量');
  ok('main、bench 两档都回 400', on.h1?.main === '400:' && on.h1.bench === '400:', on.h1);
  console.log('H2 写进 Redis');
  const h2 = on.h2;
  ok('读、列表、前缀列表读到的是 Redis 那份（rev 2 的 2）', h2?.rev === 2 && h2.get === 2 && JSON.stringify(h2.list) === '["hot.p:2","plain:1"]' && JSON.stringify(h2.prefix) === '["hot.p"]', h2);
  ok('台库、主库都还没有；Redis 里有；台库记了「有待落盘」；审计当场记了两笔', JSON.stringify(h2?.redis) === '["hot.p"]' && h2.bench === null && h2.main === null && h2.pending === true && JSON.stringify(h2.audit) === '["create","update"]', h2);
  console.log('H3 落盘');
  ok('Redis 那份进了台库和主库（rev 2），Redis 那份删了，待落盘、dirty 清掉，两边一致', on.h3?.bench === 2 && on.h3.main?.revision === 2 && on.h3.main.value === '2' && on.h3.redis === null && on.h3.pending === false && on.h3.dirty === false && on.h3.same === true, { flush: on.h3flush, h3: on.h3 });
  console.log('H4 删高频变量');
  ok('删了以后读 404、列表里没有；台库在落盘前还留着', on.h4?.del === true && on.h4.get === '404:not_found' && JSON.stringify(on.h4.list) === '["plain"]' && on.h4.benchBefore === 2, on.h4);
  ok('落盘后台库、主库都删了', on.h4?.after?.bench === null && on.h4.after.main === null && on.h4.after.pending === false, on.h4?.after);
  console.log('H5 Redis 不通、有待落盘');
  ok('高频变量的读、列表、写都回 503（可重试）；普通变量照常', on.h5?.get === '503:vars_hot_unavailable:retry' && on.h5.list === '503:vars_hot_unavailable:retry' && on.h5.set === '503:vars_hot_unavailable:retry' && on.h5.plain === 'y', on.h5);
  ok('Redis 恢复后读到的是 Redis 那份', on.h5?.back?.get === 1, on.h5?.back);
  ok('读完、写之前 Redis 断开：写回 503（可重试），不落进台库', on.h5?.midway?.set === '503:vars_hot_unavailable:retry' && on.h5.midway.bench === null && on.h5.midway.main === null, on.h5?.midway);
  console.log('H6 Redis 不通、没有待落盘');
  ok('高频变量照普通变量直接写台库和主库，不记待落盘', on.h6?.bench === '5' && on.h6.main === '5' && on.h6.pending === false && on.h6.redis === null, on.h6);
  console.log('H7 换进程、Redis 连着');
  ok('第一次用到先落盘、再对同步点：值对，台库、主库都有，Redis 那份删了', on.h7?.get === 'a' && on.h7.bench === '"a"' && on.h7.main === '"a"' && on.h7.redis === null && on.h7.pending === false, on.h7);
  console.log('H8 换进程、Redis 不通、有待落盘');
  ok('整张卡片回 503（可重试），连普通变量也不读', on.h8?.plain === '503:vars_hot_unavailable:retry' && on.h8.hot === '503:vars_hot_unavailable:retry', on.h8);
  ok('恢复后照常：落盘、写回主库', on.h8?.back?.plain === 'z' && on.h8.back.hot === 'b' && on.h8.back.main === '"b"', on.h8?.back);
  console.log('H9 换进程、没落盘、main 档期间主库又改了');
  ok('报分叉（503 vars_diverged），不静默以哪边为准', on.h9 === '503:vars_diverged', on.h9);
  console.log('H10 Redis 整个丢了');
  ok('落盘时什么也没有：清掉待落盘，值回到上一次落盘的（最多丢一个周期）', on.h10?.get === 1 && on.h10.pending === false && on.h10.after === 1, on.h10);
  console.log('H11 没配 Redis');
  ok('高频变量就是普通变量：直接写台库和主库，不记待落盘', off.h11?.bench === '1' && off.h11.main?.value === '1' && off.h11.pending === false, off.h11);
  console.log('H12 写回主库：同版本、不同值');
  ok('主库那行和台库同版本、值不同：算写回失败（计数 1），dirty 留着，主库那行不动', on.h12?.failures === 1 && on.h12.dirty === true && on.h12.main === '99', on.h12);
  console.log('H13 没落完盘就切到 main / shadow 档');
  for (const m of ['main', 'shadow']) {
    const x = on.h13?.[m];
    ok(`${m} 档：启动报出卡片 7；高频变量读、写、全列表、hot. 列表回 503（可重试）；普通变量照常`, JSON.stringify(x?.report) === '[7]' && x.get === '503:vars_hot_unavailable:retry' && x.set === '503:vars_hot_unavailable:retry' && x.list === '503:vars_hot_unavailable:retry' && x.listHot === '503:vars_hot_unavailable:retry' && x.listPlain === 1 && x.plain === 1, x);
  }
  ok('回到 bench 档落完盘以后，main 档照常（读到落盘的值），不再报', JSON.stringify(on.h13?.after?.report) === '[]' && on.h13.after.get === 1, on.h13?.after);
  console.log('H14 删卡片和落盘撞在一起');
  ok('卡片删了以后落盘：主库不补孤儿行，待落盘的记录清掉', on.h14?.orphans === 0 && JSON.stringify(on.h14.report) === '[]', on.h14);
  ok('落盘读台库的那一刻卡片被删：不写回主库（没有孤儿行），待落盘的记录清掉', on.h14b?.hit >= 1 && on.h14b.orphans === 0 && JSON.stringify(on.h14b.report) === '[]', on.h14b);
  ok('对同步点补写回、读台库的那一刻卡片被删：不补写回（没有孤儿行）', on.h14c?.hit >= 1 && on.h14c.toMain === 0 && on.h14c.orphans === 0, on.h14c);
  console.log(`vars-hot-test: ${pass} passed / ${fail} failed`);
  if (fail) process.exitCode = 1;
}
