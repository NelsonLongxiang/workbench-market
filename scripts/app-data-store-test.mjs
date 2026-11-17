#!/usr/bin/env node
/**
 * 台的提交记录和附件存进卡片的台库（services/app-data.ts 的 WM_APP_DATA_STORE 三档；docs/data-views.md 第十三节第 6 条）。
 * 子进程里装上服务容器（临时数据目录），直接调服务和迁移：
 *
 *   A1 main 档：写提交、附件都不碰台库（卡片已有的台库里也不建这两张表）
 *   A2 迁移：dry-run 只数（几个台、几行、要写几行；没有卡片的台、孤儿、一个台两张卡片、磁盘上找不到的附件），不建台库；
 *      正式抄完两边摘要一致；再跑一次零写入
 *   A3 shadow 档：写提交、软删、上传、改备注、回写 sha256 之后，台库那份和主库逐行一样（比对按摘要）
 *   A4 bench 档：分页、幂等键、附件、计数、契约用的附件 id 都从台库读，结果和主库那份一样（列表的键次序也一样）
 *   A5 抄进台库失败：主库那笔照样写成、请求不失败，失败计数加一；下一次读之前按主库整份重抄，读得到
 *   A6 换进程：主库有、台库没抄到的行（上一个进程抄到一半退了），第一次用到时按主库重抄
 *   A7 台没有卡片：三档一样只用主库，不建台库
 *
 *   node scripts/app-data-store-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.APP_DATA_STORE_CHILD) await child(); else await parent();

async function child() {
  const src = (p) => pathToFileURL(join(ROOT, 'server/src', p)).href;
  const { DatabaseSync } = await import('node:sqlite');
  const { root } = await import(src('root-context.ts'));
  const { svc } = await import(src('context.ts'));
  const { db, dataDir } = await import(src('db.ts'));
  const { benchStore, closeBenchStores, benchStoreExists } = await import(src('services/bench-store.ts'));
  const { benchOfCard, createBench } = await import(src('services/bench-registry.ts'));
  const A = svc('appData');
  const out = {};
  // 台：a（有卡片）、b（有卡片，迁移时用）、c（没卡片）、d（两张卡片）、gone（台删了的孤儿行）
  for (const s of ['a', 'b', 'c', 'd']) db.prepare('INSERT INTO apps (slug, title) VALUES (?, ?)').run(`syn-${s}`, `合成${s}`);
  const card = (slug) => Number(db.prepare("INSERT INTO workbenches (name, url, type, enabled) VALUES (?, ?, 'market-app', 1)").run(slug, `/apps/${slug}/`).lastInsertRowid);
  const CA = card('syn-a'), CB = card('syn-b'); card('syn-d'); card('syn-d');
  const tables = (slug) => { const b = benchOfCard(A.cardOf(slug)); if (!b || !benchStoreExists(b.slug)) return null; const f = new DatabaseSync(join(dataDir, 'bench-stores', `${b.slug}.sqlite`), { readOnly: true }); try { return f.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bs_app%' ORDER BY name").all().map((r) => r.name).join(','); } finally { f.close(); } };
  const mainDigestSame = async (slug) => (await A.compare(slug)).same;

  // A1：main 档，卡片 a 已经有台库（建过数据集）
  createBench({ workbench_id: CA }, 'app-data-store-test', Date.now());
  await (await benchStore(benchOfCard(CA).slug)).datasets();
  A.setMode('main');
  const idA1 = await A.dataInsert('syn-a', '{"n":1}', 'seed', '', null);
  await A.fileInsert('syn-a', 'x.txt', 'text/plain', 3, 'uploads/syn/x.txt', 'seed', '', '');
  await closeBenchStores();
  out.a1 = { id: idA1, tables: tables('syn-a') };

  // A2：迁移（主库里 a、b、c、d、gone 都有行；c 没卡片、d 两张卡片、gone 台删了）
  await A.dataInsert('syn-b', '{"n":2}', 'seed', 'page\nk1', 'user:alpha');
  await A.dataInsert('syn-b', '{"n":3}', 'seed', '', null);
  await A.dataSoftDelete(await A.dataInsert('syn-b', '{"n":4}', 'seed', '', null), 'syn-b');
  await A.fileInsert('syn-b', 'y.txt', 'text/plain', 3, 'uploads/syn/y.txt', 'seed', '备注', 'a'.repeat(64));
  await A.dataInsert('syn-c', '{"n":5}', 'seed', '', null);
  await A.dataInsert('syn-d', '{"n":6}', 'seed', '', null);
  await A.dataInsert('syn-gone', '{"n":7}', 'seed', '', null);
  const missingOk = (p) => p !== 'uploads/syn/y.txt';
  out.dry = await A.migrate({ dryRun: true, fileExists: missingOk });
  out.dryStoreB = benchOfCard(CB) !== null;
  out.real = await A.migrate({ fileExists: missingOk });
  out.realSame = [await mainDigestSame('syn-a'), await mainDigestSame('syn-b'), await mainDigestSame('syn-d')];
  out.again = await A.migrate({ fileExists: missingOk });

  // A3：shadow 档
  A.setMode('shadow');
  const id3 = await A.dataInsert('syn-b', '{"n":8}', 'page', 'mcp:s1\nk2', null);
  await A.dataSoftDelete(id3, 'syn-b');
  const f3 = await A.fileInsert('syn-b', 'z.txt', 'text/plain', 5, 'uploads/syn/z.txt', 'page', '', '');
  await A.fileUpdateNote(f3, 'syn-b', '新备注');
  await A.fileSetSha256(f3, 'syn-b', 'b'.repeat(64));
  await A.fileSoftDelete(f3, 'syn-b');
  out.a3 = { same: await mainDigestSame('syn-b'), cmp: await A.compare('syn-b') };
  // A3b：shadow 档读主库——台库里多了一行（合成的），shadow 档读不到它
  const sb = await benchStore(benchOfCard(CB).slug);
  await sb.appDataPut({ id: 9999, data: '{"fake":1}', created_by: 'x', created_at: '2026-01-01 00:00:00', deleted_at: '', idempotency_key: '', submitter_principal: null });
  out.a3b = (await A.dataPage('syn-b', 0, 1)).map((r) => r.id);
  await sb.appDataDrop(9999);

  // A4：bench 档，读从台库来，和主库一样
  const mainPage = await (async () => { A.setMode('main'); return { data: await A.dataPage('syn-b', 0, 10), files: await A.filePage('syn-b', 0, 10), idem: await A.dataByIdempotencyKey('syn-b', 'page\nk1'), file: await A.fileById(f3 - 1, 'syn-b'), softDeleted: (await A.fileById(f3, 'syn-b')) ?? null, count: await A.fileCount('syn-b'), ids: [...(await A.fileIdsExisting('syn-b', [f3 - 1, f3, 999]))] }; })();
  A.setMode('bench');
  const store = await benchStore(benchOfCard(CB).slug);
  const realPage = store.appDataPage.bind(store);
  let benchReads = 0;
  store.appDataPage = async (...x) => { benchReads++; return realPage(...x); };
  const benchPage = { data: await A.dataPage('syn-b', 0, 10), files: await A.filePage('syn-b', 0, 10), idem: await A.dataByIdempotencyKey('syn-b', 'page\nk1'), file: await A.fileById(f3 - 1, 'syn-b'), softDeleted: (await A.fileById(f3, 'syn-b')) ?? null, count: await A.fileCount('syn-b'), ids: [...(await A.fileIdsExisting('syn-b', [f3 - 1, f3, 999]))] };
  store.appDataPage = realPage;
  out.a4 = { same: JSON.stringify(mainPage) === JSON.stringify(benchPage), benchReads, main: mainPage, bench: benchPage };

  // A5：bench 档抄进台库失败一次
  const realPut = store.appDataPut.bind(store);
  store.appDataPut = async () => { store.appDataPut = realPut; throw new Error('合成：台库写失败'); };
  const before = A.stats().mirror_failures;
  const id5 = await A.dataInsert('syn-b', '{"n":9}', 'page', '', null);
  out.a5 = { id: id5, failures: A.stats().mirror_failures - before, mainHas: !!db.prepare('SELECT 1 FROM app_data WHERE id = ?').get(id5), read: (await A.dataPage('syn-b', 0, 1)).map((r) => r.id), same: await mainDigestSame('syn-b') };

  // A6：主库有、台库没抄到（直接往主库写一行），换进程
  const id6 = Number(db.prepare("INSERT INTO app_data (app_slug, data, created_by) VALUES ('syn-b', '{\"n\":10}', 'x')").run().lastInsertRowid);
  const staleRead = (await A.dataPage('syn-b', 0, 1)).map((r) => r.id);
  A.setMode('bench');
  out.a6 = { stale: staleRead, after: (await A.dataPage('syn-b', 0, 1)).map((r) => r.id), id6 };
  // A6b：条数不变、内容变了（主库那行被直接软删，台库没抄到），换进程第一次用到时也要按主库重抄（比的是摘要，不是条数）
  db.prepare("UPDATE app_data SET deleted_at = '2026-01-01 00:00:00' WHERE id = ?").run(id6);
  A.setMode('bench');
  out.a6b = (await A.dataPage('syn-b', 0, 1)).map((r) => r.id);

  // A7：台 c 没卡片：bench 档照主库读，不建台库
  out.a7 = { read: (await A.dataPage('syn-c', 0, 5)).length, card: A.cardOf('syn-c'), benches: db.prepare('SELECT COUNT(*) AS n FROM bench_views').get().n };
  await closeBenchStores();
  await root.fiber.dispose();
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

async function parent() {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x === undefined ? '' : `（${JSON.stringify(x)}）`}`); } };
  const dataDir = mkdtempSync(join(tmpdir(), 'wm-app-data-store-'));
  const env = { ...process.env, APP_DATA_STORE_CHILD: '1', DATA_DIR: dataDir, NODE_ENV: 'test', WM_VAULT_PATH: join(dataDir, 'vault.json') };
  delete env.REDIS_URL; delete env.WM_APP_DATA_STORE;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('exit', () => { const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{')); try { resolve(JSON.parse(line)); } catch { console.log(err.slice(-3000)); resolve({}); } });
  });
  rmSync(dataDir, { recursive: true, force: true });
  console.log('A1 main 档');
  ok('写提交、附件都不碰台库：卡片已有的台库里没有提交、附件那两张表', r.a1?.tables === '', r.a1);
  console.log('A2 迁移');
  const d = r.dry;
  ok('dry-run 只数：有卡片的台 3 个（a、b、d），没卡片的 1 个（1 行），孤儿 1 个（1 行），两张卡片的 1 个，找不到的附件 1 个；不建台库', d?.slugs === 3 && d.no_card === 1 && d.no_card_rows === 1 && d.orphans === 1 && d.orphan_rows === 1 && d.multi_card === 1 && d.missing_files === 1 && d.written === d.rows && r.dryStoreB === false, { dry: d, store: r.dryStoreB });
  ok('正式抄：写了 dry-run 数出来的那么多行，三个台两边摘要一致', r.real?.written === d?.written && r.realSame?.every(Boolean), { real: r.real, same: r.realSame });
  ok('再跑一次：零写入，三个台都跳过', r.again?.written === 0 && r.again.skipped === 3, r.again);
  console.log('A3 shadow 档');
  ok('写提交、软删、上传、改备注、回写 sha256、软删附件之后，台库那份和主库逐行一样', r.a3?.same === true, r.a3);
  ok('shadow 档照旧读主库：台库里多出来的行读不到', r.a3b?.[0] !== 9999, r.a3b);
  console.log('A4 bench 档');
  ok('分页、幂等键、附件、计数、契约用的附件 id 从台库读，和主库那份逐字一样（键的次序也一样）', r.a4?.same === true && r.a4.benchReads >= 1, r.a4);
  console.log('A5 抄进台库失败');
  ok('主库那笔照样写成、请求不失败，失败计数 1；下一次读之前按主库重抄，读得到、两边一致', r.a5?.failures === 1 && r.a5.mainHas && r.a5.read[0] === r.a5.id && r.a5.same === true, r.a5);
  console.log('A6 换进程');
  ok('主库有、台库没抄到的行：同一个进程里还读不到（台库为准），换进程第一次用到时按主库重抄、读得到', r.a6?.stale[0] !== r.a6.id6 && r.a6.after[0] === r.a6.id6, r.a6);
  ok('条数不变、内容变了（主库那行被软删）：换进程按摘要发现不一致、重抄，软删的那行不再读到', r.a6b?.[0] !== r.a6?.id6, { a6b: r.a6b, id6: r.a6?.id6 });
  console.log('A7 台没有卡片');
  ok('bench 档照主库读，不建台库', r.a7?.read === 1 && r.a7.card === null, r.a7);
  console.log(`app-data-store-test: ${pass} passed / ${fail} failed`);
  if (fail) process.exitCode = 1;
}
