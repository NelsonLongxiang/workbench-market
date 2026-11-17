/** 门户 SSO 回调票据的 SQLite 存储（契约 identity.ts 的 SsoTicketStore）：重启不丢，同一 DATA_DIR 的多个实例共享同一张表。 */
import { db } from './db.ts';
import type { SsoTicket, SsoTicketStore } from './identity.ts';

export function sqliteSsoTicketStore(): SsoTicketStore {
  const getQ = db.prepare('SELECT wb_id, origin, source, exp FROM sso_tickets WHERE state = ?');
  const putQ = db.prepare('INSERT OR REPLACE INTO sso_tickets (state, wb_id, origin, source, exp) VALUES (?, ?, ?, ?, ?)');
  const takeQ = db.prepare('DELETE FROM sso_tickets WHERE state = ? RETURNING wb_id, origin, source, exp'); // 原子取出：多实例只有一个能拿到
  const expQ = db.prepare('DELETE FROM sso_tickets WHERE exp <= ?');
  const countQ = db.prepare('SELECT COUNT(*) AS n FROM sso_tickets');
  const trimQ = db.prepare('DELETE FROM sso_tickets WHERE state IN (SELECT state FROM sso_tickets ORDER BY exp ASC LIMIT ?)');
  const bySourceQ = db.prepare('SELECT COUNT(*) AS n FROM sso_tickets WHERE source = ? AND exp > ?');
  type Row = { wb_id: number; origin: string; source: string; exp: number } | undefined;
  const ticketOf = (r: Row): SsoTicket | null => (r ? { id: Number(r.wb_id), origin: r.origin, source: r.source, exp: Number(r.exp) } : null);
  return {
    get: (state) => ticketOf(getQ.get(state) as Row),
    put: (state, t) => { putQ.run(state, t.id, t.origin, t.source, t.exp); },
    take: (state) => ticketOf(takeQ.get(state) as Row),
    sweep: (now, max) => {
      expQ.run(now);
      const n = Number((countQ.get() as { n: number }).n);
      if (n > max) trimQ.run(n - max);
    },
    activeBySource: (source, now) => Number((bySourceQ.get(source, now) as { n: number }).n),
  };
}
