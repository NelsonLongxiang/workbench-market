#!/usr/bin/env node
/**
 * 判定并行比对的报告（阶段六 6c）：把录制回放和 CI 里的脚本命令都在比对打开（WM_JUDGMENT_COMPARE=on）的情况下跑一遍，
 * 每次比对往输出文件追加一行（不含 id 和凭据），最后按「域 × 原因」汇总成一份 Markdown。
 *   · 回放：每条请求带 x-replay-step，报告里每类不一致能指到「哪条录制的哪个请求」；
 *   · 别的脚本：一个脚本一个输出文件，报告里写是哪个脚本（只有起实例时把环境变量传下去的脚本才有数）。
 * 只在本机起隔离实例，不访问任何外部系统。不进 CI（要跑一个多小时）。
 *
 *   node scripts/judgment-compare-report.mjs [--out 报告.md] [--replay-only] [--require-zero] [--from 比对输出.jsonl ...]
 *   node scripts/judgment-compare-report.mjs --snapshot 比对结果.json [--since 上一次的比对结果.json] [--out 报告.md] [--require-zero]
 *   --require-zero：有不一致就失败（CI 用：只跑回放，守住内置身份清单和细分动作不漂移）
 *   --from：不起实例、不跑脚本，只汇总给出的比对输出（WM_JUDGMENT_COMPARE_OUT 的文件）；可以给多个
 *   --snapshot：不起实例、不跑脚本，汇总 GET /api/judgment/compare 的应答（存成文件）。生产上不用开 WM_JUDGMENT_COMPARE_OUT
 *     （那个文件每比一次加一行、不轮转），比对的库本来就按路由、结果攒着计数，拿这个接口的应答就够出「按域」那张表。
 *     和 --from 的差别：接口只有合计，没有每次请求，所以不一致的「最小复现」写不出录制位置，只有路由；
 *     面门拦下的（surface-blocked）在库里和完整性门记在一起（integrity-blocked）。
 *   --since：再给一份更早的应答，报告只算两份之间新增的（每天看一次时用前一天的那份）。比对的库清过、计数变小了就报错退出，不出半截的数
 * 报告里有「按域」一节：每个域各种结果各多少次，切换按域开关，每一波看这张表。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const REPORT = outArg >= 0 ? argv[outArg + 1] : join(ROOT, 'tmp', 'judgment-compare-report.md');
const replayOnly = argv.includes('--replay-only');
const requireZero = argv.includes('--require-zero');
const fromFiles = argv.flatMap((a, i) => (argv[i - 1] === '--from' ? [a] : []));
if (argv.includes('--from') && fromFiles.length === 0) { console.error('--from 后面要给比对输出文件'); process.exit(2); }
for (const f of fromFiles) if (!existsSync(f)) { console.error(`比对输出 ${f} 不存在`); process.exit(2); }
const optOf = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; if (!v || v.startsWith('--')) { console.error(`${name} 后面要给文件`); process.exit(2); } if (!existsSync(v)) { console.error(`${name} 给的 ${v} 不存在`); process.exit(2); } return v; };
const snapshotFile = optOf('--snapshot'), sinceFile = optOf('--since');
if (sinceFile && !snapshotFile) { console.error('--since 要和 --snapshot 一起用'); process.exit(2); }
if (snapshotFile && fromFiles.length) { console.error('--snapshot 和 --from 二选一'); process.exit(2); }
const WORK = join(ROOT, 'tmp', `judgment-compare-${process.pid}`);
mkdirSync(WORK, { recursive: true });

function run(name, cmd, args) {
  const out = join(WORK, `${name.replace(/[^a-z0-9-]/gi, '_')}.jsonl`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, CI: 'true', WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: out }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  console.log(`  ${r.status === 0 ? '✓' : '·'} ${name}（退出 ${r.status}，${Math.round((Date.now() - t0) / 1000)} 秒）`);
  return { name, status: r.status };
}

const offline = fromFiles.length > 0 || !!snapshotFile;
const runs = offline ? [] : [run('route-replay', process.execPath, ['scripts/route-replay-test.mjs'])];
if (!replayOnly && !offline) {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const cmds = [...new Set(ci.split(/&&|\n/).map((p) => p.trim().replace(/^(-\s*)?run:\s*/, '').trim()).filter((p) => /^node scripts\/[a-z0-9-]+\.mjs( [-a-z0-9 ]+)?$/.test(p)))]
    .filter((c) => !/route-replay-test|judgment-compare|identity-seam-mutation|browser|e2e-full-run|tech-route-check|surface-snapshot/.test(c));
  for (const c of cmds) { const [, script, ...rest] = c.split(/\s+/); runs.push(run(script.replace('scripts/', '').replace('.mjs', '') + (rest.length ? `_${rest.join('_')}` : ''), process.execPath, [script, ...rest])); }
}

