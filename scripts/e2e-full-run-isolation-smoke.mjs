#!/usr/bin/env node
/** e2e-full-run 隔离机械回归（#301 监督席复核 6539090560）：宿主 YGL_HOME / LC_YGL_HOME 设成不可读诱饵目录时，
 *  跑器交给 server、种子脚本、E2E 三类子进程的 YGL_HOME 仍是 TMP 下的专属 home，诱饵路径不出现、LC_* 不透传。
 *  只跑 --dry-env（不起实例）；完整 E2E 的 CI 步骤同样带诱饵 YGL_HOME 实跑。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const decoy = resolve('tmp/e2e-decoy-home-' + process.pid);
mkdirSync(decoy, { recursive: true });
writeFileSync(join(decoy, 'DECOY'), '宿主 YGL_HOME 诱饵：跑器不得把它交给任何子进程\n');
chmodSync(decoy, 0o000);
let passed = 0;
try {
  for (const mode of [[], ['--control-off']]) {
    const r = spawnSync(process.execPath, ['scripts/e2e-full-run.mjs', '--dry-env', ...mode], {
      encoding: 'utf8', env: { ...process.env, YGL_HOME: decoy, LC_YGL_HOME: decoy, LC_YGL_BIN: join(decoy, 'bin.cjs'), YGL_SESSION: 'host-session' },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.ok(out.tmp.startsWith(resolve('tmp') + sep + 'e2e-full-'), out.tmp);
    for (const who of ['server', 'seed', 'e2e']) {
      const e = out[who];
      assert.equal(e.YGL_HOME, join(out.tmp, 'ygl-home'), `${who} YGL_HOME 应为 TMP 专属 home：${e.YGL_HOME}`);
      assert.ok(!JSON.stringify(e).includes(decoy), `${who} 环境里出现了诱饵路径`);
      for (const k of ['LC_YGL_HOME', 'LC_YGL_BIN', 'YGL_SESSION']) assert.equal(e[k] ?? null, null, `${who} 不应透传 ${k}`);
      assert.ok(e.DATA_DIR.startsWith(out.tmp), `${who} DATA_DIR 应在 TMP 下`);
      passed++;
    }
  }
} finally { chmodSync(decoy, 0o700); rmSync(decoy, { recursive: true, force: true }); }
console.log(`e2e-full-run-isolation-smoke: ${passed}/6 PASS`);
