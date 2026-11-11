#!/usr/bin/env node
/** 台库冒烟（数据视图，docs/data-views.md）：不起服务，直接调 server/src/services/bench-store.ts，数据目录是临时的。
 *  覆盖：数据集定义与改列（加列、删列先留快照、改类型拒绝、改必填和设主键前核对现有行）；写入四种（整份替换、追加、按主键更新、按主键删行）
 *  的逐行校验、幂等键、上限；快照与退回；查询描述（筛选、分组、聚合、排序、参数、截断）和注入形态的名字与取值；
 *  视图描述的核对、版本、并发保存不覆盖、回退只移指针、差异；一个台的读写排队；台与台隔离；标识不能逃出目录；关掉重开数据还在；
 *  库比代码新时拒绝打开；备份副本。 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

mkdirSync('tmp', { recursive: true });
const DATA = mkdtempSync(resolve('tmp/bench-store-smoke-'));
process.env.DATA_DIR = DATA;
const { benchStore, benchStoreExists, closeBenchStores, removeBenchStore, onBenchChange, configureBenchRuntime, benchRuntimeStats, stopBenchWorkerAbruptly } = await import('../server/src/services/bench-store.ts');
const { BENCH_LIMITS, planQuery } = await import('../server/src/bench-query.ts');
const { BenchHost } = await import('../server/src/services/bench-store-core.ts');
const { benchSqlKit } = await import('../server/src/db.ts');
const { validateViewDoc, diffJson } = await import('../server/src/bench-views.ts');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
/** 期待被拒：返回错误（code、message、details），没被拒返回 null */
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, message: String(e.message), details: e.details ?? [], ...(e.cause ? { cause: String(e.cause.message ?? e.cause) } : {}) }; } };
let clock = 1_800_000_000_000;
const ctx = (extra = {}) => ({ actor: 'tester', at: ++clock, ...extra });

