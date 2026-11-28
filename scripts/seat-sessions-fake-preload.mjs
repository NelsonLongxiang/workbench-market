/** Test-only upstream for the team session replay. All other fetches pass through. */
import { createPrivateKey } from 'node:crypto';
import { signCard } from '@nelsonlongxiang/dsh-open-a2a-net/card';

if (process.env.NODE_ENV !== 'test') throw new Error('seat session fixture requires NODE_ENV=test');
process.env.DSH_VAULT_PASSWORD = 'Replay-only vault password! 2026#Seat';
const origin = 'https://seat-session.synthetic.invalid';
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 47)]), format: 'der', type: 'pkcs8' });
const delegate = 'dshod_synthetic-replay-delegate';
let scope;
const session = 'session-11223344-0000-0000-0000-aabbccddeeff';
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== origin) return fetchOriginal(input, init);
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  const json = (data, status = 200) => Response.json(data, { status });
  if (url.pathname === '/.well-known/agent-card.json' && method === 'GET') {
    return json(signCard({ session: 'replay-node', team: 'fixture', name: 'Replay fixture', expiresAt: Date.now() + 60_000, capabilities: {} }, key));
  }
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.pathname === '/__dsh_a2a/owner-delegates/pair' && method === 'POST') {
    if (body.action === 'start') {
      scope = body.scope;
      return json({ ok: true, id: 'replay-pair', code: 'REPLAY', secret: 'synthetic-one-time-secret', expiresAt: new Date(Date.now() + 60_000).toISOString(), scope });
    }
    if (body.action === 'poll' && body.id === 'replay-pair' && body.secret === 'synthetic-one-time-secret' && scope) {
      return json({ state: 'approved', token: delegate, scope });
    }
  }
  if (headers.get('x-dsh-owner-delegate') !== delegate) return json({ code: 'scope', error: 'missing synthetic delegate' }, 403);
  if (url.pathname === '/__dsh_a2a/user/sessions' && method === 'GET' && url.searchParams.get('team') === 'fixture/11223344') {
    return json({ sessions: [{ id: session, team: 'fixture/11223344', joined: true, live: true, archived: false }], count: 1, truncated: false });
  }
  if (url.pathname === '/__dsh_a2a/user/session' && method === 'GET' && url.searchParams.get('id') === session) {
    return json({ total: 1, from: 0, to: 1, stale: false, entries: [{ i: 0, role: 'user', text: 'replay synthetic transcript' }] });
  }
  if (url.pathname === '/__dsh_a2a/user/session/stop' && method === 'POST' && body.id === session) {
    return json({ stopped: true });
  }
  return json({ ok: false, code: 'fixture_route', error: 'unknown synthetic node route' }, 404);
};
