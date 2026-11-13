#!/usr/bin/env node
/**
 * 比对打开时的「按人迁移授予」不放宽（遗留差异 L6）：身份来源的管理员第一次被见到，只迁 member 和 admin，不迁 management。
 * 管理层由属主单独授。几处业务代码直接认管理层授予，所以迁了 management 就等于比对一开就放宽——这里一处一处守住：
 *
 *   一、身份来源的管理员第一次被见到后：迁出来的只有 member、admin，没有任何生效的 management
 *   二、团队分配、收回：仍回 403 not_team_lead（系统管理员不代办）
 *   三、认领团队：仍然走提议（202），不直接落
 *   四、数据视图（WM_BENCH_VIEWS=on）：仍然进不去（403 bench_views_forbidden）
 *   五、对照：属主（本机命令行）单独授了 management 之后，同一个人上面三处都放行——证明前面的拒绝是因为没有管理层授予，不是别的门
 *
 * 真实的 server/src/index.ts，比对打开（WM_JUDGMENT_COMPARE=on）；身份来源是假提供方，只在 127.0.0.1 上，不访问任何外部系统。
 *   node scripts/judgment-migration-test.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `judgment-migration-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-migration-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.63' };
const HOST = 'a1b2c3d5';
const TEAM = 'zone1/canvas/Mig Team';
const OTHER = 'zone1/canvas/Mig Other';
const THIRD = 'zone1/canvas/Mig Third';
const MEMBER = { seat: 'zone1/0000001b', seat_id: 'seat-0000001b' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

let child = null;
const data = join(OUT, 'data');
async function boot() {
  const port = await freePort();
  const home = join(OUT, 'home'), ext = join(OUT, 'ext');
  for (const d of [data, home, ext]) mkdirSync(d, { recursive: true });
  const env = {};
  for (const k of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext, WM_JUDGMENT_COMPARE: 'on', WM_BENCH_VIEWS: 'on' });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += String(d); });
  child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const deadline = Date.now() + 40000; !ready && Date.now() < deadline && child.exitCode === null;) {
    try { ready = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ready) await sleep(200);
  }
  if (!ready) throw new Error(`隔离实例没起来：${log.trim().split('\n').slice(-4).join(' | ') || '没有输出'}`);
  const call = async (method, path, { headers = {}, body, session } = {}) => {
    const h = { ...headers };
    if (session) h.cookie = `session_id=${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: res.status, json };
  };
  return { host: new URL(base).host, call };
}

try {
  const srv = await boot();
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const asRoot = { headers: { ...REMOTE, ...same }, session: SESSIONS.admin }; // 身份来源说是管理员的人
  const now = new Date().toISOString();
  db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)').run(HOST, 'https://node-mig.synthetic.invalid', 'zone1', now, now);
  // 团队归属绑节点（根地址 + 完整指纹）：这个根地址要在对端登记里、启用、有指纹（合成的）
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES (?, ?, 'zone1', '', 'active', ?, 'seed', '0', '0') ON CONFLICT(root_url) DO UPDATE SET status = 'active', key_fingerprint = CASE WHEN a2a_peers.key_fingerprint = '' THEN excluded.key_fingerprint ELSE a2a_peers.key_fingerprint END").run(`peer-${HOST}`, 'https://node-mig.synthetic.invalid', `sha256:${String(HOST).padEnd(64, '0')}`);
  const seatIns = db.prepare('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)');
  seatIns.run(HOST, TEAM, 'zone1/0000001a', 'seat-0000001a', '合成总工', 'router', now, now);
  seatIns.run(HOST, TEAM, MEMBER.seat, MEMBER.seat_id, '合成成员', 'member', now, now);
  seatIns.run(HOST, OTHER, 'zone1/0000001c', 'seat-0000001c', '合成别队总工', 'router', now, now);
  seatIns.run(HOST, THIRD, 'zone1/0000001d', 'seat-0000001d', '合成第三队总工', 'router', now, now);
  // 部门和团队由属主（本机命令行）建好：TEAM 认领到 sales，负责人 alpha
  await srv.call('PUT', '/api/departments/sales', { body: { name: '合成销售部' } });
  await srv.call('PUT', '/api/departments/ops', { body: { name: '合成运营部' } });
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta]) await srv.call('GET', '/api/auth/viewer', { session: s });
  await srv.call('POST', '/api/teams/claim', { body: { host: HOST, team: TEAM, department: 'sales' } });
  await srv.call('POST', '/api/teams/leads', { body: { host: HOST, team: TEAM, principal: 'user:alpha' } });

  // 让比对第一次见到身份来源的管理员：读一个管理面、一个业务读面
  await srv.call('GET', '/api/principals', asRoot);
  await srv.call('GET', '/api/teams', asRoot);
  await sleep(400);
  await srv.call('GET', '/api/judgment/compare'); // 取一次报告：把攒着的比对记账写掉

  // ---------- 一、迁出来的只有 member、admin ----------
  {
    const migrated = ((await srv.call('GET', '/api/grants?source=migration&principal=user:root-admin')).json?.grants ?? []).map((g) => `${g.role}:${g.status}`).sort();
    const mgmt = db.prepare("SELECT COUNT(*) AS n FROM grants WHERE principal_id = 'user:root-admin' AND role = 'management' AND status = 'active'").get().n;
    check(show(migrated) === show(['admin:active', 'member:active']) && mgmt === 0,
      '身份来源的管理员第一次被见到：迁出来的只有 member、admin，没有任何生效的 management（管理层由属主单独授，L6）', show({ migrated, mgmt }));
  }
  const seat = { host: HOST, team: TEAM, seat: MEMBER.seat, seat_id: MEMBER.seat_id };
  // ---------- 二、团队分配、收回：系统管理员不代办 ----------
  const assign = await srv.call('POST', '/api/teams/assign', { ...asRoot, body: { ...seat, principal: 'user:beta' } });
  const unassign = await srv.call('POST', '/api/teams/unassign', { ...asRoot, body: seat });
  check(assign.status === 403 && assign.json?.error === 'not_team_lead' && unassign.status === 403 && unassign.json?.error === 'not_team_lead'
    && db.prepare('SELECT COUNT(*) AS n FROM seat_assignments').get().n === 0,
    '团队分配、收回：身份来源的管理员仍回 403 not_team_lead（系统管理员不代办），没有写分配', show({ assign: [assign.status, assign.json?.error], unassign: [unassign.status, unassign.json?.error] }));
  // ---------- 三、认领团队：走提议 ----------
  const claim = await srv.call('POST', '/api/teams/claim', { ...asRoot, body: { host: HOST, team: OTHER, department: 'ops' } });
  const claimed = db.prepare('SELECT claimed FROM teams WHERE host = ? AND team = ?').get(HOST, OTHER)?.claimed ?? 0;
  check(claim.status === 202 && claim.json?.proposed === true && !claimed,
    '认领团队：身份来源的管理员仍然只能提议（202），团队没有直接认领', show({ claim: [claim.status, claim.json], claimed }));
  // ---------- 四、数据视图：进不去 ----------
  const bench = await srv.call('POST', '/api/bench-views', { ...asRoot, body: { slug: 'wm-mig-probe', title: '合成台' } });
  check(bench.status === 403 && bench.json?.error === 'bench_views_forbidden',
    '数据视图：身份来源的管理员仍然进不去（403 bench_views_forbidden），台没有登记', show({ bench: [bench.status, bench.json?.error] }));

  // ---------- 五、对照：属主单独授了 management 之后，同一个人都放行 ----------
  {
    const d = await srv.call('POST', '/api/grants', { body: { principal: 'user:root-admin', role: 'management', scope: '*', reason: '合成：属主单独授管理层' } });
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    const ap = await srv.call('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const assign2 = await srv.call('POST', '/api/teams/assign', { ...asRoot, body: { ...seat, principal: 'user:beta' } });
    const unassign2 = await srv.call('POST', '/api/teams/unassign', { ...asRoot, body: seat });
    const claim2 = await srv.call('POST', '/api/teams/claim', { ...asRoot, body: { host: HOST, team: THIRD, department: 'ops' } });
    const bench2 = await srv.call('POST', '/api/bench-views', { ...asRoot, body: { slug: 'wm-mig-probe', title: '合成台' } });
    check(ap.status === 200 && assign2.status === 201 && unassign2.status === 200 && claim2.status === 200 && bench2.status === 201,
      '对照：属主单独授了 management 之后，同一个人能分配、收回，认领直接落，能登记数据视图——前面的拒绝都是因为没有管理层授予',
      show({ ap: ap.status, assign2: assign2.status, unassign2: unassign2.status, claim2: [claim2.status, claim2.json], bench2: [bench2.status, bench2.json?.error] }));
  }
  db.close();
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await sleep(500); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`judgment-migration-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
