#!/usr/bin/env node
/** 身份服务连不上（#639：要认人的接口回 502 { error: 'identity_unavailable' }）的浏览器回归（Python Playwright/Chromium）：
 *  页面里把接口截下来回这个应答，看外壳的整页提示、侧栏角标和全景「等你拍板」写「暂时取不到」、不跳登录页、不清登录态；
 *  放开之后自动重试、提示自己消失；别的 502、401 不进这个状态；任何同源 /api/ 请求回这个代号都会挂提示（统一在请求层认）。
 *  需先 pnpm --filter web build。全新 DATA_DIR + 随机回环端口；合成身份、合成口令；不造数据。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeGithub } from './github-fixture.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/identity-down-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const gh = await startFakeGithub();
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-identity-down-admin';
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
  writeFileSync(cfg, JSON.stringify({ base, alpha_session: SESSIONS.alpha, flaky_session: SESSIONS.flaky, data_dir: join(TMP, 'data') }));
  const py = spawn(pythonBin(), ['scripts/identity-down-browser.py', cfg, ...(process.env.WM_SHOT ? [process.env.WM_SHOT, process.env.WM_SHOT.replace(/\.png$/, '-有数据.png')] : [])], { stdio: 'inherit' });
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
