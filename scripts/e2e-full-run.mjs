#!/usr/bin/env node
/** 完整 E2E（evidence/e2e_test.py）合成跑器：全新 DATA_DIR + 随机端口 + 合成 ADMIN_TOKEN 起一个隔离实例，
 *  再把 E2E 打过去。#292 M1 双面：缺省控制面 = 业务端口 + 1；`--control-off` 用 WM_CONTROL_PORT=0 关闭控制面。
 *  不碰生产 9800、不读真实 YGL_HOME / LC_* 凭据。需要 web 已构建（pnpm --filter web build）与 Python Playwright。
 *  用法：node scripts/e2e-full-run.mjs [--control-off]；PYTHON 指定解释器（缺省 python3）。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const controlOff = process.argv.includes('--control-off');
if (!existsSync('web/dist/index.html')) { console.error('e2e-full-run: 缺 web/dist（先 pnpm --filter web build）'); process.exit(2); }
const TMP = resolve('tmp/e2e-full-' + Date.now().toString(36)); mkdirSync(TMP, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 18000);
const env = { ...process.env, MCP_GATEWAY: '', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-e2e-admin' };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT', 'WM_DEV_ORIGIN', 'E2E_ALLOW_PROD']) delete env[k];
if (controlOff) env.WM_CONTROL_PORT = '0';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let err = ''; server.stderr.on('data', (c) => (err += c));
let code = 1;
try {
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error('实例未就绪：' + err.slice(-400));
  console.log(`[e2e-full-run] 实例 ${PORT}，控制面 ${controlOff ? '关闭（WM_CONTROL_PORT=0）' : PORT + 1}`);
  // E2E 组 18 要求演示 SOP（demo-rack-sop）常驻、且有一条已完成的演示 run（演示·张工，3 步数据）——生产库里本来就有，隔离实例要先种
  const PY = process.env.PYTHON || 'python3', base = `http://127.0.0.1:${PORT}`;
  const seed = spawn(PY, ['scripts/seed-demo-sop.py'], { stdio: 'inherit', env: { ...env, SEED_BASE: base } });
  if ((await new Promise((r) => seed.on('exit', r))) !== 0) throw new Error('演示 SOP 种子失败');
  const cli = (m, p, b) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json());
  const run = await cli('POST', '/api/sop/runs', { slug: 'demo-rack-sop', started_by: '演示·张工' });
  for (const [stepKey, value] of [['prepare', { 配件数: '6', 外观: '无' }], ['rack', { 机位: 'A-12', 扭矩复核: '已复核' }], ['power', { 自检: '通过' }]]) await cli('PUT', `/api/sop/runs/${run.id}`, { stepKey, value });
  await cli('POST', `/api/sop/runs/${run.id}/finish`);
  const py = spawn(PY, ['evidence/e2e_test.py'], {
    stdio: 'inherit', env: { ...env, E2E_PORT: String(PORT), E2E_ADMIN_TOKEN: env.ADMIN_TOKEN },
  });
  code = await new Promise((r) => py.on('exit', (c) => r(c ?? 1)));
} catch (e) { console.error('e2e-full-run:', e.message); }
finally { server.kill(); rmSync(TMP, { recursive: true, force: true }); }
process.exit(code);
