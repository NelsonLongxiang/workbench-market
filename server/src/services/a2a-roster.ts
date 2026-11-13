/**
 * 阶段七：团队名册（dsh-open-a2a-net#604 P3）的登记与读。SQL 在这里；时间由代码生成后传入。
 * 名册只当信息给人看（团队页、把句柄显示成名字、在岗数），不授予任何东西；在办件数从事项现算，不另存。
 *
 * 名册以（根地址 peer_root，节点公钥完整指纹 key_fingerprint）为键；席位的键是它加上团队、席位句柄。host（指纹前 8 位）只拿来显示和匹配：
 * 按 host 找节点、找席位一律经视图 a2a_rosters_live（db.ts）——同一个 host 下有两个节点（前 8 位撞了）时两个都不算，等管理员停用其中一个；
 * 对端停用、等确认新键、记下的指纹不是此刻钉住那把的，也不算。不再「谁先报谁绑定」。
 * 每台宿主每次报的是全量快照：比已有的新才替换；替换时和上一版比，算出变化记进 a2a_roster_changes：
 *   team-added / team-removed  团队出现、消失（这台宿主上）
 *   seat-added / seat-removed  成员出现、消失（某个团队里）
 *   router-changed             团队的总工（role=router 的席位）换了，detail 里有 from、to
 * 只留记录；通知和「等你拍板」由上层做。第一次收到某台宿主的名册时，它的团队和席位都记成 added。
 */
import { db } from '../db.ts';
import { sqlTime } from './a2a-replies.ts';

export type RosterSeat = { seat: string; seat_id: string; name: string; team: string; role: 'router' | 'member' | 'observer' | ''; online: boolean; queued: number; last_active_at: string };
export type RosterRow = { host: string; peer_root: string; key_fingerprint: string; peer_zone: string; reported_at: string; received_at: string; seats: RosterSeat[] };
export type RosterChange = { id: number; host: string; kind: 'team-added' | 'seat-added' | 'seat-removed' | 'team-removed' | 'router-changed'; team: string; seat: string; detail: string; at: string };

/** 这个根地址是我们投递过的哪个区的宿主（投递时取名片记下的区）；没投递过返回 null */
export function deliveredPeerZone(root: string): string | null {
  if (root === '') return null;
  const row = db.prepare("SELECT peer_zone FROM a2a_sent_tasks WHERE peer_root = ? AND peer_zone <> '' ORDER BY rowid DESC LIMIT 1").get(root) as { peer_zone: string } | undefined;
  return row?.peer_zone ?? null;
}

type SeatRow = { team: string; seat: string; role: string };

/** 一个团队的总工（role=router 的席位，按句柄排序取第一个；没有返回 ''） */
const routerOf = (rows: readonly SeatRow[], team: string) => rows.filter((r) => r.team === team && r.role === 'router').map((r) => r.seat).sort()[0] ?? '';

/**
 * 记下一台宿主的名册（键是根地址 + 节点公钥完整指纹）：比已有的新才替换（宿主报的时间），替换时算出变化。
 * 返回 'recorded'、'stale'；收下了但同一个 host 下还有别的节点（指纹前 8 位撞了，两个都不参与匹配）返回 'host-shared'。
 * 同一根地址下升级时回填不上指纹（needs_review）的旧行，收到这个根地址的新名册时清掉。
 */
