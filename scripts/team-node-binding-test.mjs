#!/usr/bin/env node
/**
 * 团队归属绑节点本身（根地址 + 完整指纹）的对抗组。全是合成数据：隔离的数据目录，节点、人、部门都是编的，不碰任何外部系统。
 *
 *   一、正常：认领、指定负责人、分配成员时记下这个 host 现在的节点（名册里的根地址、对端登记里的完整指纹）；负责人、成员的主人、事项归属都算数
 *   二、名册被清、别的节点报了同一个 8 位号（根地址、指纹都不同）：原负责人、成员的主人、认领都不转给它——
 *       负责人没了、成员不归谁、这个人「我分到的成员」「我负责的团队」里都没了、团队状态是 node-changed、细到团队的台绑不上；
 *       「等你拍板」的团队归属列出来；重新认领、指定、分配以后算数，旧的那几行自动结束（记 system:node-changed）
 *   三、同一个根地址换了钥（指纹变了）：同样不算数
 *   四、对端停用：不算数；恢复启用（同一根地址、同一指纹）就又算数
 *   五、节点没核过（名册里没有、对端没登记、对端没有指纹、对端停用）：认领、指定负责人、分配都拒（409 node_unverified），什么都不写
 *   六、存量回填只做一次：加列那一次按当时的名册回填；回填不上的留空、不算数；以后再启动、哪怕那个号后来有了名册，也不回填（不让后来的节点接走）
 *   七、「等你拍板」：团队归属要重新确认的，管理层、管理员看得到；普通员工看不到；不露节点标识以外的东西
 *
 *   node scripts/team-node-binding-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from './owned-script-fixture.mjs';
import { SESSIONS } from './identity-fake-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tmp', `team-node-binding-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => JSON.stringify(pathToFileURL(join(ROOT, p)).href);
const PRELOAD = pathToFileURL(join(HERE, 'identity-fake-preload.mjs')).href;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在一个独立进程里（指定的数据目录）跑一段用到服务的代码，把它 console.log('OUT ' + JSON) 的东西拿回来 */
function inProc(name, dataDir, body) {
  const file = join(OUT, `${name}.mjs`);
  writeFileSync(file, `
const { db } = await import(${at('server/src/db.ts')});
const { svc } = await import(${at('server/src/context.ts')});
const { parseBinding } = await import(${at('server/src/services/bench-registry.ts')});
const teams = svc('teams');
const seedNode = (host, root, fp, status = 'active') => {
  // 名册以（根地址，完整指纹）为键：这个号原来的名册连席位一起换成这一份（指纹就是这台节点签名用的那把）
  db.prepare('DELETE FROM a2a_roster_nodes WHERE host = ?').run(host);
  db.prepare("INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES (?, ?, ?, 'zsyn', '0', '0')").run(host, root, fp);
  // 这个号原来报的席位，现在由这台节点报（同一份席位）
  db.prepare('UPDATE a2a_roster_node_seats SET peer_root = ?, key_fingerprint = ? WHERE host = ?').run(root, fp, host);
  db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES (?, ?, 'zsyn', '合成节点', ?, ?, 'seed', '0', '0') ON CONFLICT(root_url) DO UPDATE SET status = excluded.status, key_fingerprint = excluded.key_fingerprint").run('peer-' + root.length + '-' + Math.random().toString(36).slice(2), root, status, fp);
};
const seats = (host, team, list) => { const ins = db.prepare("INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ((SELECT peer_root FROM a2a_roster_nodes WHERE host = ?1 ORDER BY rowid LIMIT 1), (SELECT key_fingerprint FROM a2a_roster_nodes WHERE host = ?1 ORDER BY rowid LIMIT 1), ?1, ?2, ?3, ?4, ?5, ?6, 1, 0, '', '0')"); db.prepare('DELETE FROM a2a_roster_node_seats WHERE host = ?').run(host); for (const s of list) ins.run(host, team, s.seat, s.seat_id, s.seat, s.role ?? 'member'); };
const person = (id) => db.prepare("INSERT INTO principals (id, id_key, kind, display_name, status) VALUES (?, ?, 'person', ?, 'active') ON CONFLICT(id) DO NOTHING").run(id, id, 'Synthetic ' + id);
const dept = (id) => { const r = svc('departments').upsert({ id, name: '合成' + id, functionCode: null, lead: null }, 'test', 1); if (!r.ok) throw new Error('部门建不起来：' + JSON.stringify(r)); };
const A = { by: 'test-management', principal: null };
let out = {};
${body}
console.log('OUT ' + JSON.stringify(out));
process.exit(0);
`);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file], { env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 120000 });
  const m = /OUT (.*)/.exec(r.stdout);
  if (!m) throw new Error(`${name} 跑不起来：${(r.stderr || r.stdout).slice(-900)}`);
  return JSON.parse(m[1]);
}

