/** #296 terminal content dispatcher. Single process, hard 300s; no sliding renewal.
 * Every admission rechecks the original viewer through the trusted adapter BEFORE
 * reading target credentials or connecting upstream. Never uses browser auth upstream. */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { createContentAccess, contentLaunchPage, type ContentTarget } from './content-access.ts';
import { registerSurface, surfaceOf } from './surfaces.ts';

type Viewer = { subject: string; internal: true };
type Upstream = { url: string; authorization?: string; cookie?: string };
export type ContentSurfaceConfig = { host: string; port: number; marketOrigin: string; targets: (ContentTarget & { upstreamUrl: string })[] };
type Config = ContentSurfaceConfig;
type Deps = {
  viewer: (cookie: string) => Promise<Viewer | null>;
  upstream: (id: number) => Upstream | null;
  now?: () => number;
};
const json = { error: 'content_context_expired' };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const fixedHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };

export function contentConfig(env: NodeJS.ProcessEnv): Config | null {
  if (!env.WM_CONTENT_PORT || env.WM_CONTENT_PORT === '0') return null;
  const port = Number(env.WM_CONTENT_PORT), host = env.WM_CONTENT_IP ?? '', marketOrigin = env.WM_CONTENT_MARKET_ORIGIN ?? '';
  if (!/^[0-9]+$/.test(env.WM_CONTENT_PORT) || !Number.isInteger(port) || port < 1 || port > 65535 || !isIP(host) || ['0.0.0.0','::'].includes(host)) throw Error('Invalid explicit content listener');
  const targets: Config['targets'] = JSON.parse(env.WM_CONTENT_TARGETS ?? '[]');
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 256) throw Error('Explicit content targets required');
  for (const t of targets) {
    if (Number(new URL(t.origin).port || 80) !== port || new URL(t.origin).hostname === new URL(marketOrigin).hostname) throw Error('Content origin port/host mismatch');
    const u = new URL(t.upstreamUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw Error('Invalid pinned upstream');
  }
  createContentAccess(targets, marketOrigin, () => null); // validate hosts, IDs and trusted origin, never an active epoch
  return { host, port, marketOrigin, targets };
}

