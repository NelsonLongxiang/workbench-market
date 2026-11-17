#!/usr/bin/env node
/**
 * 契约联调：市场 × a2a-net 上游的 superagent 宿主（上游代码当对端，宿主自己从 process face 签发确认、进展、提问、结果回执）。
 *
 *   A2A_UPSTREAM_DIR=<已装依赖并构建好的上游检出> node scripts/contract-upstream-test.mjs
 *
 * 做的事：把 scripts/contract/market-superagent.spec.ts 拷进上游的 tests/mesh/，用上游自己的 vitest 跑它
 * （市场起在临时目录、只听回环），读回「步骤 × 结果」，除了下面列明的几条，任何一步「不过」都算失败。
 *
 * 守卫（生产里装不上）：
 *   · NODE_ENV=production、或设了 DATA_DIR / MARKET_PUBLIC_URL 指向回环以外的地址，一律拒绝运行；
 *   · 不设 A2A_UPSTREAM_DIR 或那里没有构建好的上游，拒绝运行（不去下载上游；跑上游的 vitest 时经 npx 取钉住版本的 pnpm）；
 *   · 夹具里的市场只用临时数据目录、回环端口和合成口令，不读这台机器上的任何市场数据。
 * 这个脚本和夹具都不在服务端代码的引用链上。
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const fail = (msg) => { console.error(`contract-upstream-test：${msg}`); process.exit(1); };
const loopback = (u) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

if (process.env.NODE_ENV === 'production') fail('拒绝运行：NODE_ENV=production');
if (process.env.MARKET_PUBLIC_URL && !loopback(process.env.MARKET_PUBLIC_URL)) fail('拒绝运行：MARKET_PUBLIC_URL 不是回环地址');
if (process.env.DATA_DIR) fail('拒绝运行：设了 DATA_DIR（夹具只用自己建的临时目录）');
const UP = process.env.A2A_UPSTREAM_DIR ? resolve(process.env.A2A_UPSTREAM_DIR) : '';
if (!UP || !existsSync(join(UP, 'src/index.ts')) || !existsSync(join(UP, 'tests/mesh/harness.ts')) || !existsSync(join(UP, 'node_modules'))) {
  fail('拒绝运行：A2A_UPSTREAM_DIR 要指向一份装好依赖、构建过的上游 dsh-open-a2a-net 检出');
}

const ROOT = resolve('.');
const spec = join(UP, 'tests/mesh/zz-market-contract.spec.ts');
copyFileSync(join(ROOT, 'scripts/contract/market-superagent.spec.ts'), spec);
const outDir = mkdtempSync(join(tmpdir(), 'market-contract-'));
const OUT = join(outDir, 'result.json');

const code = await new Promise((done) => {
  const c = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'pnpm@11.28.5', 'exec', 'vitest', 'run', 'tests/mesh/zz-market-contract.spec.ts'], {
    cwd: UP, stdio: 'inherit',
    env: { ...process.env, MARKET_TREE: ROOT, CONTRACT_OUT: OUT, CONTRACT_LABEL: 'ci' },
  });
  c.on('close', done);
});
try { rmSync(spec); } catch { /* 留着也无害 */ }
if (!existsSync(OUT)) fail(`夹具没写出结果（vitest 退出码 ${code}）`);

// 允许「不过」的步骤：节点侧清单的前提检查（市场没列进团队名单时，派工进不了路由席——夹具接着就补上再重发）
const ALLOWED_FAIL = ['派工进路由席（清单没写要把市场列进团队名单）'];
const { results } = JSON.parse(readFileSync(OUT, 'utf8'));
let pass = 0, bad = 0;
for (const r of results) {
  const allowed = r.result === '不过' && ALLOWED_FAIL.includes(r.step);
  if (r.result === '过') pass++;
  else if (r.result === '不过' && !allowed) bad++;
  console.log(`  ${r.result === '过' ? '✓' : r.result === '未验' || allowed ? '·' : '✗'} ${r.step}${r.result === '过' ? '' : ' — ' + String(r.detail).slice(0, 300)}`);
}
// 关键步骤必须真的走到（防止夹具半路断掉也被当成「没有不过」）
const MUST = ['确认：市场收到 ack-<task>，宿主签名被接受', '进展：市场收到 progress-<task>-<n>', '提问：市场收到 attention-<task>-<qid>（带 question）',
  '答复：作为同 context 的新任务发出（a2a_sent_tasks kind=answer）', '结果：市场收到 receipt-<task> outcome=completed，签名被接受', '结局 abandoned：市场事项状态 ∈ {dropped}'];
const missing = MUST.filter((m) => !results.some((r) => r.step === m && r.result === '过'));
if (missing.length) { bad += missing.length; for (const m of missing) console.log(`  ✗ 关键步骤没走到或没过：${m}`); }
console.log(`\n${pass} 过 / ${bad} 败（结果 ${OUT}）`);
process.exit(bad === 0 && code === 0 ? 0 : 1);
