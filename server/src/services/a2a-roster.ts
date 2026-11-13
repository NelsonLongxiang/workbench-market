/**
 * 阶段七：团队名册（dsh-open-a2a-net#604 P3）的登记与读。SQL 在这里；时间由代码生成后传入。
 * 名册只当信息给人看（团队页、把句柄显示成名字、在岗数），不授予任何东西；在办件数从事项现算，不另存。
 *
 * 席位的键是「节点（宿主指纹）+ 团队 + 席位句柄」（14 号文档：团队登记、负责人、分配建在 a2a_roster_seats 上）。
 * 每台宿主每次报的是全量快照：比已有的新才替换；替换时和上一版比，算出变化记进 a2a_roster_changes：
 *   team-added / team-removed  团队出现、消失（这台宿主上）
 *   seat-added / seat-removed  成员出现、消失（某个团队里）
 *   router-changed             团队的总工（role=router 的席位）换了，detail 里有 from、to
 * 只留记录；通知和「等你拍板」由上层做。第一次收到某台宿主的名册时，它的团队和席位都记成 added。
 */
import { db } from '../db.ts';
import { sqlTime } from './a2a-replies.ts';

export type RosterSeat = { seat: string; seat_id: string; name: string; team: string; role: 'router' | 'member' | 'observer' | ''; online: boolean; queued: number; last_active_at: string };
export type RosterRow = { host: string; peer_root: string; peer_zone: string; reported_at: string; received_at: string; seats: RosterSeat[] };
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

