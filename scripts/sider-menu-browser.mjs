#!/usr/bin/env node
/** #316 侧栏五组菜单 + #317 页面骨架 + #319 列表规则浏览器回归（Python Playwright/Chromium，CI browser-security job）。
 *  #319（list-rules-browser.py）：统一待办 ProTable 全部可读且 ID 不重复、状态最左/操作最右、直接操作 ≤2、相对时间、数字右对齐。
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
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-menu-admin' };
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
  // #319：25 条进行中 run → 统一待办 25 条 market 任务（超过一页 20 条）；再登记一个工作台
  const adm = (method, path, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-admin-token': env.ADMIN_TOKEN }, body: JSON.stringify(body) }).then(async (x) => { if (!x.ok) throw new Error(`${method} ${path} → ${x.status} ${await x.text()}`); return x.json(); });
  await adm('POST', '/api/apps', { slug: 'list-sop', kind: 'sop', title: '列表合成 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: 列表合成 SOP\nsteps:\n  - key: a\n    title: A\n' }] });
  await adm('POST', '/api/sops/list-sop/publish', {});
  for (let i = 0; i < 25; i++) await adm('POST', '/api/sop/runs', { slug: 'list-sop', started_by: `合成-${i}` });
  await adm('POST', '/api/workbenches', { name: '列表合成台', url: base + '/api/health', type: 'web' });
  await adm('POST', '/api/check-all', {});
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, control: `http://127.0.0.1:${PORT + 1}`, token: env.ADMIN_TOKEN, cockpit, cockpit_name: '合成驾驶舱', min_tasks: 25 }));
  code = 0;
  for (const script of ['scripts/sider-menu-browser.py', 'scripts/page-skeleton-browser.py', 'scripts/list-rules-browser.py']) {
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
