#!/usr/bin/env node
/**
 * 判定并行比对的零不一致门槛（阶段六 6c，接进 CI）：比对打开时跑全量录制回放，新旧结论不一致必须为 0。
 * 守住内置身份的清单、按请求细分的动作、「状态码不代表授权」和完整性门的单列不漂移：谁改了路由的放行范围却没改登记，这里就红。
 * 只在本机起隔离实例，不访问任何外部系统。
 *
 *   node scripts/judgment-compare-zero-test.mjs              测本仓库
 *   node scripts/judgment-compare-zero-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'judgment-compare-report.mjs'), '--replay-only', '--require-zero', '--out', join(ROOT, 'tmp', `judgment-compare-zero-${process.pid}.md`)],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const verdict = out.split('\n').filter((l) => /^\s*[✓✗] /.test(l));
for (const l of verdict) console.log(l);
const ok = r.status === 0 && verdict.some((l) => l.includes('✓'));
console.log(`judgment-compare-zero-test: ${ok ? '1 passed / 0 failed' : '0 passed / 1 failed'}`);
process.exit(ok ? 0 : 1);
