/** Optional same-origin Odoo login relay. It never proxies the Odoo application. */
import express from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { configuredOdooUrl, odooSessionOf, safeLoginRedirect } from './odoo-session.ts';
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
    const upstream = new URL(configuredOdooUrl());
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

/** Hide/disable external Odoo OAuth choices in the relay surface.
 *  Password/TOTP remain; Feishu and Odoo.com OAuth cannot round-trip through this
 *  narrow same-origin relay and previously produced language-prefix redirect loops. */
export function suppressUnsupportedOdooLogins(html: string): string {
  const css = '<style id="wm-hide-odoo-oauth">.o_login_auth{display:none!important;visibility:hidden!important}a[href^="/auth_feishu/login"],a[href*="accounts.odoo.com/oauth2/auth"],a[href^="/auth_oauth/"]{display:none!important;pointer-events:none!important}</style>';
  const script = '<script>(function(){function off(n){n.tabIndex=-1;n.addEventListener(\'click\',function(e){e.preventDefault();e.stopPropagation()},true)}document.querySelectorAll(\'.o_login_auth\').forEach(function(n){n.hidden=true;n.setAttribute(\'aria-hidden\',\'true\');n.querySelectorAll(\'a,button\').forEach(off)});document.querySelectorAll(\'a[href^="/auth_feishu/login"],a[href*="accounts.odoo.com/oauth2/auth"],a[href^="/auth_oauth/"]\').forEach(function(n){n.hidden=true;off(n)})})();</script>';
  let out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + css) : css + html;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, script + '</body>') : out + script;
  return out;
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
        // Odoo redirects browser-language translations to /<lang>/...; that path is outside
        // this narrow relay. Request English only for this read-only endpoint so the login
        // bundle always gets JSON instead of a language redirect.
        if (String(req.url ?? '').split('?')[0] === '/website/translations') proxyReq.setHeader('accept-language', 'en-US,en;q=0.9');
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
              if (safeLoginRedirect(candidate)) next = candidate;
              // Odoo language negotiation: 303 to /<lang>/<same-path> (e.g. /zh_CN/website/translations).
              // Same origin, same resource, language prefix only — not an MFA/OAuth/foreign redirect.
              else if (loginPath !== '/web/login' && loginPath !== '/web/login/totp' && /^\/[a-z]{2}(_[A-Z]{2})?\//.test(u.pathname) && u.pathname.replace(/^\/[a-z]{2}(_[A-Z]{2})?\//, '/') === loginPath) {
                next = candidate;
              }
              else if (u.pathname === '/web/login' || u.pathname === '/web/login/totp') {
                const r = safeLoginRedirect(u.searchParams.get('redirect'));
                next = u.pathname + (r ? '?redirect=' + encodeURIComponent(r) : '');
              }
            }
          } catch { /* refuse */ }
          if (next) proxyRes.headers.location = next;
          else { delete proxyRes.headers.location; proxyRes.statusCode = 502; } // unsupported MFA/OAuth/foreign redirect: fail closed
        }
        // GET login HTML is handled by relayLoginGet below; this hook remains for POST redirects/cookies.
        proxyRes.headers['cache-control'] = 'no-store';
        // no-referrer makes some browsers send Origin: null on form POST; strict-origin
        // keeps the origin for CSRF checks without sending the source path or query.
        proxyRes.headers['referrer-policy'] = 'strict-origin';
        delete proxyRes.headers['service-worker-allowed'];
        // 嵌入策略取交集（direct-871e4312 / direct-237dbde1 / PG 席 direct-5a3a140f）：上游 CSP 头原样保留、一条不改，
        // 另追加一条只含市场 frame-ancestors 的独立 CSP。浏览器对多条 CSP 逐条都要满足，结果只会比上游更严，不会放宽：
        // 上游 XFO 是 DENY、或任一条上游 CSP 的 frame-ancestors 是 'none' → 追加 'none'；其余 → 追加 'self'（挡住别的源）。
        // XFO 只保留上游 DENY，其余 SAMEORIGIN（不支持 frame-ancestors 的旧浏览器靠它）；nosniff 恒设
        // 从 rawHeaders 取上游的每一条 CSP / XFO 头（headers 里重复的头已被 node 用逗号并成一条）
        const raw = (proxyRes as { rawHeaders?: string[] }).rawHeaders ?? [];
        const rawAll = (name: string) => raw.flatMap((v, i) => (i % 2 === 0 && v.toLowerCase() === name ? [String(raw[i + 1])] : []));
        const upstreamCsp = rawAll('content-security-policy');
        // 上游 XFO 只要任一条、任一项（逗号拆开）是 DENY，就按 DENY 算——重复下发的 XFO 不能被认成「没禁」
        const xfoDeny = rawAll('x-frame-options').some((v) => v.split(',').some((t) => t.trim().toUpperCase() === 'DENY'));
        const forbidAll = xfoDeny || upstreamCsp.some((v) => v.split(';').some((d) => /^\s*frame-ancestors\s+'none'\s*$/i.test(d)));
        proxyRes.headers['x-frame-options'] = xfoDeny ? 'DENY' : 'SAMEORIGIN';
        proxyRes.headers['x-content-type-options'] = 'nosniff';
        proxyRes.headers['content-security-policy'] = [...upstreamCsp, `frame-ancestors ${forbidAll ? "'none'" : "'self'"}`] as unknown as string;
      },
    },
  });

  // Fetch the two read-only Odoo login forms directly. This lets us suppress unsupported
  // OAuth controls without intercepting HPM's streamed response; POST still uses the proxy.
  const relayLoginGet = async (req: express.Request, res: express.Response): Promise<void> => {
    const upstreamUrl = new URL(String(req.url ?? '/'), origin);
    const sid = odooSessionOf(String(req.headers.cookie ?? ''));
    const headers: Record<string, string> = { accept: String(req.headers.accept ?? 'text/html'), 'user-agent': String(req.headers['user-agent'] ?? 'workbench-relay') };
    const language = String(req.headers['accept-language'] ?? '');
    if (language) headers['accept-language'] = language;
    if (/^[A-Za-z0-9_.=-]{16,512}$/.test(sid)) headers.cookie = `session_id=${sid}`;
    const upstream = await fetch(upstreamUrl, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const secure = req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
    const sessionCookies = upstream.headers.getSetCookie().filter(c => /^session_id=/i.test(c)).map(c => {
      let v = c.replace(/;\s*(domain|path|samesite)=[^;]*/gi, '');
      if (!/;\s*httponly\b/i.test(v)) v += '; HttpOnly';
      if (secure && !/;\s*secure\b/i.test(v)) v += '; Secure';
      return v + '; Path=/; SameSite=Lax';
    });
    if (sessionCookies.length) res.setHeader('Set-Cookie', sessionCookies);
    const location = upstream.headers.get('location');
    if (location) {
      let next = '';
      try {
        const u = new URL(location, origin);
        if (u.origin === origin && !location.startsWith('//')) {
          const candidate = u.pathname + u.search + u.hash;
          if (safeLoginRedirect(candidate)) next = candidate;
          else if (u.pathname === '/web/login' || u.pathname === '/web/login/totp') {
            const r = safeLoginRedirect(u.searchParams.get('redirect'));
            next = u.pathname + (r ? '?redirect=' + encodeURIComponent(r) : '');
          }
        }
      } catch { /* refuse */ }
      res.setHeader('Cache-Control', 'no-store');
      if (next) { res.setHeader('Location', next); return void res.status(upstream.status).end(); }
      return void res.status(502).type('text').send('Unsupported Odoo login redirect');
    }
    const contentType = String(upstream.headers.get('content-type') ?? 'text/html');
    let body = await upstream.text();
    if (contentType.includes('text/html')) body = suppressUnsupportedOdooLogins(body);
    res.status(upstream.status).type(contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
    if (req.method === 'HEAD') return void res.end();
    return void res.end(body);
  };

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
    // Only the known market destinations (and the portal SSO callback) can be supplied to Odoo as redirect.
    const u = new URL(String(req.url ?? ''), 'http://wm.invalid');
    const r = safeLoginRedirect(u.searchParams.get('redirect'));
    if (u.searchParams.has('redirect')) { u.searchParams.delete('redirect'); if (r) u.searchParams.set('redirect', r); }
    req.url = u.pathname + u.search;
    if ((req.method === 'GET' || req.method === 'HEAD') && (rawPath === '/web/login' || rawPath === '/web/login/totp')) {
      return void relayLoginGet(req, res).catch(() => { if (!res.headersSent) res.status(502).type('text').send('Odoo login unavailable'); });
    }
    const forward = () => proxy(req, res, next);
    if (req.method !== 'POST') return forward();
    return express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 24 })(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).type('text').send('Invalid login request'); // never log or echo form data
      if (req.body && Object.hasOwn(req.body, 'redirect')) {
        const safe = safeLoginRedirect(req.body.redirect);
        if (safe) req.body.redirect = safe; else delete req.body.redirect;
      }
      forward();
    });
  });
}