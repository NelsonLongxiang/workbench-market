#!/usr/bin/env node
/** 完整 E2E（evidence/e2e_test.py）合成跑器：全新 DATA_DIR + 随机端口 + 合成 ADMIN_TOKEN 起一个隔离实例，
 *  再把 E2E 打过去。#292 M1 双面：服务端没设 WM_CONTROL_PORT 时**不开**控制面，所以缺省这一轮由跑器显式设
 *  WM_CONTROL_PORT = 业务端口 + 1（并设一个合成的凭据库专用域名 WM_VAULT_HOST）；`--control-off` 设 WM_CONTROL_PORT=0，不开控制面。
 *  起来之后先核两面（surfaceChecks）：控制面真的开着（服务端打出控制面那一行、端口应答），否则判失败——两轮不会悄悄退化成同一种模式；
 *  控制面只承载它该承载的（业务内容的路径在控制面上 404）、业务面上管理员凭口令照常能管（11-02 撤销强制之后的行为）、凭据库域名照旧。
 *  `--surfaces-only`：只起实例、核两面，不种数据、不跑 E2E（不要 Python），本机核这一步用。
 *  不碰生产 9800；不读宿主 YGL_HOME 凭据：TMP 下建专属空 YGL_HOME，显式传给 server、种子脚本与 E2E（及其子脚本），
 *  宿主 YGL_HOME 一律覆盖。需要 web 已构建（pnpm --filter web build）与 Python Playwright。
 *  用法：node scripts/e2e-full-run.mjs [--control-off] [--dry-env]；PYTHON 指定解释器（缺省 python3）。
 *  --dry-env：不起实例，只打印三类子进程会拿到的隔离相关环境（JSON），供 e2e-full-run-isolation-smoke 机械回归。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGithub } from './github-fixture.mjs';

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
const VAULT_HOST = 'vault.e2e.synthetic.invalid';
const REMOTE = { 'x-forwarded-for': '192.0.2.71' }; // 带转发头：不当本机命令行，按远程的管理员（口令）判

/** 发一个请求（Host 头要能自己写，所以不用 fetch）；连不上回 status 0 */
function hit(port, method, path, { headers = {}, body } = {}) {
  return new Promise((done) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) }, timeout: 10_000 }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ } done({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', () => done({ status: 0, headers: {}, text: '', json: null }));
    req.on('timeout', () => { req.destroy(); });
    if (data) req.write(data);
    req.end();
  });
}

/** 业务内容的路径：控制面、凭据库域名都不承载（index.ts 的控制面围栏） */
export const FENCED_PATHS = ['/go/1/', '/sop/e2e-probe', '/apps/e2e-probe/', '/mcp', '/openapi.json', '/api/mcp-rest/tools/e2e-probe', '/a2a/direct'];

/**
 * 两面的核对。返回没过的项（空 = 都过）。exported 供单测用。
 *   控制面开（control 是端口）：
 *     · 服务端打出了控制面那一行，端口应答 /api/health；
 *     · 业务内容的路径在控制面上一律 404「控制面不提供此路径」，在业务面上不是这个 404；控制面的应答带不许被嵌的头；
 *     · 业务面上管理员凭口令照常能管（建、删一个类型），不带口令被拒；控制面上同样能管；
 *     · 凭据库专用域名（vaultHost）照旧：业务内容的路径 404「凭据库域名不提供此路径」，凭据库的状态接口照常应答。
 *   控制面关（control 为 null）：服务端没打控制面那一行，业务端口 + 1 上没有市场应答；业务面上没有控制面的围栏。
 *   控制面专属的路由没有：凭据库在服务端持有主密码时只在控制面或凭据库域名开放（业务面回 403 vault_control_only），不是 404；那一条由凭据库自己的回归守。
 */