export function recordRoster(r: { host: string; peerRoot: string; keyFingerprint: string; peerZone: string; reportedAt: string; seats: RosterSeat[]; now?: number }): 'recorded' | 'stale' | 'host-shared' {
  const at = sqlTime(r.now);
  db.exec('SAVEPOINT a2a_roster');
  try {
    const prev = db.prepare('SELECT reported_at FROM a2a_roster_nodes WHERE peer_root = ? AND key_fingerprint = ?').get(r.peerRoot, r.keyFingerprint) as { reported_at: string } | undefined;
    if (prev && !(r.reportedAt > prev.reported_at)) { db.exec('RELEASE a2a_roster'); return 'stale'; }
    // 这个根地址升级时回填不上的旧行（不管当时是哪个 host）：它现在报来了验过签的名册，旧行连席位一起清掉
    const legacy = db.prepare('SELECT key_fingerprint FROM a2a_roster_nodes WHERE peer_root = ? AND needs_review = 1').all(r.peerRoot) as { key_fingerprint: string }[];
    for (const l of legacy) {
      db.prepare('DELETE FROM a2a_roster_node_seats WHERE peer_root = ? AND key_fingerprint = ?').run(r.peerRoot, l.key_fingerprint);
      db.prepare('DELETE FROM a2a_roster_nodes WHERE peer_root = ? AND key_fingerprint = ?').run(r.peerRoot, l.key_fingerprint);
    }
    db.prepare(`INSERT INTO a2a_roster_nodes (peer_root, key_fingerprint, host, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_root, key_fingerprint) DO UPDATE SET host = excluded.host, peer_zone = excluded.peer_zone, reported_at = excluded.reported_at, received_at = excluded.received_at`)
      .run(r.peerRoot, r.keyFingerprint, r.host, r.peerZone, r.reportedAt, at);
    const before = db.prepare('SELECT team, seat, role, first_seen_at FROM a2a_roster_node_seats WHERE peer_root = ? AND key_fingerprint = ?').all(r.peerRoot, r.keyFingerprint) as (SeatRow & { first_seen_at: string })[];
    // 同一个（团队、席位）报了两次：取第一次
    const seen = new Set<string>();
    const after = r.seats.filter((s) => { const k = `${s.team}\u0000${s.seat}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const key = (x: { team: string; seat: string }) => `${x.team}\u0000${x.seat}`;
    const beforeKeys = new Set(before.map(key)), afterKeys = new Set(after.map(key));
    const firstSeen = new Map(before.map((b) => [key(b), b.first_seen_at]));
    const log = db.prepare('INSERT INTO a2a_roster_changes (host, peer_root, key_fingerprint, kind, team, seat, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const note = (kind: string, team: string, seat: string, detail: string) => log.run(r.host, r.peerRoot, r.keyFingerprint, kind, team, seat, detail, at);
    const teamsBefore = new Set(before.map((b) => b.team)), teamsAfter = new Set(after.map((a) => a.team));
    for (const t of teamsAfter) if (!teamsBefore.has(t)) note('team-added', t, '', '{}');
    for (const a of after) if (!beforeKeys.has(key(a))) note('seat-added', a.team, a.seat, JSON.stringify({ name: a.name, role: a.role }));
    for (const b of before) if (!afterKeys.has(key(b))) note('seat-removed', b.team, b.seat, JSON.stringify({ role: b.role }));
    for (const t of teamsBefore) if (!teamsAfter.has(t)) note('team-removed', t, '', '{}');
    for (const t of teamsAfter) {
      if (!teamsBefore.has(t)) continue;
      const from = routerOf(before, t), to = routerOf(after, t);
      if (from !== to) note('router-changed', t, to, JSON.stringify({ from, to }));
    }
    db.prepare('DELETE FROM a2a_roster_node_seats WHERE peer_root = ? AND key_fingerprint = ?').run(r.peerRoot, r.keyFingerprint);
    const ins = db.prepare('INSERT INTO a2a_roster_node_seats (peer_root, key_fingerprint, host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const a of after) ins.run(r.peerRoot, r.keyFingerprint, r.host, a.team, a.seat, a.seat_id, a.name, a.role, a.online ? 1 : 0, a.queued, a.last_active_at, firstSeen.get(key(a)) ?? at);
    const shared = (db.prepare('SELECT COUNT(*) AS n FROM a2a_roster_nodes WHERE host = ? AND needs_review = 0').get(r.host) as { n: number }).n > 1;
    db.exec('RELEASE a2a_roster');
    return shared ? 'host-shared' : 'recorded';
  } catch (e) { db.exec('ROLLBACK TO a2a_roster'); db.exec('RELEASE a2a_roster'); throw e; }
}

/**
 * 名册来源的汇总（health 的 a2a.roster 用，不带任何标识）：有几个来源、最久没收下的那个上次收下是什么时候、
 * 超过 staleMs 没收下的有几个。宿主正常每 5 分钟推一次。received_at 只在收下（recorded）时更新。
 */
export function rosterSourceStats(now = Date.now(), staleMs = 15 * 60_000): { sources: number; stalest_received_at: string | null; stale_15m: number } {
  const row = db.prepare('SELECT COUNT(*) AS n, MIN(received_at) AS oldest, SUM(CASE WHEN received_at < ? THEN 1 ELSE 0 END) AS stale FROM a2a_roster_nodes')
    .get(sqlTime(now - staleMs)) as { n: number; oldest: string | null; stale: number | null };
  return { sources: Number(row.n), stalest_received_at: row.oldest ?? null, stale_15m: Number(row.stale ?? 0) };
}

/** 名册里此刻能按 host 匹配的节点标识和根地址（a2a_rosters_live：host ↔ peer_root 一对一）。认事项属于哪个团队时，用投递地址的根地址换 host */
export function rosterHosts(): { host: string; peer_root: string }[] {
  return db.prepare('SELECT host, peer_root FROM a2a_rosters_live').all() as { host: string; peer_root: string }[];
}

/** 这个根地址报过名册、此刻按 host 能匹配上的那台宿主的节点键（a2a_rosters_live）；没有是 null */
export function rosterHostOfRoot(root: string): string | null {
  const row = db.prepare('SELECT host FROM a2a_rosters_live WHERE peer_root = ? ORDER BY received_at DESC LIMIT 1').get(root) as { host: string } | undefined;
  return row?.host ?? null;
}

/** 名册里（host, team）下 seat_id 是这个值的席位；没有是 null */
export function rosterSeatById(host: string, team: string, seatId: string): { seat: string; seat_id: string; name: string; role: RosterSeat['role'] } | null {
  const row = db.prepare(`SELECT s.seat, s.seat_id, s.name, s.role FROM a2a_roster_node_seats s JOIN a2a_rosters_live r ON r.peer_root = s.peer_root AND r.key_fingerprint = s.key_fingerprint
    WHERE r.host = ? AND s.team = ? AND s.seat_id = ? LIMIT 1`).get(host, team, seatId) as { seat: string; seat_id: string; name: string; role: RosterSeat['role'] } | undefined;
  return row ?? null;
}

/** 名册里（host, team）下句柄是这个值的席位的 seat_id（成员换会话以后句柄会变，按收到回执那一刻的名册换）；没有或没带 seat_id 是 '' */
export function rosterSeatIdOf(host: string, team: string, seat: string): string {
  const row = db.prepare(`SELECT s.seat_id FROM a2a_roster_node_seats s JOIN a2a_rosters_live r ON r.peer_root = s.peer_root AND r.key_fingerprint = s.key_fingerprint
    WHERE r.host = ? AND s.team = ? AND s.seat = ? LIMIT 1`).get(host, team, seat) as { seat_id: string } | undefined;
  return row?.seat_id ?? '';
}

/**
 * 名册（按节点、带席位）。缺省只给视图 a2a_rosters_live 里的（按节点号能认的那些）；
 * listed = true：给团队页「这个团队还在不在名册上」用——没标 needs_review、同一个号下只有这一个节点的都给，不看对端此刻的状态
 * （对端停用、等确认新键的节点，它的团队照样在名册上，只是归属核不过、显示「节点换了」）。认人、认归属一律不用它，只经视图
 */
export function rosters(opts: { listed?: boolean } = {}): RosterRow[] {
  const src = opts.listed
    ? `(SELECT r.* FROM a2a_roster_nodes r WHERE r.needs_review = 0 AND (SELECT COUNT(*) FROM a2a_roster_nodes d WHERE d.host = r.host AND d.needs_review = 0) = 1)`
    : 'a2a_rosters_live';
  const hosts = db.prepare(`SELECT host, peer_root, key_fingerprint, peer_zone, reported_at, received_at FROM ${src} ORDER BY peer_zone, host`).all() as Omit<RosterRow, 'seats'>[];
  const seats = db.prepare(`SELECT s.peer_root, s.key_fingerprint, s.team, s.seat, s.seat_id, s.name, s.role, s.online, s.queued, s.last_active_at FROM a2a_roster_node_seats s
    JOIN ${src} r ON r.peer_root = s.peer_root AND r.key_fingerprint = s.key_fingerprint ORDER BY r.host, s.team, s.seat`).all() as { peer_root: string; key_fingerprint: string; team: string; seat: string; seat_id: string; name: string; role: RosterSeat['role']; online: number; queued: number; last_active_at: string }[];
  return hosts.map((h) => ({ ...h, seats: seats.filter((s) => s.peer_root === h.peer_root && s.key_fingerprint === h.key_fingerprint).map((s) => ({ seat: s.seat, seat_id: s.seat_id, name: s.name, team: s.team, role: s.role, online: s.online === 1, queued: s.queued, last_active_at: s.last_active_at })) }));
}

/** 名册的变化记录（最近的在后），after 之后的最多 limit 条 */
export function rosterChanges(after = 0, limit = 200): RosterChange[] {
  return db.prepare('SELECT id, host, kind, team, seat, detail, at FROM a2a_roster_changes WHERE id > ? ORDER BY id LIMIT ?').all(after, limit) as RosterChange[];
}

/** 每个席位手头在办的事项数（事项的承接是它、还没结束的） */
export function activeItemsBySeat(): Map<string, number> {
  const rows = db.prepare("SELECT seat, COUNT(*) AS n FROM work_items WHERE seat <> '' AND state NOT IN ('done','failed','dropped','cancelled') GROUP BY seat").all() as { seat: string; n: number }[];
  return new Map(rows.map((r) => [r.seat, Number(r.n)]));
}
