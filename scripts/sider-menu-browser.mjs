#!/usr/bin/env node
/** #316 侧栏五组菜单 + #317 页面骨架浏览器回归（Python Playwright/Chromium，CI browser-security job）。
 *  #317（page-skeleton-browser.py）：10 个页面都有 PageContainer、标题 = 菜单名、面包屑 = 分组 / 页面、右上至多 1 个 primary；驾驶舱详情带详情名。
 *  #316（sider-menu-browser.py）：
 *  旧路由照开 · 业务面四组按序且无管理组 · 日常组默认展开 · 侧栏文字对比度 ≥4.5 · 每页专属图标 ·
 *  控制面无口令无管理组、输口令后管理组出现且默认折叠、点开可跳转。
 *  需先 pnpm --filter web build（服务端托管 web/dist）。全新 DATA_DIR + 随机回环端口；合成口令。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const TMP = resolve('tmp/sider-menu-browser-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, MCP_GATEWAY: 'off', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-menu-admin' };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT']) delete env[k]; // 控制面用缺省 PORT+1
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const r = await fetch(base + '/api/cockpits', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': env.ADMIN_TOKEN }, body: JSON.stringify({ name: '合成驾驶舱', panels: [] }) });
  if (!r.ok) throw new Error(`seed cockpit → ${r.status}`);
  const cockpit = (await r.json()).id;
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, control: `http://127.0.0.1:${PORT + 1}`, token: env.ADMIN_TOKEN, cockpit, cockpit_name: '合成驾驶舱' }));
  code = 0;
  for (const script of ['scripts/sider-menu-browser.py', 'scripts/page-skeleton-browser.py']) {
    const py = spawn(process.env.PYTHON || 'python3', [script, cfg], { stdio: 'inherit' });
    code |= await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
