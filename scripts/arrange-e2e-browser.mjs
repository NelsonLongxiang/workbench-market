#!/usr/bin/env node
/** 「安排一件事」浏览器端到端（Python Playwright/Chromium），见 scripts/arrange-e2e-browser.py。
 *  起一个全新的合成实例（随机回环端口、合成口令、合成身份），经管理接口（POST /api/bindings）给任务中心绑两个合成的通知团队，不开库。
 *  页面上的请求一个都不截：打开抽屉、读可派团队、交表单、进详情、回列表，走的都是实例里真的接口。
 *  需先 pnpm --filter web build。 */
import { freePort } from './lib/free-port.mjs';
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/arrange-e2e-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = await freePort();
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-arrange-e2e-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'owner', WM_OUTBOUND: 'off', WM_EXTENSIONS_DIR: join(TMP, 'ext') };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const ADMIN = { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN, 'sec-fetch-site': 'same-origin' };
  // 通知地址指向回环上没人听的端口：派出去投不到，只是记失败、不影响建事项（缺省先过目，本来也不派）
  const teams = {};
  for (const name of ['合成甲队', '合成乙队']) {
    const r = await fetch(base + '/api/bindings', { method: 'POST', headers: ADMIN, body: JSON.stringify({ target_type: 'sop', target_slug: 'task-center', agent_node: `syn/canvas/${name}`, direction: 'notify', notify_url: 'http://127.0.0.1:9' }) });
    if (r.status !== 201) throw new Error(`seed binding ${name} → ${r.status} ${await r.text()}`);
    teams[name] = (await r.json()).id;
  }
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, admin_token: ADMIN_TOKEN, alpha_session: SESSIONS.alpha, owner_session: SESSIONS.admin, bindings: teams }));
  const py = spawn(pythonBin(), ['scripts/arrange-e2e-browser.py', cfg], { stdio: 'inherit' });
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
