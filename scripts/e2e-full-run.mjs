#!/usr/bin/env node
/** 完整 E2E（evidence/e2e_test.py）合成跑器：全新 DATA_DIR + 随机端口 + 合成 ADMIN_TOKEN 起一个隔离实例，
 *  再把 E2E 打过去。#292 M1 双面：缺省控制面 = 业务端口 + 1；`--control-off` 用 WM_CONTROL_PORT=0 关闭控制面。
 *  不碰生产 9800；不读宿主 YGL_HOME / LC_* 凭据：TMP 下建专属空 YGL_HOME，显式传给 server、种子脚本与 E2E（及其子脚本），
 *  宿主 YGL_HOME 一律覆盖。需要 web 已构建（pnpm --filter web build）与 Python Playwright。
 *  用法：node scripts/e2e-full-run.mjs [--control-off] [--dry-env]；PYTHON 指定解释器（缺省 python3）。
 *  --dry-env：不起实例，只打印三类子进程会拿到的隔离相关环境（JSON），供 e2e-full-run-isolation-smoke 机械回归。 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 收尾：只停自己起的 server，**确认它已退出**才删自己的 TMP（Windows 上进程还持有 DATA_DIR 文件句柄时 rm 会 EPERM）。
 *  等到期仍未退出：不删 TMP、留现场并报出 PID，退出码非 0；删不掉同样如实报、非 0。不杀别的进程、不删别的目录。
 *  exported 供 e2e-full-run-cleanup-test 用假子进程机械回归。 */
export async function cleanupOwn(child, tmp, code, { timeoutMs = 15_000, rm = rmSync, log = console.error } = {}) {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (alive()) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    let timer;
    await Promise.race([exited, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }
  if (alive()) {
    log(`e2e-full-run: 自起 server（PID ${child.pid}）${timeoutMs}ms 内未退出，保留 ${tmp} 不删；请确认该进程后手动清理`);
    return code === 0 ? 1 : code;
  }
  try { rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (e) { log(`e2e-full-run: 清理 ${tmp} 失败：${e.code ?? ''} ${e.message}`); return code === 0 ? 1 : code; }
  return code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
async function main() {

const controlOff = process.argv.includes('--control-off');
const dryEnv = process.argv.includes('--dry-env');
if (!dryEnv && !existsSync('web/dist/index.html')) { console.error('e2e-full-run: 缺 web/dist（先 pnpm --filter web build）'); process.exit(2); }
const TMP = resolve('tmp/e2e-full-' + Date.now().toString(36)); mkdirSync(TMP, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 18000);
const YGL_HOME = join(TMP, 'ygl-home'); mkdirSync(YGL_HOME, { recursive: true }); // 专属空工作区：统一待办的 ygl-trees 源只会读到它
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-e2e-admin', YGL_HOME };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT', 'WM_DEV_ORIGIN', 'E2E_ALLOW_PROD', 'YGL_SESSION', 'A2A_STATE_URL']) delete env[k];
if (controlOff) env.WM_CONTROL_PORT = '0';
const base = `http://127.0.0.1:${PORT}`;
const seedEnv = { ...env, SEED_BASE: base };
const e2eEnv = { ...env, E2E_PORT: String(PORT), E2E_ADMIN_TOKEN: env.ADMIN_TOKEN };
if (dryEnv) {
  const pick = (e) => Object.fromEntries(['YGL_HOME', 'DATA_DIR', ...Object.keys(e).filter((k) => /^LC_|^YGL_|^A2A_STATE/.test(k))].map((k) => [k, e[k] ?? null]));
  console.log(JSON.stringify({ tmp: TMP, server: pick(env), seed: pick(seedEnv), e2e: pick(e2eEnv) }));
  rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let err = ''; server.stderr.on('data', (c) => (err += c));
let code = 1;
try {
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error('实例未就绪：' + err.slice(-400));
  console.log(`[e2e-full-run] 实例 ${PORT}，控制面 ${controlOff ? '关闭（WM_CONTROL_PORT=0）' : PORT + 1}`);
  // E2E 组 18 要求演示 SOP（demo-rack-sop）常驻、且有一条已完成的演示 run（演示·张工，3 步数据）——生产库里本来就有，隔离实例要先种
  const PY = process.env.PYTHON || 'python3';
  const seed = spawn(PY, ['scripts/seed-demo-sop.py'], { stdio: 'inherit', env: seedEnv });
  if ((await new Promise((r) => seed.on('exit', r))) !== 0) throw new Error('演示 SOP 种子失败');
  const cli = (m, p, b) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json());
  const run = await cli('POST', '/api/sop/runs', { slug: 'demo-rack-sop', started_by: '演示·张工' });
  for (const [stepKey, value] of [['prepare', { 配件数: '6', 外观: '无' }], ['rack', { 机位: 'A-12', 扭矩复核: '已复核' }], ['power', { 自检: '通过' }]]) await cli('PUT', `/api/sop/runs/${run.id}`, { stepKey, value });
  await cli('POST', `/api/sop/runs/${run.id}/finish`);
  const py = spawn(PY, ['evidence/e2e_test.py'], { stdio: 'inherit', env: e2eEnv });
  code = await new Promise((r) => py.on('exit', (c) => r(c ?? 1)));
} catch (e) { console.error('e2e-full-run:', e.message); }
finally { code = await cleanupOwn(server, TMP, code); }
process.exit(code);
}