try {
  const s = await benchStore('demo');
  const events = [];
  onBenchChange((c) => events.push(c));

  // —— 数据集 ——
  console.log('数据集');
  const cols = [
    { name: 'id', type: 'integer' }, { name: 'status', type: 'text', label: '状态' }, { name: 'done', type: 'integer' },
    { name: 'amount', type: 'decimal' }, { name: 'day', type: 'date' }, { name: 'at', type: 'datetime' }, { name: 'ok', type: 'boolean' },
  ];
  let r = await s.defineDataset({ name: 'runs', title: '运行', columns: cols, key: ['id'] }, ctx());
  ok('D1 新建数据集是第 1 版', r.created && r.version === 1);
  r = await s.defineDataset({ name: 'runs', title: '运行', columns: cols, key: ['id'] }, ctx());
  ok('D1 定义没变不产生新版本', r.unchanged && r.version === 1);
  let e = await refused(() => s.defineDataset({ name: 'Runs; DROP TABLE bs_meta', columns: cols }, ctx()));
  ok('D2 数据集名只认白名单写法', e?.code === 'invalid');
  e = await refused(() => s.defineDataset({ name: 'x', columns: [{ name: 'a"); DROP TABLE ds_runs; --', type: 'text' }] }, ctx()));
  ok('D2 列名只认白名单写法', e?.code === 'invalid');
  e = await refused(() => s.defineDataset({ name: 'x', columns: [{ name: 'a', type: 'blob' }] }, ctx()));
  ok('D2 不认识的类型被拒', e?.code === 'invalid');
  e = await refused(() => s.defineDataset({ name: 'x', columns: [{ name: 'a', type: 'text' }], key: ['b'] }, ctx()));
  ok('D2 主键列须在列定义里', e?.code === 'invalid');
  e = await refused(() => s.defineDataset({ name: 'x', columns: [{ name: 'a', type: 'text', html: '<b>' }] }, ctx()));
  ok('D2 列定义里多出来的键被拒', e?.code === 'invalid');
  e = await refused(() => s.defineDataset({ name: 'x', columns: Array.from({ length: BENCH_LIMITS.columns + 1 }, (_, i) => ({ name: `c${i}`, type: 'text' })) }, ctx()));
  ok('D3 列数超上限被拒', e?.code === 'limit');
  ok('D2 被拒的都没建出来', (await s.datasets()).map((d) => d.name).join() === 'runs');

  // —— 写入 ——
  console.log('写入');
  const row = (id, status, done, extra = {}) => ({ id, status, done, amount: done * 1.5, day: '2026-02-0' + ((id % 9) + 1), at: '2026-02-01T08:00:00+08:00', ok: id % 2 === 0, ...extra });
  r = await s.replace('runs', [row(1, 'a', 5), row(2, 'b', 7), row(3, 'a', 1)], ctx());
  ok('W1 整份替换写入 3 行', r.rows === 3 && r.row_count === 3 && r.snapshot_id === undefined);
  let q = await s.query({ dataset: 'runs', sort: [{ col: 'id' }] });
  ok('W1 读回的值和类型对（布尔、时间规范成 UTC）', q.rows[0].ok === false && q.rows[1].ok === true && q.rows[0].at === '2026-02-01T00:00:00.000Z' && q.rows[0].amount === 7.5, q.rows[0]);
  const bad = [
    [{ ...row(4, 'a', 1), done: '1' }, '整数列给了文本'],
    [{ ...row(4, 'a', 1), day: '2026-02-30' }, '不存在的日期'],
    [{ ...row(4, 'a', 1), at: '2026-02-01 08:00:00' }, '时间没带时区'],
    [{ ...row(4, 'a', 1), ok: 'yes' }, '布尔列给了文本'],
    [{ ...row(4, 'a', 1), amount: Infinity }, '小数不是有限数'],
    [{ ...row(4, 'a', 1), nope: 1 }, '多出来的列'],
    [{ status: 'a' }, '缺主键'],
    ['not-an-object', '行不是对象'],
    [{ ...row(4, 'a', 1), status: 'x'.repeat(BENCH_LIMITS.textChars + 1) }, '文本超长'],
  ];
  for (const [b, why] of bad) {
    e = await refused(() => s.append('runs', [row(9, 'z', 9), b], ctx()));
    ok(`W2 坏行整批拒收：${why}`, e?.code === 'invalid' && e.details.some((d) => d.startsWith('第 2 行')), e);
  }
  ok('W2 被拒的批次一行都没写进去', (await s.query({ dataset: 'runs' })).rows.length === 3);
  e = await refused(() => s.append('runs', [row(1, 'dup', 0)], ctx()));
  ok('W3 追加撞主键被拒', e?.code === 'conflict', e);
  e = await refused(() => s.append('runs', [row(7, 'a', 1), row(7, 'b', 2)], ctx()));
  ok('W3 同一批里主键重复被拒', e?.code === 'invalid' && e.details.some((d) => d.includes('重复')));
  r = await s.append('runs', [row(4, 'c', 2)], ctx({ idemKey: 'idem-key-0001' }));
  const again = await s.append('runs', [row(4, 'c', 2)], ctx({ idemKey: 'idem-key-0001' }));
  ok('W4 同幂等键同内容：返回原结果，不重复写', r.row_count === 4 && again.duplicate === true && again.row_count === 4 && (await s.query({ dataset: 'runs' })).rows.length === 4);
  e = await refused(() => s.append('runs', [row(5, 'c', 2)], ctx({ idemKey: 'idem-key-0001' })));
  ok('W4 同幂等键不同内容被拒', e?.code === 'conflict');
  r = await s.upsert('runs', [{ id: 1, done: 50 }, { id: 6, status: 'new', done: 0 }], ctx());
  q = await s.query({ dataset: 'runs', filter: [{ col: 'id', op: 'in', values: [1, 6] }], sort: [{ col: 'id' }] });
  ok('W5 按主键更新：有则改（只改给了的列）、无则加', r.inserted === 1 && r.updated === 1 && q.rows[0].done === 50 && q.rows[0].status === 'a' && q.rows[1].status === 'new' && q.rows[1].amount === null, q.rows);
  r = await s.deleteRows('runs', [{ id: 6 }, { id: 999 }], ctx());
  ok('W6 按主键删行，删之前自动留快照', r.deleted === 1 && r.row_count === 4 && Number.isInteger(r.snapshot_id));
  e = await refused(() => s.deleteRows('runs', [{ id: 1, status: 'a' }], ctx()));
  ok('W6 删行的键只能是主键列', e?.code === 'invalid');
  e = await refused(() => s.append('runs', Array.from({ length: BENCH_LIMITS.rowsPerWrite + 1 }, (_, i) => row(1000 + i, 'x', 0)), ctx()));
  ok('W7 一次写入超行数上限被拒', e?.code === 'limit');
  e = await refused(() => s.replace('runs', [row(1, 'a', 1)], { actor: '', at: 1 }));
  ok('W8 没有操作者被拒', e?.code === 'invalid');
  e = await refused(() => s.replace('nope', [], ctx()));
  ok('W8 没有这个数据集', e?.code === 'not_found');
  const wl = await s.writes();
  ok('W9 写入记录只有摘要，没有内容', wl.length === 4 && wl.map((w) => w.op).join() === 'delete,upsert,append,replace' && wl.every((w) => /^[0-9a-f]{64}$/.test(w.body_sha256) && !('rows_json' in w) && !('result' in w)));

  // —— 快照与退回 ——
  console.log('快照与退回');
  const before = (await s.query({ dataset: 'runs', sort: [{ col: 'id' }] })).rows;
  r = await s.replace('runs', [row(100, 'only', 1)], ctx());
  ok('S1 整份替换前自动留上一代', Number.isInteger(r.snapshot_id) && r.row_count === 1);
  const snaps = await s.snapshots('runs');
  ok('S1 快照清单有原因和行数，不带内容', snaps[0].reason === 'replace' && snaps[0].row_count === 4 && !('content' in snaps[0]));
  const back = await s.restore(snaps[0].id, ctx());
  const after = (await s.query({ dataset: 'runs', sort: [{ col: 'id' }] })).rows;
  ok('S2 退回上一代：数据逐行相同', JSON.stringify(after) === JSON.stringify(before) && back.row_count === 4);
  ok('S2 退回之前把当时的数据也留了快照（退错了能再退回来）', Number.isInteger(back.snapshot_id));
  e = await refused(() => s.restore(987654, ctx()));
  ok('S3 没有这份快照', e?.code === 'not_found');
  for (let i = 0; i < BENCH_LIMITS.snapshots + 3; i++) { await s.upsert('runs', [{ id: 1, done: 1000 + i }], ctx()); await s.snapshot('runs', ctx()); }
  ok('S4 快照个数有上限，旧的先清', (await s.snapshots('runs')).length === BENCH_LIMITS.snapshots);
  const sameA = await s.snapshot('runs', ctx()), sameB = await s.snapshot('runs', ctx());
  ok('S5 内容和最近一份相同：不再存一份，返回原来那份', sameA.id === sameB.id && (await s.snapshots('runs')).length === BENCH_LIMITS.snapshots);
  // 验收第一轮复现的挤出：整份替换留下的上一代，不该被「一行也没删到」的删除挤掉
  await s.defineDataset({ name: 'keep', columns: [{ name: 'id', type: 'integer' }, { name: 'v', type: 'text' }], key: ['id'] }, ctx());
  await s.replace('keep', [{ id: 1, v: 'good' }, { id: 2, v: 'good' }], ctx());
  const goodSnap = (await s.replace('keep', [{ id: 9, v: 'bad' }], ctx())).snapshot_id;
  let noop;
  for (let i = 0; i < BENCH_LIMITS.snapshots + 2; i++) noop = await s.deleteRows('keep', [{ id: 777 + i }], ctx());
  ok('S6 一行也没删到：不留快照', noop.deleted === 0 && noop.snapshot_id === undefined && noop.row_count === 1, noop);
  ok('S6 不改变数据的删除不占快照名额：替换前那份还在', (await s.snapshots('keep')).some((x) => x.id === goodSnap), await s.snapshots('keep'));
  await s.restore(goodSnap, ctx());
  ok('S6 替换前的数据找得回来', (await s.query({ dataset: 'keep', sort: [{ col: 'id' }] })).rows.map((x) => `${x.id}${x.v}`).join() === '1good,2good');
  e = await refused(() => s.deleteRows('keep', [{ v: 'good' }], ctx()));
  ok('S7 删行的键个数对、名字不对也被拒', e?.code === 'invalid', e);
  // 快照序列化不下来（数据集大到一定程度会这样）：说清是超限，后面的破坏性操作不执行。
  // 要在同一个线程里把 JSON.stringify 换掉才造得出来，所以这一项不经工作线程，直接用逻辑本体
  const inproc = new BenchHost(join(DATA, 'inproc'), benchSqlKit('sqlite'));
  const core = await inproc.store('keep');
  await core.defineDataset({ name: 'keep', columns: [{ name: 'id', type: 'integer' }, { name: 'v', type: 'text' }], key: ['id'] }, ctx());
  await core.replace('keep', [{ id: 1, v: 'good' }, { id: 2, v: 'good' }], ctx());
  const realStringify = JSON.stringify;
  JSON.stringify = (v, ...a) => { if (v && typeof v === 'object' && Array.isArray(v.rows) && Array.isArray(v.columns)) throw new RangeError('Invalid string length'); return realStringify(v, ...a); };
  try { e = await refused(() => core.replace('keep', [{ id: 5, v: 'x' }], ctx())); } finally { JSON.stringify = realStringify; }
  ok('S8 快照留不下来：报超限，替换没有执行', e?.code === 'limit' && (await core.query({ dataset: 'keep' })).rows.length === 2, e);
  await inproc.closeAll();

  // —— 改列定义 ——
  console.log('改列定义');
  e = await refused(() => s.defineDataset({ name: 'runs', columns: cols.map((c) => (c.name === 'done' ? { ...c, type: 'text' } : c)), key: ['id'] }, ctx()));
  ok('C1 改列的类型被拒', e?.code === 'unsupported');
  e = await refused(() => s.defineDataset({ name: 'runs', columns: [...cols, { name: 'must', type: 'text', required: true }], key: ['id'] }, ctx()));
  ok('C2 已有数据时不能加必填列', e?.code === 'invalid');
  r = await s.defineDataset({ name: 'runs', title: '运行', columns: [...cols, { name: 'note', type: 'text' }], key: ['id'] }, ctx({ note: '加备注列' }));
  ok('C3 加可空列：新版本，原数据还在', r.version === 2 && r.added.join() === 'note' && (await s.query({ dataset: 'runs' })).rows.every((x) => x.note === null));
  e = await refused(() => s.defineDataset({ name: 'runs', columns: [...cols, { name: 'note', type: 'text', required: true }], key: ['id'] }, ctx()));
  ok('C4 列里有空值时不能改成必填', e?.code === 'invalid');
  e = await refused(() => s.defineDataset({ name: 'runs', columns: [...cols, { name: 'note', type: 'text' }], key: ['status'] }, ctx()));
  ok('C5 现有数据在新主键上有重复时不能改主键', e?.code === 'conflict', e);
  r = await s.defineDataset({ name: 'runs', title: '运行', columns: cols.filter((c) => c.name !== 'amount'), key: ['id'] }, ctx({ note: '删金额列' }));
  ok('C6 删列先自动留快照', r.version === 3 && r.removed.join() === 'amount,note' && Number.isInteger(r.snapshot_id));
  const sn = (await s.snapshots('runs'))[0];
  const back2 = await s.restore(sn.id, ctx());
  ok('C6 从删列前的快照退回：已经不存在的列丢掉并说明', back2.dropped_columns.sort().join() === 'amount,note' && back2.row_count === 4);
  const dv = await s.datasetVersions('runs');
  ok('C7 列定义的历史版本都在，带说明', dv.map((v) => v.version).join() === '3,2,1' && dv[0].note === '删金额列');
  r = await s.defineDataset({ name: 'runs', title: '运行', columns: [...cols.filter((c) => c.name !== 'amount')], key: ['id', 'status'] }, ctx());
  e = await refused(() => s.append('runs', [{ id: 1, status: 'a', done: 0 }], ctx()));
  ok('C8 改主键后按新主键拦重复', r.version === 4 && e?.code === 'conflict');
  r = await s.defineDataset({ name: 'runs', title: '运行', columns: cols.filter((c) => c.name !== 'amount'), key: ['id'] }, ctx());
  ok('C8 主键改回去：原来因为进了主键才必填的列恢复可空', r.version === 5 && (await s.datasets()).find((d) => d.name === 'runs').columns.find((c) => c.name === 'status').required === false);

  // —— 查询 ——
  console.log('查询');
  await s.replace('runs', [row(1, 'a', 5), row(2, 'b', 7), row(3, 'a', 1), row(4, null, 2, { status: undefined })].map(({ amount, ...x }) => x), ctx());
  q = await s.query({ dataset: 'runs', group: ['status'], measures: [{ as: 'n', fn: 'count' }, { as: 'total', fn: 'sum', col: 'done' }, { as: 'avg_done', fn: 'avg', col: 'done' }], sort: [{ col: 'total', dir: 'desc' }] });
  ok('Q1 分组聚合与排序（空值排最后）', JSON.stringify(q.rows) === JSON.stringify([{ status: 'b', n: 1, total: 7, avg_done: 7 }, { status: 'a', n: 2, total: 6, avg_done: 3 }, { status: null, n: 1, total: 2, avg_done: 2 }]), q.rows);
  ok('Q1 输出列带类型和角色', q.columns.map((c) => `${c.name}:${c.type}:${c.role}`).join() === 'status:text:dimension,n:integer:measure,total:integer:measure,avg_done:decimal:measure');
  q = await s.query({ dataset: 'runs', filter: [{ col: 'day', op: 'prefix', value: '$month' }, { col: 'done', op: '>=', value: '$min' }], sort: [{ col: 'id' }] }, { month: '2026-02', min: '5' });
  ok('Q2 筛选栏参数（文本形态的数字照列类型转）', q.rows.map((x) => x.id).join() === '1,2');
  q = await s.query({ dataset: 'runs', filter: [{ col: 'day', op: 'prefix', value: '$month' }] }, { month: '' });
  ok('Q2 参数没给：这条筛选不生效', q.rows.length === 4);
  q = await s.query({ dataset: 'runs', filter: [{ col: 'status', op: 'is_null' }] });
  ok('Q3 判空', q.rows.length === 1 && q.rows[0].id === 4);
  q = await s.query({ dataset: 'runs', filter: [{ col: 'status', op: 'contains', value: 'A' }] });
  ok('Q3 「包含」区分大小写', q.rows.length === 0);
  q = await s.query({ dataset: 'runs', limit: 2, sort: [{ col: 'id', dir: 'desc' }] });
  ok('Q4 行数上限与截断标记', q.rows.length === 2 && q.truncated === true && q.rows[0].id === 4);
  // 注入形态：名字只认白名单，值只走参数
  const hostile = "a' OR '1'='1";
  q = await s.query({ dataset: 'runs', filter: [{ col: 'status', op: '=', value: hostile }] });
  ok('Q5 注入形态的取值只当文本比较', q.rows.length === 0);
  q = await s.query({ dataset: 'runs', filter: [{ col: 'status', op: '=', value: '$v' }] }, { v: "x'; DROP TABLE ds_runs; --" });
  ok('Q5 注入形态的参数只当文本比较，表还在', q.rows.length === 0 && (await s.query({ dataset: 'runs' })).rows.length === 4);
  for (const [spec, why] of [
    [{ dataset: 'runs; DROP TABLE bs_meta' }, '数据集名'],
    [{ dataset: 'bs_meta' }, '读固定表'],
    [{ dataset: 'runs', select: ['rid'] }, '读内部行号'],
    [{ dataset: 'runs', select: ['id, (SELECT v FROM bs_meta)'] }, '列名里塞子查询'],
    [{ dataset: 'runs', filter: [{ col: 'id', op: '= 1 OR 1', value: 1 }] }, '比较符里塞表达式'],
    [{ dataset: 'runs', measures: [{ as: 'n"; DROP TABLE ds_runs; --', fn: 'count' }] }, '别名里塞引号'],
    [{ dataset: 'runs', measures: [{ as: 'n', fn: 'count); DELETE FROM ds_runs; --' }] }, '函数名'],
    [{ dataset: 'runs', sort: [{ col: 'id', dir: 'asc; DROP TABLE ds_runs' }] }, '排序方向'],
    [{ dataset: 'runs', limit: 999999 }, '行数上限'],
    [{ dataset: 'runs', sql: 'SELECT 1' }, '多出来的键'],
    [{ dataset: 'runs', measures: [{ as: 't', fn: 'sum', col: 'status' }] }, '对文本列求和'],
    [{ dataset: 'runs', group: ['status'], select: ['id'] }, '分组时又写 select'],
    [{ dataset: 'runs', filter: [{ col: 'id', op: '=', value: 'abc' }] }, '整数列和文本比'],
  ]) {
    e = await refused(() => s.query(spec));
    ok(`Q6 不合格的查询被拒：${why}`, e?.code === 'invalid' || e?.code === 'not_found', e);
  }
  for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    e = await refused(() => s.query({ dataset: 'runs', filter: [{ col: 'id', op, value: 1 }] }));
    ok(`Q6 对象原型上的名字不是比较符：${op}`, e?.code === 'invalid', e);
  }
  e = await refused(async () => { q = await s.query({ dataset: 'runs', filter: [{ col: 'status', op: '=', value: '$constructor' }] }, {}); });
  ok('Q6 参数名撞上对象原型上的名字：当作没给', e === null && q.rows.length === 4, e ?? q.rows.length);
  ok('Q6 被拒之后数据还在', (await s.query({ dataset: 'runs' })).rows.length === 4);
  const plan = planQuery({ dataset: 'runs', filter: [{ col: 'status', op: '=', value: 'x' }, { col: 'id', op: 'in', values: [1, 2] }], group: ['status'], measures: [{ as: 'n', fn: 'count' }] }, new Map((await s.datasets()).map((d) => [d.name, d])), { params: {} });
  ok('Q7 语句里只有核对过的名字，值全在参数里', !plan.sql.includes("'") && plan.args.slice(0, 3).join() === 'x,1,2' && /^SELECT c_status AS "status", COUNT\(\*\) AS "n" FROM ds_runs WHERE /.test(plan.sql), plan.sql);

  // —— 视图描述与版本 ——
  console.log('视图描述与版本');
  await s.defineDataset({ name: 'reports', columns: [{ name: 'title', type: 'text', required: true }, { name: 'kind', type: 'text' }] }, ctx());
  const doc = (title = '示例台') => ({ title, views: [
    { key: 'overview', title: '总览', blocks: [
      { type: 'filter-bar', fields: [{ name: 'month', kind: 'month' }, { name: 'st', kind: 'select', options: { dataset: 'runs', col: 'status' } }] },
      { type: 'stat', title: '完成', query: { dataset: 'runs', measures: [{ as: 'v', fn: 'sum', col: 'done' }] }, value: 'v' },
      { type: 'bar', title: '按状态', query: { dataset: 'runs', filter: [{ col: 'day', op: 'prefix', value: '$month' }], group: ['status'], measures: [{ as: 'n', fn: 'count' }] }, x: 'status', y: 'n' },
      { type: 'table', query: { dataset: 'runs', limit: 50 }, columns: ['id', 'status', 'done'] },
    ] },
    { key: 'report', title: '提报', blocks: [{ type: 'form', dataset: 'reports', fields: ['title', 'kind'] }] },
  ] });
  ok('V1 还没有版本时读到空', (await s.getView()) === null);
  const ds = new Map((await s.datasets()).map((d) => [d.name, d]));
  ok('V2 合格的视图描述没有问题', validateViewDoc(doc(), ds).length === 0, validateViewDoc(doc(), ds));
  const mut = (fn) => { const d = doc(); fn(d); return validateViewDoc(d, ds); };
  for (const [fn, why] of [
    [(d) => { d.views[0].blocks[1].type = 'iframe'; }, '不认识的组件类型'],
    [(d) => { d.views[0].blocks[1].html = '<script>alert(1)</script>'; }, '组件上多出来的键'],
    [(d) => { d.views[0].blocks[1].query.dataset = 'nope'; }, '数据集不存在'],
    [(d) => { d.views[0].blocks[1].value = 'done'; }, 'value 不是查询的输出列'],
    [(d) => { d.views[0].blocks[2].y = 'status'; }, 'y 不是数值'],
    [(d) => { d.views[0].blocks[2].query.filter[0].value = '$other'; }, '引用了筛选栏里没有的参数'],
    [(d) => { d.views[0].blocks[3].columns = ['amount']; }, '表格列不在输出里'],
    [(d) => { d.views[1].blocks[0].fields = ['kind']; }, '必填列不在表单里'],
    [(d) => { d.views[1].key = 'overview'; }, '视图 key 重复'],
    [(d) => { d.views[0].blocks[0].fields[1].options = { dataset: 'runs', col: 'nope' }; }, '选项的列不存在'],
    [(d) => { d.extra = 1; }, '顶层多出来的键'],
    [(d) => { d.views[0].blocks[1].span = 13; }, '栏数超出 12'],
  ]) ok(`V3 不合格的视图描述被指出：${why}`, mut(fn).length > 0);
  e = await refused(() => s.putView(mut ? (() => { const d = doc(); d.views[0].blocks[1].type = 'iframe'; return d; })() : null, ctx({ base: 0, note: '坏的' })));
  ok('V3 不合格的不产生新版本', e?.code === 'invalid' && (await s.viewVersions()).length === 0);
  e = await refused(() => s.putView(doc(), ctx({ base: 0 })));
  ok('V4 保存要写说明', e?.code === 'invalid');
  r = await s.putView(doc(), ctx({ base: 0, note: '第一版', actor: 'alice' }));
  ok('V5 第一次保存是第 1 版并生效', r.version === 1 && r.active_version === 1);
  r = await s.putView(doc(), ctx({ base: 1, note: '没改' }));
  ok('V5 内容没变不产生新版本', r.unchanged === true && r.version === 1);
  r = await s.putView(doc('示例台 改'), ctx({ base: 1, note: '改标题', actor: 'bob' }));
  ok('V6 基于最新版保存：第 2 版', r.version === 2);
  e = await refused(() => s.putView(doc('别人的改动'), ctx({ base: 1, note: '基于旧版', actor: 'carol' })));
  ok('V7 基于旧版保存被拒，并告知现在生效的是哪一版', e?.code === 'conflict' && e.details.join().includes('active_version=2'));
  const both = await Promise.allSettled([s.putView(doc('并发甲'), ctx({ base: 2, note: '甲' })), s.putView(doc('并发乙'), ctx({ base: 2, note: '乙' }))]);
  ok('V7 两个人同时基于同一版保存：只成一个，另一个被拒，不互相覆盖', both.filter((x) => x.status === 'fulfilled').length === 1 && both.filter((x) => x.status === 'rejected' && x.reason.code === 'conflict').length === 1);
  let vs = await s.viewVersions();
  ok('V8 版本清单：谁、说明、哪一版生效', vs.length === 3 && vs[0].active && vs[2].author === 'alice' && vs[1].note === '改标题');
  r = await s.rollbackView(1, ctx({ base: 3, note: '退回第一版' }));
  vs = await s.viewVersions();
  ok('V9 回退只移指针：版本一个不少，生效的是第 1 版', r.active_version === 1 && vs.length === 3 && vs.find((v) => v.active).version === 1 && (await s.getView()).content.title === '示例台');
  e = await refused(() => s.rollbackView(2, ctx({ base: 3, note: '看错了版本' })));
  ok('V9 回退也要基于当前生效的版本', e?.code === 'conflict');
  r = await s.putView(doc('回退之后再改'), ctx({ base: 1, note: '从第一版接着改' }));
  ok('V9 回退之后接着改：版本号接着往后排', r.version === 4);
  const diff = await s.diffViews(1, 4);
  ok('V10 两版差异给出路径', diff.length === 1 && diff[0].path === '/title' && diff[0].change === 'changed', diff);
  ok('V10 视图换了先后不算改动，多一个组件算', diffJson(doc(), { ...doc(), views: [...doc().views].reverse() }).length === 0 && diffJson({ a: [1] }, { a: [1, 2] })[0].change === 'added');
  ok('V11 指定版本可读（预览用）', (await s.getView(2)).content.title === '示例台 改' && (await s.getView(2)).active_version === 4);
  await s.defineDataset({ name: 'reports', columns: [{ name: 'title', type: 'text', required: true }] }, ctx());
  e = await refused(() => s.rollbackView(1, ctx({ base: 4, note: '退回' })));
  ok('V12 旧版本引用的列已经不在了：不能生效', e?.code === 'invalid' && e.details.some((d) => d.includes('kind')), e);
  const ch = await s.changes();
  ok('V13 变更记录：保存、回退、列定义、快照、退回都在', ['view.put', 'view.rollback', 'dataset.define', 'dataset.snapshot', 'dataset.restore'].every((k) => ch.some((c) => c.kind === k)));
  ok('V13 每次变更提交之后通知一次', events.some((c) => c.kind === 'view.put' && c.bench === 'demo' && c.to === 2) && events.some((c) => c.kind === 'data.replace'));

  // —— 排队、隔离、落盘 ——
  console.log('排队、隔离、落盘');
  await s.defineDataset({ name: 'seq', columns: [{ name: 'n', type: 'integer' }], key: ['n'] }, ctx());
  const burst = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => (i % 2 ? s.append('seq', [{ n: i }], ctx()) : s.query({ dataset: 'seq', measures: [{ as: 'c', fn: 'count' }] }))));
  const counts = burst.filter((_, i) => i % 2 === 0).map((x) => x.value.rows[0].c);
  ok('I1 同一个台并发读写排成一队：都成功，读到的行数只增不减', burst.every((x) => x.status === 'fulfilled') && counts.every((c, i) => i === 0 || c >= counts[i - 1]) && (await s.query({ dataset: 'seq' })).rows.length === 20, counts);
  const other = await benchStore('other');
  ok('I2 台与台隔离：另一个台看不到这个台的数据集', (await other.datasets()).length === 0 && (await refused(() => other.query({ dataset: 'runs' })))?.code === 'not_found');
  for (const slug of ['../demo', 'a/b', '', 'UPPER', '.', 'demo.sqlite', 'x'.repeat(65)]) {
    e = await refused(() => benchStore(slug));
    ok(`I3 台的标识不合规被拒：${JSON.stringify(slug).slice(0, 20)}`, e?.code === 'invalid');
  }
  ok('I3 数据目录外和上一层没有多出文件', readdirSync(join(DATA, 'bench-stores')).filter((f) => f.endsWith('.sqlite')).sort().join() === 'demo.sqlite,other.sqlite' && !existsSync(join(DATA, 'demo.sqlite')));
  ok('I4 问一句有没有，不会把库建出来', benchStoreExists('never') === false && !existsSync(join(DATA, 'bench-stores', 'never.sqlite')));
  const copy = join(DATA, 'demo-backup.sqlite');
  await s.backupTo(copy);
  const bdb = new DatabaseSync(copy, { readOnly: true });
  ok('I5 备份副本可单独打开，数据一致', bdb.prepare('SELECT COUNT(*) AS n FROM ds_runs').get().n === 4);
  bdb.close();
  ok('I5 备份目标已存在时拒绝覆盖', (await refused(() => s.backupTo(copy)))?.code === 'conflict');
  await closeBenchStores();
  e = await refused(() => s.query({ dataset: 'runs' }));
  ok('I6 关库之前拿到的句柄：明确拒绝，不是库的原始报错', e?.code === 'conflict', e);
  const s2 = await benchStore('demo');
  ok('I6 关掉重开：数据、生效版本、历史都还在', (await s2.query({ dataset: 'runs' })).rows.length === 4 && (await s2.getView()).version === 4 && (await s2.viewVersions()).length === 4);
  await closeBenchStores();
  const raw = new DatabaseSync(join(DATA, 'bench-stores', 'demo.sqlite'));
  raw.prepare("UPDATE bs_meta SET v = '999' WHERE k = 'schema_version'").run();
  raw.close();
  e = await refused(() => benchStore('demo'));
  ok('I7 库的结构比这份代码新：拒绝打开，不动它', e?.code === 'unsupported');
  await removeBenchStore('other');
  ok('I8 删台：库文件没了', !existsSync(join(DATA, 'bench-stores', 'other.sqlite')));
  // 验收第一轮复现的交错：删台的过程中又取这个台
  const race = await benchStore('race');
  await race.defineDataset({ name: 't', columns: [{ name: 'n', type: 'integer' }] }, ctx());
  const rm = removeBenchStore('race');
  e = await refused(() => benchStore('race'));
  ok('I9 删台期间取同一个台被拒', e?.code === 'conflict', e);
  await rm;
  ok('I9 删完文件没了', !existsSync(join(DATA, 'bench-stores', 'race.sqlite')));
  e = await refused(() => race.append('t', [{ n: 1 }], ctx()));
  ok('I9 删台之前拿到的句柄不能再写', e?.code === 'conflict' && !existsSync(join(DATA, 'bench-stores', 'race.sqlite')), e);
  const fresh = await benchStore('race');
  ok('I9 删完之后可以重新建，是空的', (await fresh.datasets()).length === 0);
  // 库报了意料之外的错（这里是背着服务把表删了）：对外只说内部错误，不带库的原文
  await fresh.defineDataset({ name: 'gone', columns: [{ name: 'n', type: 'integer' }] }, ctx());
  await closeBenchStores();
  const raw2 = new DatabaseSync(join(DATA, 'bench-stores', 'race.sqlite'));
  raw2.exec('DROP TABLE ds_gone');
  raw2.close();
  e = await refused(async () => (await benchStore('race')).query({ dataset: 'gone' }));
  ok('I10 库出了意料之外的错：回内部错误，不带库的报错原文', e?.code === 'internal' && !/ds_gone|no such table|SQLITE/i.test(e.message), e);
  writeFileSync(join(DATA, 'bench-stores', 'broken.sqlite'), 'this is plain text, not a database file. '.repeat(200));
  e = await refused(() => benchStore('broken'));
  ok('I11 库文件坏了：回内部错误，不带库的报错原文', e?.code === 'internal' && !/not a database|SQLITE/i.test(e.message), e);
  await removeBenchStore('broken');
  ok('I11 开不成的台可以删掉重建', (await (await benchStore('broken')).datasets()).length === 0);
  const twice = await benchStore('twice');
  await twice.defineDataset({ name: 't', columns: [{ name: 'n', type: 'integer' }] }, ctx());
  await Promise.all([removeBenchStore('twice'), removeBenchStore('twice')]);
  ok('I12 同一个台同时删两次：都完成，文件没了', !existsSync(join(DATA, 'bench-stores', 'twice.sqlite')));
  ok('I12 之后能重新建，是空的', (await (await benchStore('twice')).datasets()).length === 0);

  // —— T：读写在工作线程里跑，带时限（设计稿第十一节第 1 条）——
  console.log('T 工作线程与时限');
  const big = await benchStore('big');
  await big.defineDataset({ name: 'wide', columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }, { name: 'grp', type: 'integer' }], key: ['id'] }, ctx());
  const mk = (n, off = 0) => Array.from({ length: n }, (_, i) => ({ id: off + i, body: 'x'.repeat(1990) + String(off + i).padStart(10, '0'), grp: (off + i) % 7 }));
  const N = 20000;
  for (let o = 0; o < N; o += 5000) await big.append('wide', mk(5000, o), ctx());
  const slow = { dataset: 'wide', measures: [{ as: 'n', fn: 'count_distinct', col: 'body' }] };
  const count = async () => (await big.query({ dataset: 'wide', measures: [{ as: 'n', fn: 'count' }] })).rows[0].n;
  // 量这段时间里本进程的事件循环最长停了多久：每 5 毫秒打一次点，记相邻两次的最大间隔
  const watch = async (fn) => {
    let gap = 0, last = performance.now();
    const iv = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; }, 5);
    const t0 = performance.now();
    try { return { value: await fn(), took: performance.now() - t0, gap }; } finally { clearInterval(iv); }
  };
  const base = configureBenchRuntime({});
  let m = await watch(() => big.query(slow));
  const slowMs = m.took;
  console.log(`    慢查询 ${m.took.toFixed(0)} 毫秒，期间本进程最长停顿 ${m.gap.toFixed(0)} 毫秒`);
  ok('T1 慢查询期间市场进程不停：最长停顿不到查询用时的一半', m.value.rows[0].n === N && m.gap < m.took / 2, { took: m.took, gap: m.gap });

  configureBenchRuntime({ queryMs: 20 });
  let st = benchRuntimeStats();
  m = await watch(() => refused(() => big.query(slow)));
  configureBenchRuntime(base);
  ok('T2 查询超时：报 timeout，写明没有生效', m.value?.code === 'timeout' && /没有生效/.test(m.value.message), m.value);
  ok(`T2 到时限就停（${m.took.toFixed(0)} 毫秒），不是跑完才报；没有动用强行终止`, m.took < slowMs / 2 + 60 && benchRuntimeStats().kills === st.kills, { took: m.took, slowMs });
  e = await refused(async () => { q = await big.query(slow); });
  ok('T2 超时之后这个台照常可用，被打断的那条查询再发一次也正常', await count() === N && e === null && q.rows[0].n === N, e);

  const w0 = (await big.writes(500)).length, s0 = (await big.snapshots('wide')).length;
  configureBenchRuntime({ writeMs: 30 });
  e = await refused(() => big.replace('wide', mk(N), ctx({ idemKey: 'timeout-then-retry-1' })));
  configureBenchRuntime(base);
  ok('T3 写入超时：报 timeout', e?.code === 'timeout' && /没有生效/.test(e.message), e);
  ok('T3 整批回滚：行数、快照、写入记录都没变', await count() === N && (await big.snapshots('wide')).length === s0 && (await big.writes(500)).length === w0);
  m = await watch(() => big.replace('wide', mk(N), ctx({ idemKey: 'timeout-then-retry-1' })));
  console.log(`    整份替换 ${N} 行 ${m.took.toFixed(0)} 毫秒，期间本进程最长停顿 ${m.gap.toFixed(0)} 毫秒`);
  ok('T3 带同一个幂等键重试：这次真的写了，不算重复', m.value.duplicate !== true && m.value.row_count === N && Number.isInteger(m.value.snapshot_id), m.value);

  // 时限从轮到它开始算，排队的时间不算：四个慢查询同时发，时限定在单个用时的两倍半——要是从发起算，排在后面的会超时
  configureBenchRuntime({ queryMs: Math.ceil(slowMs * 2.5) + 50 });
  const four = await Promise.all([1, 2, 3, 4].map(() => refused(() => big.query(slow))));
  configureBenchRuntime(base);
  ok('T4 排队的时间不算进时限', four.every((x) => x === null), four);

  // 停不下来的操作（整库备份是一条语句，中途回不到服务里）：时限加宽限过了，强行终止线程
  const bk = join(DATA, 'big-backup.sqlite');
  configureBenchRuntime({ writeMs: 1, graceMs: 1 });
  st = benchRuntimeStats();
  const killed = refused(() => big.backupTo(bk));
  const behind = big.datasets().then((d) => d.length, (x) => x?.code ?? String(x));
  e = await killed;
  configureBenchRuntime(base);
  ok('T5 停不下来的操作被强行终止：报 timeout，写明写入是否生效不确定', e?.code === 'timeout' && /不确定/.test(e.message) && benchRuntimeStats().kills === st.kills + 1, e);
  ok('T5 排在后面的读写在新起的线程上照常完成', (await behind) === 1 && benchRuntimeStats().spawns === st.spawns + 1, { behind: await behind, ...benchRuntimeStats() });
  ok('T5 备份的目标文件没有留下半截的', !existsSync(bk));
  ok('T5 之后这个台照常读写', await count() === N && (await big.upsert('wide', [{ id: 0, body: 'changed', grp: 1 }], ctx())).updated === 1);
  e = await refused(() => big.backupTo(bk));
  ok('T5 再备份一次成功，临时文件不留', e === null && existsSync(bk) && !existsSync(`${bk}.partial`), e);
  // 被强行终止的线程手里握着写锁（留快照要先读完全表，中途停不下来）：等它真的退出才起新线程，排在后面的写入不会撞上锁
  configureBenchRuntime({ writeMs: 1, graceMs: 1 });
  st = benchRuntimeStats();
  const killedInTx = refused(() => big.snapshot('wide', ctx()));
  const writeBehind = refused(() => big.upsert('wide', [{ id: 1, body: 'after-kill', grp: 2 }], ctx()));
  e = await killedInTx;
  configureBenchRuntime(base);
  const wb = await writeBehind;
  ok('T5 事务做到一半被强行终止：排在后面的写入在新线程上成功，没有撞上旧线程的锁', e?.code === 'timeout' && benchRuntimeStats().kills === st.kills + 1 && wb === null, { e, wb });
  ok('T5 被终止的那次留快照没有生效', (await big.snapshots('wide')).length === s0 + 1 && await count() === N);

  e = await refused(() => big.query({ dataset: 'wide', select: ['body'], limit: 5000 }));
  ok('T6 一次取回的内容太大：报超限', e?.code === 'limit' && /字符/.test(e.message), e);
  q = await big.query({ dataset: 'wide', select: ['id', 'grp'], limit: 5000 });
  ok('T6 少取几列就可以', q.rows.length === 5000 && q.truncated === true);
  e = await refused(() => big.query({ dataset: 'wide', select: ['body'], limit: 100 }));
  ok('T6 因为太大被打断的那条查询，行数调小再发正常', e === null, e);

  e = await refused(() => big.append('wide', [{ id: N + 1, body: () => 1, grp: 1 }], ctx()));
  ok('T7 参数里有过不了线程的值：当场拒绝，后面的照常', e?.code === 'invalid' && await count() === N, e);

  // 线程自己意外退出（这里用测试口子让它退）：手上那件事马上失败，不用等到时限；下一件事另起线程
  st = benchRuntimeStats();
  const inflight = watch(() => refused(() => big.query(slow)));
  await new Promise((r) => setTimeout(r, 10));
  stopBenchWorkerAbruptly();
  m = await inflight;
  ok('T9 线程意外退出：手上那件事报内部错误，写明写入是否生效不确定', m.value?.code === 'internal' && /意外退出/.test(m.value.message) && benchRuntimeStats().crashes === st.crashes + 1, m.value);
  ok(`T9 马上就知道（${m.took.toFixed(0)} 毫秒），不是等到时限加宽限`, m.took < 1500, { took: m.took });
  ok('T9 下一次读写另起线程，照常', await count() === N && benchRuntimeStats().spawns === st.spawns + 1);

  // 提交之前看时限：时限短到任何写入都来不及，而这次写入中途没有别的检查点——只有提交前这一道拦得住
  const bigDoc = { title: '大台', views: [{ key: 'main', title: '总览', blocks: [{ type: 'table', query: { dataset: 'wide', select: ['id', 'grp'], limit: 50 }, columns: ['id', 'grp'] }] }] };
  configureBenchRuntime({ writeMs: 0.01 });
  e = await refused(() => big.putView(bigDoc, ctx({ base: 0, note: '应当超时' })));
  configureBenchRuntime(base);
  ok('T10 提交之前看时限：过了就不提交，报 timeout', e?.code === 'timeout' && (await big.viewVersions()).length === 0 && (await big.getView()) === null, e);
  e = await refused(async () => { r = await big.putView(bigDoc, ctx({ base: 0, note: '正常时限' })); });
  ok('T10 同一份内容，时限正常时保存成功', e === null && r.version === 1 && r.active_version === 1, e ?? r);

  // 写入在行与行之间看时限：超时的大写入早早停下，不是把两万行都插完才发现。比的是用时，留了很宽的余量
  await big.defineDataset({ name: 'fresh', columns: [{ name: 'id', type: 'integer' }, { name: 'body', type: 'text' }, { name: 'grp', type: 'integer' }], key: ['id'] }, ctx());
  configureBenchRuntime({ writeMs: 0.01 });
  m = await watch(() => refused(() => big.replace('fresh', mk(N), ctx())));
  configureBenchRuntime(base);
  const stoppedIn = m.took;
  ok('T11 超时的大写入：报 timeout，一行没写', m.value?.code === 'timeout' && (await big.query({ dataset: 'fresh', measures: [{ as: 'n', fn: 'count' }] })).rows[0].n === 0, m.value);
  m = await watch(() => big.replace('fresh', mk(N), ctx()));
  console.log(`    两万行写入：超时的那次 ${stoppedIn.toFixed(0)} 毫秒就停了，写完的那次 ${m.took.toFixed(0)} 毫秒`);
  ok('T11 停得早：用时不到写完那次的七成', stoppedIn < m.took * 0.7, { stoppedIn, full: m.took });

  // 线程只认登记过的操作名和消息格式（直接起一个线程发消息，不经市场进程这一侧）
  const tw = new Worker(new URL('../server/src/services/bench-store-worker.ts', import.meta.url), { workerData: { root: join(DATA, 'direct'), kit: benchSqlKit('sqlite') } });
  const ask = (msg) => new Promise((res) => { const t = setTimeout(() => res('没有回话'), 1500); tw.once('message', (r) => { clearTimeout(t); res(r); }); tw.postMessage(msg); });
  let died = false; tw.on('error', () => { died = true; }); tw.on('exit', () => { died = true; });
  const badOps = [];
  for (const method of ['constructor', '__proto__', 'init', 'close', 'withBudget', 'toString', '@nope']) badOps.push(await ask({ id: 1, slug: 'direct', method, args: [], budgetMs: 0 }));
  ok('T12 线程只做登记过的操作：别的名字一律拒', badOps.every((r) => r.ok === false && r.error.code === 'invalid'), badOps);
  tw.postMessage(null); tw.postMessage('x'); tw.postMessage({ method: 'datasets' });
  const malformed = await ask({ id: 2, slug: 'direct', method: 'datasets', args: 'not-an-array', budgetMs: 0 });
  const fine = await ask({ id: 3, slug: 'direct', method: 'datasets', args: [], budgetMs: 0 });
  ok('T12 格式不对的消息不理或拒绝，线程不垮，后面的照常', malformed.ok === false && malformed.error.code === 'invalid' && fine.ok === true && Array.isArray(fine.value) && !died, { malformed, fine, died });
  await ask({ id: 4, slug: '', method: '@closeAll', args: [], budgetMs: 0 });
  await tw.terminate();

  const flood = await Promise.all(Array.from({ length: BENCH_LIMITS.queue + 50 }, () => refused(() => big.viewVersions())));
  const busy = flood.filter((x) => x?.code === 'busy').length;
  ok('T8 排队的读写有上限：超出的报 busy，排上的都做完', busy === 49 && flood.filter((x) => x === null).length === BENCH_LIMITS.queue + 1, { busy });
  ok('T8 之后照常可用', await count() === N && benchRuntimeStats().queued === 0);
} finally {
  onBenchChange(null);
  await closeBenchStores();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nbench-store-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
