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
  const db = new DatabaseSync(join(data, 'workbench-market.db'));
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
      && staff.status === 200 && show(staff.json) === '{"can":{"claim":false,"propose_claim":false,"release":false,"add_lead":false,"propose_lead":false,"manage_leads":false,"manage_departments":false},"departments":[]}',
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

  // ---------- 五、可见范围 ----------
  {
    const alpha = await viewOf(as(SESSIONS.alpha));
    const beta = await viewOf(as(SESSIONS.beta));
    const stranger = await srv.call('GET', '/api/teams', as(SESSIONS.noAdminFlag));
    check(alpha?.status === 'active' && beta?.status === 'active' && show(stranger.json) === '{"can":{"claim":false,"propose_claim":false,"release":false,"add_lead":false,"propose_lead":false,"manage_leads":false,"manage_departments":false},"departments":[]}',
      '可见范围：部门成员兼负责人 alpha、部门负责人 beta 看得到；不相干的人看不到', show({ stranger: stranger.json }));
    // 管理层授予：给 no-flag 一条 management，就看得到全部认领了的
    const d = await srv.call('POST', '/api/grants', { body: { principal: 'user:no-flag', role: 'management', scope: '*', reason: '合成：管理层' } });
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/submit`);
    await srv.call('POST', `/api/grants/${d.json?.grant?.id}/approve`);
    const mgmt = await srv.call('GET', '/api/teams', as(SESSIONS.noAdminFlag));
    check(mgmt.json?.departments?.[0]?.teams?.length === 1 && !('unclaimed' in (mgmt.json ?? {})), '管理层授予：看得到全部认领了的团队，看不到待认领那一栏', show(mgmt.json?.departments?.map((x) => x.id)));
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
    await srv.call('POST', '/api/teams/release', { headers: token, body: { host: HOST, team: OTHER } });
  }

  // ---------- 八之三、关系由谁说了算：只有系统管理员身份的人造不出带来权限的关系 ----------
  {
    // 在本进程外读关系函数和服务（同一个数据目录）
    const inproc = (body) => {
      const script = `
        const { relationOf } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/team-relation.ts')).href)});
        const { svc } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server/src/context.ts')).href)});
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
    const claimByMgmt = await approve(pClaim, as(SESSIONS.noAdminFlag)); // 管理层（不是管理员）：经写请求总门的放行进来
    const leadByOwner = await approve(pLead, {}); // 属主（本机命令行）
    const deptByOwner = await approve(pDept, {});
    const confirmed = inproc(`return {
      claimed: svc('teams').registration({ host: '${HOST}', team: ${JSON.stringify(OTHER)} })?.department_id ?? null,
      rootTeam: relationOf({ principal: 'user:root-admin' }, { team: { host: '${HOST}', team: ${JSON.stringify(TEAM)} } }).relations,
      rootQa: relationOf({ principal: 'user:root-admin' }, { department: 'qa' }).relations,
    };`);
    const code = (r) => `${r.status}:${r.json?.error ?? r.json?.proposal?.status}`;
    check(show(Object.fromEntries(Object.entries(tries).map(([k, r]) => [k, code(r)]))) === show({ claimByToken: '403:business_confirm_required', claimByRoot: '403:business_confirm_required', claimByAlpha: '403:business_confirm_required', leadByMgmt: '403:owner_required', deptByMgmt: '403:owner_required' })
      && seen?.can_approve === true && !(listAlpha.json?.proposals ?? []).some((p) => p.id === pClaim) && (attnMgmt.json?.items ?? []).some((i) => i.source === 'relation-proposals' && i.source_id === String(pClaim))
      && code(claimByMgmt) === '200:approved' && code(leadByOwner) === '200:approved' && code(deptByOwner) === '200:approved'
      && confirmed.claimed === 'qa' && confirmed.rootTeam?.includes('team-lead') && confirmed.rootQa?.includes('dept-lead'),
      '确认：认领要管理层或接收部门的负责人（管理口令、只有系统管理员身份的登录、不相干的员工 403），负责人只有属主（管理层 403）；管理层在列表和「等你拍板」里看得到、能确认；属主确认之后关系才生效',
      show({ tries: Object.fromEntries(Object.entries(tries).map(([k, r]) => [k, code(r)])), seen: seen && [seen.can_approve, seen.approve_denied_text], claimByMgmt: code(claimByMgmt), leadByOwner: code(leadByOwner), deptByOwner: code(deptByOwner), confirmed }));
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
    check(move.status === 202 && code(byQaLead) === '403:business_confirm_required' && code(byOpsLead) === '200:approved' && direct.status === 200 && direct.json?.changed === true,
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
    check(asListed === '2000-01-01T00:00:00.000Z' && !item(fresh) && item(stale)?.title?.includes('合成节点') && item(stale)?.title?.includes('60 分钟') && !item(stale)?.title?.includes(HOST) && !item(staff),
      '名册超过阈值（缺省 60 分钟）没更新：进管理员的「等你拍板」，写节点名不写节点标识；新鲜的不列；员工看不到；库里的 SQLite 时刻给出去统一成 ISO',
      show({ fresh: !!item(fresh), stale: item(stale)?.title, staff: !!item(staff) }));
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
    check(show(kinds) === show(['assign:3', 'claim:1', 'lead-add:2', 'lead-remove:1', 'release:1', 'unassign:1']) && lines.length >= 7,
      '每一步留痕：认领、加负责人两次（第二次是属主确认的提议，八之三）、移除一次、分配三次、收回一次、退回各一行；日志里每步一行', show({ kinds, lines: lines.length }));
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
