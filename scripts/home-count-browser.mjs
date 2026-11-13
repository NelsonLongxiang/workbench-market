#!/usr/bin/env node
/** 「等你拍板」三处同数的浏览器回归（Python Playwright/Chromium）：侧栏角标、全景总结句、卡片区的件数必须是同一个数，
 *  而且只数「轮到看的人、能当场办」的；要到别处处理的、别人的事可以代办的都不算。
 *  造数据只走现有接口（名册是节点签名报上来的，没有 HTTP 入口，起实例前经名册服务的 recordRoster 记一份）：
 *    任务中心绑两个通知团队 team-a、team-b；部门「合成采购部」的负责人是会话登录的管理员（root-admin），team-a 认领到这个部门
 *    （都经部门和团队的正式入口，本机命令行即属主）；team-b 没有负责人。
 *  第一段（负责人）：合成员工 alpha 给 team-a 建两件先过目的事项 → 放行归负责人，轮到他、能当场放行 → 三处都是 2；
 *    当场放行一件 → 三处都变 1，再放一件 → 都是 0（不刷新页面）；另建 SOP 执行若干，作为「要到别处处理的」，不进这三处；
 *    他这一视角没有「可以代办」那一组（他身上没有管理层授予）。建立人 alpha：不轮到他，三处都是 0。
 *  第二段（管理层代办）：alpha 再给 team-b 建两件 → 团队没有负责人，持有管理层授予的人（user:no-flag）代办：
 *    这两件在「可以代办」那一组，不进角标、不算进总结句的等你拍板数，三处都是 0、仍然一致；总结句说「另有 2 件别人的事你可以代办」。
 *  需先 pnpm --filter web build。全新 DATA_DIR + 随机回环端口；合成身份、合成口令。 */
