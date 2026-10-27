#!/usr/bin/env node
/** ③ 互斥锁冒烟（判据先红→绿）：并发两席切分支——仅一成功·另一退避；超时催办提示；残留锁清理。 */
import { execFileSync, spawn } from 'node:child_process';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' ' + x); } };
import { spawnSync } from 'node:child_process';
const run = (args, opts = {}) => { const r = spawnSync('bash', ['scripts/co-checkout.sh', ...args], { encoding: 'utf8', ...opts }); return { code: r.status ?? 1, out: String(r.stdout ?? '') + String(r.stderr ?? '') }; };
const branchNow = () => execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const start = branchNow();
try {
  // ① 单席取锁→切换→释放
  const r1 = run([start, '--seat', 'smoke-A']);
  ok('① 单席取锁并切换成功', r1.code === 0 && r1.out.includes('锁获取成功'), r1.out.slice(-120));
  // ② 并发：A 持锁 3s·B --wait 0 → 退避失败（exit 3）
  const holder = spawn('bash', ['scripts/co-checkout.sh', start, '--seat', 'smoke-A', '--hold', '3'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const r2 = run([start, '--seat', 'smoke-B', '--wait', '0']);
  ok('② 异席同时切 → 仅一成功·另一退避（exit 3）', r2.code === 3, 'code=' + r2.code + ' ' + r2.out.slice(0, 100));
  await new Promise((r) => setTimeout(r, 3200));
  // ③ 释放后 B 可取得
  const r3 = run([start, '--seat', 'smoke-B', '--wait', '5']);
  ok('③ 锁释放后异席取得（退避窗口内重试成功）', r3.code === 0 && r3.out.includes('smoke-B'), r3.out.slice(-120));
  // ④ 残留锁清理（造老锁·pid 不存在）
  execFileSync('bash', ['-c', 'printf "ghost|' + start + '|1|999999\\n" > .git/wm-co-checkout.lock; mkdir -p .git/wm-co-checkout.lock.d']);
  const r4 = run([start, '--seat', 'smoke-C', '--wait', '3']);
  ok('④ 残留锁（owner 不在·age>600s）启动清理并取得', r4.code === 0 && r4.out.includes('清理残留锁'), r4.out.slice(-160));
  holder.kill();
} finally {
  try { execFileSync('bash', ['scripts/co-checkout.sh', '--release-only'], { stdio: 'ignore' }); } catch {}
  try { execFileSync('git', ['checkout', start], { stdio: 'ignore' }); } catch {}
}
console.log('\n===== 互斥锁冒烟 ' + (pass + fail) + ' 项：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