export function createContentSurface(config: Config, deps: Deps) {
  const now = deps.now ?? Date.now;
  // Odoo SID stays only here; content cookie contains neither SID nor user identity.
  // ponytail: process-local references; multiworker needs a separate atomic/revocation design.
  const viewers = new Map<string, { cookie: string; subject: string; epoch: string; expires: number }>();
  const access = createContentAccess(config.targets, config.marketOrigin, handle => viewers.get(handle)?.epoch ?? null, now);
  const byId = new Map(config.targets.map(t => [t.id, Object.freeze({ ...t })]));
  function sweep() { for (const [h, v] of viewers) if (v.expires <= now()) viewers.delete(h); }
  async function valid(handle: string): Promise<Viewer | null> {
    sweep(); const v = viewers.get(handle); if (!v) return null;
    let who: Viewer | null = null;
    try { who = await deps.viewer(v.cookie); } catch { /* unavailable => deny */ }
    if (!who || who.internal !== true || who.subject !== v.subject || v.expires <= now()) { viewers.delete(handle); return null; }
    return who;
  }
  function expire(req: express.Request, res: express.Response) {
    const target = access.resolve(req);
    const mode = req.headers['sec-fetch-mode'], dest = req.headers['sec-fetch-dest'];
    const navigation = req.headers['x-requested-with'] === undefined && (req.method === 'GET' || req.method === 'HEAD') &&
      ((mode === 'navigate' && dest === 'document') || (!mode && !dest && String(req.headers.accept ?? '').includes('text/html')));
    res.set(fixedHeaders).status(401);
    if (navigation && target) {
      // No reflected request URL or optional return path. Always re-launch this target home.
      const href = config.marketOrigin + '/content/open/' + target.id;
      res.type('html').send('<!doctype html><meta charset="utf-8"><title>Session expired</title><h1>会话已到期</h1><p>请回可信入口重新打开此工作台。</p><a rel="noopener noreferrer" href="' + esc(href) + '">重新打开此工作台</a>');
    } else res.type('json').send(JSON.stringify(json));
  }
  const launchBody = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 2 });
  const handler: express.RequestHandler = (req, res) => { void (async () => {
    res.setHeader('Cache-Control', 'private, no-store');
    const route = access.route(req);
    if (!route) { res.status(404).type('text').send('Not found'); return; }
    if (route === 'launch') {
      if (req.url !== '/__wm/launch' || req.method !== 'POST') { res.status(404).end(); return; }
      await new Promise<void>((resolve, reject) => launchBody(req, res, e => e ? reject(e) : resolve()));
      const result = access.exchange(req, typeof req.body?.ticket === 'string' ? req.body.ticket : '');
      if (!result) { expire(req, res); return; }
      const proof = { ...req, url: result.bouncePath, headers: { ...req.headers, origin: access.resolve(req)!.origin, cookie: result.cookie.split(';')[0] }, rawHeaders: ['Host', String(req.headers.host), 'Origin', access.resolve(req)!.origin, 'Cookie', result.cookie.split(';')[0]] };
      const exchanged = access.admit(proof);
      if (!exchanged || !await valid(exchanged.subject) || !access.admit(proof)) { expire(req, res); return; }
      const page = contentLaunchPage(result.bouncePath);
      res.status(page.status).set(page.headers).set('Set-Cookie', result.cookie).send(page.html); return;
    }
    const admitted = access.admit(req);
    const who = admitted ? await valid(admitted.subject) : null;
    // Odoo request may race a clock/revocation change: re-run core validation after await.
    if (!admitted || !who || !access.admit(req)) { expire(req, res); return; }
    const upstream = deps.upstream(admitted.target.id); // FIRST target credential read
    if (!upstream || upstream.url !== byId.get(admitted.target.id)?.upstreamUrl) { res.status(503).type('json').send('{"error":"content_target_unavailable"}'); return; }
    proxy(req, res, upstream, admitted.target);
  })().catch(() => { if (!res.headersSent) res.status(502).type('json').send('{"error":"content_unavailable"}'); else res.destroy(); }); };
  const launch: express.RequestHandler = (req, res) => { void (async () => {
    res.set(fixedHeaders);
    const match = /^[/]content[/]open[/]([1-9][0-9]*)$/.exec(req.url ?? '');
    const target = match ? byId.get(Number(match[1])) : null;
    if (!target || !['GET', 'HEAD'].includes(req.method) || String(req.headers.host ?? '') !== new URL(config.marketOrigin).host) { res.status(404).end(); return; }
    sweep(); if (viewers.size >= 2048) { res.status(503).end(); return; }
    // Strict adapter parses only a single session_id; never uses target/upstream auth.
    let who: Viewer | null = null;
    const sid = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith('session_id='));
    const cookie = sid.length === 1 && /^session_id=[A-Za-z0-9_.=-]{16,512}$/.test(sid[0]) ? sid[0] : '';
    try { who = await deps.viewer(cookie); } catch { /* fail closed */ }
    if (!who || who.internal !== true) {
      res.status(401).type('html').send('<!doctype html><meta charset="utf-8"><title>Login required</title><p>请先在可信入口登录，再返回此工作台启动页。</p><a href="/lifecycle" rel="noopener noreferrer">前往可信登录入口</a>'); return;
    }
    const handle = randomBytes(32).toString('base64url'), epoch = randomBytes(24).toString('base64url');
    viewers.set(handle, { cookie, subject: who.subject, epoch, expires: now() + 300_000 });
    const ticket = access.issueLaunch(target.id, { subject: handle, internal: true, epoch });
    // Trusted top-level page, explicit button starts cross-site top-level POST in a new noopener tab.
    res.set('Referrer-Policy', 'strict-origin'); // no-referrer would force cross-site POST Origin:null
    res.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action " + target.origin);
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Open workbench</title><form method="post" target="_blank" rel="noopener" action="' + esc(target.origin) + '/__wm/launch"><input type="hidden" name="ticket" value="' + esc(ticket) + '"><button>打开工作台</button></form>');
  })().catch(() => { if (!res.headersSent) res.status(503).end(); }); };
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const admitted = access.admit(req), who = admitted ? await valid(admitted.subject) : null;
    if (!admitted || !who || !access.admit(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' + JSON.stringify(json)); return; }
    const upstream = deps.upstream(admitted.target.id);
    if (!upstream || upstream.url !== byId.get(admitted.target.id)?.upstreamUrl) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    const url = upstreamUrl(req.url ?? '', upstream, admitted.target.id);
    const headers = upstreamHeaders(req, upstream); headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name] as string;
    const q = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', headers });
    socket.once('close', () => q.destroy()); q.once('error', () => socket.destroy()); q.setTimeout(10_000, () => q.destroy());
    q.once('response', r => { r.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    q.once('upgrade', (r, remote, upstreamHead) => {
      const responseHeaders = ['HTTP/1.1 101 Switching Protocols'];
      for (const name of ['upgrade','connection','sec-websocket-accept','sec-websocket-protocol']) if (typeof r.headers[name] === 'string') responseHeaders.push(name + ': ' + r.headers[name]);
      socket.write(responseHeaders.join('\r\n') + '\r\n\r\n'); if (upstreamHead.length) socket.write(upstreamHead); if (head.length) remote.write(head);
      remote.once('error', () => socket.destroy()); socket.once('error', () => remote.destroy()); socket.once('close', () => remote.destroy()); remote.pipe(socket); socket.pipe(remote);
    }); q.end();
  }
  return { access, handler, launch, upgrade };
}
function upstreamUrl(path: string, target: Upstream, id: number) {
  const u = new URL(target.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw Error('Unsupported content target');
  const prefix = new RegExp('^/go/' + id + '(?=/|[?]|$)', 'i');
  const rest = path.replace(prefix, '') || '/';
  const p = rest.indexOf('?');
  u.pathname = u.pathname.replace(/[/]+$/, '') + (p < 0 ? rest : rest.slice(0, p));
  if (p >= 0) u.search = rest.slice(p); return u;
}
function upstreamHeaders(req: IncomingMessage, target: Upstream): Record<string, string> {
  const headers: Record<string, string> = {};
  // No Host/Origin/browser Cookie/Authorization/admin/forwarded headers are copied.
  for (const name of ['accept','accept-language','content-type','content-length','user-agent','range','if-none-match','if-modified-since']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name] as string;
  // Rebuild authority/origin; the browser authority must never reach the upstream.
  if (req.headers.origin !== undefined) headers.origin = new URL(target.url).origin;
  if (target.authorization) headers.authorization = target.authorization;
  if (target.cookie) headers.cookie = target.cookie;
  return headers;
}
function proxy(req: express.Request, res: express.Response, target: Upstream, content: ContentTarget) {
  const url = upstreamUrl(req.url, target, content.id);
  const q = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: req.method, headers: upstreamHeaders(req, target) }, r => {
    res.status(r.statusCode ?? 502);
    r.once('error', () => res.destroy());
    // Dynamic upstream cookie jar intentionally unsupported: never let it overwrite context.
    // Redirects may stay only on this target's content host/path; no cross-target bounce.
    if (r.headers.location) {
      let location: URL; const base = new URL(target.url);
      try { location = new URL(r.headers.location, url); } catch { r.resume(); res.status(502).end(); return; }
      if (location.origin !== base.origin || location.username || location.password || !location.pathname.startsWith(base.pathname.replace(/[/]+$/, '') + '/')) { r.resume(); res.status(502).end(); return; }
      res.setHeader('location', '/go/' + content.id + location.pathname.slice(base.pathname.replace(/[/]+$/, '').length) + location.search);
    }
    for (const name of ['content-type','content-length','content-encoding','content-range','accept-ranges','etag','last-modified']) { const value = r.headers[name]; if (value !== undefined) res.setHeader(name, value); }
    r.pipe(res);
  });
  req.once('aborted', () => q.destroy()); res.once('close', () => q.destroy());
  q.once('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
  q.setTimeout(10_000, () => q.destroy()); req.pipe(q);
}
export function mountContentSurface(app: express.Express, runtime: ReturnType<typeof createContentSurface>) {
  app.use((req, res, next) => { if (surfaceOf(req) !== 'content') return next(); runtime.handler(req, res, next); });
}
export function listenContentSurface(app: express.Express, config: Config, runtime: ReturnType<typeof createContentSurface>) {
  const server = registerSurface(app, 'content', config.port, undefined, config.host);
  server.on('upgrade', (req, socket, head) => { void runtime.upgrade(req, socket, head).catch(() => socket.destroy()); });
  return server;
}