// ---------- 汇总 ----------
const lines = [];
const inputs = fromFiles.length ? fromFiles.map((f) => ({ path: f, source: f.split(/[\\/]/).pop().replace(/\.jsonl$/, '') }))
  : readdirSync(WORK).filter((n) => n.endsWith('.jsonl')).map((n) => ({ path: join(WORK, n), source: n.replace(/\.jsonl$/, '') }));
if (!snapshotFile) for (const { path, source } of inputs) {
  for (const l of readFileSync(path, 'utf8').split('\n')) { if (!l.trim()) continue; try { lines.push({ ...JSON.parse(l), source }); } catch { /* 半行 */ } }
}
// --snapshot：接口应答里的合计展开成带次数（n）的行，和逐行的输出走同一套汇总。不一致用不一致表（带身份、两边结论、规则），
// 不用计数表里的 mismatch 行，免得算两遍；切换开关拒掉的用 enforced 表
const snap = snapshotFile ? readSnapshot(snapshotFile) : null;
const sinceSnap = sinceFile ? readSnapshot(sinceFile) : null;
function readSnapshot(file) {
  let j; try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`${file} 不是 JSON：${e.message}`); process.exit(2); }
  if (!j || !Array.isArray(j.tally) || !Array.isArray(j.mismatches)) { console.error(`${file} 不是 GET /api/judgment/compare 的应答（要有 tally、mismatches）`); process.exit(2); }
  if (j.on === false) { console.error(`${file}：比对没打开（on=false），没有数`); process.exit(2); }
  const rows = [];
  for (const t of j.tally) if (t.outcome !== 'mismatch') rows.push({ key: `t\u0000${t.route}\u0000${t.outcome}`, route: t.route, action: t.action, outcome: t.outcome, n: Number(t.count) || 0 });
  for (const m of j.mismatches) rows.push({ key: `m\u0000${m.route}\u0000${m.actor_kind}\u0000${m.old}\u0000${m.new}\u0000${m.rule}`, route: m.route, action: m.action, outcome: 'mismatch', actor: m.actor_kind, old: m.old, new: m.new, rule: m.rule, status: m.status, n: Number(m.count) || 0 });
  for (const e of j.enforced ?? []) rows.push({ key: `e\u0000${e.route}\u0000${e.actor_kind}\u0000${e.verdict}\u0000${e.rule}`, route: e.route, action: e.action, outcome: 'enforced-deny', actor: e.actor_kind, rule: e.rule, n: Number(e.count) || 0 });
  return { rows, writeFailures: Number(j.writeFailures) || 0, dropped: Number(j.dropped) || 0 };
}
if (snap) {
  const before = new Map((sinceSnap?.rows ?? []).map((r) => [r.key, r.n]));
  const shrunk = [...before.entries()].filter(([k, n]) => n > (snap.rows.find((r) => r.key === k)?.n ?? 0));
  if (shrunk.length) { console.error(`--since 那份比这份还多（${shrunk.length} 项计数变小了）：比对的库清过或者两份给反了，没法算差`); process.exit(2); }
  for (const r of snap.rows) { const n = r.n - (before.get(r.key) ?? 0); if (n > 0) lines.push({ ...r, n, source: 'snapshot' }); }
}
const nOf = (l) => l.n ?? 1;
const domainOf = (l) => (l.action ? l.action.split('.')[0] : (String(l.route).split(' ')[1] ?? '').split('/').filter(Boolean).slice(0, 2).join('/'));
const count = (pred) => lines.filter(pred).reduce((a, l) => a + nOf(l), 0);
// surface-blocked：被面门（路由声明的 surfaceGate）拦下，旧结论拒绝，不比；和 integrity-blocked 分开列
const OUTCOMES = ['agree', 'mismatch', 'uncertain', 'skip-404', 'unregistered', 'not-verdict', 'integrity-blocked', 'surface-blocked', 'enforced-deny', 'error'];
const totals = Object.fromEntries(OUTCOMES.map((o) => [o, count((l) => l.outcome === o)]));
// 按域：每个域各种结果各多少次（清单外的结果记进「其他」）
const byDomain = new Map();
for (const l of lines) {
  const d = domainOf(l) || '（无）';
  const e = byDomain.get(d) ?? Object.fromEntries([...OUTCOMES, 'other', 'total'].map((o) => [o, 0]));
  e[OUTCOMES.includes(l.outcome) ? l.outcome : 'other'] += nOf(l); e.total += nOf(l);
  byDomain.set(d, e);
}
const reasonOf = (l) => (l.old === 'allow' ? `旧允许·新${l.new === 'ask' ? '先问人' : '拒绝'}·${l.rule}` : `旧拒绝·新允许·${l.rule}`);
const mism = lines.filter((l) => l.outcome === 'mismatch');
const byReason = new Map();
for (const l of mism) {
  const key = `${reasonOf(l)}｜${l.actor}`;
  const e = byReason.get(key) ?? { reason: reasonOf(l), actor: l.actor, count: 0, domains: new Map(), routes: new Map(), sample: null };
  e.count += nOf(l);
  e.domains.set(domainOf(l), (e.domains.get(domainOf(l)) ?? 0) + nOf(l));
  e.routes.set(l.route, (e.routes.get(l.route) ?? 0) + nOf(l));
  if (!e.sample || (!e.sample.step && l.step)) e.sample = { step: l.step ?? null, source: l.source, route: l.route, status: l.status };
  byReason.set(key, e);
}
const domains = [...new Set(mism.map(domainOf))].sort();
const uncertain = new Map();
for (const l of lines.filter((x) => x.outcome === 'uncertain')) uncertain.set(l.route, (uncertain.get(l.route) ?? 0) + nOf(l));
const unreg = new Map();
for (const l of lines.filter((x) => x.outcome === 'unregistered')) unreg.set(domainOf(l), (unreg.get(domainOf(l)) ?? 0) + nOf(l));

