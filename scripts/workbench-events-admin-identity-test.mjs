#!/usr/bin/env node
/**
 * 工作台事件的读写面认会话登录的管理员（ADMIN_IDENTITY_PATHS 加 workbench-events）。这是放宽访问，带对抗：
 *
 *   一、路径匹配只多这一组：把 index.ts 里的正则对 surfaces/routes.json 的全部路由各取一个样本路径，
 *       匹配到的集合钉成一张表；和去掉 workbench-events 这一项的正则比，只多 /api/workbench-events 的四条
 *   二、起一个隔离实例（假的登录提供方，NODE_ENV=test），对 /api/workbench-events 的列表、详情、放行：
 *       · 口令管理员：照旧能看、能放行
 *       · 会话登录的管理员：现在能看、能放行（有意放开，放行是写操作）
 *       · 会话登录的非管理员、远程匿名、提供方不认的会话：照旧 403，应答和管理门原来的一样
 *       · 停用的主体：和一个早就在名单里的管理读面（/api/change-requests）同一个结果
 *       · 决定端点凭回复令牌，不看管理员：会话登录的管理员不带令牌照旧被拒
 *
 *   node scripts/workbench-events-admin-identity-test.mjs              测本仓库
 *   node scripts/workbench-events-admin-identity-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `wbe-admin-identity-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'wbe-identity-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);

/** 进路由前认定会话登录管理员的路由（口令、身份端点、管理读面）。改这张表要在 PR 里说明为什么。 */
const EXPECTED = [
  "DELETE /api/admin-token",
  "DELETE /api/bindings/:id",
  "DELETE /api/mcp/sessions/:id",
  "DELETE /api/vault/entries/:id",
  "DELETE /api/vault/trash/:id",
  "GET /api/admin-token/state",
  "GET /api/admin/whoami",
  "GET /api/bindings",
  "GET /api/change-requests",
  "GET /api/mcp/access-requests",
  "GET /api/mcp/calls",
  "GET /api/mcp/sessions",
  "GET /api/mcp/tools",
  "GET /api/mcp/upstreams",
  "GET /api/remote-allow/diff",
  "GET /api/tasks",
  "GET /api/vault/entries",
  "GET /api/vault/entries/:id",
  "GET /api/vault/entries/:id/totp",
  "GET /api/vault/health",
  "GET /api/vault/history",
  "GET /api/vault/status",
  "GET /api/vault/trash",
  "POST /api/bindings",
  "POST /api/change-requests/:id/approve",
  "POST /api/change-requests/:id/reject",
  "POST /api/mcp/access-requests/:id/approve",
  "POST /api/mcp/access-requests/:id/reject",
  "POST /api/mcp/sessions",
  "POST /api/tasks/read-grants/revoke",
  "POST /api/vault/entries",
  "POST /api/vault/generate",
  "POST /api/vault/lock",
  "POST /api/vault/master-check",
  "POST /api/vault/strength",
  "POST /api/vault/trash/:id/restore",
  "POST /api/vault/unlock",
  "PUT /api/admin-token",
  "PUT /api/mcp/sessions/:id/grants",
  "PUT /api/mcp/upstreams",
  "PUT /api/tasks/read-grants",
  "PUT /api/vault/entries/:id",
  // 这次加的：工作台事件的列表、详情、放行、决定（写的两条本来就过写请求总门、那里已经认定，实际变的是两条读）
  'GET /api/workbench-events', 'GET /api/workbench-events/:eventId', 'POST /api/workbench-events/:eventId/release', 'POST /api/workbench-events/:eventId/decision',
];
const ADDED = EXPECTED.filter((r) => r.includes('/api/workbench-events'));

