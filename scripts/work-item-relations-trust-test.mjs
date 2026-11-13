#!/usr/bin/env node
/**
 * 等关系确认制（规范 14「关系由谁说了算」）：只凭系统管理员身份写下的关系，不能让人看到事项。
 *
 *   系统管理员（管理口令）把一个人指成团队的负责人、把一个成员分给另一个人之后，
 *   在业务侧点头之前，这两人在「我团队的」「我的 AI 员工手上的」视角里都没有别人的事项，详情都是 404。
 *
 *   管理口令把团队认领到一个部门、只记成提议时，那个部门的负责人不算这个团队的负责人，看不到它的事项。
 *   对照：属主确认了负责人的提议、负责人把成员分给他之后，两人都看得到（证明上面不是因为别的原因看不到）。
 * 依赖身份线的关系确认制（#638）：管理口令指负责人只记成提议，分配成员系统管理员不能代办。
 *
 *   node scripts/work-item-relations-trust-test.mjs              测本仓库
 *   node scripts/work-item-relations-trust-test.mjs --root DIR   测另一棵目录树
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `work-item-relations-trust-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'relations-trust-synthetic-admin';
const { SESSIONS } = await import('./identity-fake-provider.mjs');
const HOST = 'a1b2c3d4', PEER = 'http://peer.synthetic.invalid', TEAM = 'zone1/canvas/Team A', TEAM2 = 'zone1/canvas/Team B';
const MEMBER = { seat: 'zone1/0000000b', seat_id: 'seat-0000000b' };

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null, log = '';
try {
  const data = join(OUT, 'data'), home = join(OUT, 'home');
  for (const d of [data, home, join(OUT, 'ext')]) mkdirSync(d, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, DATA_DIR: data, NODE_ENV: 'test', ADMIN_TOKEN, REDIS_URL: '', MCP_GATEWAY: 'on', WM_CONTROL_PORT: '0', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: join(OUT, 'ext'), MARKET_PUBLIC_URL: 'http://market.synthetic.invalid' };
  // 一件 zeta 建、交给团队 A 的事项
  const seed = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
    const ev = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/workbench-events.ts')).href)});
    const { root } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/root-context.ts')).href)});
    const { WorkItemService, itemIdForEvent } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/services/work-item.ts')).href)});
    ev.initWorkbenchEvents();
    await root.plugin(WorkItemService);
    const items = root.get('workItems');
    const b = db.prepare("INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, created_by) VALUES ('sop', 'task-center', ?, 'notify', 'read', ?, 'seed')");
    b.run(${JSON.stringify(TEAM)}, ${JSON.stringify(PEER)}); b.run(${JSON.stringify(TEAM2)}, ${JSON.stringify(PEER)});
    const mk = (team) => {
      const id = Number(db.prepare("INSERT INTO tasks (title, status) VALUES ('合成：团队的事', 'published')").run().lastInsertRowid);
      const f = { title: '合成：团队的事', intent: 'i', references: '', deliverable: 'd', target: '', due: '' };
      db.exec('BEGIN IMMEDIATE');
      const e = ev.recordTaskCenterEvent({ id, data: f, stepValue: (k) => f[k], publishedBy: 'x', requesterPrincipal: 'user:zeta', publisherPrincipal: 'user:zeta', templateVersion: 1, materialSha256: 'h', agentDispatch: false, centerOn: false, arranged: { team, submitter: 'user:zeta' } });
      db.exec('COMMIT');
      items.syncEvent(e);
      return itemIdForEvent(e);
    };
    console.log('SEEDED ' + JSON.stringify({ item: mk(${JSON.stringify(TEAM)}), item2: mk(${JSON.stringify(TEAM2)}) }));
    process.exit(0);`], { env, encoding: 'utf8' });
  const m = /SEEDED (.*)/.exec(seed.stdout);
  if (!m) throw new Error(`造数据失败：${seed.stderr.slice(-800)}`);
  const I = JSON.parse(m[1]);
  const port = await freePort();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], { cwd: join(ROOT, 'server'), env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { log += String(d); }); child.stderr.on('data', (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0, ok = false; !ok; i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`实例没起来：${log.slice(-800)}`);
    try { ok = (await fetch(`${base}/api/health`)).status === 200; } catch { /* 还没起来 */ }
    if (!ok) await new Promise((r) => setTimeout(r, 200));
  }
  const call = async (method, path, headers, json) => {
    const r = await fetch(base + path, { method, headers: { ...headers, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
    let body = null; try { body = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, body };
  };
  const SAME = { 'sec-fetch-site': 'same-origin' };
  const ADMIN = { ...SAME, 'x-admin-token': ADMIN_TOKEN };
  const WHO = { 被指成负责人的: { ...SAME, cookie: `session_id=${SESSIONS.beta}` }, 被分到成员的: { ...SAME, cookie: `session_id=${SESSIONS.noAdminFlag}` }, 部门负责人: { ...SAME, cookie: `session_id=${SESSIONS.alpha}` } };
  for (const h of Object.values(WHO)) await call('GET', '/api/auth/me', h);
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
    const now = Date.now();
    db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at, key_fingerprint) VALUES (?1, ?2, ?3, ?4, ?5, char(115, 104, 97, 50, 53, 54, 58) || substr(?1 || hex(zeroblob(32)), 1, 64))').run(HOST, PEER, 'zone1', new Date(now).toISOString(), new Date(now).toISOString());
    const seatIns = db.prepare('INSERT INTO a2a_roster_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ((SELECT peer_root FROM a2a_rosters WHERE host = ?1 ORDER BY rowid LIMIT 1), (SELECT key_fingerprint FROM a2a_rosters WHERE host = ?1 ORDER BY rowid LIMIT 1), ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, ?7, ?8)');
    seatIns.run(HOST, TEAM, 'zone1/0000000a', 'seat-0000000a', '合成总工', 'router', now, now);
    seatIns.run(HOST, TEAM, MEMBER.seat, MEMBER.seat_id, '合成成员', 'member', now, now);
    seatIns.run(HOST, TEAM2, 'zone1/0000000d', 'seat-0000000d', '合成别队总工', 'router', now, now);
    db.close();
  }
  // 部门（不指部门负责人）、团队认领由属主（本机命令行）做，直接生效：团队已认领、没有负责人
  const dept = await call('PUT', '/api/departments/ops', {}, { name: '合成部门' });
  const claim = await call('POST', '/api/teams/claim', {}, { host: HOST, team: TEAM, department: 'ops' });
  // 只用系统管理员身份（管理口令）写带权限的关系：指负责人、分配成员
  const lead = await call('POST', '/api/teams/leads', ADMIN, { host: HOST, team: TEAM, principal: 'user:beta' });
  const assign = await call('POST', '/api/teams/assign', ADMIN, { host: HOST, team: TEAM, ...MEMBER, principal: 'user:no-flag' });
  check(dept.status === 201 && claim.status === 200 && lead.status === 202 && lead.body?.proposed === true && assign.status === 403,
    '管理口令指负责人只记成提议（202，待确认）；分配成员系统管理员不能代办（403）', show({ dept: dept.status, claim: claim.status, lead: [lead.status, lead.body?.proposal?.status], assign: assign.status }));
  {
    const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
    db.prepare('UPDATE work_items SET seat = ?, seat_id = ?, seat_at = ? WHERE id = ?').run(MEMBER.seat, MEMBER.seat_id, sqlTime(Date.now() + 2000), I.item);
    db.close();
  }
  const lst = (h, v) => call('GET', `/api/work-items?view=${v}`, h);
  const has = (r) => (r.body?.items ?? []).some((x) => x.id === I.item);
  {
    const t = await lst(WHO.被指成负责人的, 'team'), d = await call('GET', `/api/work-items/${I.item}`, WHO.被指成负责人的);
    check(!has(t) && d.status === 404, '系统管理员指成负责人、业务侧没点头：「我团队的」里没有这个团队的事项，详情 404', show({ team: t.status, n: (t.body?.items ?? []).length, d: d.status }));
  }
  {
    const s = await lst(WHO.被分到成员的, 'seats'), d = await call('GET', `/api/work-items/${I.item}`, WHO.被分到成员的);
    check(!has(s) && d.status === 404, '系统管理员把成员分给他、业务侧没点头：「我的 AI 员工手上的」里没有这个成员接手的事项，详情 404', show({ seats: s.status, n: (s.body?.items ?? []).length, d: d.status }));
  }
  // ---------- 团队认领只是提议：接收部门的负责人不算这个团队的负责人 ----------
  const dept2 = await call('PUT', '/api/departments/sales2', {}, { name: '合成部门二', lead: 'user:alpha' });
  const claim2 = await call('POST', '/api/teams/claim', ADMIN, { host: HOST, team: TEAM2, department: 'sales2' });
  {
    const t = await lst(WHO.部门负责人, 'team'), d = await call('GET', `/api/work-items/${I.item2}`, WHO.部门负责人);
    const has2 = (r) => (r.body?.items ?? []).some((x) => x.id === I.item2);
    check(dept2.status === 201 && claim2.status === 202 && !has2(t) && d.status === 404, '管理口令把团队认领到部门、只是提议：接收部门的负责人「我团队的」里没有它的事项，详情 404', show({ dept2: dept2.status, claim2: claim2.status, t: t.status, has: has2(t), d: d.status }));
    const ok2 = await call('POST', `/api/relations/proposals/${claim2.body?.proposal?.id}/approve`, {}, {}); // 属主确认（谁能确认由 #638 判，这里只要一条已确认的认领）
    const t2 = await lst(WHO.部门负责人, 'team'), d2 = await call('GET', `/api/work-items/${I.item2}`, WHO.部门负责人);
    check(ok2.status === 200 && has2(t2) && d2.status === 200, '对照：认领确认之后，接收部门的负责人「我团队的」里有、详情 200', show({ ok2: [ok2.status, ok2.body?.error], has: has2(t2), d2: d2.status }));
  }
  // ---------- 对照：属主确认、负责人分配之后，两人都看得到 ----------
  {
    const ok = await call('POST', `/api/relations/proposals/${lead.body?.proposal?.id}/approve`, {}, {});
    const as = await call('POST', '/api/teams/assign', WHO.被指成负责人的, { host: HOST, team: TEAM, ...MEMBER, principal: 'user:no-flag' });
    // 分配在接手之前（seat_at 是两秒后），左闭右开归这次分配
    const t = await lst(WHO.被指成负责人的, 'team'), d1 = await call('GET', `/api/work-items/${I.item}`, WHO.被指成负责人的);
    const s2 = await lst(WHO.被分到成员的, 'seats'), d2 = await call('GET', `/api/work-items/${I.item}`, WHO.被分到成员的);
    check(ok.status === 200 && as.status >= 200 && as.status < 300 && has(t) && d1.status === 200 && has(s2) && d2.status === 200,
      '对照：属主确认负责人、负责人把成员分给他之后，「我团队的」「我的 AI 员工手上的」里有、详情 200', show({ ok: ok.status, as: as.status, t: has(t), d1: d1.status, s: has(s2), d2: d2.status }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 跑不下去：${e?.stack ?? e}`);
  if (log) console.log(log.split('\n').filter((l) => !l.includes('self-probe')).slice(-30).join('\n'));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
