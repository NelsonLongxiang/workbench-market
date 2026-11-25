#!/usr/bin/env node
/** #1063 设置页「个人令牌」：真实后端 → 浏览器（起隔离实例，个人令牌接口不截）。
 *   准备：属主 root-admin（owner 授予）、非属主 alpha；浏览器（scripts/personal-tokens-browser.py）签发、只显示一次、刷新后看不到、名字重复照说、撤销后 401、非属主只见说明。
 *   回到这里：服务端输出里不得出现任何令牌原文。身份用合成的（identity-fake-provider）。隔离目录 tmp/personal-tokens-browser-*，跑完清掉。需先 pnpm --filter web build。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/personal-tokens-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const PORT = 21000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), HOME: join(TMP, 'home'), ADMIN_TOKEN: 'synthetic-personal-tokens-admin', REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, IDENTITY_FAKE_ADMIN_GRANT: 'admin', WM_EXTENSIONS_DIR: join(TMP, 'ext'), WM_BENCH_VIEWS: 'on' };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env });
let serverOut = ''; server.stdout.on('data', (c) => (serverOut += c)); server.stderr.on('data', (c) => (serverOut += c));
const call = async (method, path, { body, session } = {}) => {
  const h = {}; if (session) h.cookie = `session_id=${session}`; if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  return { status: res.status, text, json };
};
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  for (const s of [SESSIONS.admin, SESSIONS.alpha]) await call('GET', '/api/auth/viewer', { session: s });
  // 属主授予只给 root-admin（本机命令行建、提交、批准，同 bench-mcp-test）
  const g = await call('POST', '/api/grants', { body: { principal: 'user:root-admin', role: 'owner', scope: '*', reason: '合成：#1063 个人令牌' } });
  await call('POST', `/api/grants/${g.json?.grant?.id}/submit`); const ap = await call('POST', `/api/grants/${g.json?.grant?.id}/approve`);
  if (ap.status >= 300) throw new Error('owner grant → ' + ap.status + ' ' + ap.text);
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, session_owner: SESSIONS.admin, session_other: SESSIONS.alpha }));
  const py = spawn(pythonBin(), ['scripts/personal-tokens-browser.py', cfg], { stdio: 'inherit' });
  const pyCode = await new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
  const leaked = /wmu_[A-Za-z0-9_-]{43}/.test(serverOut);
  console.log(leaked ? '  ✗ 服务端输出里出现了令牌原文' : '  ✓ 服务端输出里没有令牌原文');
  code = pyCode || leaked ? 1 : 0;
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill(); await new Promise((x) => setTimeout(x, 400));
  if (code && serverOut) console.log(serverOut.replace(/wmu_[A-Za-z0-9_-]{43}/g, 'wmu_<redacted>').slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(code);