const H = 'a1b2c3d4', TEAM = 'zsyn/canvas/alpha-team';
const R1 = 'https://node-one.synthetic.invalid', F1 = 'sha256:' + '1'.repeat(64);
const R2 = 'https://node-impostor.synthetic.invalid', F2 = 'sha256:' + '2'.repeat(64);
const F3 = 'sha256:' + '3'.repeat(64);
const R4 = 'https://node-squatter.synthetic.invalid', F4 = 'sha256:' + '4'.repeat(64);
const SEAT = { seat: 'zsyn/0000000a', seat_id: 'seat-0000000a' };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let child = null;
try {
  // ---------- 一 ~ 五（服务层） ----------
  const o = inProc('scenarios', join(OUT, 'data-1'), `
const K = { host: '${H}', team: '${TEAM}' };
const S = { ...K, seat: '${SEAT.seat}', seat_id: '${SEAT.seat_id}' };
for (const p of ['user:lead1', 'user:owner1', 'user:lead2']) person(p);
dept('sales');
// 五：节点没核过——名册里没有 / 对端没登记 / 没指纹 / 停用：都拒、不写
const refused = {};
db.prepare("INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES ('${H}', '${R1}', '${F1}', 'zsyn', '0', '0')").run();
seats('${H}', '${TEAM}', [${JSON.stringify(SEAT)}]);
refused.noPeer = teams.claim(K, 'sales', A, 1).code ?? 'ok';
db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('p1', '${R1}', 'zsyn', '合成节点', 'active', '', 'seed', '0', '0')").run();
refused.noFp = teams.claim(K, 'sales', A, 1).code ?? 'ok';
db.prepare("UPDATE a2a_peers SET key_fingerprint = '${F1}', status = 'disabled' WHERE root_url = '${R1}'").run();
refused.disabled = teams.claim(K, 'sales', A, 1).code ?? 'ok';
refused.rows = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
out.refused = refused;
db.prepare("UPDATE a2a_peers SET status = 'active' WHERE root_url = '${R1}'").run();
// 一：正常
out.claim = teams.claim(K, 'sales', A, 10).ok;
out.lead = teams.addLead(K, 'user:lead1', A, 11).ok;
out.assign = teams.assign(S, 'user:owner1', A, 12).ok;
const snap = () => ({
  status: teams.status(K), leads: teams.leads(K).map((l) => l.principal), owner: teams.ownerAt(S, 100), owners: teams.ownersAt([{ key: S, at: 100 }]),
  assignedTo: teams.assignedTo('user:owner1').length, history: teams.assignmentHistory('user:owner1').length, leadOf: teams.explicitLeadOf('user:lead1').length,
  member: teams.allViews().find((t) => t.host === K.host && t.team === K.team)?.members?.find((m) => m.seat_id === S.seat_id)?.assigned_to?.principal ?? null,
  stale: teams.staleBindings(), bench: (() => { try { parseBinding({ department: 'sales', team_host: K.host, team: K.team }); return 'ok'; } catch (e) { return e.message; } })(),
});
out.normal = snap();
out.stamped = db.prepare("SELECT (SELECT peer_root || '|' || key_fingerprint FROM teams) AS t, (SELECT peer_root || '|' || key_fingerprint FROM team_leads) AS l, (SELECT peer_root || '|' || key_fingerprint FROM seat_assignments) AS a, (SELECT COUNT(*) FROM team_events WHERE peer_root = '${R1}' AND key_fingerprint = '${F1}') AS ev").get();
// 二：名册被清，别的节点报了同一个号
db.prepare("DELETE FROM a2a_roster_nodes WHERE host = '${H}'").run();
seedNode('${H}', '${R2}', '${F2}');
seats('${H}', '${TEAM}', [${JSON.stringify(SEAT)}]);
out.impostor = snap();
out.impostorAttempt = { lead: teams.addLead(K, 'user:lead2', A, 20).code ?? 'ok', assign: teams.assign(S, 'user:lead2', A, 20).code ?? 'ok' };
// 管理层重新认领、指定、分配：算数；旧行自动结束
out.reclaim = teams.claim(K, 'sales', A, 30).changed;
out.endedAtClaim = db.prepare("SELECT (SELECT COUNT(*) FROM team_leads WHERE ended_by = 'system:node-changed' AND ended_at = 30) AS l, (SELECT COUNT(*) FROM seat_assignments WHERE ended_by = 'system:node-changed' AND ended_at = 30) AS a").get();
out.relead = teams.addLead(K, 'user:lead1', A, 31).added;
out.reassign = teams.assign(S, 'user:owner1', A, 32).ok;
out.after = snap();
out.eventsLead = teams.events(K, true).map((e) => e.kind);
out.eventsAll = teams.events(K).map((e) => e.kind);
out.ended = db.prepare("SELECT (SELECT COUNT(*) FROM team_leads WHERE ended_by = 'system:node-changed') AS l, (SELECT COUNT(*) FROM seat_assignments WHERE ended_by = 'system:node-changed') AS a").get();
// 三：同一根地址换了钥
db.prepare("UPDATE a2a_peers SET key_fingerprint = '${F3}' WHERE root_url = '${R2}'").run();
out.rekey = snap();
// 四：对端停用、恢复
db.prepare("UPDATE a2a_peers SET key_fingerprint = '${F2}', status = 'disabled' WHERE root_url = '${R2}'").run();
out.disabled = snap();
// 对端停用时团队显示「节点换了」：节点名字、名册停推的提示照样给（属主要靠它去找那台机器），只是展示，不认人
out.disabledNode = teams.nodeInfo('${H}');
const seatRel = async () => (await import(${at('server/src/team-relation.ts')})).relationOf({ seat: S }, { seat: S }).relations.sort();
// 席位作主体：对端停用时这个席位不算在团队里（不给 team-seat、router、same-seat）
out.seatRelDisabled = await seatRel();
db.prepare("UPDATE a2a_roster_nodes SET received_at = '2000-01-01 00:00:00' WHERE host = '${H}'").run();
out.disabledStale = { one: teams.rosterStaleness('${H}', Date.parse('2026-11-13T00:00:00Z')).roster_stale, list: teams.staleRosters(Date.parse('2026-11-13T00:00:00Z')).some((r) => r.host === '${H}' && r.node_name === '合成节点') };
db.prepare("UPDATE a2a_roster_nodes SET received_at = '0' WHERE host = '${H}'").run();
db.prepare("UPDATE a2a_peers SET status = 'active' WHERE root_url = '${R2}'").run();
out.restored = snap();
out.seatRelRestored = await seatRel();
// 撞号：另一个根地址、另一把键也报了这个号（对端启用）——同一个号下两个节点，两个都不算：现在的归属不算数；停用撞号的那台后恢复
db.prepare("INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES ('${H}', '${R4}', '${F4}', 'zsyn', '0', '0')").run();
db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('p-squat', '${R4}', 'zsyn', '撞号的', 'active', '${F4}', 'seed', '0', '0')").run();
// 撞号那台的名册里，同一个团队下还有一个原来那台没有的席位
db.prepare("INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES ('${R4}', '${F4}', '${H}', '${TEAM}', 'zsyn/0000004a', 'seat-squat-only', '撞号节点上的成员', 'member', 1, 0, '', '0')").run();
out.collide = snap();
out.collideNode = (await import(${at('server/src/services/team.ts')})).currentNode('${H}');
db.prepare("UPDATE a2a_peers SET status = 'disabled' WHERE root_url = '${R4}'").run();
out.collideResolved = snap();
// 停用撞号那台之后：只在它名册里的席位不认（分配、改派都 404 seat_not_in_roster，什么都不写）；原来那台的席位照常能分
{
  const SQ = { ...K, seat: 'zsyn/0000004a', seat_id: 'seat-squat-only' };
  const n0 = db.prepare("SELECT COUNT(*) AS n FROM seat_assignments WHERE seat_id = 'seat-squat-only'").get().n;
  out.squatSeat = { assign: teams.assign(SQ, 'user:lead2', A, 50).code ?? 'ok', reassign: teams.reassign(SQ, 'user:lead2', A, 51).code ?? 'ok',
    written: db.prepare("SELECT COUNT(*) AS n FROM seat_assignments WHERE seat_id = 'seat-squat-only'").get().n - n0,
    legit: teams.reassign(S, 'user:lead2', A, 52).ok === true };
}
out.resolvedNode = (await import(${at('server/src/services/team.ts')})).currentNode('${H}');
`);
  check(show(o.refused) === show({ noPeer: 'node_unverified', noFp: 'node_unverified', disabled: 'node_unverified', rows: 0 }),
    '节点没核过（对端没登记、没有指纹、停用）：认领拒（409 node_unverified），什么都不写', show(o.refused));
  check(o.claim && o.lead && o.assign && o.normal.status === 'active' && show(o.normal.leads) === show(['user:lead1']) && o.normal.owner === 'user:owner1' && o.normal.owners[0] === 'user:owner1'
      && o.normal.assignedTo === 1 && o.normal.history === 1 && o.normal.leadOf === 1 && o.normal.member === 'user:owner1' && o.normal.stale.length === 0 && o.normal.bench === 'ok'
      && o.stamped.t === `${R1}|${F1}` && o.stamped.l === `${R1}|${F1}` && o.stamped.a === `${R1}|${F1}` && o.stamped.ev >= 3,
    '正常：认领、负责人、分配、团队事件都记下根地址和完整指纹；负责人、成员的主人、事项归属、细到团队的台都算数', show({ normal: o.normal, stamped: o.stamped }));
  const gone = (x) => x.status === 'node-changed' && x.leads.length === 0 && x.owner === null && x.owners[0] === null && x.assignedTo === 0 && x.history === 0 && x.leadOf === 0 && x.member === null && x.bench !== 'ok';
  check(gone(o.impostor) && show(o.impostor.stale) === show([{ host: H, team: TEAM, claim: true, leads: 1, assignments: 1 }]),
    '名册被清、别的节点报了同一个号：原负责人、成员的主人、认领都不转给它（负责人没了、成员不归谁、「我分到的」「我负责的」都没了、团队 node-changed、台绑不上）；团队归属列进待重新确认', show(o.impostor));
  check(show(o.impostorAttempt) === show({ lead: 'team_not_claimed', assign: 'team_not_claimed' }),
    '……在重新认领之前，往这个团队里指定负责人、分配成员都拒', show(o.impostorAttempt));
  check(o.reclaim === true && o.relead === true && o.reassign === true && o.after.status === 'active' && show(o.after.leads) === show(['user:lead1']) && o.after.owner === 'user:owner1' && o.after.stale.length === 0
      && o.ended.l === 1 && o.ended.a === 1,
    '管理层重新认领、指定、分配以后算数（记下现在的节点）；记在旧节点上的那几行自动结束（system:node-changed），待重新确认的清空', show({ after: o.after, ended: o.ended }));
  check(o.endedAtClaim.l === 1 && o.endedAtClaim.a === 1,
    '……重新认领的那一刻，旧节点上还挂着的负责人和分配就一起结束（不等重新指定、分配）', show(o.endedAtClaim));
  check(show(o.eventsLead) === show(['claim', 'lead-add', 'assign']) && show(o.eventsAll) === show(['claim', 'lead-add', 'assign', 'claim', 'lead-add', 'assign']),
    '团队留痕：负责人口径只给记在现在这个节点上的那几行（看不到旧节点时期的认领、分配和当时分到成员的人）；管理员、管理层口径看全部历史', show({ lead: o.eventsLead, all: o.eventsAll }));
  check(gone(o.rekey), '同一根地址换了钥（指纹变了）：归属同样不算数', show(o.rekey));
  check(gone(o.disabled) && o.restored.status === 'active' && o.restored.owner === 'user:owner1',
    '对端停用：不算数；恢复启用（同一根地址、同一指纹）就又算数', show({ disabled: o.disabled.status, restored: o.restored.status }));
  check(o.seatRelDisabled.length === 0 && o.seatRelRestored.includes('team-seat') && o.seatRelRestored.includes('same-seat'),
    '席位作主体（relationOf）：对端停用时不给 team-seat、same-seat（节点核不过就不认这个席位）；恢复后照常', show({ disabled: o.seatRelDisabled, restored: o.seatRelRestored }));
  check(o.disabledNode?.node_name === '合成节点' && o.disabledStale.one === true && o.disabledStale.list === true,
    '……对端停用、团队显示「节点换了」时，节点名字和名册停推的提示照样给（只是展示）', show({ node: o.disabledNode, stale: o.disabledStale }));
  check(o.squatSeat.assign === 'seat_not_in_roster' && o.squatSeat.reassign === 'seat_not_in_roster' && o.squatSeat.written === 0 && o.squatSeat.legit,
    '撞号那台停用之后：只在它名册里的席位不认——分配、改派都 404 seat_not_in_roster、什么都不写；原来那台的席位照常能改派', show(o.squatSeat));
  check(o.collide.leads.length === 0 && o.collide.owner === null && o.collide.assignedTo === 0 && o.collide.leadOf === 0 && o.collide.member === null && o.collide.bench !== 'ok'
      && o.collideNode === null && o.collideResolved.status === 'active' && o.collideResolved.owner === 'user:owner1' && show(o.collideResolved.leads) === show(['user:lead1'])
      && show(o.resolvedNode) === show({ peer_root: R2, key_fingerprint: F2 }),
    '撞号：另一个节点也报了这个号（对端启用）——两个都不算，负责人、成员的主人、「我分到的」「我负责的」、细到团队的台都不算数；停用撞号那台后恢复', show({ collide: o.collide, node: o.collideNode, resolved: o.collideResolved.status, resolvedNode: o.resolvedNode }));

  // ---------- 六、存量回填只做一次 ----------
  const d6 = join(OUT, 'data-6');
  inProc('fresh', d6, `out.ok = 1;`); // 建一个新库
  {
    // 退回加列之前的样子：去掉两列，放几行存量；B 这个号此时没有对端
    const db = new DatabaseSync(join(d6, 'workbench-market.db'));
    try {
      for (const t of ['teams', 'team_leads', 'seat_assignments', 'team_events']) { db.exec(`ALTER TABLE ${t} DROP COLUMN peer_root`); db.exec(`ALTER TABLE ${t} DROP COLUMN key_fingerprint`); }
      db.prepare("INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES ('aaaa0001', 'https://legacy-a.synthetic.invalid', 'sha256:aaaa000100000000000000000000000000000000000000000000000000000000', 'zsyn', '0', '0')").run();
      db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('pa', 'https://legacy-a.synthetic.invalid', 'zsyn', '', 'active', 'sha256:aaaa000100000000000000000000000000000000000000000000000000000000', 'seed', '0', '0')").run();
      for (const h of ['aaaa0001', 'bbbb0002']) {
        db.prepare("INSERT INTO teams (host, team, department_id, claimed, claimed_by, claimed_at, updated_at) VALUES (?, 'zsyn/canvas/t', '', 0, '', NULL, 1)").run(h);
        db.prepare("INSERT INTO team_leads (host, team, principal_id, added_by, added_at) VALUES (?, 'zsyn/canvas/t', 'user:x', 'seed', 1)").run(h);
        db.prepare("INSERT INTO seat_assignments (host, team, seat, seat_id, principal_id, assigned_by, assigned_at) VALUES (?, 'zsyn/canvas/t', 'zsyn/00000001', 'sid-1', 'user:x', 'seed', 1)").run(h);
      }
    } finally { db.close(); }
  }
  const m1 = inProc('migrate', d6, `out.rows = db.prepare("SELECT 'leads' AS t, host, peer_root, key_fingerprint FROM team_leads UNION ALL SELECT 'asg', host, peer_root, key_fingerprint FROM seat_assignments UNION ALL SELECT 'team', host, peer_root, key_fingerprint FROM teams ORDER BY 1, 2").all();`);
  {
    const db = new DatabaseSync(join(d6, 'workbench-market.db'));
    try {
      // B 这个号后来有了名册和启用的对端（可能是任何节点）
      db.prepare("INSERT INTO a2a_roster_nodes (host, peer_root, key_fingerprint, peer_zone, reported_at, received_at) VALUES ('bbbb0002', 'https://latecomer.synthetic.invalid', 'sha256:bbbb000200000000000000000000000000000000000000000000000000000000', 'zsyn', '0', '0')").run();
      db.prepare("INSERT INTO a2a_peers (id, root_url, zone, name, status, key_fingerprint, registered_by, registered_at, updated_at) VALUES ('pb', 'https://latecomer.synthetic.invalid', 'zsyn', '', 'active', 'sha256:bbbb000200000000000000000000000000000000000000000000000000000000', 'seed', '0', '0')").run();
    } finally { db.close(); }
  }
  const m2 = inProc('restart', d6, `out.b = db.prepare("SELECT peer_root, key_fingerprint FROM team_leads WHERE host = 'bbbb0002'").get(); out.leadOfX = teams.explicitLeadOf('user:x').map((k) => k.host);`);
  const byHost = (t, h) => m1.rows.find((r) => r.t === t && r.host === h);
  check(['leads', 'asg', 'team'].every((t) => byHost(t, 'aaaa0001')?.peer_root === 'https://legacy-a.synthetic.invalid' && byHost(t, 'aaaa0001')?.key_fingerprint === 'sha256:aaaa000100000000000000000000000000000000000000000000000000000000' && byHost(t, 'bbbb0002')?.peer_root === '' && byHost(t, 'bbbb0002')?.key_fingerprint === ''),
    '存量回填：加列那一次按当时的名册和启用的对端回填；回填不上的留空', show(m1.rows));
  check(m2.b?.peer_root === '' && m2.b?.key_fingerprint === '' && show(m2.leadOfX) === show(['aaaa0001']),
    '……之后再启动、那个号后来有了名册和对端，也不回填：后来的节点接不走旧的负责人', show(m2));

  // ---------- 七、「等你拍板」：管理层、管理员看得到，普通员工看不到 ----------
  const d7 = join(OUT, 'data-7');
  inProc('seed7', d7, `
person('user:seed-owner');
dept('sales');
seedNode('${H}', '${R1}', '${F1}');
seats('${H}', '${TEAM}', [${JSON.stringify(SEAT)}]);
teams.claim({ host: '${H}', team: '${TEAM}' }, 'sales', A, 1);
teams.assign({ host: '${H}', team: '${TEAM}', ...${JSON.stringify(SEAT)} }, 'user:seed-owner', A, 2);
db.prepare("DELETE FROM a2a_roster_nodes WHERE host = '${H}'").run();
seedNode('${H}', '${R2}', '${F2}');
out.ok = 1;`);
  const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', PRELOAD, 'src/index.ts'], {
    cwd: join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: join(OUT, 'home'), PORT: String(port), WM_CONTROL_PORT: '0', DATA_DIR: d7, NODE_ENV: 'test', MCP_GATEWAY: 'on', ADMIN_TOKEN: 'team-binding-synthetic-admin', REDIS_URL: '', IDENTITY_SEAM_ROOT: ROOT },
  });
  let log = ''; child.stdout.on('data', (c) => { log += c; }); child.stderr.on('data', (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (const end = Date.now() + 40000; !ready && Date.now() < end && child.exitCode === null;) { try { ready = (await fetch(base + '/api/health')).status === 200; } catch { /* 还没起来 */ } if (!ready) await sleep(200); }
  if (!ready) throw new Error('市场没起来：' + log.slice(-600));
  const call = async (method, path, { session, body, headers = {} } = {}) => {
    const h = { ...headers, ...(session ? { cookie: `session_id=${session}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { status: r.status, json, text };
  };
  for (const s of [SESSIONS.alpha, SESSIONS.noAdminFlag]) await call('GET', '/api/auth/viewer', { session: s });
  const issue = async (principal, role) => { const d = await call('POST', '/api/grants', { body: { principal, role, scope: '*', reason: '合成：团队归属' } }); await call('POST', `/api/grants/${d.json?.grant?.id}/submit`); return (await call('POST', `/api/grants/${d.json?.grant?.id}/approve`)).status; };
  const issued = [await issue('user:no-flag', 'management'), await issue('user:alpha', 'member')];
  const REMOTE = { 'x-forwarded-for': '192.0.2.70', 'sec-fetch-site': 'same-origin' };
  const rowsOf = (r) => (r.json?.items ?? []).filter((x) => x.source === 'team-binding');
  const mg = await call('GET', '/api/attention', { session: SESSIONS.noAdminFlag, headers: REMOTE });
  const al = await call('GET', '/api/attention', { session: SESSIONS.alpha, headers: REMOTE });
  const tk = await call('GET', '/api/attention', { headers: { 'x-admin-token': 'team-binding-synthetic-admin' } });
  const mgRows = rowsOf(mg), alRows = rowsOf(al), tkRows = rowsOf(tk);
  check(issued.every((s) => s === 200) && mgRows.length === 1 && tkRows.length === 1 && alRows.length === 0 && /1 个成员分配/.test(mgRows[0].title) && /认领/.test(mgRows[0].title)
      && !mgRows[0].title.includes(R1) && !mgRows[0].title.includes(R2) && !mgRows[0].title.includes(F1),
    '「等你拍板」：团队归属要重新确认的，管理层、管理员看得到（认领、几个成员分配），普通员工看不到；标题里不带根地址和指纹', show({ issued, mg: mgRows.map((r) => r.title), al: alRows.length, tk: tkRows.length }));
  // 团队留痕的口径：本机命令行（属主）重新认领、把 alpha 指定成负责人；alpha 只看得到现在这个节点上的留痕，管理层看全部历史
  const reclaim = await call('POST', '/api/teams/claim', { body: { host: H, team: TEAM, department: 'sales' } });
  const lead = await call('POST', '/api/teams/leads', { body: { host: H, team: TEAM, principal: 'user:alpha' } });
  const q = `/api/teams/events?host=${H}&team=${encodeURIComponent(TEAM)}`;
  const evAlpha = (await call('GET', q, { session: SESSIONS.alpha, headers: REMOTE })).json?.events?.map((e) => e.kind) ?? null;
  const evMg = (await call('GET', q, { session: SESSIONS.noAdminFlag, headers: REMOTE })).json?.events?.map((e) => e.kind) ?? null;
  check(reclaim.status === 200 && lead.status === 201 && show(evAlpha) === show(['claim', 'lead-add']) && show(evMg) === show(['claim', 'assign', 'claim', 'lead-add']),
    '团队留痕（GET /api/teams/events）：新节点上的负责人只看到现在这个节点上的认领、指定；管理层看全部历史（含旧节点时期的分配）', show({ reclaim: reclaim.status, lead: lead.status, evAlpha, evMg }));
} catch (e) {
  fail++;
  console.log(`  ✗ 没跑完：${e?.stack ?? e}`);
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`team-node-binding-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