export async function surfaceChecks({ market, control, vaultHost, token, log }) {
  const bad = [];
  const line = /\[workbench-market\] control http:\/\/127\.0\.0\.1:(\d+)/;
  let seen = null;
  for (let i = 0; i < 40 && !(seen = line.exec(log())); i++) await new Promise((r) => setTimeout(r, 100));
  const fenced = (r) => r.status === 404 && r.text.includes('控制面不提供此路径');
  if (control === null) {
    if (seen) bad.push(`说的是控制面关，服务端却打出了控制面那一行（端口 ${seen[1]}）`);
    if ((await hit(market + 1, 'GET', '/api/health')).status === 200) bad.push(`说的是控制面关，业务端口 + 1（${market + 1}）上却有市场在应答`);
    for (const p of FENCED_PATHS) { const r = await hit(market, 'GET', p, { headers: REMOTE }); if (fenced(r)) bad.push(`控制面关时业务面上 ${p} 被控制面的围栏挡了`); }
    return bad;
  }
  if (!seen || Number(seen[1]) !== control) { bad.push(`说的是控制面开（${control}），服务端没打出控制面那一行${seen ? `（打的是 ${seen[1]}）` : ''}`); return bad; }
  if ((await hit(control, 'GET', '/api/health')).status !== 200) { bad.push(`控制面端口 ${control} 不应答 /api/health`); return bad; }
  for (const p of FENCED_PATHS) {
    const onControl = await hit(control, 'GET', p, { headers: REMOTE });
    const onMarket = await hit(market, 'GET', p, { headers: REMOTE });
    if (!fenced(onControl)) bad.push(`控制面上 ${p} 应当 404「控制面不提供此路径」，实际 ${onControl.status}`);
    if (fenced(onMarket)) bad.push(`业务面上 ${p} 不该被控制面的围栏挡`);
  }
  const ctlHome = await hit(control, 'GET', '/api/health', { headers: REMOTE });
  if (!/frame-ancestors 'none'/.test(String(ctlHome.headers['content-security-policy'] ?? '')) || String(ctlHome.headers['x-frame-options'] ?? '') !== 'DENY') bad.push('控制面的应答没带不许被嵌的头（frame-ancestors none、X-Frame-Options DENY）');
  // 管理员凭口令照常能管：业务面、控制面各建一个类型再删掉（不留数据给 E2E）
  for (const [name, port] of [['业务面', market], ['控制面', control]]) {
    const key = `e2e-surface-${name === '业务面' ? 'market' : 'control'}`;
    const noToken = await hit(port, 'POST', '/api/types', { headers: REMOTE, body: { key, name: '合成探针类型' } });
    if (noToken.status !== 401 && noToken.status !== 403) bad.push(`${name}上不带口令建类型应当被拒，实际 ${noToken.status}`);
    const made = await hit(port, 'POST', '/api/types', { headers: { ...REMOTE, 'x-admin-token': token }, body: { key, name: '合成探针类型' } });
    if (made.status !== 201) { bad.push(`${name}上管理员凭口令建类型应当 201，实际 ${made.status}`); continue; }
    const gone = await hit(port, 'DELETE', `/api/types/${made.json?.id}`, { headers: { ...REMOTE, 'x-admin-token': token } });
    if (gone.status >= 300) bad.push(`${name}上管理员凭口令删类型应当成功，实际 ${gone.status}`);
  }
  if (vaultHost) {
    const vh = { ...REMOTE, host: vaultHost, 'x-admin-token': token };
    for (const p of ['/mcp', '/go/1/']) { const r = await hit(market, 'GET', p, { headers: vh }); if (!(r.status === 404 && r.text.includes('凭据库域名不提供此路径'))) bad.push(`凭据库域名上 ${p} 应当 404「凭据库域名不提供此路径」，实际 ${r.status}`); }
    const st = await hit(market, 'GET', '/api/vault/status', { headers: vh });
    if (st.status !== 200) bad.push(`凭据库域名上管理员读凭据库状态应当 200，实际 ${st.status}`);
  }
  return bad;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
async function main() {

const controlOff = process.argv.includes('--control-off');
const dryEnv = process.argv.includes('--dry-env');
const surfacesOnly = process.argv.includes('--surfaces-only');
if (!dryEnv && !existsSync('web/dist/index.html')) { console.error('e2e-full-run: 缺 web/dist（先 pnpm --filter web build）'); process.exit(2); }
const TMP = resolve('tmp/e2e-full-' + Date.now().toString(36)); mkdirSync(TMP, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 11000);
const YGL_HOME = join(TMP, 'ygl-home'); mkdirSync(YGL_HOME, { recursive: true }); // 专属空工作区：统一待办的 ygl-trees 源只会读到它
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-e2e-admin', YGL_HOME, SCRIPT_TARGET_MODE: 'isolated', SCRIPT_ISOLATED_ROOT: TMP, SCRIPT_SOURCE_DB: join(TMP, 'data/workbench-market.db'), SCRIPT_SOURCE_DATA_DIR: join(TMP, 'data') };
for (const k of ['WM_ODOO_URL', 'WM_EXTENSIONS_DIR', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT', 'WM_DEV_ORIGIN', 'E2E_ALLOW_PROD', 'YGL_SESSION', 'A2A_STATE_URL']) delete env[k];
// 控制面：服务端只在 WM_CONTROL_PORT 是有效端口时才开（surfaces.ts 的 surfacePorts），没设就不开——所以两轮都显式设
const CONTROL_PORT = controlOff ? null : PORT + 1;
env.WM_CONTROL_PORT = controlOff ? '0' : String(CONTROL_PORT);
if (!controlOff) env.WM_VAULT_HOST = VAULT_HOST;
const base = `http://127.0.0.1:${PORT}`;
const seedEnv = { ...env, SEED_BASE: base };
const e2eEnv = { ...env, E2E_PORT: String(PORT), E2E_ADMIN_TOKEN: env.ADMIN_TOKEN };
if (dryEnv) {
  const pick = (e) => Object.fromEntries(['YGL_HOME', 'DATA_DIR', 'SCRIPT_TARGET_MODE', 'SCRIPT_ISOLATED_ROOT', 'SCRIPT_SOURCE_DB', 'SCRIPT_SOURCE_DATA_DIR', ...Object.keys(e).filter((k) => /^YGL_|^A2A_STATE/.test(k))].map((k) => [k, e[k] ?? null]));
  console.log(JSON.stringify({ tmp: TMP, port: PORT, control: { WM_CONTROL_PORT: env.WM_CONTROL_PORT ?? null, WM_VAULT_HOST: env.WM_VAULT_HOST ?? null }, server: pick(env), seed: pick(seedEnv), e2e: pick(e2eEnv) }));
  rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}
// 属主 2026-11-02 来源收敛：自产台/SOP 台只从 GitHub main 同步——起本机替身，服务经 WM_GITHUB_API 拉取，
// Python 子进程（种子/E2E/cap 浏览器）经 E2E_FAKE_GITHUB 的写口提交文件（scripts/gh_fixture.py）
const gh = await startFakeGithub();
env.WM_GITHUB_API = gh.api; delete env.WM_GITHUB_TOKEN;
seedEnv.E2E_FAKE_GITHUB = gh.api; e2eEnv.E2E_FAKE_GITHUB = gh.api;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let err = '', out = ''; server.stderr.on('data', (c) => (err += c)); server.stdout.on('data', (c) => { if (out.length < 200_000) out += c; });
let code = 1;
try {
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 250)); }
  if (!up) throw new Error('实例未就绪：' + err.slice(-400));
  console.log(`[e2e-full-run] 实例 ${PORT}，控制面 ${controlOff ? '关闭（WM_CONTROL_PORT=0）' : CONTROL_PORT}`);
  // 守卫：这一轮的控制面要真的是说的那样（开着的那一轮服务端要打出控制面那一行、端口要应答；关着的那一轮两样都没有）
  const problems = await surfaceChecks({ market: PORT, control: CONTROL_PORT, vaultHost: controlOff ? null : VAULT_HOST, token: env.ADMIN_TOKEN, log: () => out });
  if (problems.length) throw new Error(`两面的核对没过（${controlOff ? '控制面关' : '控制面开'}）：\n  - ${problems.join('\n  - ')}`);
  console.log(controlOff ? '[e2e-full-run] 控制面已关：端口不应答；业务面上没有控制面的围栏' : `[e2e-full-run] 控制面已开：${CONTROL_PORT}；两面分开、业务面管理员凭口令照常能管、凭据库域名照旧`);
  if (surfacesOnly) code = 0;
  else {
  // E2E 组 18 要求演示 SOP（demo-rack-sop）常驻、且有一条已完成的演示 run（演示·张工，3 步数据）——生产库里本来就有，隔离实例要先种
  const PY = pythonBin();
  const seed = spawn(PY, ['scripts/seed-demo-sop.py', '--target-mode', 'isolated'], { stdio: 'inherit', env: seedEnv });
  if ((await new Promise((r) => seed.on('exit', r))) !== 0) throw new Error('演示 SOP 种子失败');
  const cli = (m, p, b) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then((r) => r.json());
  const run = await cli('POST', '/api/sop/runs', { slug: 'demo-rack-sop', started_by: '演示·张工' });
  for (const [stepKey, value] of [['prepare', { 配件数: '6', 外观: '无' }], ['rack', { 机位: 'A-12', 扭矩复核: '已复核' }], ['power', { 自检: '通过' }]]) await cli('PUT', `/api/sop/runs/${run.id}`, { stepKey, value });
  await cli('POST', `/api/sop/runs/${run.id}/finish`);
  const py = spawn(PY, ['evidence/e2e_test.py'], { stdio: 'inherit', env: e2eEnv });
  code = await new Promise((r) => py.on('exit', (c) => r(c ?? 1)));
  // #309 phase2：真实浏览器实测 Runner 读能力（localStorage cap + 「需读授权」提示）
  if (code === 0) {
    const capBrowser = spawn(PY, ['scripts/sop-runner-cap-browser.py'], { stdio: 'inherit', env: e2eEnv });
    code = await new Promise((r) => capBrowser.on('exit', (c) => r(c ?? 1)));
  }
  }
} catch (e) { console.error('e2e-full-run:', e.message); }
finally { code = await cleanupOwn(server, TMP, code); await gh.close(); }
process.exit(code);
}