const md = [];
const compared = count(() => true);
md.push('# 判定并行比对报告', '', snap ? `比对的请求：${compared} 次（来源：GET /api/judgment/compare 的应答${sinceSnap ? '，只算和上一份之间新增的' : '，从比对打开起的合计'}）。` : fromFiles.length ? `比对的请求：${compared} 次（来源：${inputs.length} 个比对输出文件）。` : `比对的请求：${compared} 次（来源：${runs.length} 个脚本，回放的每条请求带了录制里的位置）。`, '');
// 接口应答里的两个丢数计数是从进程启动起算的（不随 --since 相减）：不是 0 就说明这段时间有比对没记进库，按域那张表偏少
if (snap) md.push(`记账写失败 ${snap.writeFailures} 次、队列满丢掉 ${snap.dropped} 次（从进程启动起算）。${snap.writeFailures || snap.dropped ? '**不是 0：这段时间有比对没记进库，下面的数偏少。**' : ''}`, '');
md.push('| 结果 | 次数 |', '|---|---|', ...Object.entries(totals).map(([k, v]) => `| ${k} | ${v} |`), '');
md.push('## 按域', '', '没报动作的路由按路径前两段归。切换按域开关，每一波看这一节：要切的域 mismatch 为 0，其余各列逐条能解释。enforced-deny 是切换开关（WM_JUDGMENT_ENFORCE）在处理之前拒掉的。', '');
md.push(`| 域 | 合计 | ${OUTCOMES.join(' | ')} | 其他 |`, `|---|---|${OUTCOMES.map(() => '---').join('|')}|---|`);
for (const [d, e] of [...byDomain.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) md.push(`| ${d} | ${e.total} | ${OUTCOMES.map((o) => e[o] || '').join(' | ')} | ${e.other || ''} |`);
md.push('');
md.push('## 不一致：原因 × 域', '');
if (byReason.size === 0) md.push('没有。');
else {
  md.push(`| 原因 | 身份 | 合计 | ${domains.join(' | ')} | 最小复现 |`, `|---|---|---|${domains.map(() => '---').join('|')}|---|`);
  for (const e of [...byReason.values()].sort((a, b) => b.count - a.count)) {
    const where = e.sample?.step ? `回放 \`${e.sample.step}\`` : e.sample?.source === 'snapshot' ? `接口合计（${e.sample.route}，状态码 ${e.sample.status}）` : `脚本 \`${e.sample?.source}\`（${e.sample?.route}）`;
    md.push(`| ${e.reason} | ${e.actor} | ${e.count} | ${domains.map((d) => e.domains.get(d) ?? '').join(' | ')} | ${where} |`);
  }
  md.push('', '### 每类不一致涉及的路由', '');
  for (const e of [...byReason.values()].sort((a, b) => b.count - a.count)) md.push(`- **${e.reason}｜${e.actor}**：${[...e.routes.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `\`${r}\` ${n}`).join('；')}`);
}
md.push('', '## 不确定（400/409/422 这类、5xx）：按路由', '', '| 路由 | 次数 |', '|---|---|', ...[...uncertain.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `| \`${r}\` | ${n} |`));
const byRoute = (o) => { const m = new Map(); for (const l of lines.filter((x) => x.outcome === o)) m.set(l.route, (m.get(l.route) ?? 0) + nOf(l)); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
md.push('', '## 状态码不代表授权（路由声明了，不比）：按路由', '', '| 路由 | 次数 |', '|---|---|', ...byRoute('not-verdict').map(([r, n]) => `| \`${r}\` | ${n} |`));
md.push('', '## 被完整性门拦下（跨站、别的站来源，旧结论拒绝，不比）：按路由', '', '| 路由 | 次数 |', '|---|---|', ...byRoute('integrity-blocked').map(([r, n]) => `| \`${r}\` | ${n} |`));
md.push('', '## 没报动作、不比：按域', '', '| 域 | 次数 |', '|---|---|', ...[...unreg.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `| ${d} | ${n} |`));
if (snap) md.push('', '## 来源', '', `- \`${snapshotFile.split(/[\\/]/).pop()}\`${sinceSnap ? `，减去 \`${sinceFile.split(/[\\/]/).pop()}\`` : ''}：比对 ${compared} 次`);
else if (fromFiles.length) md.push('', '## 来源', '', ...inputs.map((i) => `- \`${i.source}\`：比对 ${count((l) => l.source === i.source)} 次`));
else md.push('', '## 各脚本', '', ...runs.map((r) => `- ${r.name}：退出 ${r.status}；比对 ${count((l) => l.source === r.name.replace(/[^a-z0-9-]/gi, '_'))} 次`));
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, md.join('\n') + '\n');
writeFileSync(REPORT.replace(/\.md$/, '.json'), JSON.stringify({ totals, reasons: [...byReason.values()].map((e) => ({ ...e, domains: Object.fromEntries(e.domains), routes: Object.fromEntries(e.routes) })), uncertain: Object.fromEntries(uncertain), unregistered: Object.fromEntries(unreg), by_domain: Object.fromEntries(byDomain) }, null, 2));
console.log(`\n报告：${REPORT}`);
if (existsSync(WORK) && !argv.includes('--keep')) rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (requireZero) {
  if (totals.mismatch > 0) {
    for (const e of [...byReason.values()]) console.log(`  ✗ 不一致：${e.reason}｜${e.actor}，${e.count} 次（${e.sample?.step ?? e.sample?.source}）`);
    console.log(`judgment-compare-report: 不一致 ${totals.mismatch} 次`);
    process.exit(1);
  }
  if (compared === 0) { console.log('  ✗ 一次比对都没有（比对没打开？）'); process.exit(1); }
  console.log(`  ✓ 比对 ${compared} 次，不一致为 0`);
}
