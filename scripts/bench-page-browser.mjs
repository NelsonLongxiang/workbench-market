#!/usr/bin/env node
/** 视图台页面（/use/<卡片 id>）的浏览器回归（Python Playwright/Chromium），见 scripts/bench-page-browser.py。
 *  起一个全新的合成实例（随机回环端口、合成口令、合成身份），用管理口令登记一张合成卡片（没有台库）。
 *  没有台的卡片、不存在的卡片、没登录：走实例里真的入口（404 / 401）；
 *  是视图台的那一种：入口、取数、交表单在页面里用 page.route 截下、换成合成的应答，并记下页面发了什么。
 *  需先 pnpm --filter web build。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/bench-page-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-bench-page-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(TMP, 'ext'), WM_BENCH_VIEWS: 'on' };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const r = await fetch(base + '/api/workbenches', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: '合成·嵌页台', url: 'http://127.0.0.1:9/', type: 'web' }) });
  if (!r.ok) throw new Error(`seed workbench → ${r.status} ${await r.text()}`);
  const card = (await r.json()).id;
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, card, alpha_session: SESSIONS.alpha }));
  const py = spawn(pythonBin(), ['scripts/bench-page-browser.py', cfg], { stdio: 'inherit' });
  code = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
