#!/usr/bin/env node
/**
 * 判定并行比对的报告（阶段六 6c）：把录制回放和 CI 里的脚本命令都在比对打开（WM_JUDGMENT_COMPARE=on）的情况下跑一遍，
 * 每次比对往输出文件追加一行（不含 id 和凭据），最后按「域 × 原因」汇总成一份 Markdown。
 *   · 回放：每条请求带 x-replay-step，报告里每类不一致能指到「哪条录制的哪个请求」；
 *   · 别的脚本：一个脚本一个输出文件，报告里写是哪个脚本（只有起实例时把环境变量传下去的脚本才有数）。
 * 只在本机起隔离实例，不访问任何外部系统。不进 CI（要跑一个多小时）。
 *
 *   node scripts/judgment-compare-report.mjs [--out 报告.md] [--replay-only] [--require-zero]
 *   --require-zero：有不一致就失败（CI 用：只跑回放，守住内置身份清单和细分动作不漂移）
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
const WORK = join(ROOT, 'tmp', `judgment-compare-${process.pid}`);
mkdirSync(WORK, { recursive: true });

function run(name, cmd, args) {
  const out = join(WORK, `${name.replace(/[^a-z0-9-]/gi, '_')}.jsonl`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, CI: 'true', WM_JUDGMENT_COMPARE: 'on', WM_JUDGMENT_COMPARE_OUT: out }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
  console.log(`  ${r.status === 0 ? '✓' : '·'} ${name}（退出 ${r.status}，${Math.round((Date.now() - t0) / 1000)} 秒）`);
  return { name, status: r.status };
}

const runs = [run('route-replay', process.execPath, ['scripts/route-replay-test.mjs'])];
if (!replayOnly) {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const cmds = [...new Set(ci.split(/&&|\n/).map((p) => p.trim().replace(/^(-\s*)?run:\s*/, '').trim()).filter((p) => /^node scripts\/[a-z0-9-]+\.mjs( [-a-z0-9 ]+)?$/.test(p)))]
    .filter((c) => !/route-replay-test|judgment-compare|identity-seam-mutation|browser|e2e-full-run|tech-route-check|surface-snapshot/.test(c));
  for (const c of cmds) { const [, script, ...rest] = c.split(/\s+/); runs.push(run(script.replace('scripts/', '').replace('.mjs', '') + (rest.length ? `_${rest.join('_')}` : ''), process.execPath, [script, ...rest])); }
}

// ---------- 汇总 ----------
const lines = [];
for (const f of readdirSync(WORK).filter((n) => n.endsWith('.jsonl'))) {
  const source = f.replace(/\.jsonl$/, '');
  for (const l of readFileSync(join(WORK, f), 'utf8').split('\n')) { if (!l.trim()) continue; try { lines.push({ ...JSON.parse(l), source }); } catch { /* 半行 */ } }
}
const domainOf = (l) => (l.action ? l.action.split('.')[0] : (String(l.route).split(' ')[1] ?? '').split('/').filter(Boolean).slice(0, 2).join('/'));
const count = (pred) => lines.filter(pred).length;
const totals = Object.fromEntries(['agree', 'mismatch', 'uncertain', 'skip-404', 'unregistered', 'not-verdict', 'integrity-blocked', 'error'].map((o) => [o, count((l) => l.outcome === o)]));
const reasonOf = (l) => (l.old === 'allow' ? `旧允许·新${l.new === 'ask' ? '先问人' : '拒绝'}·${l.rule}` : `旧拒绝·新允许·${l.rule}`);
const mism = lines.filter((l) => l.outcome === 'mismatch');
const byReason = new Map();
for (const l of mism) {
  const key = `${reasonOf(l)}｜${l.actor}`;
  const e = byReason.get(key) ?? { reason: reasonOf(l), actor: l.actor, count: 0, domains: new Map(), routes: new Map(), sample: null };
  e.count++;
  e.domains.set(domainOf(l), (e.domains.get(domainOf(l)) ?? 0) + 1);
  e.routes.set(l.route, (e.routes.get(l.route) ?? 0) + 1);
  if (!e.sample || (!e.sample.step && l.step)) e.sample = { step: l.step ?? null, source: l.source, route: l.route, status: l.status };
  byReason.set(key, e);
}
const domains = [...new Set(mism.map(domainOf))].sort();
const uncertain = new Map();
for (const l of lines.filter((x) => x.outcome === 'uncertain')) uncertain.set(l.route, (uncertain.get(l.route) ?? 0) + 1);
const unreg = new Map();
for (const l of lines.filter((x) => x.outcome === 'unregistered')) unreg.set(domainOf(l), (unreg.get(domainOf(l)) ?? 0) + 1);

