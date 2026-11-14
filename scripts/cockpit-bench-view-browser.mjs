#!/usr/bin/env node
/** 驾驶舱里的数据视图（#669）浏览器回归（Python Playwright/Chromium），见 scripts/cockpit-bench-view-browser.py。
 *  起一个全新的合成实例（随机回环端口、合成口令），用管理口令建一个驾驶舱，里面先挂两份数据视图的引用（存的只是名字）。
 *  数据视图的接口（台的清单、视图描述、取数）在页面里用 page.route 截下、换成合成的应答：这样不用造台、也不依赖谁有台的权限。
 *  需先 pnpm --filter web build。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const TMP = resolve('tmp/cockpit-bench-view-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-cockpit-bv-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
  WM_EXTENSIONS_DIR: join(TMP, 'ext'), WM_BENCH_VIEWS: 'on' };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const r = await fetch(base + '/api/cockpits', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN }, body: JSON.stringify({ name: '合成视图舱', panels: [
    { kind: 'bench-view', bench: 'synth-a', view: 'board', tab: 'board', order: 0 },
    { kind: 'bench-view', bench: 'synth-hidden', view: 'secret', tab: 'board', order: 1 },
  ] }) });
  if (!r.ok) throw new Error(`seed cockpit → ${r.status} ${await r.text()}`);
  const cockpit = (await r.json()).id;
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, token: ADMIN_TOKEN, cockpit }));
  const py = spawn(pythonBin(), ['scripts/cockpit-bench-view-browser.py', cfg], { stdio: 'inherit' });
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
