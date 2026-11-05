/** Browser-only Odoo login origin. Never changes the proxy target or identity backend. */
import { trustedOdooOrigins } from './odoo-session.ts';

function originOnly(value: string): URL {
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) throw Error('origin required');
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('origin required');
  return u;
}

export function odooBrowserOrigin(): { origin: string; hostname: string; upstream: string } | null {
  if (process.env.WM_ODOO_BROWSER_URL === undefined) return null;
  try {
    const raw = process.env.WM_ODOO_BROWSER_URL;
    if (!raw || raw !== raw.trim() || /[\s\\]/.test(raw)) throw Error('invalid origin');
    const browser = originOnly(raw), upstream = originOnly(String(process.env.LC_ODOO_URL ?? ''));
    if (!trustedOdooOrigins().origins.has(browser.origin)) throw Error('untrusted browser origin');
    return { origin: browser.origin, hostname: browser.hostname.toLowerCase(), upstream: upstream.origin };
  } catch { throw Error('WM_ODOO_BROWSER_URL must be an explicit trusted http(s) origin without credentials, path, query or fragment'); }
}

/** null means the fixed LAN origin cannot safely share a host-only SID with this browser authority. */
export function browserLoginOrigin(target: string, authority: string, configured: ReturnType<typeof odooBrowserOrigin>, secure = false): string | null {
  if (!configured || target !== configured.upstream) return target;
  // A TLS signal is used only to refuse a downgrade, never to authorize a destination.
  if (secure && !configured.origin.startsWith('https:')) return null;
  try {
    const current = new URL('http://' + authority);
    if (current.username || current.password || current.pathname !== '/' || current.search || current.hash || current.hostname.toLowerCase() !== configured.hostname) return null;
    return configured.origin;
  } catch { return null; }
}
