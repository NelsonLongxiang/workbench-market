#!/usr/bin/env node
/** 身份变了以后页面重读的浏览器回归（Python Playwright/Chromium）：合成员工 alpha 建两件事项，打开事项列表、事项详情、全景；
 *  接口回 401 且确认没登录了、或者会话换成另一个人（beta）→ alpha 的东西从页面上清掉、按现在的人重读；
 *  身份服务连不上（502 identity_unavailable）→ 不清、挂 #641 的横幅；旧身份在路上的请求回来不写回页面；从浏览器缓存恢复的页面也确认一次。
 *  造数据只走现有接口。需先 pnpm --filter web build。全新 DATA_DIR + 随机回环端口；合成身份、合成口令。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/session-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const gh = await startFakeGithub();
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-session-admin';
const env = { ...process.env, NODE_ENV: 'test', PORT: String(PORT), DATA_DIR: join(TMP, 'data'), YGL_HOME: join(TMP, 'home'), ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'off', WM_CONTROL_PORT: '0',
  IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(TMP, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', WM_GITHUB_API: gh.api };
for (const k of ['WM_ODOO_URL', 'WM_ODOO_ORIGINS']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', pathToFileURL(join(ROOT, 'scripts/identity-fake-preload.mjs')).href, 'server/src/index.ts'], { stdio: ['ignore', 'ignore', 'pipe'], env });
let serverErr = ''; server.stderr.on('data', (c) => (serverErr += c));
let code = 1;
try {
  const end = Date.now() + 40_000;
  for (;;) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} if (Date.now() > end) throw new Error('server not ready'); await new Promise((x) => setTimeout(x, 250)); }
  const call = async (method, path, headers, body) => {
    const r = await fetch(base + path, { method, headers: { 'sec-fetch-site': 'same-origin', ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const ADMIN = { 'x-admin-token': ADMIN_TOKEN }, ALPHA = { cookie: `session_id=${SESSIONS.alpha}` };
  // 可派的团队：任务中心上绑一个通知团队（合成名字）
  await call('POST', '/api/bindings', ADMIN, { target_type: 'sop', target_slug: 'task-center', agent_node: 'zone/canvas/team-a', direction: 'notify', notify_url: 'http://127.0.0.1:1' });
  await call('GET', '/api/work-items/teams', ALPHA); // 先登录一次，主体建出来
  // 两件：办完一件之后角标要从 2 变成 1（只造一件的话，角标算坏成 0 也会被当成「办完了」）
  const mk = (title, key) => call('POST', '/api/work-items', ALPHA, { title, intent: '把三家的报价比一比', deliverable: '一张比价表', team: 'zone/canvas/team-a', review: true, idempotency_key: key });
  const made = await mk('合成：比一比三家报价', 'session-browser-0001');
  const made2 = await mk('合成：核对到货数量', 'session-browser-0002');
  // 要到别处处理的：三条进行中的 SOP 执行（统一待办里的条目，没有当场的答法）
  const pub = await ghPublish(base, gh, { slug: 'count-sop', kind: 'sop', title: '计数合成 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: 计数合成 SOP\nsteps:\n  - key: a\n    title: A\n' }] }, ADMIN);
  if (!pub.ok) throw new Error(`sync count-sop → ${pub.status} ${await pub.text()}`);
  await call('POST', '/api/sops/count-sop/publish', ADMIN, {});
  for (let i = 0; i < 3; i++) await call('POST', '/api/sop/runs', ADMIN, { slug: 'count-sop', started_by: `合成-${i}` });
  // 驾驶舱：一块数据视图的引用（数据视图开关缺省关着，面板位会写「数据视图未开启」——看的是它的读请求按新的人重发）
  const ck = await call('POST', '/api/cockpits', ADMIN, { name: '合成驾驶舱', panels: [{ i: 'bv-synthetic-bench-kpi', kind: 'bench-view', bench: 'synthetic-bench', view: 'kpi', tab: 'board', order: 0 }] });
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, cockpit: ck.id, admin_session: SESSIONS.admin, alpha_session: SESSIONS.alpha, beta_session: SESSIONS.beta, items: [made.item_id, made2.item_id], titles: ['合成：比一比三家报价', '合成：核对到货数量'] }));
  const py = spawn(pythonBin(), ['scripts/session-browser.py', cfg], { stdio: 'inherit' });
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