const md = [];
md.push('# 判定并行比对报告', '', `比对的请求：${lines.length} 次（来源：${runs.length} 个脚本，回放的每条请求带了录制里的位置）。`, '');
md.push('| 结果 | 次数 |', '|---|---|', ...Object.entries(totals).map(([k, v]) => `| ${k} | ${v} |`), '');
md.push('## 不一致：原因 × 域', '');
if (byReason.size === 0) md.push('没有。');
else {
  md.push(`| 原因 | 身份 | 合计 | ${domains.join(' | ')} | 最小复现 |`, `|---|---|---|${domains.map(() => '---').join('|')}|---|`);
  for (const e of [...byReason.values()].sort((a, b) => b.count - a.count)) {
    const where = e.sample?.step ? `回放 \`${e.sample.step}\`` : `脚本 \`${e.sample?.source}\`（${e.sample?.route}）`;
    md.push(`| ${e.reason} | ${e.actor} | ${e.count} | ${domains.map((d) => e.domains.get(d) ?? '').join(' | ')} | ${where} |`);
  }
  md.push('', '### 每类不一致涉及的路由', '');
  for (const e of [...byReason.values()].sort((a, b) => b.count - a.count)) md.push(`- **${e.reason}｜${e.actor}**：${[...e.routes.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `\`${r}\` ${n}`).join('；')}`);
}
md.push('', '## 不确定（400/409/422 这类、5xx）：按路由', '', '| 路由 | 次数 |', '|---|---|', ...[...uncertain.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `| \`${r}\` | ${n} |`));
const byRoute = (o) => { const m = new Map(); for (const l of lines.filter((x) => x.outcome === o)) m.set(l.route, (m.get(l.route) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
md.push('', '## 状态码不代表授权（路由声明了，不比）：按路由', '', '| 路由 | 次数 |', '|---|---|', ...byRoute('not-verdict').map(([r, n]) => `| \`${r}\` | ${n} |`));
md.push('', '## 被完整性门拦下（跨站、别的站来源，旧结论拒绝，不比）：按路由', '', '| 路由 | 次数 |', '|---|---|', ...byRoute('integrity-blocked').map(([r, n]) => `| \`${r}\` | ${n} |`));
md.push('', '## 没报动作、不比：按域', '', '| 域 | 次数 |', '|---|---|', ...[...unreg.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `| ${d} | ${n} |`));
md.push('', '## 各脚本', '', ...runs.map((r) => `- ${r.name}：退出 ${r.status}；比对 ${count((l) => l.source === r.name.replace(/[^a-z0-9-]/gi, '_'))} 次`));
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, md.join('\n') + '\n');
writeFileSync(REPORT.replace(/\.md$/, '.json'), JSON.stringify({ totals, reasons: [...byReason.values()].map((e) => ({ ...e, domains: Object.fromEntries(e.domains), routes: Object.fromEntries(e.routes) })), uncertain: Object.fromEntries(uncertain), unregistered: Object.fromEntries(unreg) }, null, 2));
console.log(`\n报告：${REPORT}`);
if (existsSync(WORK) && !argv.includes('--keep')) rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (requireZero) {
  if (totals.mismatch > 0) {
    for (const e of [...byReason.values()]) console.log(`  ✗ 不一致：${e.reason}｜${e.actor}，${e.count} 次（${e.sample?.step ?? e.sample?.source}）`);
    console.log(`judgment-compare-report: 不一致 ${totals.mismatch} 次`);
    process.exit(1);
  }
  if (lines.length === 0) { console.log('  ✗ 一次比对都没有（比对没打开？）'); process.exit(1); }
  console.log(`  ✓ 比对 ${lines.length} 次，不一致为 0`);
}
