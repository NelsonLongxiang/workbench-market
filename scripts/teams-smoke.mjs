#!/usr/bin/env node
/**
 * 团队与分配（规范 14 第 1 步）的对抗组。真实的 server/src/index.ts，身份来源是假提供方（identity-fake-provider.mjs），
 * 名册直接往库里种（名册是节点报的事实，经 HTTP 只能由节点签名推送），只在 127.0.0.1 上，不访问任何外部系统。
 *
 *   一、待认领的团队只有管理员看得到；认领要管理员，挂的部门要存在，团队要在名册里；写法不对的拒
 *   二、状态在读的时候推：认领后部门负责人自动是团队负责人（正常）；部门负责人清掉、又没另外指定的 → 负责人缺位
 *   三、负责人：另外指定、最后一个不能直接移除、部门负责人跟着部门走（不能在团队上移除）
 *   四、分配：负责人能分、别的员工不能；总工不能分；同一席位同时只有一条生效；没 seat_id 的旧席位按句柄认；
 *       远程匿名、跨站都拒；收回之后再分，起止时间对得上（那时归谁查得到）
 *   五、可见范围：部门的人、负责人、被分到成员的人看得到；不相干的人看不到；管理层授予看全部认领的
 *   六、「我的 AI 员工」；读接口只给团队、人和计数，不带事项内容
 *   七、退回待认领：另外指定的负责人和生效的分配一起结束；有团队挂着的部门不能删
 *   八、关系函数（人和席位都答）：dept-member、dept-lead、team-lead、seat-owner、team-seat、router，另带显示用的名字
 *   八之二、别队的负责人冒用本队席位的 seat_id 或句柄，动不了本队的分配
 *   九、每一步留痕
 *
 *   node scripts/teams-smoke.mjs
 */
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `teams-smoke-${process.pid}-${Date.now().toString(36)}`);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;
const ADMIN_TOKEN = 'synthetic-teams-admin';
const REMOTE = { 'x-forwarded-for': '192.0.2.81' };
const token = { ...REMOTE, 'x-admin-token': ADMIN_TOKEN };
const HOST = 'a1b2c3d4';
const TEAM = 'zone1/canvas/Sales Team';
const OTHER = 'zone1/canvas/Other';
const ROUTER = { seat: 'zone1/0000000a', seat_id: 'seat-0000000a' };
const MEMBER = { seat: 'zone1/0000000b', seat_id: 'seat-0000000b' };
const LEGACY = { seat: 'zone1/0000000c', seat_id: '' };

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
  Object.assign(env, { HOME: home, PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: data, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN, REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT, WM_EXTENSIONS_DIR: ext });
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
    return { status: res.status, text, json };
  };
  return { base, host: new URL(base).host, call, log: () => log };
}

