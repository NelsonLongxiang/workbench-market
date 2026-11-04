/** Optional same-origin Odoo login relay. It never proxies the Odoo application. */
import express from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { odooSessionOf, safeReturnPath } from './odoo-session.ts';
import { surfaceOf } from './surfaces.ts';

const ASSET = /^\/web\/(?:assets|static)\/[A-Za-z0-9_./~-]+$/;

/** Exact unauthenticated surface shared by login-gate and the proxy. */
export function odooLoginProxyRoute(method: string, pathname: string, enabled = process.env.WM_ODOO_LOGIN_PROXY === '1'): boolean {
  if (!enabled || !pathname.startsWith('/') || pathname.includes('..') || pathname.includes('//') || pathname.includes('%') || pathname.includes('\\')) return false;
  if (pathname === '/web/login' || pathname === '/web/login/totp') return method === 'GET' || method === 'HEAD' || method === 'POST';
  return (method === 'GET' || method === 'HEAD') && (ASSET.test(pathname) || pathname === '/web/binary/company_logo' || pathname === '/website/translations');
}

/** Only the deployment-configured Odoo origin is an upstream. */
function configuredOdooOrigin(): string {
  try {
    const upstream = new URL(String(process.env.WM_ODOO_URL ?? ''));
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || (upstream.pathname !== '/' && upstream.pathname !== '')) throw new Error('origin required');
    return upstream.origin;
  } catch { throw new Error('WM_ODOO_LOGIN_PROXY=1 requires WM_ODOO_URL to be an http(s) origin without credentials or path'); }
}

/** Terminate the exact Odoo session via its authenticated JSON-RPC endpoint.
 *  Never expose the SID or upstream response in logs/errors. */
export async function revokeOdooSession(sid: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.=-]{16,512}$/.test(sid)) return false;
  try {
    const r = await fetch(configuredOdooOrigin() + '/web/session/destroy', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Cookie: 'session_id=' + sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
    });
    if (!r.ok || !r.body) return false;
    const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) { await reader.cancel(); return false; }
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body?.jsonrpc === '2.0' && !body.error && Object.hasOwn(body, 'result') && body.result === null;
  } catch { return false; }
}

/** Install the narrowly scoped same-origin login routes. */
export function installOdooLoginProxy(app: express.Express): void {
  if (process.env.WM_ODOO_LOGIN_PROXY !== '1') return;
  const origin = configuredOdooOrigin();
  const proxy = createProxyMiddleware({
    target: origin, changeOrigin: true, xfwd: false,
    pathFilter: (_path, req) => odooLoginProxyRoute(req.method ?? '', String(req.url ?? '').split('?')[0]),
    on: {
      proxyReq(proxyReq, req) {
        // Never give Odoo unrelated market credentials, including Authorization and X-Admin-Token.
        const allowed = new Set(['host', 'accept', 'accept-language', 'content-type', 'content-length', 'user-agent']);
        for (const h of Object.keys(req.headers)) if (!allowed.has(h.toLowerCase())) proxyReq.removeHeader(h);
        const sid = odooSessionOf(String(req.headers.cookie ?? ''));
        if (/^[A-Za-z0-9_.=-]{16,512}$/.test(sid)) proxyReq.setHeader('cookie', 'session_id=' + sid);
        else proxyReq.removeHeader('cookie');
        proxyReq.setHeader('origin', origin);
        proxyReq.setHeader('accept-encoding', 'identity');
        fixRequestBody(proxyReq, req);
      },
      proxyRes(proxyRes, req) {
        // Only the Odoo session may be issued on the market host. Other upstream cookies
        // must not overwrite market cookies. Preserve expiry; pin scope and protection.
        const secure = (req as express.Request).secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
        const loginPath = String(req.url ?? '').split('?')[0];
        const cookies = (loginPath === '/web/login' || loginPath === '/web/login/totp') ? (proxyRes.headers['set-cookie'] ?? []) : [];
        proxyRes.headers['set-cookie'] = cookies.filter(c => /^session_id=/i.test(c)).map(c => {
          let v = c.replace(/;\s*(domain|path|samesite)=[^;]*/gi, '');
          if (!/;\s*httponly\b/i.test(v)) v += '; HttpOnly';
          if (secure && !/;\s*secure\b/i.test(v)) v += '; Secure';
          return v + '; Path=/; SameSite=Lax';
        });
        if (!proxyRes.headers['set-cookie'].length) delete proxyRes.headers['set-cookie'];
        // Odoo 19 treats redirects as local. Never relay an external location or let a
        // login redirect escape into an unrelated market or Odoo route.
        const loc = proxyRes.headers.location;
        if (loc) {
          let next = '';
          try {
            const u = new URL(loc, origin);
            if (u.origin === origin && !String(loc).startsWith('//')) {
              const candidate = u.pathname + u.search + u.hash;
              if (safeReturnPath(candidate)) next = candidate;
              else if (u.pathname === '/web/login' || u.pathname === '/web/login/totp') {
                const r = safeReturnPath(u.searchParams.get('redirect'));
                next = u.pathname + (r ? '?redirect=' + encodeURIComponent(r) : '');
              }
            }
          } catch { /* refuse */ }
          if (next) proxyRes.headers.location = next;
          else { delete proxyRes.headers.location; proxyRes.statusCode = 502; } // unsupported MFA/OAuth/foreign redirect: fail closed
        }
        proxyRes.headers['cache-control'] = 'no-store';
        // no-referrer makes some browsers send Origin: null on form POST; strict-origin
        // keeps the origin for CSRF checks without sending the source path or query.
        proxyRes.headers['referrer-policy'] = 'strict-origin';
        delete proxyRes.headers['service-worker-allowed'];
      },
    },
  });
  app.use((req, res, next) => {
    const rawPath = String(req.url ?? '').split('?')[0];
    if (!odooLoginProxyRoute(req.method, rawPath)) return next();
    if (surfaceOf(req) !== 'market') return res.status(404).end();
    if (req.method === 'POST') {
      const site = String(req.headers['sec-fetch-site'] ?? '');
      if (site && site !== 'same-origin' && site !== 'none') return res.status(403).end();
      if (req.headers.origin) {
        try { if (new URL(String(req.headers.origin)).host !== String(req.headers.host ?? '')) return res.status(403).end(); }
        catch { return res.status(403).end(); }
      }
      if (!req.is('application/x-www-form-urlencoded')) return res.status(415).end();
    }
    // Only the three known market destinations can be supplied to Odoo as redirect.
    const u = new URL(String(req.url ?? ''), 'http://wm.invalid');
    const r = safeReturnPath(u.searchParams.get('redirect'));
    if (u.searchParams.has('redirect')) { u.searchParams.delete('redirect'); if (r) u.searchParams.set('redirect', r); }
    req.url = u.pathname + u.search;
    const forward = () => proxy(req, res, next);
    if (req.method !== 'POST') return forward();
    return express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 24 })(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).type('text').send('Invalid login request'); // never log or echo form data
      if (req.body && Object.hasOwn(req.body, 'redirect')) {
        const safe = safeReturnPath(req.body.redirect);
        if (safe) req.body.redirect = safe; else delete req.body.redirect;
      }
      forward();
    });
  });
}