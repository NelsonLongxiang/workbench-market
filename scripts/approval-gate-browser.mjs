#!/usr/bin/env node
/** 核准类请求的门（替 review-gate-browser，审核页随旧页面删除清单第二批删了；性质搬到全景卡片和「等你拍板」上）：
 *  (a) 没有核准资格的人打开全景、「等你拍板」，网络里没有发往核准类接口的读写；
 *  (b) 有资格的人在卡片上点批准、不给（带理由）：发出的请求路径、方法、请求体对——走统一答复入口的和按 answer_via 走的各一种。
 *  Python Playwright/Chromium；全新 DATA_DIR + 随机回环端口；合成身份、合成口令。条目用页面里截下来的合成夹具（服务端的守卫由服务端测试覆盖）。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeGithub } from './github-fixture.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/approval-gate-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const gh = await startFakeGithub();
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-approval-gate-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(TMP, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', WM_GITHUB_API: gh.api };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, alpha_session: SESSIONS.alpha, admin_session: SESSIONS.admin }));
  const py = spawn(pythonBin(), ['scripts/approval-gate-browser.py', cfg, ...(process.env.WM_SHOT ? [process.env.WM_SHOT, process.env.WM_SHOT.replace(/\.png$/, '-有数据.png')] : [])], { stdio: 'inherit' });
  code = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill(); await gh.close();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
