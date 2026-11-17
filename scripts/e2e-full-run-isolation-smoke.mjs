#!/usr/bin/env node
/** e2e-full-run 隔离机械回归（#301 监督席复核 6539090560）：宿主 YGL_HOME 设成不可读诱饵目录时，
 *  跑器交给 server、种子脚本、E2E 三类子进程的 YGL_HOME 仍是 TMP 下的专属 home，诱饵路径不出现、宿主会话不透传。
 *  只跑 --dry-env（不起实例）；完整 E2E 的 CI 步骤同样带诱饵 YGL_HOME 实跑。
 *  另核两轮的控制面开关是显式设的（缺省那一轮 WM_CONTROL_PORT=业务端口+1，--control-off 那一轮为 0），不会退化成同一种模式。 */
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
      encoding: 'utf8', env: { ...process.env, YGL_HOME: decoy, YGL_SESSION: 'host-session' },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    // 控制面：服务端没设 WM_CONTROL_PORT 就不开，所以两轮都要显式设——开的那一轮是业务端口 + 1（带合成的凭据库域名），关的那一轮是 0
    if (mode.length === 0) { assert.equal(out.control.WM_CONTROL_PORT, String(out.port + 1), '控制面开的那一轮要显式设 WM_CONTROL_PORT=业务端口+1'); assert.ok(out.control.WM_VAULT_HOST, '控制面开的那一轮要设合成的凭据库域名'); }
    else { assert.equal(out.control.WM_CONTROL_PORT, '0'); assert.equal(out.control.WM_VAULT_HOST, null); }
    assert.ok(out.tmp.startsWith(resolve('tmp') + sep + 'e2e-full-'), out.tmp);
    for (const who of ['server', 'seed', 'e2e']) {
      const e = out[who];
      assert.equal(e.YGL_HOME, join(out.tmp, 'ygl-home'), `${who} YGL_HOME 应为 TMP 专属 home：${e.YGL_HOME}`);
      assert.ok(!JSON.stringify(e).includes(decoy), `${who} 环境里出现了诱饵路径`);
      for (const k of ['YGL_SESSION']) assert.equal(e[k] ?? null, null, `${who} 不应透传 ${k}`);
      assert.ok(e.DATA_DIR.startsWith(out.tmp), `${who} DATA_DIR 应在 TMP 下`);
      assert.equal(e.SCRIPT_TARGET_MODE,'isolated');
      assert.equal(e.SCRIPT_ISOLATED_ROOT,out.tmp);
      assert.equal(e.SCRIPT_SOURCE_DB,join(out.tmp,'data/workbench-market.db'));
      assert.equal(e.SCRIPT_SOURCE_DATA_DIR,join(out.tmp,'data'));
      passed++;
    }
  }
} finally { chmodSync(decoy, 0o700); rmSync(decoy, { recursive: true, force: true }); }
console.log(`e2e-full-run-isolation-smoke: ${passed}/6 PASS`);
