#!/usr/bin/env node
/** 全站登录门真实浏览器回归（Python Playwright/Chromium，CI browser-security job）。WM_LOGIN_GATE=enforce 的隔离实例：
 *  ① 匿名打开自产台 → 登录页（next 带原地址）；错误口令有提示；口令登录后回到原地址
 *  ② 沙箱自产台（CSP sandbox，不透明源，子资源不带 cookie）在登录门下照常工作：相对脚本、绝对样式表、静态/动态 <img> 文件、
 *     带 X-App-Token 的文件接口；地址带查看凭证
 *  ③ 使用页 /use/<id> 内嵌同一台（iframe 经 /go/<id>/）照常工作
 *  ④ SPA 顶栏显示登录身份与「退出」；会话失效后 SPA 的接口 401 整页去登录页（next 回当前页）；退出后再进被拦
 *  ⑤ next 指向站外时登录后落在首页
 *  需先 pnpm --filter web build。合成口令、中性 slug、本机 GitHub 替身、随机回环端口；不碰生产。 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const TMP = resolve('tmp/login-gate-browser-' + Date.now().toString(36));
mkdirSync(join(TMP, 'data'), { recursive: true });
const gh = await startFakeGithub();
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, WM_LOGIN_GATE: 'enforce', NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN: 'synthetic-login-gate-browser', WM_GITHUB_API: gh.api, REDIS_URL: '' };
for (const k of ['WM_ODOO_URL', 'WM_EXTENSIONS_DIR', 'WM_ODOO_ORIGINS', 'WM_CONTROL_PORT', 'MCP_GATEWAY']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
// 1×1 PNG（合成）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// 自产台：相对脚本 + 绝对样式表 + 静态绝对 <img>（文件 id 1）；脚本里带台令牌读文件列表、动态建 <img>
const APP_JS = `(async () => {
  const out = { js: true };
  const t = window.WM_APP_TOKEN, s = window.WM_APP_SLUG;
  try { const r = await fetch('/api/apps/' + s + '/files', { headers: { 'X-App-Token': t } }); const j = await r.json(); out.files = r.status; out.fileId = j.items && j.items[0] && j.items[0].id; } catch (e) { out.files = 'err'; }
  const img = document.createElement('img'); img.id = 'dyn'; img.src = '/api/apps/' + s + '/files/' + out.fileId; document.body.appendChild(img);
  await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 3000); });
  const st = document.getElementById('st');
  out.dyn = img.naturalWidth; out.st = st.complete ? st.naturalWidth : -1;
  out.css = getComputedStyle(document.body).getPropertyValue('--gate-css').trim();
  const el = document.getElementById('out'); el.textContent = JSON.stringify(out); el.setAttribute('data-done', '1');
})();`;
const INDEX = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/apps/gate-app/style.css"></head>
<body><img id="st" src="/api/apps/gate-app/files/1"><pre id="out"></pre><script src="app.js"></script></body></html>`;
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const pub = await ghPublish(base, gh, { slug: 'gate-app', title: 'Gate App', files: [
    { path: 'index.html', content: INDEX }, { path: 'app.js', content: APP_JS }, { path: 'style.css', content: 'body{--gate-css:loaded}' }] });
  if (!pub.ok) throw new Error(`sync gate-app → ${pub.status} ${await pub.text()}`);
  const fd = new FormData(); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
  const up = await fetch(base + '/api/apps/gate-app/files', { method: 'POST', body: fd }); // 本机命令行
  const upj = await up.json();
  if (!up.ok || (upj.id ?? upj.file?.id) !== 1) throw new Error(`upload → ${up.status} ${JSON.stringify(upj)}`);
  const wbs = await (await fetch(base + '/api/workbenches')).json();
  const wid = wbs.find((w) => w.url === '/apps/gate-app/')?.id;
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, wid, token: env.ADMIN_TOKEN }));
  const py = spawn(process.env.PYTHON || 'python3', ['scripts/login-gate-browser.py', cfg], { stdio: 'inherit' });
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
