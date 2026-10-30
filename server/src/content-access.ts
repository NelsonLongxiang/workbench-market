/** #291 content admission kernel. No listener or production routes registered here.
 * Surface selection belongs to surfaces.ts/localPort; this module only selects
 * a registered target INSIDE that surface. Adapters must gate HTTP and WS with
 * admit() before reading any stored credential or contacting an upstream.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type ContentTarget = Readonly<{ id: number; origin: string }>;
type Request = Pick<IncomingMessage, 'headers' | 'url' | 'method' | 'rawHeaders'>;
type Context = { targetId: number; subject: string; expires: number; epoch: string };
const COOKIE = 'wm_content_context';
const LAUNCH_PATH = '/__wm/launch';

function authority(raw: string): string | null {
  // No credentials, IPs, extra labels, whitespace, forwarded host or URL syntax.
  const match = /^(w-[1-9][0-9]*-(?:test|gray|prod)[.]internal)[.]?(?::([1-9][0-9]{0,4}))?$/i.exec(raw);
  if (!match || (match[2] && Number(match[2]) > 65535)) return null;
  return match[1].toLowerCase() + (match[2] && Number(match[2]) !== 80 ? ':' + match[2] : '');
}
function singleHeader(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw !== 'string') return null;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count === 1 ? raw : null;
}
function exactOrigin(raw: string | null, expected: string): boolean {
  // URL parsing would otherwise accept path/userinfo and silently normalize it.
  return raw === expected;
}

export function createContentAccess(targets: readonly ContentTarget[], marketOrigin: string,
  currentEpoch: (subject: string) => string | null, now: () => number = Date.now) {
  const m = new URL(marketOrigin);
  if (m.origin !== marketOrigin || !['http:', 'https:'].includes(m.protocol)) throw new Error('Invalid trusted market origin');
  const byHost = new Map<string, ContentTarget>();
  const ids = new Set<number>();
  for (const target of targets) {
    const u = new URL(target.origin);
    const host = authority(u.host);
    if (!Number.isSafeInteger(target.id) || target.id < 1 || u.protocol !== 'http:' ||
      u.origin !== target.origin || !host || !u.hostname.startsWith('w-' + target.id + '-') ||
      byHost.has(host) || ids.has(target.id)) throw new Error('Invalid or duplicate content target');
    byHost.set(host, Object.freeze({ ...target })); ids.add(target.id);
  }
  // Process-local secrets/records: restart invalidates all contexts and tickets.
  // ponytail: one process; shared atomic store required before multi-worker use.
  const key = randomBytes(32);
  const tickets = new Map<string, Context>();
  const sessions = new Map<string, Context>();
  const digest = (id: string) => createHmac('sha256', key).update(id).digest('base64url');
  const token = () => randomBytes(32).toString('base64url');
  function sweep() {
    const at = now();
    for (const store of [tickets, sessions]) for (const [id, value] of store) if (value.expires <= at) store.delete(id);
  }
  function resolve(req: Request): ContentTarget | null {
    const host = authority(singleHeader(req, 'host') ?? '');
    if (!host) return null;
    const target = byHost.get(host);
    if (!target) return null;
    const path = req.url ?? '';
    // Reject absolute-form requests rather than letting URL/Host disagree.
    if (!path.startsWith('/') || path.startsWith('//') || path.includes(String.fromCharCode(92)) ||
      [...path].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)) return null;
    // Do not let downstream URL normalization change the target/path interpretation.
    if (path.split('?')[0].split('/').some(p => p === '.' || p === '..' || /%/i.test(p))) return null;
    const portal = /^[/]go[/]([^/?]+)(?:[/?]|$)/.exec(path);
    if (portal && portal[1] !== String(target.id)) return null;
    return target;
  }
  return {
    resolve,
    /** Only the trusted adapter may call this AFTER a fresh strict Odoo internal
     * viewer resolution. There is deliberately no anonymous ticket variant.
     * epoch is an opaque nonsecret revocation reference, never a raw Odoo SID.
     */
    issueLaunch(targetId: number, viewer: { subject: string; internal: boolean; epoch: string }): string {
      sweep();
      if (!ids.has(targetId) || viewer.internal !== true || !viewer.subject || !viewer.epoch ||
        currentEpoch(viewer.subject) !== viewer.epoch) throw new Error('Internal viewer required');
      if (tickets.size >= 4096) throw new Error('Launch capacity reached');
      const id = token();
      tickets.set(id, { targetId, subject: viewer.subject, epoch: viewer.epoch, expires: now() + 60_000 });
      return id;
    },
    /** Top-level cross-site POST only; request body carries the one-use ticket.
     * This endpoint NEVER reads upstream credentials or contacts the upstream.
     */
    exchange(req: Request, ticket: string): { cookie: string; location: string } | null {
      sweep();
      const target = resolve(req);
      if (!target || req.url !== LAUNCH_PATH || req.method !== 'POST' ||
        !exactOrigin(singleHeader(req, 'origin'), marketOrigin)) return null;
      const record = tickets.get(ticket);
      if (!record || record.targetId !== target.id || currentEpoch(record.subject) !== record.epoch || sessions.size >= 4096) return null;
      tickets.delete(ticket); // Consume only after every validation succeeds.
      const id = token();
      sessions.set(id, { ...record, expires: now() + 300_000 });
      return { cookie: COOKIE + '=' + id + '.' + digest(id) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=300', location: '/go/' + target.id + '/' };
    },
    admit(req: Request): { target: ContentTarget; subject: string } | null {
      sweep();
      const target = resolve(req);
      if (!target || req.url?.split('?')[0] === LAUNCH_PATH) return null;
      if (req.headers.origin !== undefined && !exactOrigin(singleHeader(req, 'origin'), target.origin)) return null;
      const cookie = singleHeader(req, 'cookie');
      if (!cookie || cookie.length > 8192) return null;
      const values = cookie.split(';').map(p => p.trim()).filter(p => p.startsWith(COOKIE + '=')).map(p => p.slice(COOKIE.length + 1));
      if (values.length !== 1) return null;
      const pair = /^([A-Za-z0-9_-]{43})[.]([A-Za-z0-9_-]{43})$/.exec(values[0]);
      if (!pair || !timingSafeEqual(Buffer.from(pair[2]), Buffer.from(digest(pair[1])))) return null;
      const record = sessions.get(pair[1]);
      if (!record || record.targetId !== target.id || currentEpoch(record.subject) !== record.epoch) return null;
      // Do not return cookies/keys/credentials. The adapter must strip all browser
      // Cookie/Authorization before building its own target-scoped upstream request.
      return { target, subject: record.subject };
    },
  };
}
