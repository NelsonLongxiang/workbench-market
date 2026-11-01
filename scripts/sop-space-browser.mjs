#!/usr/bin/env node
/** #318 SOP 交付空间浏览器回归（Python Playwright/Chromium，CI browser-security job）。
 *  合成 SOP（含私有填写值 + 附件）+ 全新 DATA_DIR + 随机回环端口；业务面无读授权、控制面持管理员口令两种视角。
 *  需先 pnpm --filter web build（服务端托管 web/dist）。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const TMP = resolve('tmp/sop-space-browser-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, MCP_GATEWAY: 'off', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), ADMIN_TOKEN: 'synthetic-sop-space-admin' };
for (const k of ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT']) delete env[k]; // 控制面用缺省 PORT+1
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
const api = async (method, path, body, form) => {
  const r = await fetch(base + path, { method, headers: { 'x-admin-token': env.ADMIN_TOKEN, ...(form ? {} : { 'content-type': 'application/json' }) }, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const yaml = 'title: 机柜验收\ncode: RK-01\nsteps:\n  - key: pos\n    title: 机位确认\n    body: <p>STEP-BODY-HTML</p>\n  - key: torque\n    title: 扭矩复核\n  - key: selftest\n    title: 通电自检\n';
  await api('POST', '/api/apps', { slug: 'rack-check', kind: 'sop', title: '机柜验收', changelog: '首版', files: [{ path: 'sop.yaml', content: yaml }] });
  await api('POST', '/api/sops/rack-check/publish', {});
  const run = await api('POST', '/api/sop/runs', { slug: 'rack-check', started_by: '合成·张工' });
  await api('PUT', `/api/sop/runs/${run.id}`, { stepKey: 'pos', value: { 机位: 'A-12', 备注: '<b>SECRET-POS</b>' } });
  await api('PUT', `/api/sop/runs/${run.id}`, { stepKey: 'torque', value: 'PRIVATE-TORQUE-42' });
  const fd = new FormData(); fd.append('file', new Blob(['synthetic deliverable']), 'report-private.txt');
  await api('POST', `/api/sop/runs/${run.id}/files`, undefined, fd);
  await api('POST', `/api/sop/runs/${run.id}/finish`, {});
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, control: `http://127.0.0.1:${PORT + 1}`, token: env.ADMIN_TOKEN, slug: 'rack-check', run: run.id, private: ['A-12', 'SECRET-POS', 'PRIVATE-TORQUE-42', 'report-private.txt'], step_body: 'STEP-BODY-HTML', downloads: join(TMP, 'dl') }));
  const py = spawn(process.env.PYTHON || 'python3', ['scripts/sop-space-browser.py', cfg], { stdio: 'inherit' });
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
