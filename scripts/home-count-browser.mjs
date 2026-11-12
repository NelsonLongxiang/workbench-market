#!/usr/bin/env node
/** 「等你拍板」三处同数的浏览器回归（Python Playwright/Chromium）：侧栏角标、全景总结句、卡片区的件数必须是同一个数，
 *  而且只数「轮到看的人、能当场办」的；要到别处处理的不算。
 *  造数据只走现有接口，不写库：管理员给任务中心绑一个通知团队 → 合成员工 alpha 用「安排一件事」建一件先过目的事项（停在等放行）。
 *  管理员看：这一件轮到他、能当场放行 → 三处都是 1；另建 SOP 执行若干，作为「要到别处处理的」，不该进这三处。
 *  「别人的事、你可以代办」那一组要事项走到等验收或在问，得有节点回执，现有接口造不出来——那一组由单测（home-ui-unit）和试联实测覆盖。
 *  需先 pnpm --filter web build。全新 DATA_DIR + 随机回环端口；合成身份、合成口令。 */
import { pythonBin } from './python-bin.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeGithub, ghPublish } from './github-fixture.mjs';

if (!existsSync('web/dist/index.html')) { console.error('缺 web/dist：先跑 pnpm --filter web build'); process.exit(2); }
const ROOT = resolve('.');
const TMP = resolve('tmp/home-count-browser-' + Date.now().toString(36));
for (const d of ['data', 'home', 'ext']) mkdirSync(join(TMP, d), { recursive: true });
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const gh = await startFakeGithub();
const PORT = 20000 + Math.floor(Math.random() * 12000);
const base = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'synthetic-home-count-admin';
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
  const made = await call('POST', '/api/work-items', ALPHA, { title: '合成：比一比三家报价', intent: '把三家的报价比一比', deliverable: '一张比价表', team: 'zone/canvas/team-a', review: true, idempotency_key: 'home-count-browser-0001' });
  // 要到别处处理的：三条进行中的 SOP 执行（统一待办里的条目，没有当场的答法）
  const pub = await ghPublish(base, gh, { slug: 'count-sop', kind: 'sop', title: '计数合成 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: 计数合成 SOP\nsteps:\n  - key: a\n    title: A\n' }] }, ADMIN);
  if (!pub.ok) throw new Error(`sync count-sop → ${pub.status} ${await pub.text()}`);
  await call('POST', '/api/sops/count-sop/publish', ADMIN, {});
  for (let i = 0; i < 3; i++) await call('POST', '/api/sop/runs', ADMIN, { slug: 'count-sop', started_by: `合成-${i}` });
  const cfg = join(TMP, 'browser.json');
  writeFileSync(cfg, JSON.stringify({ base, admin_session: SESSIONS.admin, alpha_session: SESSIONS.alpha, item: made.item_id, title: '合成：比一比三家报价' }));
  const py = spawn(pythonBin(), ['scripts/home-count-browser.py', cfg], { stdio: 'inherit' });
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
