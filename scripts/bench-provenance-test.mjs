#!/usr/bin/env node
/** 台库的来源列（公共区：领域之间的产出物，第 15 篇第九节）：不起服务，经 server/src/services/bench-store.ts（工作线程）调，数据目录是临时的。
 *  覆盖：带来源列建数据集、改列时来源列保留、普通定义建不出来源列；只能凭来源追加（替换、按主键改、删行、退回快照、不带来源的追加都拒）；
 *  来源列由服务端填、写入方给了拒；同一个写授权只写一次（重放原样说重复）和按授权数行；更正（被更正的行要在、只能更正链头、同批不重复）；
 *  查询：来源列和行号能选能筛，current_only 只取每条更正链最新那行、只用于带来源列的数据集。 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp/bench-provenance-'));
process.env.DATA_DIR = DATA;
const { benchStore, closeBenchStores } = await import('../server/src/services/bench-store.ts');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, message: String(e.message) }; } };
let clock = 1_800_000_000_000;
const ctx = (extra = {}) => ({ actor: 'tester', at: ++clock, ...extra });
const prov = (grant, extra = {}) => ({ area: 'plan', task: 'task-1', batch: 'b1', grant, ...extra });
const DEF = { name: 'forecast', title: '预测', columns: [{ name: 'sku', type: 'text', required: true }, { name: 'qty', type: 'integer' }] };

try {
  let s = await benchStore('pub-plan');
  console.log('一、建数据集');
  const d = await s.defineDataset(DEF, ctx(), { provenance: true });
  let ds = (await s.datasets()).find((x) => x.name === 'forecast');
  const sys = ds?.columns.filter((c) => c.system).map((c) => c.name).join(',');
  ok('带 provenance 建：多出六个来源列', d.created && sys === '_area,_task,_batch,_grant,_upstream,_supersedes', sys);
  const plain = await refused(() => s.defineDataset({ name: 'sneaky', columns: [{ name: '_grant', type: 'text' }] }, ctx()));
  ok('普通定义建不出下划线开头的列', plain?.code === 'invalid', plain);
  await s.defineDataset({ ...DEF, columns: [...DEF.columns, { name: 'note', type: 'text' }] }, ctx());
  ds = (await s.datasets()).find((x) => x.name === 'forecast');
  ok('改列（调用方不给来源列）：加了 note，来源列都还在', ds.columns.some((c) => c.name === 'note') && ds.columns.filter((c) => c.system).length === 6, ds.columns.map((c) => c.name));
  const off = await refused(() => s.defineDataset(DEF, ctx(), { provenance: false }));
  ok('带来源列的数据集不能改回不带', off?.code === 'unsupported', off);
  await s.defineDataset({ name: 'plain', columns: [{ name: 'x', type: 'text' }] }, ctx());
  const on = await refused(() => s.defineDataset({ name: 'plain', columns: [{ name: 'x', type: 'text' }] }, ctx(), { provenance: true }));
  ok('已有的普通数据集不能改成带来源列', on?.code === 'unsupported', on);

  console.log('二、只能凭来源追加');
  const rows = [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }];
  for (const [name, fn] of [
    ['不带来源的追加', () => s.append('forecast', rows, ctx())],
    ['整份替换', () => s.replace('forecast', rows, ctx())],
    ['按主键改', () => s.upsert('forecast', rows, ctx())],
    ['删行', () => s.deleteRows('forecast', [{ sku: 'A' }], ctx())],
  ]) { const r = await refused(fn); ok(`${name} → 拒（unsupported）`, r?.code === 'unsupported', r); }
  for (const [name, fn] of [
    ['普通入口追加带 _grant', () => s.append('plain', [{ x: '1', _grant: 'g-forged' }], ctx())],
    ['普通入口整份替换带 _area', () => s.replace('plain', [{ x: '1', _area: 'plan' }], ctx())],
    ['普通入口按主键改带 _supersedes', () => s.upsert('plain', [{ x: '1', _supersedes: 1 }], ctx())],
  ]) { const r = await refused(fn); ok(`普通数据集：${name} → 拒`, r?.code === 'invalid', r); }
  ok('……普通数据集里一行都没写进去', (await s.query({ dataset: 'plain' })).rows.length === 0);
  const wrong = await refused(() => s.append('plain', [{ x: '1' }], ctx({ provenance: prov('g-plain') })));
  ok('不带来源列的数据集不收来源', wrong?.code === 'invalid', wrong);
  const given = await refused(() => s.append('forecast', [{ sku: 'A', _grant: 'forged' }], ctx({ provenance: prov('g-0') })));
  ok('写入方自己给来源列 → 拒', given?.code === 'invalid' && /_grant/.test(given.message), given);
  const rowGiven = await refused(() => s.append('forecast', [{ sku: 'A', _row: 9 }], ctx({ provenance: prov('g-0') })));
  ok('写入方给行号 → 拒', rowGiven?.code === 'invalid', rowGiven);
  const empty = await refused(() => s.append('forecast', [], ctx({ provenance: prov('g-0') })));
  ok('空批 → 拒（一个写授权至少写一行）', empty?.code === 'invalid', empty);
  const badProv = await refused(() => s.append('forecast', rows, ctx({ provenance: { area: 'plan', task: 'x', batch: 'b', grant: '' } })));
  ok('来源缺授权号 → 拒', badProv?.code === 'invalid', badProv);

  // 带主键的公共数据集：按主键改、删行在这里本来是走得通的（有主键、给齐了必填列），只有「公共区的只能追加」能拦住。
  // 拦截一旦放开，下面两例会因为数据真被改了、删了而变红，不只是错误码不同
  await s.defineDataset({ name: 'keyed', columns: [{ name: 'sku', type: 'text', required: true }, { name: 'qty', type: 'integer' }], key: ['sku'] }, ctx(), { provenance: true });
  await s.append('keyed', [{ sku: 'K1', qty: 1 }, { sku: 'K2', qty: 2 }], ctx({ provenance: prov('g-keyed') }));
  const keyedRows = async () => JSON.stringify((await s.query({ dataset: 'keyed', select: ['sku', 'qty', '_grant'] })).rows);
  const keyedBefore = await keyedRows();
  const up = await refused(() => s.upsert('keyed', [{ sku: 'K1', qty: 99, _area: 'plan', _task: 'forged', _batch: 'b9', _grant: 'g-forged' }], ctx()));
  ok('带主键的公共数据集：按主键改 → unsupported（公共区只能追加），数据没动', up?.code === 'unsupported' && /只能追加/.test(up.message) && (await keyedRows()) === keyedBefore, [up, await keyedRows()]);
  const del = await refused(() => s.deleteRows('keyed', [{ sku: 'K2' }], ctx()));
  ok('带主键的公共数据集：删行 → unsupported（公共区只能追加），两行都还在', del?.code === 'unsupported' && /只能追加/.test(del.message) && (await keyedRows()) === keyedBefore, [del, await keyedRows()]);

  console.log('三、来源列由服务端填；同一个授权只写一次');
  const w1 = await s.append('forecast', rows, ctx({ provenance: prov('g-1', { upstream: ['pub-sales/orders#3'] }) }));
  ok('凭授权 g-1 追加两行', w1.inserted === 2, w1);
  let q = await s.query({ dataset: 'forecast', select: ['_row', 'sku', '_area', '_task', '_batch', '_grant', '_upstream', '_supersedes'] });
  ok('来源列和行号读得到、是服务端填的', q.rows.length === 2 && q.rows.every((r) => r._area === 'plan' && r._task === 'task-1' && r._batch === 'b1' && r._grant === 'g-1' && r._upstream === '["pub-sales/orders#3"]' && r._supersedes === null) && q.rows[0]._row === 1 && q.rows[1]._row === 2, q.rows);
  const again = await s.append('forecast', [{ sku: 'Z', qty: 9 }], ctx({ provenance: prov('g-1') }));
  q = await s.query({ dataset: 'forecast', select: ['sku'] });
  ok('同一个授权再追加（内容不同也一样）→ 重复，不再写', again.duplicate === true && again.inserted === 0 && q.rows.length === 2, again);
  ok('按授权数行：g-1 两行，没用过的 0 行', (await s.grantRows('forecast', 'g-1')) === 2 && (await s.grantRows('forecast', 'g-none')) === 0);

  console.log('四、更正');
  const mis = await refused(() => s.append('forecast', [{ sku: 'A', qty: 5 }], ctx({ provenance: prov('g-2', { supersedes: [1, null] }) })));
  ok('supersedes 和行数对不上 → 拒', mis?.code === 'invalid', mis);
  const ghost = await refused(() => s.append('forecast', [{ sku: 'A', qty: 5 }], ctx({ provenance: prov('g-2', { supersedes: [99] }) })));
  ok('更正不存在的行 → 拒', ghost?.code === 'not_found', ghost);
  const twice = await refused(() => s.append('forecast', [{ sku: 'A', qty: 5 }, { sku: 'A', qty: 6 }], ctx({ provenance: prov('g-2', { supersedes: [1, 1] }) })));
  ok('同一批两行更正同一行 → 拒', twice?.code === 'invalid', twice);
  const fix = await s.append('forecast', [{ sku: 'A', qty: 5 }], ctx({ provenance: prov('g-2', { supersedes: [1] }) }));
  ok('第 3 行更正第 1 行', fix.inserted === 1, fix);
  const stale = await refused(() => s.append('forecast', [{ sku: 'A', qty: 7 }], ctx({ provenance: prov('g-3', { supersedes: [1] }) })));
  ok('再更正已经被更正过的第 1 行 → 拒（只能更正链头）', stale?.code === 'conflict', stale);
  await s.append('forecast', [{ sku: 'A', qty: 8 }], ctx({ provenance: prov('g-4', { supersedes: [3] }) }));

  console.log('五、查询');
  const all = await s.query({ dataset: 'forecast', select: ['_row', 'sku', 'qty'] });
  const cur = await s.query({ dataset: 'forecast', select: ['_row', 'sku', 'qty'], current_only: true });
  ok('不加 current_only：四行都在（旧行不改不删）', all.rows.length === 4, all.rows);
  const chain = await s.query({ dataset: 'forecast', select: ['_row'], filter: [{ col: 'sku', op: '=', value: 'A' }], current_only: true });
  ok('更正链 a → b → c（第 1 行 → 第 3 行 → 第 4 行）：只返回 c', JSON.stringify(chain.rows) === JSON.stringify([{ _row: 4 }]), chain.rows);
  ok('current_only：每条更正链只剩最新那行（A 只剩第 4 行 qty 8，B 不变）', JSON.stringify(cur.rows) === JSON.stringify([{ _row: 2, sku: 'B', qty: 2 }, { _row: 4, sku: 'A', qty: 8 }]), cur.rows);
  const byGrant = await s.query({ dataset: 'forecast', select: ['_row'], filter: [{ col: '_grant', op: '=', value: 'g-2' }] });
  ok('按 _grant 筛', JSON.stringify(byGrant.rows) === JSON.stringify([{ _row: 3 }]), byGrant.rows);
  const sorted = await s.query({ dataset: 'forecast', select: ['_row'], sort: [{ col: '_row', dir: 'desc' }], current_only: true });
  ok('按 _row 排序，和 current_only 一起用', JSON.stringify(sorted.rows) === JSON.stringify([{ _row: 4 }, { _row: 2 }]), sorted.rows);
  const grouped = await s.query({ dataset: 'forecast', group: ['sku'], measures: [{ fn: 'sum', col: 'qty', as: 'n' }], current_only: true });
  ok('current_only 也作用于聚合', JSON.stringify(grouped.rows) === JSON.stringify([{ sku: 'A', n: 8 }, { sku: 'B', n: 2 }]), grouped.rows);
  const dflt = await s.query({ dataset: 'forecast', limit: 1 });
  ok('不写 select：普通列、来源列和行号都给', dflt.columns.map((c) => c.name).join(',') === 'sku,qty,note,_area,_task,_batch,_grant,_upstream,_supersedes,_row', dflt.columns.map((c) => c.name));
  const notPub = await refused(() => s.query({ dataset: 'plain', current_only: true }));
  ok('current_only 用在普通数据集上 → 拒', notPub?.code === 'invalid', notPub);
  const plainSys = await refused(() => s.query({ dataset: 'plain', select: ['_row'] }));
  ok('普通数据集没有行号列', plainSys?.code === 'invalid', plainSys);
  const badFlag = await refused(() => s.query({ dataset: 'forecast', current_only: 'yes' }));
  ok('current_only 不是布尔 → 拒', badFlag?.code === 'invalid', badFlag);

  console.log('五之二、同一个授权并发追加：只有一边写进去');
  const [r1, r2] = await Promise.all([
    s.append('forecast', [{ sku: 'C', qty: 1 }, { sku: 'D', qty: 1 }], ctx({ provenance: prov('g-race') })),
    s.append('forecast', [{ sku: 'E', qty: 1 }], ctx({ provenance: prov('g-race') })),
  ]);
  const raceRows = await s.grantRows('forecast', 'g-race');
  ok('同一进程里两次并发：一边插入、一边 duplicate，凭这个授权的行数等于插入那批', [r1, r2].filter((r) => r.inserted > 0).length === 1 && [r1, r2].filter((r) => r.duplicate).length === 1 && raceRows === [r1, r2].find((r) => r.inserted > 0).inserted, [r1, r2, raceRows]);
  // 两个进程各开一份同一个台库（同一个数据目录），约好同一时刻用同一个授权追加：靠台库写事务开头的 BEGIN IMMEDIATE 互斥
  await closeBenchStores();
  const startAt = Date.now() + 1500;
  const child = (n, sku) => new Promise((res) => {
    const code = `const { benchStore, closeBenchStores } = await import(${JSON.stringify(new URL('../server/src/services/bench-store.ts', import.meta.url).href)});
      const s = await benchStore('pub-plan');
      while (Date.now() < ${startAt}) await new Promise((r) => setTimeout(r, 2));
      const r = await s.append('forecast', Array.from({ length: ${n} }, (_, i) => ({ sku: '${sku}' + i, qty: 1 })), { actor: 'proc-${sku}', at: ${startAt}, provenance: { area: 'plan', task: 'task-1', batch: 'b1', grant: 'g-xproc' } });
      console.log(JSON.stringify(r)); await closeBenchStores();`;
    const file = resolve(DATA, `race-${sku}.mjs`); writeFileSync(file, code);
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { env: { ...process.env, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => { try { res(JSON.parse(out.trim().split('\n').pop())); } catch { res({ error: `exit ${code}: ${err.slice(-300)}` }); } });
  });
  const [p1, p2] = await Promise.all([child(3, 'P'), child(2, 'Q')]);
  s = await benchStore('pub-plan');
  const xRows = await s.grantRows('forecast', 'g-xproc');
  const won = [p1, p2].filter((r) => r.inserted > 0);
  ok('两个进程同时用同一个授权追加：只有一边写进去、另一边 duplicate，库里只有赢的那批', won.length === 1 && [p1, p2].filter((r) => r.duplicate).length === 1 && xRows === won[0].inserted, [p1, p2, xRows]);

  console.log('六、退回快照');
  const snap = await s.snapshot('forecast', ctx());
  const back = await refused(() => s.restore(snap.snapshot_id ?? snap.id, ctx({ note: '试退回' })));
  ok('带来源列的数据集不能退回快照', back?.code === 'unsupported', back);
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  await closeBenchStores();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`bench-provenance-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