const freePort = () => new Promise((ok, no) => { const s = createServer(); s.unref(); s.on('error', no); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const SEED = `
const at = (p) => ${JSON.stringify(pathToFileURL(ROOT).href)} + '/' + p;
const { db } = await import(at('server/src/db.ts'));
const events = await import(at('server/src/workbench-events.ts'));
events.initWorkbenchEvents();
db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, notify_url) VALUES ('sop', 'task-center', 'team-a', 'notify', 'http://team-a.synthetic.invalid/a2a')").run();
const ids = [];
for (const id of [701, 702]) { db.exec('BEGIN IMMEDIATE'); ids.push(events.recordTaskCenterEvent({ id, data: {}, stepValue: () => '', publishedBy: 'alpha', templateVersion: 1, materialSha256: 'c'.repeat(64), agentDispatch: false, centerOn: false })); db.exec('COMMIT'); }
console.log('SEEDED ' + JSON.stringify(ids));
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  // ---------- 一、路径匹配只多这一组 ----------
  {
    const src = readFileSync(join(ROOT, 'server/src/index.ts'), 'utf8');
    const lit = /const ADMIN_IDENTITY_PATHS = \/(.*?)\/;/.exec(src)?.[1];
    const now = new RegExp(lit);
    const before = new RegExp(lit.replace('|workbench-events(\\/|$)', ''));
    const routes = [...new Set(JSON.parse(readFileSync(join(ROOT, 'surfaces/routes.json'), 'utf8')).apps.flat().flatMap((x) => (typeof x === 'string' ? [x] : x?.routes ?? [])).map((l) => l.split('  <-')[0].trim()).filter((r) => /^(GET|POST|PUT|PATCH|DELETE|ALL) \//.test(r)))];
    const sample = (r) => r.split(' ')[1].replace(/:[A-Za-z_]+/g, 'x1').replace(/\(\.\*\)|\*/g, 'x1').toLowerCase();
    const hit = (re) => routes.filter((r) => r.split(' ')[1].startsWith('/') && re.test(sample(r))).sort();
    const got = hit(now), old = hit(before);
    check(lit !== undefined && show(got) === show([...EXPECTED].sort()), `正则匹配到的路由正好是钉住的 ${EXPECTED.length} 条`, show({ 多: got.filter((r) => !EXPECTED.includes(r)), 少: EXPECTED.filter((r) => !got.includes(r)) }));
    const added = got.filter((r) => !old.includes(r)), removed = old.filter((r) => !got.includes(r));
    check(show(added) === show([...ADDED].sort()) && removed.length === 0, `和去掉 workbench-events 的正则比：只多工作台事件这 ${ADDED.length} 条，没有少的`, show({ added, removed }));
  }

  // ---------- 二、隔离实例 ----------
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid', A2A_OUTBOX_BACKOFF_SCALE: '100000' };
  const seeded = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', SEED], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seeded.stdout);
  if (!m) throw new Error(`造数据失败：${seeded.stderr.slice(-800)}`);
  const [ev1, ev2] = JSON.parse(m[1]);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const call = async (method, path, headers, body) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body: json };
  };
  const token = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const sessionAdmin = { ...SAME, cookie: `session_id=${SESSIONS.admin}` };
  const GUARD_403 = '需要有效的 X-Admin-Token 或 Odoo 管理员登录';

  // 口令管理员：照旧
  const t1 = await call('GET', '/api/workbench-events', token), t2 = await call('GET', `/api/workbench-events/${ev1}`, token);
  check(t1.status === 200 && t1.body.length === 2 && t2.status === 200 && t2.body.event_id === ev1, '口令管理员：列表、详情照旧能看', show([t1.status, t2.status]));

  // 会话登录的管理员：现在能看、能放行
  const s1 = await call('GET', '/api/workbench-events', sessionAdmin), s2 = await call('GET', `/api/workbench-events/${ev1}`, sessionAdmin);
  check(s1.status === 200 && s1.body.length === 2 && s2.status === 200, '会话登录的管理员：列表、详情现在能看（有意放开）', show([s1.status, s1.body, s2.status]));
  const rel = await call('POST', `/api/workbench-events/${ev1}/release`, sessionAdmin, {});
  const after = await call('GET', `/api/workbench-events/${ev1}`, token);
  check(rel.status === 200 && after.body.deliveries.every((d) => d.status !== 'held') && after.body.log.some((l) => l.action === 'released'), '会话登录的管理员：放行能做（写操作；改前就能，写请求总门里已经认定），投递离开搁置、留了一行 released', show([rel.status, rel.body]));

  // 照旧被拒的
  const denied = [
    ['会话登录的非管理员', { ...SAME, cookie: `session_id=${SESSIONS.alpha}` }],
    ['远程匿名', { ...SAME, 'x-forwarded-for': '198.51.100.7' }],
    ['提供方不认的会话', { ...SAME, cookie: `session_id=${SESSIONS.forged}` }],
    ['口令不对', { ...SAME, 'x-admin-token': 'not-the-token' }],
  ];
  for (const [who, h] of denied) {
    const rs = [await call('GET', '/api/workbench-events', h), await call('GET', `/api/workbench-events/${ev2}`, h), await call('POST', `/api/workbench-events/${ev2}/release`, h, {})];
    check(rs.every((r) => r.status === 403 && String(r.body?.error ?? '').startsWith(GUARD_403)), `${who}：列表、详情、放行照旧 403，应答是管理门原来那一句`, show(rs.map((r) => [r.status, r.body])));
  }
  const still = await call('GET', `/api/workbench-events/${ev2}`, token);
  check(still.body.deliveries.every((d) => d.status === 'held'), '被拒的放行没有生效：第二个事件仍然搁置');

  // 决定端点凭回复令牌：会话登录的管理员不带令牌照旧被拒
  const dec = await call('POST', `/api/workbench-events/${ev2}/decision`, sessionAdmin, { decision: 'accept', reason: 'x' });
  check(dec.status >= 400 && dec.status < 500, '决定端点不看管理员：会话登录的管理员不带回复令牌照旧被拒', show(dec));

  // 停用的主体：和早就在名单里的管理读面同一个结果
  const off = await call('POST', '/api/principals/disable', token, { id: 'user:root-admin', reason: '对抗：停用管理员' });
  const ref = await call('GET', '/api/change-requests', sessionAdmin), wbe = await call('GET', '/api/workbench-events', sessionAdmin);
  check(off.status === 200 && ref.status === wbe.status && ref.status !== 200, `停用的主体：工作台事件列表和 /api/change-requests 一样被拒（${ref.status}）`, show({ off: [off.status, off.body], ref: ref.status, wbe: wbe.status }));
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.slice(-1500));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