try {
  const srv = await boot();
  const db = new DatabaseSync(join(data, 'workbench-market.db'), { timeout: 5000 });
  const same = { origin: `http://${srv.host}`, 'sec-fetch-site': 'same-origin' };
  const as = (s) => ({ headers: { ...REMOTE, ...same }, session: s });
  for (const s of [SESSIONS.admin, SESSIONS.alpha, SESSIONS.beta, SESSIONS.noAdminFlag]) await srv.call('GET', '/api/auth/viewer', { session: s });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)').run(HOST, 'https://node.synthetic.invalid', 'zone1', now, now);
  // 对端登记表里这个节点的名字（团队页显示「来自 某节点」，不显示节点标识）
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, registered_by, registered_at, updated_at) VALUES ('peer-syn', 'https://node.synthetic.invalid', 'zone1', '合成节点', 'active', 'cli', ?, ?)").run(String(now), String(now));
  const seatIns = db.prepare('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)');
  seatIns.run(HOST, TEAM, ROUTER.seat, ROUTER.seat_id, '合成总工', 'router', now, now);
  seatIns.run(HOST, TEAM, MEMBER.seat, MEMBER.seat_id, '合成成员甲', 'member', now, now);
  seatIns.run(HOST, TEAM, LEGACY.seat, '', '合成成员乙', 'member', now, now);
  seatIns.run(HOST, OTHER, 'zone1/0000000d', 'seat-0000000d', '合成别队', 'router', now, now);
  seatIns.run(HOST, OTHER, 'zone1/0000000e', 'seat-0000000e', '合成别队成员', 'member', now, now);
  db.exec("INSERT INTO work_items (id, title, created_by, creator_principal, source_kind, seat) VALUES ('wi_team_canary', 'CANARY-TEAM-ITEM-TITLE', 'user:alpha', 'user:alpha', 'agent', 'zone1/0000000b')");
  // 部门：sales，负责人 beta，成员 alpha
  await srv.call('PUT', '/api/departments/sales', { body: { name: '合成销售部', lead: 'user:beta' } }); // 属主（本机命令行）指定部门负责人
  await srv.call('PUT', '/api/departments/sales/members/user:alpha', { headers: token });
  await srv.call('PUT', '/api/departments/ops', { headers: token, body: { name: '合成运营部' } });
  const team = { host: HOST, team: TEAM };

  // ---------- 一、待认领、认领 ----------
  {
    const cli = await srv.call('GET', '/api/teams');
    const staff = await srv.call('GET', '/api/teams', as(SESSIONS.alpha));
    check(cli.status === 200 && cli.json?.unclaimed?.length === 2 && cli.json.unclaimed.every((t) => t.status === 'unclaimed' && t.node_name === '合成节点' && t.roster_received_at === new Date(now).toISOString()) && cli.json.departments.length === 0
      && staff.status === 200 && show(staff.json) === '{"roster_stale_minutes":60,"can":{"claim":false,"propose_claim":false,"release":false,"add_lead":false,"propose_lead":false,"manage_leads":false,"manage_departments":false},"departments":[]}',
      '待认领的团队只有管理员看得到（本机命令行看到两个，带节点在对端登记表里的名字和名册最近收到的时间），员工什么都看不到、连待认领那一栏都没有', show({ cli: cli.json?.unclaimed?.map((t) => t.team), staff: staff.json }));
    const denied = {
      staff: await srv.call('POST', '/api/teams/claim', { ...as(SESSIONS.alpha), body: { ...team, department: 'sales' } }),
      anonymous: await srv.call('POST', '/api/teams/claim', { headers: REMOTE, body: { ...team, department: 'sales' } }),
      crossToken: await srv.call('POST', '/api/teams/claim', { headers: { ...token, origin: 'https://elsewhere.example', 'sec-fetch-site': 'cross-site' }, body: { ...team, department: 'sales' } }),
    };
    const bad = {
      deptUnknown: [await srv.call('POST', '/api/teams/claim', { headers: token, body: { ...team, department: 'nope' } }), 422],
      notInRoster: [await srv.call('POST', '/api/teams/claim', { headers: token, body: { host: HOST, team: 'zone1/canvas/Ghost', department: 'sales' } }), 404],
      badHost: [await srv.call('POST', '/api/teams/claim', { headers: token, body: { host: 'A1B2C3D4', team: TEAM, department: 'sales' } }), 400],
      badTeam: [await srv.call('POST', '/api/teams/claim', { headers: token, body: { host: HOST, team: 'not-a-canvas', department: 'sales' } }), 400],
    };
    const deniedBad = Object.entries(denied).filter(([, r]) => r.status !== 403).map(([k, r]) => [k, r.status]);
    const badBad = Object.entries(bad).filter(([, [r, want]]) => r.status !== want).map(([k, [r, want]]) => [k, r.status, want]);
    const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n);
    // 口令管理员认领只记成提议（规范 14「关系由谁说了算」），团队仍是待认领；属主（本机命令行）直接认领
    const proposed = await srv.call('POST', '/api/teams/claim', { headers: token, body: { ...team, department: 'sales' } });
    const rowsAfterPropose = Number(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n);
    const ok = await srv.call('POST', '/api/teams/claim', { body: { ...team, department: 'sales' } });
    check(deniedBad.length === 0 && badBad.length === 0 && rows === 0 && proposed.status === 202 && proposed.json?.proposed === true && rowsAfterPropose === 0 && ok.status === 200 && ok.json?.changed === true,
      '认领要管理员（员工、远程匿名、带口令的跨站都 403）；部门不存在 422、团队不在名册 404、键写法不对 400，都没写进去；口令管理员认领只记成提议（202，团队没写进去）；属主认领成功', show({ deniedBad, badBad, rows, proposed: [proposed.status, proposed.json], rowsAfterPropose }));
  }

  // ---------- 二、状态在读的时候推 ----------
  const viewOf = async (who = {}) => { const r = await srv.call('GET', '/api/teams', who); return r.json?.departments?.flatMap((d) => d.teams).find((t) => t.host === HOST && t.team === TEAM); };
  {
    const t = await viewOf();
    check(t?.status === 'active' && show(t.leads) === show([{ principal: 'user:beta', display_name: t.leads[0]?.display_name, source: 'department' }]) && t.router?.seat === ROUTER.seat && t.members.length === 2 && t.name === 'Sales Team',
      '认领后：部门负责人 beta 自动是团队负责人（source=department），状态正常；总工单列，成员两个；团队名取画布名', show(t));
    await srv.call('PUT', '/api/departments/sales', { headers: token, body: { name: '合成销售部', lead: null } });
    const t2 = await viewOf();
    check(t2?.status === 'lead-vacant' && t2.leads.length === 0, '部门负责人清掉、又没另外指定的：负责人缺位', show({ status: t2?.status, leads: t2?.leads }));
  }

  // ---------- 三、负责人 ----------
  {
    const add = await srv.call('POST', '/api/teams/leads', { body: { ...team, principal: 'user:alpha' } }); // 属主（本机命令行）
    const again = await srv.call('POST', '/api/teams/leads', { body: { ...team, principal: 'user:alpha' } });
    const notPerson = await srv.call('POST', '/api/teams/leads', { headers: token, body: { ...team, principal: 'user:nobody' } });
    const lastLead = await srv.call('POST', '/api/teams/leads/remove', { headers: token, body: { ...team, principal: 'user:alpha' } });
    await srv.call('PUT', '/api/departments/sales', { body: { name: '合成销售部', lead: 'user:beta' } });
    const deptLead = await srv.call('POST', '/api/teams/leads/remove', { headers: token, body: { ...team, principal: 'user:beta' } });
    const staffAdd = await srv.call('POST', '/api/teams/leads', { ...as(SESSIONS.alpha), body: { ...team, principal: 'user:alpha' } });
    const t = await viewOf();
    check(add.status === 201 && again.status === 200 && again.json?.added === false && notPerson.status === 422
      && lastLead.status === 409 && lastLead.json?.error === 'last_lead' && deptLead.status === 409 && deptLead.json?.error === 'lead_from_department' && staffAdd.status === 403
      && t?.status === 'active' && show(t.leads.map((l) => [l.principal, l.source])) === show([['user:alpha', 'explicit'], ['user:beta', 'department']]),
      '负责人：另外指定 alpha（重复指定不重复记）；不是启用的人 422；最后一个负责人不能直接移除 409；部门负责人在团队上移除不了 409；员工不能指定 403',
      show({ add: add.status, lastLead: lastLead.json?.error, deptLead: deptLead.json?.error, staffAdd: staffAdd.status, leads: t?.leads }));
  }

  // ---------- 四、分配 ----------
  const t0 = Date.now();
  let tMid = 0;
  {
    const seatBody = (s, principal) => ({ ...team, seat: s.seat, seat_id: s.seat_id, ...(principal ? { principal } : {}) });
    const byLead = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.alpha), body: seatBody(MEMBER, 'user:beta') });
    const dup = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.alpha), body: seatBody(MEMBER, 'user:alpha') });
    const router = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.alpha), body: seatBody(ROUTER, 'user:beta') });
    const notPerson = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.alpha), body: seatBody(LEGACY, 'seat:x/y') });
    const notLead = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.noAdminFlag), body: seatBody(LEGACY, 'user:alpha') });
    const anon = await srv.call('POST', '/api/teams/assign', { headers: REMOTE, body: seatBody(LEGACY, 'user:alpha') });
    const cross = await srv.call('POST', '/api/teams/assign', { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: SESSIONS.alpha, body: seatBody(LEGACY, 'user:alpha') });
    const ghost = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.alpha), body: { ...team, seat: 'zone1/000000ff', seat_id: '', principal: 'user:beta' } });
    const legacy = await srv.call('POST', '/api/teams/assign', { ...as(SESSIONS.alpha), body: seatBody(LEGACY, 'user:alpha') });
    const active = Number(db.prepare('SELECT COUNT(*) AS n FROM seat_assignments WHERE ended_at IS NULL').get().n);
    check(byLead.status === 201 && dup.status === 409 && dup.json?.error === 'seat_assigned' && router.status === 422 && router.json?.error === 'router_not_assignable'
      && notPerson.status === 422 && notLead.status === 403 && notLead.json?.error === 'not_team_lead' && anon.status === 401 && cross.status === 403
      && ghost.status === 404 && legacy.status === 201 && active === 2,
      '分配：负责人 alpha 把成员甲分给 beta；同一席位再分 409；总工 422；分给非人 422；不是负责人 403；远程匿名 401；跨站 403；名册里没有的席位 404；没 seat_id 的旧席位按句柄能分；生效的正好两条',
      show({ byLead: byLead.status, dup: dup.status, router: router.status, notPerson: notPerson.status, notLead: notLead.status, anon: anon.status, cross: cross.status, ghost: ghost.status, legacy: legacy.status, active }));
    await sleep(5);
    const t1 = Date.now();
    tMid = t1;
    await sleep(5);
    const un = await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.alpha), body: seatBody(MEMBER) });
    const unAgain = await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.alpha), body: seatBody(MEMBER) });
    const re = await srv.call('POST', '/api/teams/assign', { body: seatBody(MEMBER, 'user:alpha') }); // 本机命令行（属主）
    const hist = db.prepare('SELECT principal_id, assigned_at, ended_at FROM seat_assignments WHERE host = ? AND seat_id = ? ORDER BY id').all(HOST, MEMBER.seat_id);
    const at = (ms) => { const h = hist.find((r) => r.assigned_at <= ms && (r.ended_at === null || r.ended_at > ms)); return h?.principal_id ?? null; };
    check(un.json?.removed === true && unAgain.json?.removed === false && re.status === 201 && hist.length === 2
      && at(t1) === 'user:beta' && at(Date.now()) === 'user:alpha' && at(t0 - 1000) === null && hist[0].ended_at <= hist[1].assigned_at,
      '收回再分：起止时间首尾相接；那时归谁按时间点查得到（收回前是 beta，现在是 alpha，分配之前谁都不是）；重复收回不报错', show(hist));
  }

  // ---------- 四之二、历史和关系（第 2 步的读接口）：按关系裁剪，读不到的按不存在回；不带事项内容 ----------
  const evq = (t) => `/api/teams/events?host=${encodeURIComponent(t.host)}&team=${encodeURIComponent(t.team)}`;
  const asq = (p, extra = '') => `/api/teams/assignments?principal=${encodeURIComponent(p)}${extra}`;
  {
    const ghostTeam = { host: HOST, team: 'zone1/canvas/Ghost' };
    const norm = (r) => ({ status: r.status, body: r.json });
    const cli = await srv.call('GET', evq(team));
    const byLead = await srv.call('GET', evq(team), as(SESSIONS.alpha));
    const byDeptLead = await srv.call('GET', evq(team), as(SESSIONS.beta));
    const stranger = norm(await srv.call('GET', evq(team), as(SESSIONS.noAdminFlag))), strangerGhost = norm(await srv.call('GET', evq(ghostTeam), as(SESSIONS.noAdminFlag)));
    const unclaimed = norm(await srv.call('GET', evq({ host: HOST, team: OTHER }), as(SESSIONS.alpha))), alphaGhost = norm(await srv.call('GET', evq(ghostTeam), as(SESSIONS.alpha)));
    const anon = await srv.call('GET', evq(team), { headers: REMOTE });
    const cross = await srv.call('GET', evq(team), { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: SESSIONS.alpha });
    const badHost = await srv.call('GET', evq({ host: 'A1B2C3D4', team: TEAM }), as(SESSIONS.alpha));
    const kinds = (cli.json?.events ?? []).map((e) => e.kind);
    const assignEv = (cli.json?.events ?? []).find((e) => e.kind === 'assign' && e.principal === 'user:beta');
    check(cli.status === 200 && ['claim', 'lead-add', 'assign', 'unassign'].every((k) => kinds.includes(k)) && assignEv?.principal_name && assignEv.actor_name && assignEv.actor_name !== assignEv.actor
      && byLead.status === 200 && byDeptLead.status === 200 && show(byLead.json) === show(cli.json)
      && stranger.status === 404 && show(stranger) === show(strangerGhost) && unclaimed.status === 404 && show(unclaimed) === show(alphaGhost)
      && anon.status === 401 && cross.status === 403 && badHost.status === 400 && !cli.text.includes('CANARY-TEAM-ITEM-TITLE'),
      '团队的变更记录：管理员、另外指定的负责人、经部门的负责人看得到（认领、负责人、分配、收回都在，带显示名）；不相干的人、负责人看待认领的别队，和不存在的团队一模一样 404；远程匿名 401；跨站 403；写法不对 400；不带事项内容',
      show({ kinds, assignEv, byLead: byLead.status, byDeptLead: byDeptLead.status, stranger, strangerGhost, unclaimed, anon: anon.status, cross: cross.status, badHost: badHost.status }));

    const self = await srv.call('GET', asq('user:beta'), as(SESSIONS.beta));
    const lead = await srv.call('GET', asq('user:beta'), as(SESSIONS.alpha));
    const strangerBeta = norm(await srv.call('GET', asq('user:beta'), as(SESSIONS.noAdminFlag))), strangerNobody = norm(await srv.call('GET', asq('user:nobody-synthetic'), as(SESSIONS.noAdminFlag)));
    const strangerSelf = await srv.call('GET', asq('user:no-flag'), as(SESSIONS.noAdminFlag));
    const adminAlpha = await srv.call('GET', asq('user:alpha'), { headers: token });
    const ranged = await srv.call('GET', asq('user:beta', `&from=${Date.now()}`), as(SESSIONS.beta));
    const badRange = await srv.call('GET', asq('user:beta', '&from=5&to=5'), as(SESSIONS.beta));
    const badFrom = await srv.call('GET', asq('user:beta', '&from=x'), as(SESSIONS.beta));
    const anonA = await srv.call('GET', asq('user:beta'), { headers: REMOTE });
    const seg = self.json?.assignments ?? [];
    check(self.status === 200 && seg.length === 1 && seg[0].seat_id === MEMBER.seat_id && seg[0].to !== null && seg[0].team_name === 'Sales Team'
      && lead.status === 200 && show(lead.json) === show(self.json) && strangerBeta.status === 404 && show(strangerBeta) === show(strangerNobody)
      && strangerSelf.status === 200 && strangerSelf.json?.assignments?.length === 0 && adminAlpha.status === 200 && adminAlpha.json?.assignments?.length === 2
      && ranged.status === 200 && ranged.json?.assignments?.length === 0 && badRange.status === 400 && badFrom.status === 400 && anonA.status === 401,
      '分配的历史：本人看自己的（收回过的那段带止时间）；负责人看自己团队里的那几段；不相干的人看别人，和不存在的人一模一样 404；看自己是空的；管理员看任何人；按时间段截；时间写法不对 400；远程匿名 401',
      show({ self: self.json, lead: lead.status, strangerBeta, strangerNobody, strangerSelf: strangerSelf.json, adminAlpha: adminAlpha.json?.assignments?.length, ranged: ranged.json, badRange: badRange.status, badFrom: badFrom.status, anonA: anonA.status }));

    // 「谁能做什么」页：带上团队这层关系（只增），不带事项内容；管理员看得到别人的关系
    const accA = await srv.call('GET', '/api/principals/user:alpha/access', as(SESSIONS.alpha));
    const accB = await srv.call('GET', '/api/principals/user:beta/access', { headers: token });
    const ra = accA.json?.relations, rb = accB.json?.relations;
    check(accA.status === 200 && show(ra?.departments) === show([{ id: 'sales', name: '合成销售部', member: true, lead: false }])
      && show(ra?.teams_led?.map((t) => [t.team, t.source, t.department?.id])) === show([[TEAM, 'explicit', 'sales']]) && ra?.members?.length === 2 && ra.members.every((m) => m.team === TEAM && m.team_name === 'Sales Team')
      && accB.status === 200 && rb?.departments?.[0]?.lead === true && show(rb?.teams_led?.map((t) => t.source)) === show(['department']) && rb?.members?.length === 0
      && !accA.text.includes('CANARY-TEAM-ITEM-TITLE') && !accB.text.includes('CANARY-TEAM-ITEM-TITLE'),
      '「谁能做什么」带上团队关系：alpha 是销售部成员、另外指定的负责人、手上两个成员；beta（管理员看）是部门负责人、经部门的负责人、手上没有成员（收回了）；不带事项内容',
      show({ ra, rb }));
  }

  // ---------- 五、可见范围 ----------
  {
    const alpha = await viewOf(as(SESSIONS.alpha));
    const beta = await viewOf(as(SESSIONS.beta));
    const stranger = await srv.call('GET', '/api/teams', as(SESSIONS.noAdminFlag));
    check(alpha?.status === 'active' && beta?.status === 'active' && show(stranger.json) === '{"roster_stale_minutes":60,"can":{"claim":false,"propose_claim":false,"release":false,"add_lead":false,"propose_lead":false,"manage_leads":false,"manage_departments":false},"departments":[]}',
      '可见范围：部门成员兼负责人 alpha、部门负责人 beta 看得到；不相干的人看不到', show({ stranger: stranger.json }));
    // 管理层授予：给 no-flag 一条 management，就看得到全部认领了的
    const d = await srv.call('POST', '/api/grants', { body: { principal: 'user:no-flag', role: 'management', scope: '*', reason: '合成：管理层' } });
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const mgmt = await srv.call('GET', '/api/teams', as(SESSIONS.noAdminFlag));
    check(mgmt.json?.departments?.[0]?.teams?.length === 1 && !('unclaimed' in (mgmt.json ?? {})), '管理层授予：看得到全部认领了的团队，看不到待认领那一栏', show(mgmt.json?.departments?.map((x) => x.id)));
    const mgEv = await srv.call('GET', evq(team), as(SESSIONS.noAdminFlag)), mgUnclaimed = await srv.call('GET', evq({ host: HOST, team: OTHER }), as(SESSIONS.noAdminFlag));
    const mgAs = await srv.call('GET', asq('user:beta'), as(SESSIONS.noAdminFlag));
    check(mgEv.status === 200 && mgUnclaimed.status === 404 && mgAs.status === 200 && mgAs.json?.assignments?.length === 1, '管理层授予之后：看得到认领了的团队的变更记录（待认领的照旧 404）、任何人的分配历史', show({ mgEv: mgEv.status, mgUnclaimed: mgUnclaimed.status, mgAs: mgAs.status }));
  }

  // ---------- 五之二、页面用的 can：和接口出自同一处判断 ----------
  {
    const teamOf = (r) => r.json?.departments?.flatMap((d) => d.teams)?.find((t) => t.team === team.team);
    const asAlpha = await srv.call('GET', '/api/teams', as(SESSIONS.alpha));
    const asMgmt = await srv.call('GET', '/api/teams', as(SESSIONS.noAdminFlag)); // 管理层授予，不是负责人：管理层能分配
    const asAdmin = await srv.call('GET', '/api/teams', { headers: token });
    const lead = teamOf(asAlpha), mgmtView = teamOf(asMgmt), adminView = teamOf(asAdmin);
    const seat = { ...team, seat: ROUTER.seat, seat_id: ROUTER.seat_id }; // 总工从不分配：收回只回「没有可收的」，不改状态
    const byLead = await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.alpha), body: seat });
    const byMgmt = await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.noAdminFlag), body: seat });
    const byAdmin = await srv.call('POST', '/api/teams/unassign', { headers: token, body: seat });
    const agree = [[lead, byLead], [mgmtView, byMgmt], [adminView, byAdmin]].every(([t, r]) => t && t.can_assign === (r.status === 200) && (t.can_assign || r.json?.message === t.assign_denied_text));
    check(agree && lead.can_assign === true && mgmtView.can_assign === true && adminView.can_assign === false && adminView.assign_denied_text?.includes('负责人或管理层') && !('assignable' in adminView)
      && Array.isArray(lead.assignable) && lead.assignable.some((p) => p.principal === 'user:alpha') && lead.assignable.every((p) => p.principal && 'display_name' in p)
      && show(asAlpha.json?.can) === show({ claim: false, propose_claim: false, release: false, add_lead: false, propose_lead: false, manage_leads: false, manage_departments: false })
      && show(asAdmin.json?.can) === show({ claim: false, propose_claim: true, release: true, add_lead: false, propose_lead: true, manage_leads: true, manage_departments: true }),
      '页面用的 can：负责人、管理层 can_assign 为真，收回 200；口令管理员（不是负责人、不是管理层）为假、说法和接口被拒时一致，收回 403；顶层 can：口令管理员认领、指定负责人只能提议，退回、移除负责人、管部门能做；员工全假',
      show({ lead: lead && [lead.can_assign, lead.assignable], mgmt: mgmtView && [mgmtView.can_assign, mgmtView.assign_denied_text], byLead: byLead.status, byMgmt: [byMgmt.status, byMgmt.json?.message], byAdmin: byAdmin.status, can: [asAlpha.json?.can, asAdmin.json?.can] }));
  }

  // ---------- 六、「我的 AI 员工」；不带事项内容 ----------
  {
    const mine = await srv.call('GET', '/api/teams/mine', as(SESSIONS.alpha));
    const list = await srv.call('GET', '/api/teams', as(SESSIONS.alpha));
    const memberA = list.json?.departments?.[0]?.teams?.[0]?.members?.find((m) => m.seat === MEMBER.seat);
    check(mine.status === 200 && show(mine.json.members.map((m) => m.seat).sort()) === show([MEMBER.seat, LEGACY.seat].sort()) && mine.json.teams.length === 1 && mine.json.teams[0].router?.seat === ROUTER.seat
      && memberA?.active_items === 1 && !list.text.includes('CANARY-TEAM-ITEM') && !mine.text.includes('CANARY-TEAM-ITEM'),
      '「我的 AI 员工」：分给我的两个成员，加上我负责的团队和它的总工；成员卡带在办几件（计数），事项内容一个字不出', show({ mine: mine.json, items: memberA?.active_items }));
  }

  // ---------- 八、关系函数 ----------
  {
    const script = `
      const { relationOf } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/team-relation.ts')).href)});
      // 旁路进程照正式启动装角色表（判「有没有这个部门的拍板授予」要看角色）
      { const { svc } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/context.ts')).href)});
        const roles = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/roles.ts')).href)});
        const { readFileSync } = await import('node:fs');
        const snap = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'surfaces/actions.json'))}, 'utf8'));
        const catalog = new Map();
        for (const line of snap.apps.flat()) { const m = /->\\s+([a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*)\\s+(read|write|decide|admin)/.exec(line); if (m) catalog.set(m[1], m[2]); }
        svc('grants').setRoles(roles.buildRoles(roles.orgRolesFromConfig().roles, catalog)); }
      const t = { host: '${HOST}', team: ${JSON.stringify(TEAM)} };
      const out = {
        alphaDept: relationOf({ principal: 'user:alpha' }, { department: 'sales' }).relations,
        betaTeam: relationOf({ principal: 'user:beta' }, { team: t }).relations,
        alphaSeat: relationOf({ principal: 'user:alpha' }, { seat: { ...t, seat: '${MEMBER.seat}', seat_id: '${MEMBER.seat_id}' } }),
        routerTeam: relationOf({ seat: { ...t, seat: '${ROUTER.seat}', seat_id: '${ROUTER.seat_id}' } }, { team: t }).relations,
        seatDept: relationOf({ seat: { ...t, seat: '${MEMBER.seat}', seat_id: '${MEMBER.seat_id}' } }, { department: 'sales' }).relations,
        seatOtherDept: relationOf({ seat: { ...t, seat: '${MEMBER.seat}', seat_id: '${MEMBER.seat_id}' } }, { department: 'ops' }).relations,
        stranger: relationOf({ principal: 'user:no-flag' }, { team: t }).relations,
        forgedSeat: relationOf({ principal: 'user:alpha' }, { seat: { host: '${HOST}', team: ${JSON.stringify(OTHER)}, seat: 'zone1/000000ee', seat_id: '${MEMBER.seat_id}' } }),
      };
      const { svc } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/context.ts')).href)});
      const seatK = { ...t, seat: '${MEMBER.seat}', seat_id: '${MEMBER.seat_id}' };
      out.ownerMid = svc('teams').ownerAt(seatK, ${tMid});
      out.ownerNow = svc('teams').ownerAt(seatK, Date.now());
      out.ownerBefore = svc('teams').ownerAt(seatK, ${t0 - 1000});
      out.attention = svc('teams').needingAttention().map((x) => [x.team, x.status]);
      const legacyK = { ...t, seat: '${LEGACY.seat}', seat_id: '' };
      out.batch = svc('teams').ownersAt([{ key: seatK, at: ${tMid} }, { key: seatK, at: Date.now() }, { key: seatK, at: ${t0 - 1000} }, { key: legacyK, at: Date.now() }, { key: { ...t, seat: 'zone1/000000ff', seat_id: '' }, at: Date.now() }]);
      out.histBeta = svc('teams').assignmentHistory('user:beta').map((h) => [h.seat, h.to === null]);
      out.histAlpha = svc('teams').assignmentHistory('user:alpha').map((h) => [h.seat, h.to === null]).sort();
      out.histBetaLater = svc('teams').assignmentHistory('user:beta', { from: Date.now() }).length;
      console.log('REL ' + JSON.stringify(out));
      process.exit(0);`;
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '' }, encoding: 'utf8', timeout: 60000 });
    const m = /REL (.*)/.exec(r.stdout ?? '');
    const o = m ? JSON.parse(m[1]) : null;
    const has = (arr, ...want) => want.every((w) => arr?.includes(w));
    check(!!o && has(o.alphaDept, 'dept-member') && has(o.betaTeam, 'dept-lead', 'team-lead') && has(o.alphaSeat.relations, 'seat-owner', 'team-lead', 'dept-member')
      && o.alphaSeat.display.team?.name === 'Sales Team' && o.alphaSeat.display.department?.name === '合成销售部' && o.alphaSeat.display.owner?.principal === 'user:alpha' && o.alphaSeat.display.leads.length === 2
      && JSON.stringify(o.attention) === JSON.stringify([[OTHER, 'unclaimed']]) && JSON.stringify(o.batch) === JSON.stringify(['user:beta', 'user:alpha', null, 'user:alpha', null])
      && JSON.stringify(o.histBeta) === JSON.stringify([[MEMBER.seat, false]]) && JSON.stringify(o.histAlpha) === JSON.stringify([[LEGACY.seat, true], [MEMBER.seat, true]].sort()) && o.histBetaLater === 0
      && o.ownerMid === 'user:beta' && o.ownerNow === 'user:alpha' && o.ownerBefore === null
      && has(o.routerTeam, 'team-seat', 'router') && has(o.seatDept, 'team-seat') && o.seatOtherDept.length === 0 && o.stranger.length === 0
      && !o.forgedSeat.relations.includes('seat-owner') && o.forgedSeat.display.owner === null,
      '关系函数：人（部门成员、部门负责人、团队负责人、成员的主人）和席位（团队的席位、总工、挂在部门下的团队的席位）都答；不相干的是空；报别队的队名、带本队席位的 seat_id 冒不出主人；带团队名、部门名、负责人和主人的显示名；服务的「那时归谁」（ownerAt）按时间点答对；「等你拍板」用的 needingAttention 只列不正常的团队（这时只有待认领的别队）；批量的 ownersAt 和逐条的答案一样（旧席位按句柄认），某人各段分配 assignmentHistory 带起止、按时间段筛',
      o ? show(o) : (r.stderr ?? '').slice(-600));
  }

  // ---------- 八之二、别队的负责人动不了本队的分配 ----------
  {
    // 别队 OTHER 认领到 ops，负责人 no-flag；成员甲（在 TEAM 下、现在分给 alpha）的 seat_id 拿去冒充
    await srv.call('POST', '/api/teams/claim', { body: { host: HOST, team: OTHER, department: 'ops' } });
    await srv.call('POST', '/api/teams/leads', { body: { host: HOST, team: OTHER, principal: 'user:no-flag' } });
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM seat_assignments WHERE ended_at IS NULL AND seat_id = ?').get(MEMBER.seat_id).n);
    const evBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM team_events').get().n);
    const forged = await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.noAdminFlag), body: { host: HOST, team: OTHER, seat: 'zone1/000000ee', seat_id: MEMBER.seat_id } });
    const forgedHandle = await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.noAdminFlag), body: { host: HOST, team: OTHER, seat: LEGACY.seat, seat_id: '' } });
    const after = Number(db.prepare('SELECT COUNT(*) AS n FROM seat_assignments WHERE ended_at IS NULL AND seat_id = ?').get(MEMBER.seat_id).n);
    const legacyActive = Number(db.prepare("SELECT COUNT(*) AS n FROM seat_assignments WHERE ended_at IS NULL AND seat = ? AND seat_id = ''").get(LEGACY.seat).n);
    const evAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM team_events').get().n);
    check(before === 1 && forged.status === 404 && forgedHandle.status === 404 && after === 1 && legacyActive === 1 && evAfter === evBefore,
      '别队的负责人冒用本队席位的 seat_id（或句柄）、报自己的队名去收回：404，本队的分配原样不动，也不记留痕',
      show({ forged: [forged.status, forged.json], forgedHandle: [forgedHandle.status, forgedHandle.json], before, after, legacyActive }));
    // 改派同样：冒用 seat_id 或句柄 404；席位换了队（名册里成员 e 现在在别队，本队还挂着它的一条旧分配）时，别队负责人也动不了本队那条分配
    const ins = db.prepare('INSERT INTO seat_assignments (host, team, seat, seat_id, principal_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(HOST, TEAM, 'zone1/0000000e', 'seat-0000000e', 'user:alpha', 'synthetic', Date.now());
    const evR = Number(db.prepare('SELECT COUNT(*) AS n FROM team_events').get().n);
    const rForged = await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.noAdminFlag), body: { host: HOST, team: OTHER, seat: 'zone1/000000ee', seat_id: MEMBER.seat_id, principal: 'user:no-flag' } });
    const rForgedHandle = await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.noAdminFlag), body: { host: HOST, team: OTHER, seat: LEGACY.seat, seat_id: '', principal: 'user:no-flag' } });
    const rMoved = await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.noAdminFlag), body: { host: HOST, team: OTHER, seat: 'zone1/0000000e', seat_id: 'seat-0000000e', principal: 'user:no-flag' } });
    const movedRows = db.prepare('SELECT team, principal_id, ended_at FROM seat_assignments WHERE host = ? AND seat_id = ?').all(HOST, 'seat-0000000e');
    const evR2 = Number(db.prepare('SELECT COUNT(*) AS n FROM team_events').get().n);
    db.prepare('DELETE FROM seat_assignments WHERE id = ?').run(ins.lastInsertRowid);
    check(rForged.status === 404 && rForgedHandle.status === 404 && rMoved.status === 404 && rMoved.json?.error === 'seat_not_in_team'
      && show(movedRows) === show([{ team: TEAM, principal_id: 'user:alpha', ended_at: null }]) && evR2 === evR
      && Number(db.prepare('SELECT COUNT(*) AS n FROM seat_assignments WHERE ended_at IS NULL AND seat_id = ?').get(MEMBER.seat_id).n) === 1,
      '改派也一样：别队负责人冒用 seat_id 或句柄 404；席位换了队、本队还挂着旧分配时，别队负责人改派 404 seat_not_in_team，本队那条原样不动、不记留痕',
      show({ rForged: [rForged.status, rForged.json?.error], rForgedHandle: [rForgedHandle.status, rForgedHandle.json?.error], rMoved: [rMoved.status, rMoved.json?.error], movedRows }));
    await srv.call('POST', '/api/teams/release', { headers: token, body: { host: HOST, team: OTHER } });
  }

  // ---------- 八之二之二、改派：一个事务里收回并分给另一个人 ----------
  {
    // 进来时：成员甲、旧席位都分给 alpha；alpha 是本队负责人，no-flag 有管理层授予（别队冒用的用例在八之二，那时别队还认领着）
    const body = (s, principal, t = team) => ({ ...t, seat: s.seat, seat_id: s.seat_id, principal });
    const rowsOf = (s) => db.prepare('SELECT id, principal_id, assigned_at, ended_at FROM seat_assignments WHERE host = ? AND team = ? AND seat = ? AND seat_id = ? ORDER BY id').all(HOST, TEAM, s.seat, s.seat_id);
    const evCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM team_events').get().n);
    const asgCount = () => Number(db.prepare('SELECT COUNT(*) AS n FROM seat_assignments').get().n);
    // 1) 拦在前面的：一律不写分配、不记留痕
    const ev0 = evCount(), asg0 = asgCount();
    const denied = {
      sysAdmin: await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.admin), body: body(MEMBER, 'user:beta') }),
      token: await srv.call('POST', '/api/teams/reassign', { headers: token, body: body(MEMBER, 'user:beta') }),
      anon: await srv.call('POST', '/api/teams/reassign', { headers: REMOTE, body: body(MEMBER, 'user:beta') }),
      cross: await srv.call('POST', '/api/teams/reassign', { headers: { ...REMOTE, 'sec-fetch-site': 'cross-site' }, session: SESSIONS.alpha, body: body(MEMBER, 'user:beta') }),
      router: await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: body(ROUTER, 'user:beta') }),
      notPerson: await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: body(MEMBER, 'seat:x/y') }),
      nobody: await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: body(MEMBER, 'user:nobody') }),
      ghost: await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: { ...team, seat: 'zone1/000000ff', seat_id: '', principal: 'user:beta' } }),
      badKey: await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: { ...team, seat: 'x', principal: 'user:beta' } }),
      // 别队已经退回待认领：属主（本机命令行）也改派不了它的成员
      unclaimed: await srv.call('POST', '/api/teams/reassign', { body: { host: HOST, team: OTHER, seat: 'zone1/0000000e', seat_id: 'seat-0000000e', principal: 'user:beta' } }),
    };
    const st = Object.fromEntries(Object.entries(denied).map(([k, r]) => [k, `${r.status}${r.json?.error ? ' ' + r.json.error : ''}`]));
    check(denied.sysAdmin.status === 403 && denied.token.status === 403 && denied.token.json?.error === 'not_team_lead' && denied.anon.status === 401 && denied.cross.status === 403
      && denied.router.status === 422 && denied.router.json?.error === 'router_not_assignable' && denied.notPerson.status === 422 && denied.nobody.status === 422 && denied.nobody.json?.error === 'assignee_not_person'
      && denied.ghost.status === 404 && denied.badKey.status === 400 && denied.unclaimed.status === 409 && denied.unclaimed.json?.error === 'team_not_claimed'
      && evCount() === ev0 && asgCount() === asg0 && rowsOf(MEMBER).filter((r) => r.ended_at === null).map((r) => r.principal_id).join() === 'user:alpha',
      '改派被拒的：系统管理员、管理口令 403；远程匿名 401；跨站 403；总工、非人、不存在的人 422；名册里没有的席位 404；键写法不对 400；待认领的团队 409——分配和留痕一条不多',
      show(st));
    // 2) 负责人把成员甲从 alpha 改派给 beta：旧段结束、新段开始在同一时刻，留痕一条收回加一条分配，都带 { reassign, from, to }
    const evA = evCount(), seqA = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM team_events').get().s);
    const r1 = await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: body(MEMBER, 'user:beta') });
    const rows1 = rowsOf(MEMBER), prev = rows1[rows1.length - 2], cur = rows1[rows1.length - 1];
    const ev1 = db.prepare('SELECT kind, principal_id, detail FROM team_events WHERE seq > ? ORDER BY seq').all(seqA);
    const want = show({ reassign: true, from: 'user:alpha', to: 'user:beta' });
    check(r1.status === 200 && r1.json?.changed === true && r1.json?.from === 'user:alpha' && r1.json?.id === cur.id
      && rows1.filter((r) => r.ended_at === null).length === 1 && cur.principal_id === 'user:beta' && cur.ended_at === null && prev.principal_id === 'user:alpha' && prev.ended_at === cur.assigned_at
      && evCount() === evA + 2 && ev1.map((e) => `${e.kind}:${e.principal_id}`).join() === 'unassign:user:alpha,assign:user:beta' && ev1.every((e) => show(JSON.parse(e.detail || 'null')) === want),
      '改派：一步办完，旧段的结束和新段的开始是同一时刻，生效的只有一条；留痕是一条收回（alpha）加一条分配（beta），detail 都带 { reassign, from, to }',
      show({ r1: [r1.status, r1.json], rows: rows1.slice(-2), ev: ev1 }));
    // 3) 改给现在的人：200 changed=false，什么都不写
    const evB = evCount(), asgB = asgCount();
    const same = await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.alpha), body: body(MEMBER, 'user:beta') });
    check(same.status === 200 && same.json?.changed === false && same.json?.from === 'user:beta' && evCount() === evB && asgCount() === asgB,
      '改给现在的人：200 changed=false，分配和留痕都不多', show(same.json));
    // 4) 现在没人分着：等同于分配（from 为 null，只记一条分配）；管理层（不是负责人）也能改派
    await srv.call('POST', '/api/teams/unassign', { ...as(SESSIONS.alpha), body: body(LEGACY) });
    const evC = evCount(), seqC = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM team_events').get().s);
    const fresh = await srv.call('POST', '/api/teams/reassign', { ...as(SESSIONS.noAdminFlag), body: body(LEGACY, 'user:alpha') });
    const evFresh = db.prepare('SELECT kind, detail FROM team_events WHERE seq > ? ORDER BY seq').all(seqC);
    check(fresh.status === 200 && fresh.json?.changed === true && fresh.json?.from === null && evCount() === evC + 1
      && evFresh.length === 1 && evFresh[0].kind === 'assign' && show(JSON.parse(evFresh[0].detail || 'null')) === show({ reassign: true, from: null, to: 'user:alpha' })
      && rowsOf(LEGACY).filter((r) => r.ended_at === null).map((r) => r.principal_id).join() === 'user:alpha',
      '现在没人分着：改派等同于分配，from 为 null、只记一条分配；管理层授予的人（不是负责人）也能改派', show({ fresh: [fresh.status, fresh.json], evFresh }));
    // 收尾：成员甲改回 alpha（后面的段落照「两个都分给 alpha」往下走）
    const back = await srv.call('POST', '/api/teams/reassign', { body: body(MEMBER, 'user:alpha') }); // 本机命令行（属主）
    check(back.status === 200 && back.json?.changed === true && back.json?.from === 'user:beta', '收尾：本机命令行把成员甲改派回 alpha', show(back.json));
  }

  // ---------- 八之三、关系由谁说了算：只有系统管理员身份的人造不出带来权限的关系 ----------
  {
    // 在本进程外读关系函数和服务（同一个数据目录）
    const inproc = (body) => {
      const script = `
        const { relationOf } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/team-relation.ts')).href)});
        const { svc } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/context.ts')).href)});
        const { db } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/db.ts')).href)});
        // 旁路进程照正式启动装角色表（判「有没有这个部门的拍板授予」要看角色）：动作清单取自 surfaces/actions.json
        { const roles = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/roles.ts')).href)});
          const { readFileSync } = await import('node:fs');
          const snap = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'surfaces/actions.json'))}, 'utf8'));
          const catalog = new Map();
          for (const line of snap.apps.flat()) { const m = /->\\s+([a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*)\\s+(read|write|decide|admin)/.exec(line); if (m) catalog.set(m[1], m[2]); }
          svc('grants').setRoles(roles.buildRoles(roles.orgRolesFromConfig().roles, catalog)); }
        const out = (() => { ${body} })();
        console.log('OUT ' + JSON.stringify(out)); process.exit(0);`;
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '' }, encoding: 'utf8' });
      const m = /OUT (.*)/.exec(r.stdout ?? '');
      return m ? JSON.parse(m[1]) : { error: (r.stderr ?? '').slice(-400) };
    };
    const tOther = { host: HOST, team: OTHER };
    const tMain = { host: HOST, team: TEAM };
    const asRoot = as(SESSIONS.admin); // 管理员登录（root-admin），只有系统管理员身份
    await srv.call('PUT', '/api/departments/qa', { body: { name: '合成质检部' } });
    const seatOther = { seat: 'zone1/0000000d', seat_id: 'seat-0000000d' }; // 别队在名册里的席位（开头铺的）
    const ownerBefore = inproc(`return svc('teams').ownerAt({ host: '${HOST}', team: ${JSON.stringify(TEAM)}, seat: '${MEMBER.seat}', seat_id: '${MEMBER.seat_id}' }, Date.now());`);
    // 1) 管理口令、管理员登录做那几样：认领、指定团队负责人、指定部门负责人、给自己分成员
    const claimTok = await srv.call('POST', '/api/teams/claim', { headers: token, body: { ...tOther, department: 'qa' } });
    const claimRoot = await srv.call('POST', '/api/teams/claim', { ...asRoot, body: { ...tOther, department: 'qa' } });
    const leadTok = await srv.call('POST', '/api/teams/leads', { headers: token, body: { ...tMain, principal: 'user:root-admin' } });
    const deptTok = await srv.call('PUT', '/api/departments/qa', { headers: token, body: { name: '合成质检部', lead: 'user:root-admin' } });
    await srv.call('PUT', '/api/departments/qa/members/user:root-admin', { headers: token }); // 部门成员表：管理员可写，只是组织信息
    const assignTok = await srv.call('POST', '/api/teams/assign', { headers: token, body: { ...tMain, seat: MEMBER.seat, seat_id: MEMBER.seat_id, principal: 'user:root-admin' } });
    const assignRoot = await srv.call('POST', '/api/teams/assign', { ...asRoot, body: { ...tMain, seat: ROUTER.seat, seat_id: ROUTER.seat_id, principal: 'user:root-admin' } });
    const after = inproc(`return {
      claimed: svc('teams').registration({ host: '${HOST}', team: ${JSON.stringify(OTHER)} })?.claimed ?? 0,
      rootTeam: relationOf({ principal: 'user:root-admin' }, { team: { host: '${HOST}', team: ${JSON.stringify(TEAM)} } }).relations,
      rootQa: relationOf({ principal: 'user:root-admin' }, { department: 'qa' }).relations,
      qaLead: svc('departments').get('qa')?.lead ?? null,
      seatQa: ${seatOther ? `relationOf({ seat: { host: '${HOST}', team: ${JSON.stringify(OTHER)}, seat: ${JSON.stringify(seatOther.seat)}, seat_id: ${JSON.stringify(seatOther.seat_id ?? '')} } }, { department: 'qa' }).relations` : '[]'},
      owner: svc('teams').ownerAt({ host: '${HOST}', team: ${JSON.stringify(TEAM)}, seat: '${MEMBER.seat}', seat_id: '${MEMBER.seat_id}' }, Date.now()),
    };`);
    check(claimTok.status === 202 && claimRoot.status === 202 && claimRoot.json?.proposal?.id === claimTok.json?.proposal?.id && leadTok.status === 202 && deptTok.json?.lead_proposal?.status === 'pending'
      && assignTok.status === 403 && assignRoot.status === 403 && after.claimed === 0 && !after.rootTeam?.includes('team-lead') && !after.rootQa?.includes('dept-lead')
      && after.qaLead === null && Array.isArray(after.seatQa) && after.seatQa.length === 0 && after.owner === ownerBefore && !!seatOther,
      '只有系统管理员身份（管理口令、管理员登录）：认领、指定团队负责人、指定部门负责人都只记成提议（同样的提议不重复记），分配成员 403；做完之后团队仍待认领、他不是负责人、席位不挂到部门、成员的主人没变（部门成员表照写，只是组织信息） [red-line:relations-need-confirmation]',
      show({ claimTok: claimTok.status, claimRoot: claimRoot.status, leadTok: leadTok.status, dept: deptTok.json?.lead_proposal, assignTok: [assignTok.status, assignTok.json?.error], assignRoot: assignRoot.status, after, ownerBefore }));
    // 1b) 页面看得到「待确认」：管理员的视图带上待确认的认领、团队负责人和等谁确认；员工的视图不带
    const adminView = await srv.call('GET', '/api/teams', { headers: token });
    const staffView = await srv.call('GET', '/api/teams', as(SESSIONS.alpha));
    const otherCard = adminView.json?.unclaimed?.find((t) => t.team === OTHER);
    const mainCard = adminView.json?.departments?.flatMap((d) => d.teams).find((t) => t.team === TEAM);
    const staffMain = staffView.json?.departments?.flatMap((d) => d.teams).find((t) => t.team === TEAM);
    check(otherCard?.pending_claim?.department === 'qa' && otherCard.pending_claim.confirm_by_text === '管理层或接收部门的负责人'
      && mainCard?.pending_leads?.some((p) => p.principal === 'user:root-admin' && p.confirm_by_text === '属主')
      && claimTok.json?.proposal?.confirm_by_text === '管理层或接收部门的负责人' && leadTok.json?.proposal?.confirm_by_text === '属主' && deptTok.json?.lead_proposal?.confirm_by_text === '属主（同时放行这个部门负责人的权限）'
      && staffMain && !('pending_leads' in staffMain),
      '页面用的「待确认」：管理员的视图里待认领的卡带待确认的认领、团队带待确认的负责人，都写等谁确认（认领等管理层或接收部门的负责人，负责人等属主）；提议的应答也带；员工的视图不带',
      show({ otherCard: otherCard?.pending_claim, mainPending: mainCard?.pending_leads, staff: staffMain && Object.keys(staffMain).filter((k) => k.startsWith('pending')) }));
    // 2) 谁能确认：认领要管理层或接收部门的负责人；负责人只有属主
    const pClaim = claimTok.json?.proposal?.id, pLead = leadTok.json?.proposal?.id, pDept = deptTok.json?.lead_proposal?.id;
    const listMgmt = await srv.call('GET', '/api/relations/proposals', as(SESSIONS.noAdminFlag));
    const listAlpha = await srv.call('GET', '/api/relations/proposals', as(SESSIONS.alpha));
    const attnMgmt = await srv.call('GET', '/api/attention', as(SESSIONS.noAdminFlag));
    const approve = (id, who) => srv.call('POST', `/api/relations/proposals/${id}/approve`, who);
    const tries = {
      claimByToken: await approve(pClaim, { headers: token }), claimByRoot: await approve(pClaim, asRoot), claimByAlpha: await approve(pClaim, as(SESSIONS.alpha)),
      leadByMgmt: await approve(pLead, as(SESSIONS.noAdminFlag)), deptByMgmt: await approve(pDept, as(SESSIONS.noAdminFlag)),
    };
    const seen = listMgmt.json?.proposals?.find((p) => p.id === pClaim);
    // 页面用的只增字段：mine（是不是看的人提的）、显示名（不露代号）
    const listTok = await srv.call('GET', '/api/relations/proposals', { headers: token });
    const tokClaim = listTok.json?.proposals?.find((p) => p.id === pClaim), tokDept = listTok.json?.proposals?.find((p) => p.id === pDept);
    const names = seen && { mine: seen.mine, team: seen.team_name, node: seen.node_name, dept: seen.department_name, by: seen.proposed_by_name };
    check(show(names) === show({ mine: false, team: 'Other', node: '合成节点', dept: '合成质检部', by: '管理员（口令）' })
      && tokClaim?.mine === true && tokDept?.mine === true && tokDept.principal_name === 'Synthetic root-admin' && tokDept.department_name === '合成质检部' && tokDept.decided_by_name === null
      && !show(seen).includes('"proposed_by_name":"admin-token"'),
      '提议列表给页面的：mine（管理层看口令提的是假，口令看自己提的是真）；团队、节点、部门、被提名的人、提议人都给显示名，口令说「管理员（口令）」；没处理的处理人为 null',
      show({ names, tokClaim: tokClaim?.mine, tokDept: tokDept && [tokDept.mine, tokDept.principal_name, tokDept.department_name, tokDept.decided_by_name] }));
    const claimByMgmt = await approve(pClaim, as(SESSIONS.noAdminFlag)); // 管理层（不是管理员）：经写请求总门的放行进来
    const leadByOwner = await approve(pLead, {}); // 属主（本机命令行）
    const deptByOwner = await approve(pDept, {});
    const confirmed = inproc(`return {
      claimed: svc('teams').registration({ host: '${HOST}', team: ${JSON.stringify(OTHER)} })?.department_id ?? null,
      rootTeam: relationOf({ principal: 'user:root-admin' }, { team: { host: '${HOST}', team: ${JSON.stringify(TEAM)} } }).relations,
      rootQa: relationOf({ principal: 'user:root-admin' }, { department: 'qa' }).relations,
    };`);
    const code = (r) => `${r.status}:${r.json?.error ?? r.json?.proposal?.status}`;
    check(show(Object.fromEntries(Object.entries(tries).map(([k, r]) => [k, code(r)]))) === show({ claimByToken: '403:business_confirm_required', claimByRoot: '404:proposal_missing', claimByAlpha: '404:proposal_missing', leadByMgmt: '404:proposal_missing', deptByMgmt: '404:proposal_missing' })
      && seen?.can_approve === true && !(listAlpha.json?.proposals ?? []).some((p) => p.id === pClaim) && (attnMgmt.json?.items ?? []).some((i) => i.source === 'relation-proposals' && i.source_id === String(pClaim) && i.link === '/team')
      && code(claimByMgmt) === '200:approved' && code(leadByOwner) === '200:approved' && code(deptByOwner) === '200:approved'
      && confirmed.claimed === 'qa' && confirmed.rootTeam?.includes('team-lead') && confirmed.rootQa?.includes('dept-lead'),
      '确认：认领要管理层或接收部门的负责人（提的人自己 403；只有系统管理员身份的登录、不相干的员工读不到，和不存在一样 404），负责人只有属主（管理层读不到，404）；管理层在列表和「等你拍板」里看得到、能确认；属主确认之后关系才生效',
      show({ tries: Object.fromEntries(Object.entries(tries).map(([k, r]) => [k, code(r)])), seen: seen && [seen.can_approve, seen.approve_denied_text], claimByMgmt: code(claimByMgmt), leadByOwner: code(leadByOwner), deptByOwner: code(deptByOwner), confirmed }));
    // 2b) 驳回只归能确认的人，提的人只能撤回自己提的；系统管理员不替业务驳回别人提的（管理口令、管理员登录都一样）
    {
      const reject = (id, who) => srv.call('POST', `/api/relations/proposals/${id}/reject`, { ...who, body: { reason: '合成' } });
      const pLeadRoot = (await srv.call('POST', '/api/teams/leads', { ...asRoot, body: { ...tMain, principal: 'user:beta' } })).json?.proposal?.id; // 管理员登录提的
      const pDeptTok = (await srv.call('PUT', '/api/departments/qa', { headers: token, body: { name: '合成质检部', lead: 'user:beta' } })).json?.lead_proposal?.id; // 口令提的
      const pMoveTok = (await srv.call('POST', '/api/teams/claim', { headers: token, body: { ...tOther, department: 'sales' } })).json?.proposal?.id; // 口令提的认领
      const rootList = (await srv.call('GET', '/api/relations/proposals', asRoot)).json?.proposals ?? [];
      const rootSees = rootList.filter((p) => p.status === 'pending').map((p) => p.id).sort();
      const rootLead = rootList.find((p) => p.id === pLeadRoot);
      const r = {
        tokRejectsRootLead: await reject(pLeadRoot, { headers: token }), rootRejectsTokDept: await reject(pDeptTok, asRoot), rootRejectsTokMove: await reject(pMoveTok, asRoot),
        rootWithdrawsOwn: await reject(pLeadRoot, asRoot), ownerRejectsDept: await reject(pDeptTok, {}), mgmtRejectsMove: await reject(pMoveTok, as(SESSIONS.noAdminFlag)),
      };
      const codes = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, `${v.status}:${v.json?.error ?? v.json?.proposal?.status}`]));
      check(show(codes) === show({ tokRejectsRootLead: '404:proposal_missing', rootRejectsTokDept: '404:proposal_missing', rootRejectsTokMove: '404:proposal_missing', rootWithdrawsOwn: '200:rejected', ownerRejectsDept: '200:rejected', mgmtRejectsMove: '200:rejected' })
        && show(rootSees) === show([pLeadRoot]) && rootLead?.mine === true && rootLead.can_reject === true && rootLead.can_approve === false,
        '驳回：系统管理员（管理口令、管理员登录）驳回别人提的负责人、认领提议：读不到，和不存在一样 404；撤回自己提的 200；能确认的人（属主对负责人、管理层对认领）驳回 200；管理员登录的列表里只看到自己提的那条（can_reject 是撤回、can_approve 假） [red-line:relations-need-confirmation]',
        show({ codes, rootSees, ids: { pLeadRoot, pDeptTok, pMoveTok }, rootLead: rootLead && [rootLead.mine, rootLead.can_reject, rootLead.can_approve] }));
      // 读不到的提议，确认、驳回、撤回的任何失败都和这条不存在时一模一样：不相干的人按 id 枚举，看不出有没有、是什么结局
      {
        const ghost = 999999;
        const norm = (x, id) => ({ status: x.status, body: JSON.parse(JSON.stringify(x.json ?? null).split(String(id)).join('N')) });
        const probes = [];
        // 每个人读不到的：员工什么都没提、没处理；管理员登录只提过 pLeadRoot；口令提了别的几条，读不到管理员登录提的那条
        const unreadable = [['员工', as(SESSIONS.alpha), [pClaim, pLead, pDept, pDeptTok, pMoveTok, pLeadRoot]], ['管理员登录', asRoot, [pClaim, pLead, pDept, pDeptTok, pMoveTok]], ['管理口令', { headers: token }, [pLeadRoot]]];
        for (const who of unreadable) {
          for (const [verb, call] of [['approve', approve], ['reject', reject]]) {
            const g0 = norm(await call(ghost, who[1]), ghost);
            for (const id of who[2]) {
              const got = norm(await call(id, who[1]), id);
              if (show(got) !== show(g0)) probes.push({ who: who[0], verb, id, got, g0 });
            }
          }
        }
        check(probes.length === 0, '读不到的提议（别人提、别人处理过的：驳回的、确认的）：确认、驳回对不相干的人回的和不存在的 id 一模一样，按 id 枚举看不出结局', show(probes));
      }
      // 驳回和别人的确认撞在一起：判过之后、写之前状态变了，驳回不能回成功、带出别人确认的结果
      {
        const raced = inproc(`
          const P = svc('relationProposals');
          const owner = { by: 'cli', principal: null, owner: true };
          const { id } = P.propose({ kind: 'team-lead', host: '${HOST}', team: ${JSON.stringify(TEAM)}, principal_id: 'user:gamma' }, { by: 'admin-token', principal: null, owner: false }, Date.now());
          const orig = P.rejectRefusal.bind(P);
          P.rejectRefusal = (p, a, n) => { const r = orig(p, a, n); db.prepare("UPDATE relation_proposals SET status = 'approved', decided_by = 'someone-else', decided_at = ? WHERE id = ?").run(Date.now(), id); return r; };
          const r = P.reject(id, owner, '合成：并发', Date.now());
          const row = P.get(id);
          db.prepare('DELETE FROM relation_proposals WHERE id = ?').run(id);
          return { ok: r.ok, http: r.http ?? null, code: r.code ?? null, status: row.status, decided_by: row.decided_by };`);
        check(raced.ok === false && raced.http === 409 && raced.code === 'state' && raced.status === 'approved' && raced.decided_by === 'someone-else',
          '驳回时状态已被别人改了（并发确认）：回 409，不回成功、不带出别人确认的结果，记录还是别人确认的那样', show(raced));
      }
      // 处理过的也按看的人裁剪：看自己提的、自己处理的；别人提、别人处理的不列（属主全看）
      const idsOf = async (who) => ((await srv.call('GET', '/api/relations/proposals', who)).json?.proposals ?? []).map((p) => p.id);
      const mgmtIds = await idsOf(as(SESSIONS.noAdminFlag)), rootIds = await idsOf(asRoot), ownerIds = await idsOf({});
      const has = (ids, id) => ids.includes(id);
      check(has(mgmtIds, pMoveTok) && !has(mgmtIds, pDeptTok) && !has(mgmtIds, pLeadRoot)
        && has(rootIds, pLeadRoot) && !has(rootIds, pDeptTok) && !has(rootIds, pMoveTok)
        && [pLeadRoot, pDeptTok, pMoveTok].every((id) => has(ownerIds, id)),
        '处理过的提议也按看的人裁剪：管理层看得到自己驳回的认领，看不到属主驳回的、管理员登录撤回的；管理员登录只看得到自己撤回的那条；属主全看',
        show({ mgmt: [pMoveTok, pDeptTok, pLeadRoot].map((id) => has(mgmtIds, id)), root: [pLeadRoot, pDeptTok, pMoveTok].map((id) => has(rootIds, id)), owner: [pLeadRoot, pDeptTok, pMoveTok].map((id) => has(ownerIds, id)) }));
    }
    // 3) 接收部门的负责人（dept:<部门> 有拍板授予）能确认挂到他部门的认领；没有授予的部门负责人（只在部门表里）不能
    const g = await srv.call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'dept-lead', scope: 'dept:ops', reason: '合成：ops 负责人' } });
    await srv.call('POST', `/api/grants/${g.json?.grant?.id}/submit`); await srv.call('POST', `/api/grants/${g.json?.grant?.id}/approve`);
    const move = await srv.call('POST', '/api/teams/claim', { headers: token, body: { ...tOther, department: 'ops' } });
    const byQaLead = await approve(move.json?.proposal?.id, as(SESSIONS.alpha)); // alpha 只在部门表里（sales 成员），没有 dept:ops 的拍板授予
    const byOpsLead = await approve(move.json?.proposal?.id, as(SESSIONS.beta));
    // 4) 现有管理员（系统管理员加管理层）照常一步做：给 root-admin 管理层，认领直接生效
    const mg = await srv.call('POST', '/api/grants', { body: { principal: 'user:root-admin', role: 'management', scope: '*', reason: '合成：迁移出来的管理员' } });
    await srv.call('POST', `/api/grants/${mg.json?.grant?.id}/submit`); await srv.call('POST', `/api/grants/${mg.json?.grant?.id}/approve`);
    const direct = await srv.call('POST', '/api/teams/claim', { ...asRoot, body: { ...tOther, department: 'qa' } });
    await srv.call('POST', `/api/grants/${mg.json?.grant?.id}/revoke`, { body: { reason: '合成：收回' } });
    await srv.call('POST', `/api/grants/${g.json?.grant?.id}/revoke`, { body: { reason: '合成：收回' } });
    check(move.status === 202 && code(byQaLead) === '404:proposal_missing' && code(byOpsLead) === '200:approved' && direct.status === 200 && direct.json?.changed === true,
      '接收部门的负责人（dept:ops 拍板授予）能确认挂到 ops 的认领，不相干的人不能；现有管理员（系统管理员加管理层）认领照常直接生效',
      show({ move: move.status, byQaLead: code(byQaLead), byOpsLead: code(byOpsLead), direct: [direct.status, direct.json] }));
    // 收尾：别队退回、root-admin 的负责人移除（后面几节按原来的状态测）
    await srv.call('POST', '/api/teams/leads/remove', { headers: token, body: { ...tMain, principal: 'user:root-admin' } });
    await srv.call('POST', '/api/teams/release', { headers: token, body: tOther });
  }

  // ---------- 八之四、名册停推进「等你拍板」 ----------
  {
    const fresh = await srv.call('GET', '/api/attention', { headers: token });
    db.prepare("UPDATE a2a_rosters SET received_at = '2000-01-01 00:00:00' WHERE host = ?").run(HOST); // 生产上的写法（SQLite 时刻）
    const asListed = (await srv.call('GET', '/api/teams')).json?.unclaimed?.[0]?.roster_received_at;
    const stale = await srv.call('GET', '/api/attention', { headers: token });
    const staff = await srv.call('GET', '/api/attention', as(SESSIONS.alpha));
    db.prepare('UPDATE a2a_rosters SET received_at = ? WHERE host = ?').run(now, HOST);
    const item = (r) => (r.json?.items ?? []).find((i) => i.source === 'team-health' && i.phase === 'roster-stale');
    check(asListed === '2000-01-01T00:00:00.000Z' && item(stale)?.link === '/team' && !item(fresh) && item(stale)?.title?.includes('合成节点') && item(stale)?.title?.includes('60 分钟') && !item(stale)?.title?.includes(HOST) && !item(staff),
      '名册超过阈值（缺省 60 分钟）没更新：进管理员的「等你拍板」，写节点名不写节点标识；新鲜的不列；员工看不到；库里的 SQLite 时刻给出去统一成 ISO',
      show({ fresh: !!item(fresh), stale: item(stale)?.title, staff: !!item(staff) }));
  }

  // ---------- 八之五、没人处理的提议失效（不是驳回）：目标不在了、超过期限；接口给 outcome 和原因；失效的留 7 天 ----------
  {
    const inproc = (body) => {
      const script = `
        const { svc } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/context.ts')).href)});
        // 旁路进程照正式启动装角色表（判「有没有这个部门的拍板授予」要看角色）：动作清单取自 surfaces/actions.json
        { const roles = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/roles.ts')).href)});
          const { readFileSync } = await import('node:fs');
          const snap = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'surfaces/actions.json'))}, 'utf8'));
          const catalog = new Map();
          for (const line of snap.apps.flat()) { const m = /->\\s+([a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*)\\s+(read|write|decide|admin)/.exec(line); if (m) catalog.set(m[1], m[2]); }
          svc('grants').setRoles(roles.buildRoles(roles.orgRolesFromConfig().roles, catalog)); }
        const out = (() => { ${body} })();
        console.log('OUT ' + JSON.stringify(out)); process.exit(0);`;
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '' }, encoding: 'utf8' });
      const m = /OUT (.*)/.exec(r.stdout ?? '');
      return m ? JSON.parse(m[1]) : { error: (r.stderr ?? '').slice(-400) };
    };
    await srv.call('PUT', '/api/departments/tmp', { body: { name: '合成临时部' } });
    const pGone = (await srv.call('PUT', '/api/departments/tmp', { headers: token, body: { name: '合成临时部', lead: 'user:beta' } })).json?.lead_proposal?.id;
    await srv.call('DELETE', '/api/departments/tmp'); // 部门删了：提议的目标不在了
    const pOld = (await srv.call('POST', '/api/teams/leads', { headers: token, body: { host: HOST, team: TEAM, principal: 'user:no-flag' } })).json?.proposal?.id;
    db.prepare('UPDATE relation_proposals SET proposed_at = ? WHERE id = ?').run(Date.now() - 20 * 86_400_000, pOld); // 20 天前提的
    const pLive = (await srv.call('POST', '/api/teams/claim', { headers: token, body: { host: HOST, team: OTHER, department: 'ops' } })).json?.proposal?.id;
    const pBack = (await srv.call('PUT', '/api/departments/sales', { headers: token, body: { name: '合成销售部', lead: 'user:no-flag' } })).json?.lead_proposal?.id;
    await srv.call('POST', `/api/relations/proposals/${pBack}/reject`, { headers: token, body: { reason: '合成：提错了' } }); // 提的人撤回
    const n = inproc('return svc("relationProposals").expireStale(Date.now());');
    const list = (await srv.call('GET', '/api/relations/proposals', { headers: token })).json?.proposals ?? [];
    const of = (id) => { const p = list.find((x) => x.id === id); return p && `${p.outcome}:${p.outcome_reason ?? ''}:${p.status}`; };
    const gone = list.find((x) => x.id === pGone);
    const got = { gone: of(pGone), old: of(pOld), live: of(pLive), back: of(pBack) };
    // 第一节口令提的认领（后来属主直接认领了同一个部门）也在这一轮失效：团队已经挂到这个部门了
    const satisfied = list.find((x) => x.outcome === 'expired' && x.outcome_reason === '团队已经挂到这个部门了' && x.team === TEAM);
    check(n === 3 && !!satisfied && show(got) === show({ gone: 'expired:部门已经不在了:rejected', old: 'expired:超过 14 天没人处理:rejected', live: 'pending::pending', back: 'withdrawn:合成：提错了:rejected' })
      && gone?.decided_by_name === '系统' && gone.can_reject === false && gone.can_approve === false,
      '没人处理的提议失效：部门删了、超过 14 天的、团队已经挂到要挂的部门的都失效（outcome expired，写原因，处理人说「系统」，没有按钮），还有效的照旧待确认；提的人撤回的是 withdrawn，和失效、驳回分开',
      show({ n, got, gone: gone && [gone.decided_by_name, gone.can_reject, gone.can_approve] }));
    db.prepare('UPDATE relation_proposals SET decided_at = ? WHERE id = ?').run(Date.now() - 8 * 86_400_000, pGone); // 失效 8 天了
    const later = (await srv.call('GET', '/api/relations/proposals', { headers: token })).json?.proposals ?? [];
    check(!later.some((x) => x.id === pGone) && later.some((x) => x.id === pOld),
      '失效的在提议人那里留 7 天：8 天前失效的不再列，刚失效的还在', show(later.map((x) => [x.id, x.outcome])));
    // 团队不在名册要「持续」才算：节点照常在报、这个团队连续不在超过 24 小时；短暂掉出又回来的不收；节点整个停推的只走总期限
    const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const change = db.prepare('INSERT INTO a2a_roster_changes (host, kind, team, seat, detail, at) VALUES (?, ?, ?, \'\', \'{}\', ?)');
    const otherSeat = db.prepare('SELECT * FROM a2a_roster_seats WHERE host = ? AND team = ?').all(HOST, OTHER);
    const dropOther = () => db.prepare('DELETE FROM a2a_roster_seats WHERE host = ? AND team = ?').run(HOST, OTHER);
    const restoreOther = () => { for (const r of otherSeat) db.prepare(`INSERT OR REPLACE INTO a2a_roster_seats (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r)); };
    const stateOf = (id) => db.prepare('SELECT status, reason FROM relation_proposals WHERE id = ?').get(id);
    const expire = () => inproc('return svc("relationProposals").expireStale(Date.now());');
    const t = Date.now();
    db.prepare('UPDATE a2a_rosters SET received_at = ? WHERE host = ?').run(sqlAt(t), HOST); // 节点照常在报
    dropOther(); change.run(HOST, 'team-removed', OTHER, sqlAt(t - 3600_000));
    expire(); const shortGone = stateOf(pLive).status;
    change.run(HOST, 'team-removed', OTHER, sqlAt(t - 30 * 3600_000)); change.run(HOST, 'team-added', OTHER, sqlAt(t - 3600_000)); restoreOther();
    expire(); const cameBack = stateOf(pLive).status;
    dropOther(); change.run(HOST, 'team-removed', OTHER, sqlAt(t - 25 * 3600_000));
    expire(); const longGone = stateOf(pLive);
    restoreOther(); change.run(HOST, 'team-added', OTHER, sqlAt(t));
    // 节点整个停推：另一个节点，名册很久没报，它名下的团队 48 小时前就不在了
    db.prepare("INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES ('b1b2b3b4', 'https://node-b.synthetic.invalid', 'zone2', '2000-01-01 00:00:00', '2000-01-01 00:00:00')").run();
    change.run('b1b2b3b4', 'team-removed', 'zone2/canvas/Gone', sqlAt(t - 48 * 3600_000));
    const pNode = Number(db.prepare("INSERT INTO relation_proposals (kind, host, team, department_id, proposed_by, proposed_at) VALUES ('team-claim', 'b1b2b3b4', 'zone2/canvas/Gone', 'ops', 'admin-token', ?)").run(t).lastInsertRowid);
    expire(); const nodeStale = stateOf(pNode).status;
    db.prepare('UPDATE relation_proposals SET proposed_at = ? WHERE id = ?').run(t - 20 * 86_400_000, pNode);
    expire(); const nodeStaleOld = stateOf(pNode);
    db.prepare("DELETE FROM a2a_rosters WHERE host = 'b1b2b3b4'").run();
    check(shortGone === 'pending' && cameBack === 'pending' && longGone.status === 'rejected' && longGone.reason === '团队已经不在节点名册里超过 24 小时'
      && nodeStale === 'pending' && nodeStaleOld.status === 'rejected' && nodeStaleOld.reason === '超过 14 天没人处理',
      '团队不在名册要持续才算：掉出一小时提议还在；掉出过 30 小时又回来提议还在；连续不在 25 小时失效；节点整个停推的，团队不在 48 小时也不收，只走 14 天的总期限',
      show({ shortGone, cameBack, longGone, nodeStale, nodeStaleOld }));
  }

  // ---------- 八之六、部门负责人：字段和授予一起落；字段单独不带来任何权力 ----------
  {
    const q = (sql, ...a) => db.prepare(sql).all(...a);
    // 旁路进程（同一个数据目录），照正式启动装角色表；noRoles 时角色表是空的（模拟部署方的 dept-lead 不能用）
    const sidecar = (body, noRoles = false) => {
      const at = (f) => JSON.stringify(pathToFileURL(join(ROOT, f)).href);
      const script = `
        const { svc } = await import(${at('server/src/context.ts')});
        const { db } = await import(${at('server/src/db.ts')});
        const { relationOf } = await import(${at('server/src/team-relation.ts')});
        const lead = await import(${at('server/src/services/dept-lead-grant.ts')});
        const { nameResolver } = await import(${at('server/src/attention-names.ts')});
        const roles = await import(${at('server/src/roles.ts')});
        const { readFileSync } = await import('node:fs');
        const snap = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'surfaces/actions.json'))}, 'utf8'));
        const catalog = new Map();
        for (const line of snap.apps.flat()) { const m = /->\\s+([a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*)\\s+(read|write|decide|admin)/.exec(line); if (m) catalog.set(m[1], m[2]); }
        svc('grants').setRoles(${noRoles ? 'new Map()' : 'roles.buildRoles(roles.orgRolesFromConfig().roles, catalog)'});
        const out = (() => { ${body} })();
        console.log('OUT ' + JSON.stringify(out)); process.exit(0);`;
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { cwd: join(ROOT, 'server'), env: { ...process.env, DATA_DIR: data, NODE_ENV: 'test', REDIS_URL: '' }, encoding: 'utf8' });
      const m = /OUT (.*)/.exec(r.stdout ?? '');
      return m ? JSON.parse(m[1]) : { error: (r.stderr ?? '').slice(-400) };
    };
    const tO = { host: HOST, team: OTHER }, seatE = { ...tO, seat: 'zone1/0000000e', seat_id: 'seat-0000000e' };
    const relAlpha = () => sidecar(`return relationOf({ principal: 'user:alpha' }, { team: { host: '${HOST}', team: ${JSON.stringify(OTHER)} } }).relations;`);
    const leadGrants = (who) => q("SELECT id, status FROM grants WHERE principal_id = ? AND role = 'dept-lead' AND scope = 'dept:eng' ORDER BY id", who);
    const tryAssign = async (who) => { const r = await srv.call('POST', '/api/teams/assign', { ...as(who), body: { ...seatE, principal: 'user:beta' } }); if (r.status === 201) await srv.call('POST', '/api/teams/unassign', { body: seatE }); return r.status; };
    const otherView = async (who) => (await srv.call('GET', '/api/teams', who === null ? {} : as(who))).json?.departments?.flatMap((d) => d.teams).find((t) => t.team === OTHER);

    await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发部' } });
    await srv.call('POST', '/api/teams/claim', { body: { ...tO, department: 'eng' } }); // 属主直接认领
    // 1) 系统管理员（管理口令、管理员登录）能走的入口都只记成提议：被提名的人什么权力都没有
    const byTok = await srv.call('PUT', '/api/departments/eng', { headers: token, body: { name: '合成研发部', lead: 'user:alpha' } });
    const byRoot = await srv.call('PUT', '/api/departments/eng', { ...as(SESSIONS.admin), body: { name: '合成研发部', lead: 'user:alpha' } });
    const afterAdmin = { field: q("SELECT lead_principal FROM departments WHERE id = 'eng'")[0].lead_principal, grants: leadGrants('user:alpha').length, assign: await tryAssign(SESSIONS.alpha), rel: relAlpha() };
    check(byTok.json?.lead_proposal?.status === 'pending' && byRoot.json?.lead_proposal?.id === byTok.json?.lead_proposal?.id && afterAdmin.field === '' && afterAdmin.grants === 0 && afterAdmin.assign === 403 && !afterAdmin.rel.includes('team-lead'),
      '系统管理员（管理口令、管理员登录）改部门负责人：只记成提议，字段不变、不发授予；被提名的人分不了成员、不是团队负责人（事项、放行都跟着团队负责人走）', show({ byTok: byTok.json?.lead_proposal, afterAdmin }));
    await srv.call('POST', `/api/relations/proposals/${byTok.json?.lead_proposal?.id}/reject`, { body: { reason: '合成：收掉' } });
    // 2) 字段从别的来源写进来（存量、导入、将来的同步，这里直接写库）：只是「待属主放行」，不带任何权力 [red-line:dept-lead-field-no-power]
    db.prepare("UPDATE departments SET lead_principal = 'user:alpha' WHERE id = 'eng'").run();
    await srv.call('PUT', '/api/departments/eng/members/user:no-flag', { headers: token }); // eng 里放一个只在 eng 的成员，看「同部门看得到名字」
    const fieldOnly = {
      dept: (await srv.call('GET', '/api/departments/eng', as(SESSIONS.alpha))).json?.department?.lead,
      view: await otherView(null), alphaSees: !!(await otherView(SESSIONS.alpha)), assign: await tryAssign(SESSIONS.alpha), rel: relAlpha(),
      alphaDepts: (await srv.call('GET', '/api/departments/of/user:alpha', as(SESSIONS.alpha))).json?.departments?.map((d) => d.id),
      peerName: sidecar(`return nameResolver({ admin: false, principal: 'user:alpha' })('user:no-flag');`),
      backfill: sidecar('return svc("relationProposals").proposeMissingLeadGrants(Date.now());'),
      again: sidecar('return svc("relationProposals").proposeMissingLeadGrants(Date.now());'),
    };
    const backfilled = ((await srv.call('GET', '/api/relations/proposals')).json?.proposals ?? []).find((p) => p.kind === 'dept-lead' && p.department_id === 'eng' && p.status === 'pending');
    check(fieldOnly.dept?.grant === 'missing' && fieldOnly.view && !fieldOnly.view.leads.some((l) => l.principal === 'user:alpha') && fieldOnly.view.lead_pending_grant?.principal === 'user:alpha'
      && fieldOnly.alphaSees === false && !fieldOnly.alphaDepts?.includes('eng') && fieldOnly.peerName === null
      && fieldOnly.assign === 403 && fieldOnly.rel.includes('dept-lead-pending') && !fieldOnly.rel.includes('dept-lead') && !fieldOnly.rel.includes('team-lead')
      && fieldOnly.backfill === 1 && fieldOnly.again === 0 && backfilled?.proposed_by === 'system:migration' && backfilled.confirm_by_text === '属主（同时放行这个部门负责人的权限）',
      '只有字段、没有授予的部门负责人（存量、导入、同步、直接写库）：部门上标 grant=missing，团队上是 lead_pending_grant、不在负责人里；读不到这个部门的团队、部门归属里没有它、看不到只在这个部门的同事的名字；分不了成员、不是团队负责人；启动补记一条负责人提议给属主（重复补不重复记），提议人是 system:migration [red-line:dept-lead-field-no-power]',
      show({ fieldOnly, backfilled }));
    // 3) 属主确认那条补记的提议：同一事务里发授予、记下来；他就有了团队层的权力
    const ok = await srv.call('POST', `/api/relations/proposals/${backfilled?.id}/approve`, {});
    const g1 = leadGrants('user:alpha');
    const confirmed = { ok: ok.status, grants: g1, link: q("SELECT grant_id, principal_id FROM dept_lead_grants WHERE department_id = 'eng'"), approvedBy: q('SELECT approved_by FROM grants WHERE id = ?', g1[0]?.id)[0]?.approved_by, assign: await tryAssign(SESSIONS.alpha), rel: relAlpha(), dept: (await srv.call('GET', '/api/departments/eng')).json?.department?.lead?.grant,
      alphaSees: !!(await otherView(SESSIONS.alpha)), peerName: sidecar(`return nameResolver({ admin: false, principal: 'user:alpha' })('user:no-flag');`) };
    check(confirmed.ok === 200 && g1.length === 1 && g1[0].status === 'active' && confirmed.approvedBy === 'cli' && confirmed.link[0]?.grant_id === g1[0].id && confirmed.assign === 201 && confirmed.rel.includes('team-lead') && confirmed.dept === 'active' && confirmed.alphaSees === true && typeof confirmed.peerName === 'string',
      '属主确认负责人：同一事务里发这个部门的 dept-lead 授予（属主放行）并记下来；之后他是团队负责人、能分配成员、读得到这个部门的团队和同事的名字', show(confirmed));
    // 4) 属主（管理员也行，收紧）撤掉这条授予：团队层的权力当场没了，不等重启、不等缓存
    const rv = await srv.call('POST', `/api/grants/${g1[0]?.id}/revoke`, { headers: token, body: { reason: '合成：撤掉看权力' } });
    const revoked = { rv: rv.status, assign: await tryAssign(SESSIONS.alpha), rel: relAlpha(), dept: (await srv.call('GET', '/api/departments/eng')).json?.department?.lead?.grant, view: (await otherView(null))?.lead_pending_grant?.principal, alphaSees: !!(await otherView(SESSIONS.alpha)) };
    check(revoked.rv === 200 && revoked.assign === 403 && !revoked.rel.includes('team-lead') && revoked.dept === 'missing' && revoked.view === 'user:alpha' && revoked.alphaSees === false,
      '撤掉随负责人发的授予：字段还在，权力当场没了（分不了成员、不是团队负责人、读不到这个部门的团队），状态回到待属主放行', show(revoked));
    // 5) 属主直接指定（本机命令行）：再发一条；换人 A→B：A 那条收回，B 拿到新的
    await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发部', lead: 'user:alpha' } });
    const a2 = leadGrants('user:alpha').filter((g) => g.status === 'active');
    await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发部', lead: 'user:beta' } });
    const swap = { alpha: leadGrants('user:alpha').map((g) => g.status), beta: leadGrants('user:beta').map((g) => g.status), link: q("SELECT principal_id FROM dept_lead_grants WHERE department_id = 'eng'")[0]?.principal_id, alphaAssign: await tryAssign(SESSIONS.alpha) };
    check(a2.length === 1 && show(swap.alpha) === show(['revoked', 'revoked']) && show(swap.beta) === show(['active']) && swap.link === 'user:beta' && swap.alphaAssign === 403,
      '属主直接指定负责人也发授予；换人 A→B：A 随负责人拿到的那条收回、当场分不了成员，B 拿到新的一条', show({ a2, swap }));
    // 6) 只改部门名称（没写 lead）：不发授予——属主改名不等于确认负责人
    await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发部', lead: null } }); // 移除负责人：收回 B 那条
    db.prepare("UPDATE departments SET lead_principal = 'user:alpha' WHERE id = 'eng'").run();
    const rename = await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发二部' } });
    check(rename.status === 200 && rename.json?.department?.lead?.grant === 'missing' && leadGrants('user:alpha').every((g) => g.status === 'revoked') && leadGrants('user:beta').every((g) => g.status === 'revoked'),
      '移除负责人收回随发的授予；属主只改名称、没写 lead：不替只有字段的负责人发授予', show({ rename: rename.json?.department?.lead, alpha: leadGrants('user:alpha'), beta: leadGrants('user:beta') }));
    // 7) 已经持有这个部门的 dept-lead（另外发的）：指定为负责人不再另发；移除负责人不碰他原有的那条
    db.prepare("UPDATE departments SET lead_principal = '' WHERE id = 'eng'").run();
    const own = await srv.call('POST', '/api/grants', { body: { principal: 'user:beta', role: 'dept-lead', scope: 'dept:eng', reason: '合成：另外发的' } });
    await srv.call('POST', `/api/grants/${own.json?.grant?.id}/submit`); await srv.call('POST', `/api/grants/${own.json?.grant?.id}/approve`);
    await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发部', lead: 'user:beta' } });
    const held = { active: leadGrants('user:beta').filter((g) => g.status === 'active').map((g) => g.id), link: q("SELECT COUNT(*) AS n FROM dept_lead_grants WHERE department_id = 'eng'")[0].n };
    await srv.call('PUT', '/api/departments/eng', { body: { name: '合成研发部', lead: null } });
    const kept = q('SELECT status FROM grants WHERE id = ?', own.json?.grant?.id)[0]?.status;
    check(show(held.active) === show([own.json?.grant?.id]) && held.link === 0 && kept === 'active',
      '已经持有这个部门 dept-lead 的人被指定为负责人：不再另发、不记随发；移除负责人时他原有的那条不动', show({ held, kept }));
    await srv.call('POST', `/api/grants/${own.json?.grant?.id}/revoke`, { body: { reason: '合成：收尾' } });
    // 8) dept-lead 不能用（角色表里没有）：确认整体拒绝，部门、字段、授予都没落
    const unusable = sidecar(`const r = lead.setDepartmentLead({ id: 'eng-x', name: '合成拒绝部', functionCode: null, lead: 'user:alpha' }, { by: 'cli', principal: null, owner: true }, Date.now());
      return { ok: r.ok, code: r.code ?? null, dept: !!svc('departments').get('eng-x'), grants: db.prepare("SELECT COUNT(*) AS n FROM grants WHERE scope = 'dept:eng-x'").get().n };`, true);
    check(unusable.ok === false && unusable.code === 'dept_lead_role_unusable' && unusable.dept === false && unusable.grants === 0,
      'dept-lead 角色不能用时：确认负责人整体拒绝（422 dept_lead_role_unusable），部门、负责人字段、授予都没有落', show(unusable));
    // 9) 属主驳回补记的提议：清掉只有字段的负责人（不然每一轮都会再补记）
    db.prepare("UPDATE departments SET lead_principal = 'user:alpha' WHERE id = 'eng'").run();
    // 9a) 只有字段的负责人同时是部门成员：成员列表里他不是负责人（is_lead 假），标 lead_pending；部门归属里同样
    await srv.call('PUT', '/api/departments/eng/members/user:alpha', { headers: token });
    const mem = (await srv.call('GET', '/api/departments/eng', { headers: token })).json?.members?.find((m) => m.principal === 'user:alpha');
    const ofAlpha = (await srv.call('GET', '/api/departments/of/user:alpha', as(SESSIONS.alpha))).json?.departments?.find((d) => d.id === 'eng');
    await srv.call('DELETE', '/api/departments/eng/members/user:alpha', { headers: token });
    check(mem?.is_lead === false && mem?.lead_pending === true && ofAlpha?.is_lead === false && ofAlpha?.is_member === true && ofAlpha?.lead_pending === true,
      '只有字段的负责人又是成员：成员列表、部门归属里都不算负责人（is_lead 假），标 lead_pending', show({ mem, ofAlpha }));
    sidecar('return svc("relationProposals").proposeMissingLeadGrants(Date.now());');
    const again = ((await srv.call('GET', '/api/relations/proposals')).json?.proposals ?? []).find((p) => p.kind === 'dept-lead' && p.department_id === 'eng' && p.status === 'pending');
    const rj = await srv.call('POST', `/api/relations/proposals/${again?.id}/reject`, { body: { reason: '合成：不认这个字段' } });
    const cleared = q("SELECT lead_principal FROM departments WHERE id = 'eng'")[0].lead_principal;
    check(rj.status === 200 && cleared === '' && sidecar('return svc("relationProposals").proposeMissingLeadGrants(Date.now());') === 0,
      '属主驳回补记的负责人提议：只有字段的负责人被清掉，不再补记', show({ rj: rj.status, cleared }));
    // 收尾：别队退回待认领，eng 删掉（随负责人发的授予都收过了）
    await srv.call('POST', '/api/teams/release', { body: tO });
    const del = await srv.call('DELETE', '/api/departments/eng');
    check(del.status === 200, '收尾：随负责人发的授予都收回之后部门能删', show(del.json));
  }

  // ---------- 七、退回待认领；有团队挂着的部门不能删 ----------
  {
    const del = await srv.call('DELETE', '/api/departments/sales', { headers: token });
    const rel = await srv.call('POST', '/api/teams/release', { headers: token, body: team });
    const leadsLeft = Number(db.prepare('SELECT COUNT(*) AS n FROM team_leads WHERE ended_at IS NULL').get().n);
    const asgLeft = Number(db.prepare('SELECT COUNT(*) AS n FROM seat_assignments WHERE ended_at IS NULL').get().n);
    const staff = await srv.call('GET', '/api/teams', as(SESSIONS.alpha));
    const cli = await srv.call('GET', '/api/teams');
    const del2 = await srv.call('DELETE', '/api/departments/sales', { headers: token });
    check(del.status === 409 && del.json?.error === 'department_has_teams' && rel.status === 200 && rel.json?.leads_ended === 1 && rel.json?.assignments_ended === 2
      && leadsLeft === 0 && asgLeft === 0 && show(staff.json?.departments) === '[]' && cli.json?.unclaimed?.length === 2 && del2.status === 200,
      '有团队挂着的部门不能删 409；退回待认领：另外指定的负责人、生效的分配一起结束，员工看不到了，又回到待认领；之后部门能删', show({ del: del.status, rel: rel.json, del2: del2.status }));
  }

  // ---------- 九、留痕 ----------
  {
    const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM team_events WHERE host = ? AND team = ? GROUP BY kind ORDER BY kind').all(HOST, TEAM).map((r) => `${r.kind}:${r.n}`);
    const lines = srv.log().split('\n').filter((l) => l.includes('"source":"teams"'));
    check(show(kinds) === show(['assign:6', 'claim:1', 'lead-add:2', 'lead-remove:1', 'release:1', 'unassign:4']) && lines.length >= 7,
      '每一步留痕：认领、加负责人两次（第二次是属主确认的提议，八之三）、移除一次、分配三次加改派三次（改派里两次换人各带一条收回）、收回一次加改派前的一次、退回各一行；日志里每步一行', show({ kinds, lines: lines.length }));
  }
} catch (e) {
  fail++;
  console.log(`  ✗ 对抗组没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await sleep(500); if (child.exitCode === null) child.kill('SIGKILL'); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`teams-smoke: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
