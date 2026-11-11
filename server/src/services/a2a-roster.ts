/**
 * 阶段七：团队名册（dsh-open-a2a-net#604 P3）的登记与读。SQL 在这里；时间由代码生成后传入。
 * 名册只当信息给人看（团队页、把句柄显示成名字、在岗数），不授予任何东西；在办件数从事项现算，不另存。
 */
import { db } from '../db.ts';
import { sqlTime } from './a2a-replies.ts';

export type RosterSeat = { seat: string; name: string; team: string; role: 'router' | 'member' | 'observer' | ''; online: boolean; queued: number; last_active_at: string };
export type RosterRow = { host: string; peer_root: string; peer_zone: string; reported_at: string; received_at: string; seats: RosterSeat[] };

/** 这个根地址是我们投递过的哪个区的宿主（投递时取名片记下的区）；没投递过返回 null */
export function deliveredPeerZone(root: string): string | null {
  if (root === '') return null;
  const row = db.prepare("SELECT peer_zone FROM a2a_sent_tasks WHERE peer_root = ? AND peer_zone <> '' ORDER BY rowid DESC LIMIT 1").get(root) as { peer_zone: string } | undefined;
  return row?.peer_zone ?? null;
}

/** 记下一台宿主的名册：比已有的新才替换（宿主报的时间），返回 'recorded' 或 'stale' */
export function recordRoster(r: { host: string; peerRoot: string; peerZone: string; reportedAt: string; seats: RosterSeat[]; now?: number }): 'recorded' | 'stale' {
  const info = db.prepare(`INSERT INTO a2a_rosters (host, peer_root, peer_zone, reported_at, received_at, seats) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET peer_root = excluded.peer_root, peer_zone = excluded.peer_zone, reported_at = excluded.reported_at, received_at = excluded.received_at, seats = excluded.seats
    WHERE excluded.reported_at > a2a_rosters.reported_at`).run(r.host, r.peerRoot, r.peerZone, r.reportedAt, sqlTime(r.now), JSON.stringify(r.seats));
  return Number(info.changes) === 1 ? 'recorded' : 'stale';
}

export function rosters(): RosterRow[] {
  return (db.prepare('SELECT host, peer_root, peer_zone, reported_at, received_at, seats FROM a2a_rosters ORDER BY peer_zone, host').all() as (Omit<RosterRow, 'seats'> & { seats: string })[])
    .map((r) => { let seats: RosterSeat[] = []; try { seats = JSON.parse(r.seats); } catch { seats = []; } return { ...r, seats }; });
}

/** 每个席位手头在办的事项数（事项的承接是它、还没结束的） */
export function activeItemsBySeat(): Map<string, number> {
  const rows = db.prepare("SELECT seat, COUNT(*) AS n FROM work_items WHERE seat <> '' AND state NOT IN ('done','failed','dropped','cancelled') GROUP BY seat").all() as { seat: string; n: number }[];
  return new Map(rows.map((r) => [r.seat, Number(r.n)]));
}