/** 记下一台宿主的名册：比已有的新才替换（宿主报的时间），替换时算出变化；返回 'recorded' 或 'stale' */
export function recordRoster(r: { host: string; peerRoot: string; peerZone: string; reportedAt: string; seats: RosterSeat[]; now?: number }): 'recorded' | 'stale' | 'host-conflict' {
  const at = sqlTime(r.now);
  db.exec('SAVEPOINT a2a_roster');
  try {
    const prev = db.prepare('SELECT reported_at, peer_root FROM a2a_rosters WHERE host = ?').get(r.host) as { reported_at: string; peer_root: string } | undefined;
    // 节点键只有 8 位十六进制，能凑出撞键的公钥：已经由别的根地址报过的节点键，换个根地址来报一律不收（不覆盖、不记变化）
    if (prev && prev.peer_root !== r.peerRoot) { db.exec('RELEASE a2a_roster'); return 'host-conflict'; }
    if (prev && !(r.reportedAt > prev.reported_at)) { db.exec('RELEASE a2a_roster'); return 'stale'; }
    db.prepare(`INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET peer_root = excluded.peer_root, peer_zone = excluded.peer_zone, reported_at = excluded.reported_at, received_at = excluded.received_at`)
      .run(r.host, r.peerRoot, r.peerZone, r.reportedAt, at);
    const before = db.prepare('SELECT team, seat, role, first_seen_at FROM a2a_roster_seats WHERE host = ?').all(r.host) as (SeatRow & { first_seen_at: string })[];
    // 同一个（团队、席位）报了两次：取第一次
    const seen = new Set<string>();
    const after = r.seats.filter((s) => { const k = `${s.team}\u0000${s.seat}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const key = (x: { team: string; seat: string }) => `${x.team}\u0000${x.seat}`;
    const beforeKeys = new Set(before.map(key)), afterKeys = new Set(after.map(key));
    const firstSeen = new Map(before.map((b) => [key(b), b.first_seen_at]));
    const log = db.prepare('INSERT INTO a2a_roster_changes (host, kind, team, seat, detail, at) VALUES (?, ?, ?, ?, ?, ?)');
    const teamsBefore = new Set(before.map((b) => b.team)), teamsAfter = new Set(after.map((a) => a.team));
    for (const t of teamsAfter) if (!teamsBefore.has(t)) log.run(r.host, 'team-added', t, '', '{}', at);
    for (const a of after) if (!beforeKeys.has(key(a))) log.run(r.host, 'seat-added', a.team, a.seat, JSON.stringify({ name: a.name, role: a.role }), at);
    for (const b of before) if (!afterKeys.has(key(b))) log.run(r.host, 'seat-removed', b.team, b.seat, JSON.stringify({ role: b.role }), at);
    for (const t of teamsBefore) if (!teamsAfter.has(t)) log.run(r.host, 'team-removed', t, '', '{}', at);
    for (const t of teamsAfter) {
      if (!teamsBefore.has(t)) continue;
      const from = routerOf(before, t), to = routerOf(after, t);
      if (from !== to) log.run(r.host, 'router-changed', t, to, JSON.stringify({ from, to }), at);
    }
    db.prepare('DELETE FROM a2a_roster_seats WHERE host = ?').run(r.host);
    const ins = db.prepare('INSERT INTO a2a_roster_seats (host, team, seat, seat_id, name, role, online, queued, last_active_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const a of after) ins.run(r.host, a.team, a.seat, a.seat_id, a.name, a.role, a.online ? 1 : 0, a.queued, a.last_active_at, firstSeen.get(key(a)) ?? at);
    db.exec('RELEASE a2a_roster');
    return 'recorded';
  } catch (e) { db.exec('ROLLBACK TO a2a_roster'); db.exec('RELEASE a2a_roster'); throw e; }
}

/**
 * 名册来源的汇总（health 的 a2a.roster 用，不带任何标识）：有几个来源、最久没收下的那个上次收下是什么时候、
 * 超过 staleMs 没收下的有几个。宿主正常每 5 分钟推一次。received_at 只在收下（recorded）时更新。
 */
export function rosterSourceStats(now = Date.now(), staleMs = 15 * 60_000): { sources: number; stalest_received_at: string | null; stale_15m: number } {
  const row = db.prepare('SELECT COUNT(*) AS n, MIN(received_at) AS oldest, SUM(CASE WHEN received_at < ? THEN 1 ELSE 0 END) AS stale FROM a2a_rosters')
    .get(sqlTime(now - staleMs)) as { n: number; oldest: string | null; stale: number | null };
  return { sources: Number(row.n), stalest_received_at: row.oldest ?? null, stale_15m: Number(row.stale ?? 0) };
}

/** 名册里的节点标识和根地址（host ↔ peer_root 一对一）。认事项属于哪个团队时，用投递地址的根地址换 host */
export function rosterHosts(): { host: string; peer_root: string }[] {
  return db.prepare('SELECT host, peer_root FROM a2a_rosters').all() as { host: string; peer_root: string }[];
}

/** 这个根地址报过名册的那台宿主的节点键（一个根地址只对一个节点键：同一节点键只认第一次报它的根地址）；没报过是 null */
export function rosterHostOfRoot(root: string): string | null {
  const row = db.prepare('SELECT host FROM a2a_rosters WHERE peer_root = ? ORDER BY received_at DESC LIMIT 1').get(root) as { host: string } | undefined;
  return row?.host ?? null;
}

/** 名册里（host, team）下 seat_id 是这个值的席位；没有是 null */
export function rosterSeatById(host: string, team: string, seatId: string): { seat: string; seat_id: string; name: string; role: RosterSeat['role'] } | null {
  const row = db.prepare('SELECT seat, seat_id, name, role FROM a2a_roster_seats WHERE host = ? AND team = ? AND seat_id = ? LIMIT 1').get(host, team, seatId) as { seat: string; seat_id: string; name: string; role: RosterSeat['role'] } | undefined;
  return row ?? null;
}

/** 名册里（host, team）下句柄是这个值的席位的 seat_id（成员换会话以后句柄会变，按收到回执那一刻的名册换）；没有或没带 seat_id 是 '' */
export function rosterSeatIdOf(host: string, team: string, seat: string): string {
  const row = db.prepare('SELECT seat_id FROM a2a_roster_seats WHERE host = ? AND team = ? AND seat = ? LIMIT 1').get(host, team, seat) as { seat_id: string } | undefined;
  return row?.seat_id ?? '';
}

export function rosters(): RosterRow[] {
  const hosts = db.prepare('SELECT host, peer_root, peer_zone, reported_at, received_at FROM a2a_rosters ORDER BY peer_zone, host').all() as Omit<RosterRow, 'seats'>[];
  const seats = db.prepare('SELECT host, team, seat, seat_id, name, role, online, queued, last_active_at FROM a2a_roster_seats ORDER BY host, team, seat').all() as { host: string; team: string; seat: string; seat_id: string; name: string; role: RosterSeat['role']; online: number; queued: number; last_active_at: string }[];
  return hosts.map((h) => ({ ...h, seats: seats.filter((s) => s.host === h.host).map((s) => ({ seat: s.seat, seat_id: s.seat_id, name: s.name, team: s.team, role: s.role, online: s.online === 1, queued: s.queued, last_active_at: s.last_active_at })) }));
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
