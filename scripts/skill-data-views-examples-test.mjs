#!/usr/bin/env node
/**
 * 技能 wm-data-views 里的例子都是真的：把 SKILL.md 和 references 里标了用途的 JSON 代码块逐个拿出来，
 * 用台库的真实现跑一遍——建数据集、写数据、查询、保存视图描述、取数——都要成。上限表里的数字和代码里的常量对得上。
 * 代码改了、技能没跟上，这里会红。
 * 代码块的标记：```json dataset（同名再出现是改列）、```json rows:<数据集名>（整份替换）、```json upsert:<名>、```json append:<名>、
 * ```json delete:<名>、```json query、```json view-doc。按文件里出现的先后逐块执行。入口开之前，建台的人也用它先验自己的 JSON（技能里写了）。
 * 用法：node scripts/skill-data-views-examples-test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

mkdirSync(resolve('tmp'), { recursive: true }); // 新检出没有 tmp/
const DATA = mkdtempSync(resolve('tmp/skill-data-views-'));
process.env.DATA_DIR = DATA;
const { BenchHost } = await import('../server/src/services/bench-store-core.ts');
const { benchSqlKit } = await import('../server/src/db.ts');
const { BENCH_LIMITS } = await import('../server/src/bench-query.ts');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${typeof x === 'string' ? x : JSON.stringify(x)}`); } };
let clock = 1_700_000_000_000;
const ctx = (extra = {}) => ({ actor: 'skill-test', at: ++clock, ...extra });
const DIR = resolve('skills/wm-data-views');
const files = ['SKILL.md', ...readdirSync(join(DIR, 'references')).filter((f) => f.endsWith('.md')).sort().map((f) => `references/${f}`)];
const blocks = [];
for (const f of files) {
  const text = readFileSync(join(DIR, f), 'utf8');
  for (const m of text.matchAll(/```json ([a-z-]+(?::[a-z0-9_]+)?)\n([\s\S]*?)```/g)) blocks.push({ file: f, kind: m[1], body: m[2], n: blocks.filter((b) => b.file === f).length + 1 });
}
const say = (b) => `${b.file} 第 ${b.n} 个例子（${b.kind}）`;
const tryIt = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: { code: e.code, message: e.message, details: e.details } }; } };

const host = new BenchHost(join(DATA, 'b'), benchSqlKit('sqlite'));
try {
  ok('技能里有例子可验', blocks.length >= 10 && ['dataset', 'query', 'view-doc'].every((k) => blocks.some((b) => b.kind === k)) && blocks.some((b) => b.kind.startsWith('rows:')), blocks.map((b) => b.kind));
  const parsed = blocks.map((b) => { try { return { ...b, json: JSON.parse(b.body) }; } catch (e) { ok(`${say(b)}：是合法的 JSON`, false, e.message); return null; } }).filter(Boolean);
  const s = await host.store('skill');
  // 按文件里出现的先后逐块执行
  const seen = new Set();
  for (const b of parsed) {
    const [kind, name] = b.kind.split(':');
    seen.add(kind);
    if (kind === 'dataset') { const r = await tryIt(() => s.defineDataset(b.json, ctx())); ok(`${say(b)}：数据集定义收得下`, !r.error, r.error); }
    else if (kind === 'rows') { const r = await tryIt(() => s.replace(name, b.json, ctx())); ok(`${say(b)}：整份替换进 ${name}`, !r.error && r.value.row_count === b.json.length, r.error ?? r.value); }
    else if (kind === 'upsert') { const r = await tryIt(() => s.upsert(name, b.json, ctx())); ok(`${say(b)}：按主键更新进 ${name}`, !r.error && r.value.inserted + r.value.updated === b.json.length, r.error ?? r.value); }
    else if (kind === 'append') { const r = await tryIt(() => s.append(name, b.json, ctx())); ok(`${say(b)}：追加进 ${name}`, !r.error && r.value.inserted === b.json.length, r.error ?? r.value); }
    else if (kind === 'delete') { const r = await tryIt(() => s.deleteRows(name, b.json, ctx())); ok(`${say(b)}：按主键从 ${name} 删行，给的主键都对得上`, !r.error && r.value.deleted === b.json.length, r.error ?? r.value); }
    else if (kind === 'query') { const r = await tryIt(() => s.query(b.json, { month: '2026-01' })); ok(`${say(b)}：查询跑得通`, !r.error, r.error); }
    else if (kind === 'view-doc') {
      const base = (await s.getView())?.version ?? 0;
      const r = await tryIt(() => s.putView(b.json, ctx({ base, note: say(b) })));
      ok(`${say(b)}：视图描述保存得了`, !r.error, r.error);
      if (r.error) continue;
      for (const v of b.json.views) {
        const out = await tryIt(() => s.renderView({ view: v.key, params: { month: '2026-01' } }));
        const bad = out.value?.blocks.filter((x) => x.error) ?? [];
        ok(`${say(b)}：视图 ${v.key} 取数时每个组件都有数、没有出错的`, !out.error && bad.length === 0, out.error ?? bad.map((x) => ({ type: x.type, error: x.error })));
      }
    } else ok(`${say(b)}：标记认得`, false, `不认识的标记 ${b.kind}`);
  }
  ok('七种标记技能里都有例子', ['dataset', 'rows', 'upsert', 'append', 'delete', 'query', 'view-doc'].every((k) => seen.has(k)), [...seen]);
  const sk = readFileSync(join(DIR, 'SKILL.md'), 'utf8');
  ok('技能里写了入口开之前怎么先验：脚本名和七种标记', sk.includes('scripts/skill-data-views-examples-test.mjs') && ['json dataset', 'json rows:', 'json upsert:', 'json append:', 'json delete:', 'json query', 'json view-doc'].every((m) => sk.includes('`' + m)));
  // 完整例子（references/example-inspection.md）第 5 步写的数，和真取到的一样（文字里写了几次、几个区，代码改了要跟着改）
  {
    const m = { month: '2026-01' };
    const F = [{ col: 'day', op: 'prefix', value: '$month' }];
    const total = (await s.query({ dataset: 'patrol_records', filter: F, measures: [{ as: 'v', fn: 'count' }] }, m)).rows[0]?.v;
    const bad = (await s.query({ dataset: 'patrol_records', filter: [...F, { col: 'result', op: '=', value: 'bad' }], measures: [{ as: 'v', fn: 'count' }] }, m)).rows[0]?.v;
    const byRegion = (await s.query({ dataset: 'patrol_records', filter: F, group: ['region'], sort: [{ col: 'region' }], measures: [{ as: 'n', fn: 'count' }] }, m)).rows.map((r) => `${r.region}${r.n}`).join(',');
    const text = readFileSync(join(DIR, 'references/example-inspection.md'), 'utf8');
    ok('完整例子：第 5 步写的数和真取到的一样（本月 6 次、异常 1 次、东南西各 2 次）', total === 6 && bad === 1 && byRegion === '东区2,南区2,西区2' && text.includes('本月巡检 6 次、异常 1 次') && text.includes('柱状图东区 2、南区 2、西区 2') && text.includes('明细 6 行'), { total, bad, byRegion });
  }
  // 上限表里的数字和代码里的常量对得上
  const limits = readFileSync(join(DIR, 'references/limits.md'), 'utf8'), skill = readFileSync(join(DIR, 'SKILL.md'), 'utf8');
  const L = BENCH_LIMITS, has = (t) => limits.includes(t);
  ok('上限表：数据集个数、列数、主键列数、行数', has(`| ${L.datasets} 个 |`) && has(`${L.columns} 列（主键最多 ${L.keyColumns} 列）`) && L.rows === 50_000 && has('5 万行'), [L.datasets, L.columns, L.keyColumns, L.rows]);
  ok('上限表：三道数据量上限', has(`| ${L.datasetBytes / 1e6} MB |`) && has(`| ${L.storeBytes / 1e6} MB |`) && has(`${L.rowsPerWrite} 行、${L.writeBytes / 1e6} MB`), [L.datasetBytes, L.storeBytes, L.writeBytes]);
  ok('上限表：一格文本、一次查询、视图描述、快照、历史版本、幂等键、说明', L.textChars === 10_000 && has('1 万个字符') && has(`${L.queryLimit} 行、各格字符数合计 ${L.resultChars / 1e6 * 100} 万`) && has(`${L.viewBytes / 1000} KB`) && has(`| ${L.snapshots} 份 |`) && has(`视图 ${L.viewVersions} 版、列定义 ${L.datasetVersions} 版`) && has(`最近 ${L.writeLog} 次写入`) && has(`${L.noteChars} 个字符`), L);
  ok('上限表和主文件：时限、排队', has(`| ${L.queryMs / 1000} 秒 |`) && has(`| ${L.writeMs / 1000} 秒 |`) && has(`超过 ${L.queue} 件`) && skill.includes(`读超过 ${L.queryMs / 1000} 秒、写超过 ${L.writeMs / 1000} 秒`), [L.queryMs, L.writeMs, L.queue]);
  ok('查询参考：行数上限、筛选条数、聚合个数、in 的个数', readFileSync(join(DIR, 'references/query.md'), 'utf8').includes(`1～${L.queryLimit}，不给是 ${L.queryDefault}`) && readFileSync(join(DIR, 'references/query.md'), 'utf8').includes(`最多 ${L.filters} 条`) && readFileSync(join(DIR, 'references/query.md'), 'utf8').includes(`最多 ${L.measures} 个`) && readFileSync(join(DIR, 'references/query.md'), 'utf8').includes(`1～${L.inValues} 个`));
} catch (e) {
  fail++; console.log(`  ✗ 中途抛错：${e?.stack ?? e}`);
} finally {
  await host.closeAll();
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\nskill-data-views-examples-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
