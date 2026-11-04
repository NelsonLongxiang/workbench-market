/** 门户 SSO 回调票据的 SQLite 存储（odoo-session.ts SsoTicketStore）：重启不丢，同一 DATA_DIR 的多个实例共享同一张表。 */
import { db } from './db.ts';
import type { SsoTicket, SsoTicketStore } from './odoo-session.ts';

export function sqliteSsoTicketStore(): SsoTicketStore {
  const getQ = db.prepare('SELECT wb_id, origin, source, exp FROM sso_tickets WHERE state = ?');
  const putQ = db.prepare('INSERT OR REPLACE INTO sso_tickets (state, wb_id, origin, source, exp) VALUES (?, ?, ?, ?, ?)');
  const delQ = db.prepare('DELETE FROM sso_tickets WHERE state = ?');
  const expQ = db.prepare('DELETE FROM sso_tickets WHERE exp <= ?');
  const countQ = db.prepare('SELECT COUNT(*) AS n FROM sso_tickets');
  const trimQ = db.prepare('DELETE FROM sso_tickets WHERE state IN (SELECT state FROM sso_tickets ORDER BY exp ASC LIMIT ?)');
  const bySourceQ = db.prepare('SELECT COUNT(*) AS n FROM sso_tickets WHERE source = ? AND exp > ?');
  return {
    get: (state) => {
      const r = getQ.get(state) as { wb_id: number; origin: string; source: string; exp: number } | undefined;
      return r ? ({ id: Number(r.wb_id), origin: r.origin, source: r.source, exp: Number(r.exp) } satisfies SsoTicket) : null;
    },
    put: (state, t) => { putQ.run(state, t.id, t.origin, t.source, t.exp); },
    del: (state) => { delQ.run(state); },
    sweep: (now, max) => {
      expQ.run(now);
      const n = Number((countQ.get() as { n: number }).n);
      if (n > max) trimQ.run(n - max);
    },
    activeBySource: (source, now) => Number((bySourceQ.get(source, now) as { n: number }).n),
  };
}
