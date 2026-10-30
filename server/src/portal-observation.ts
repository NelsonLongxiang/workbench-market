/** #291 passive inventory. No listener, response, auth or header mutation; caller owns enablement.
 * Only fixed category + registered numeric target + UTC day + count are persisted.
 * UA/Fetch hints are untrusted migration clues, never identity or authorization.
 */
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

export const PORTAL_CLIENT_CLASSES = [
  'browser-top-navigation', 'browser-iframe', 'browser-fetch',
  'curl', 'node', 'python', 'mcp-client', 'other',
] as const;
export type PortalClientClass = typeof PORTAL_CLIENT_CLASSES[number];
type Headers = IncomingMessage['headers'];

export function portalClientClass(headers: Headers): PortalClientClass {
  const one = (name: string) => typeof headers[name] === 'string' ? headers[name] as string : '';
  const mode = one('sec-fetch-mode'), dest = one('sec-fetch-dest');
  const ua = one('user-agent').slice(0, 1024);
  // Contradictory/partial hints do not acquire a browser identity.
  if (mode === 'navigate' && dest === 'document') return 'browser-top-navigation';
  if (mode === 'navigate' && dest === 'iframe') return 'browser-iframe';
  if ((mode === 'cors' || mode === 'same-origin') && dest === 'empty') return 'browser-fetch';
  // Node/undici adds mode=cors but no dest/site; observation only, not auth.
  if (mode === 'cors' && !dest && !one('sec-fetch-site') && /^(node|undici)(?:[/ ]|$)/i.test(ua)) return 'node';
  if (mode || dest || one('sec-fetch-site')) return 'other';
  if (/curl[/]/i.test(ua)) return 'curl';
  if (/python|requests|httpx|aiohttp/i.test(ua)) return 'python';
  if (/mcp[- /]|modelcontextprotocol/i.test(ua)) return 'mcp-client';
  if (/node|undici/i.test(ua)) return 'node';
  // HTTP browsers often omit Fetch Metadata: do not call them machine clients.
  return 'other';
}

export function portalTargetId(url: string): number | null {
  const match = /^[/]go[/]([1-9][0-9]*)(?:[/?]|$)/.exec(url);
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

/** Construct only on an explicitly selected observation DB. Never imports the live db.
 * Call observe once at HTTP ingress OR upgrade ingress, not in proxy hooks as well.
 * Writes are synchronous (no lossy memory flush); failure never blocks old traffic,
 * but permanently marks this observer incomplete until operational reconciliation.
 */
export function createPortalObservation(db: DatabaseSync, registered: (id: number) => boolean,
  now: () => Date = () => new Date()) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS portal_observation_counts (' +
    'target_id INTEGER NOT NULL CHECK(target_id>0), client_class TEXT NOT NULL CHECK(client_class IN (' +
    PORTAL_CLIENT_CLASSES.map(c => "'" + c + "'").join(',') +
    ')), utc_day TEXT NOT NULL, hits INTEGER NOT NULL CHECK(hits>0),' +
    'PRIMARY KEY(target_id,client_class,utc_day))'
  );
  const increment = db.prepare('INSERT INTO portal_observation_counts VALUES(?,?,?,1) ' +
    'ON CONFLICT(target_id,client_class,utc_day) DO UPDATE SET hits=hits+1');
  const startedAt = now().toISOString();
  let failures = 0, lastSuccessAt: string | null = null;
  return {
    observe(req: Pick<IncomingMessage, 'url' | 'headers'>): boolean {
      try {
        const id = portalTargetId(req.url ?? '');
        if (id === null || !registered(id)) return false;
        const at = now().toISOString();
        increment.run(id, portalClientClass(req.headers), at.slice(0, 10));
        lastSuccessAt = at;
        return true;
      } catch {
        // No raw exception: sqlite/request errors may contain caller material.
        failures++;
        return false;
      }
    },
    status() { return { startedAt, lastSuccessAt, failures, writesHealthy: failures === 0, coverageVerified: false }; },
    counts() {
      return db.prepare('SELECT target_id,client_class,utc_day,hits FROM portal_observation_counts ' +
        'ORDER BY utc_day,target_id,client_class').all();
    },
  };
}