import { pythonBin } from './python-bin.mjs';
import { spawn, spawnSync } from 'node:child_process';
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
// 名册：节点签名报上来的，没有 HTTP 入口；起实例前经名册服务记一份（team-a 有一个总工席位，team-b 也在这台宿主上）
const PEER = 'http://127.0.0.1:1', HOST = 'a1b2c3d4';
// 节点公钥的完整指纹（合成的）：对端登记钉住的和名册记的是同一把，名册视图才认这台节点
const FP = 'sha256:' + (HOST + '0'.repeat(64)).slice(0, 64);
const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
  await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
  const { recordRoster } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/a2a-roster.ts')).href)});
  // 团队归属绑节点（根地址 + 完整指纹）：这个根地址在对端登记里要启用、有指纹（合成的）
  const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('peer-home', '${PEER}', 'zone', '', 'active', '${FP}', 'seed', '0', '0')").run();
  const now = Date.now();
  const seat = (team, n) => ({ team, seat: 'zone/0000000' + n, seat_id: 'seat-0000000' + n, name: '合成总工' + n, role: 'router', online: true, queued: 0, last_active_at: new Date(now).toISOString() });
  console.log('ROSTER ' + recordRoster({ host: '${HOST}', peerRoot: '${PEER}', keyFingerprint: '${FP}', peerZone: 'zone', reportedAt: new Date(now).toISOString(), seats: [seat('zone/canvas/team-a', 'a'), seat('zone/canvas/team-b', 'b')], now }));
  process.exit(0);`], { env, encoding: 'utf8' });
if (!/ROSTER recorded/.test(seeded.stdout)) { console.error('名册记不上：' + seeded.stdout + seeded.stderr.slice(-800)); process.exit(1); }
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
  const LEAD = { cookie: `session_id=${SESSIONS.admin}` }, MGMT = { cookie: `session_id=${SESSIONS.noAdminFlag}` };
  // 可派的团队：任务中心上绑两个通知团队（合成名字），投到名册里那台宿主
  for (const t of ['team-a', 'team-b']) await call('POST', '/api/bindings', ADMIN, { target_type: 'sop', target_slug: 'task-center', agent_node: `zone/canvas/${t}`, direction: 'notify', notify_url: PEER });
  for (const h of [ALPHA, LEAD, MGMT]) await call('GET', '/api/auth/me', h); // 先登录一次，主体建出来
  // 负责人：部门负责人 + 团队认领，都经正式入口（本机命令行即属主，直接生效）；team-b 不认领，没有负责人
  const local = async (method, path, body) => { const r = await fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`); return j; };
  await local('PUT', '/api/departments/purchasing', { name: '合成采购部', lead: 'user:root-admin' });
  await local('POST', '/api/teams/claim', { host: HOST, team: 'zone/canvas/team-a', department: 'purchasing' });
  // 管理层授予：只给 user:no-flag（起草→提交→放行）；负责人身上要是迁出了管理层（身份来源说是管理员的，第一次见到时迁），撤掉，让他只剩负责人这一层
  const g = await local('POST', '/api/grants', { principal: 'user:no-flag', role: 'management', scope: '*', reason: '合成：管理层' });
  await local('POST', `/api/grants/${g.grant.id}/submit`, {}); await local('POST', `/api/grants/${g.grant.id}/approve`, {});
  for (const x of ((await local('GET', '/api/grants?principal=user:root-admin&status=active')).grants ?? []).filter((x) => x.role === 'management')) await local('POST', `/api/grants/${x.id}/revoke`, { reason: '合成：只留负责人' });
  // 两件交给 team-a：办完一件之后角标要从 2 变成 1（只造一件的话，角标算坏成 0 也会被当成「办完了」）
  const mk = (title, key, team = 'team-a') => call('POST', '/api/work-items', ALPHA, { title, intent: '把三家的报价比一比', deliverable: '一张比价表', team: `zone/canvas/${team}`, review: true, idempotency_key: key });
  const made = await mk('合成：比一比三家报价', 'home-count-browser-0001');
  const made2 = await mk('合成：核对到货数量', 'home-count-browser-0002');
  // 要到别处处理的：三条进行中的 SOP 执行（统一待办里的条目，没有当场的答法）
  const pub = await ghPublish(base, gh, { slug: 'count-sop', kind: 'sop', title: '计数合成 SOP', changelog: 'x', files: [{ path: 'sop.yaml', content: 'title: 计数合成 SOP\nsteps:\n  - key: a\n    title: A\n' }] }, ADMIN);
  if (!pub.ok) throw new Error(`sync count-sop → ${pub.status} ${await pub.text()}`);
  await call('POST', '/api/sops/count-sop/publish', ADMIN, {});
  for (let i = 0; i < 3; i++) await call('POST', '/api/sop/runs', ADMIN, { slug: 'count-sop', started_by: `合成-${i}` });
  const cfg = join(TMP, 'browser.json');
  const runPy = async (phase, extra) => {
    writeFileSync(cfg, JSON.stringify({ base, phase, lead_session: SESSIONS.admin, alpha_session: SESSIONS.alpha, mgmt_session: SESSIONS.noAdminFlag, ...extra }));
    const py = spawn(pythonBin(), ['scripts/home-count-browser.py', cfg], { stdio: 'inherit' });
    return new Promise((x, j) => { py.on('error', j); py.on('exit', x); });
  };
  code = await runPy('lead', { items: [made.item_id, made2.item_id], titles: ['合成：比一比三家报价', '合成：核对到货数量'] });
  // 第二段：两件交给没有负责人的 team-b，管理层代办
  const b1 = await mk('合成：盘一盘库存', 'home-count-browser-0003', 'team-b');
  const b2 = await mk('合成：对一对发票', 'home-count-browser-0004', 'team-b');
  code = (await runPy('proxy', { items: [b1.item_id, b2.item_id], titles: ['合成：盘一盘库存', '合成：对一对发票'] })) || code;
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  server.kill(); await gh.close();
  await new Promise((x) => setTimeout(x, 400));
  if (code && serverErr) console.log(serverErr.slice(-1500));
  rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code ? 1 : 0;
