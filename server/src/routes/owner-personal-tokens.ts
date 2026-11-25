import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { addressesPublicMarketHttps, browserMarked, forwarded, originIsThisSurface, rawLoopback, surfaceOf } from '../surfaces.ts';
import { trustedPeer } from '../login-gate.ts';
import { requestPerson } from '../request-person.ts';
import { personalAuthorization } from '../portal-forward-headers.ts';
import { resolveBenchRef } from '../services/bench-registry.ts';
import type { GrantService } from '../services/grant.ts';
import { authenticatePersonalToken, issuePersonalToken, listPersonalTokens, markPersonalTokenUsed, revokePersonalToken, type PersonalToken, type Scope } from '../services/owner-personal-tokens.ts';

const personal = new WeakMap<express.Request, PersonalToken & { authorizedBench?: string }>();
export const personalTokenOf = (req: express.Request) => personal.get(req);
export const personalTokenAuditName = (t: PersonalToken) => '属主（令牌 ' + t.name + '）';

const benchRoutes: [string, RegExp, Scope][] = [
  ['POST', /^query$/, 'bench:read'],
  ['PUT', /^datasets[/][a-z0-9_-]+$/, 'bench:write'],
  ['POST', /^datasets[/][a-z0-9_-]+[/]rows$/, 'bench:write'],
  ['PUT', /^view$/, 'view'],
  ['GET', /^mcp-grants$/, 'grants'],
  ['POST', /^mcp-requests[/][1-9][0-9]{0,8}$/, 'grants'],
  ['GET', /^reports(?:[/][1-9][0-9]{0,8})?$/, 'bench:read'],
  ['PUT', /^reports[/][a-z][a-z0-9-]{0,47}[/]binding$/, 'report-dimensions'],
];
const benchRoute = /^[/]api[/]bench-views[/]([a-z0-9][a-z0-9-]{0,63})[/](.+)$/;
const dimensionRoute = /^[/]api[/]report-dimensions[/][a-z][a-z0-9-]{0,47}[/](?:activate|templates(?:[/][1-9][0-9]{0,8}[/]review)?)$/;
function targetOf(method: string, path: string): { scope: Scope; bench?: string } | null {
  const m = benchRoute.exec(path);
  if (m) {
    const route = benchRoutes.find(([verb, endpoint]) => verb === method && endpoint.test(m[2]));
    return route ? { scope: route[2], bench: resolveBenchRef(m[1]) } : null;
  }
  return method === 'POST' && dimensionRoute.test(path) ? { scope: 'report-dimensions' } : null;
}

function tokenTransport(req: express.Request) {
  const peer = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return rawLoopback(req) || req.secure || (forwarded(req) && trustedPeer(peer) && addressesPublicMarketHttps(req) && req.headers['x-forwarded-proto'] === 'https');
}

/** Presenting a personal token always goes through the scoped admission path. */
export function personalTokenAdmission(isVaultHost: (req: express.Request) => boolean): express.RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!personalAuthorization(header)) return next();
    res.set('Cache-Control', 'private, no-store').vary('Authorization');
    const send = (status: number, error: string, message: string) => { res.status(status).json({ error, message }); };
    const token = /^Bearer (wmu_[A-Za-z0-9_-]{43})$/i.exec(String(header).trim())?.[1];
    const invalid = () => send(401, 'personal_token_unauthorized', '个人令牌无效、已到期或已撤销');
    if (!token || req.headers.cookie !== undefined || req.headers['x-admin-token'] !== undefined) return invalid();
    if (surfaceOf(req) !== 'market' || isVaultHost(req) || browserMarked(req) || !tokenTransport(req)) {
      return send(403, 'personal_token_surface_denied', '个人令牌只能在市场 HTTPS 或本机直连的命令行使用');
    }
    const current = authenticatePersonalToken(token);
    if (!current) return invalid();
    const target = targetOf(req.method, req.path);
    if (!target) return send(403, 'personal_token_route_denied', '这个接口不接受个人令牌');
    if (!current.scopes.includes(target.scope)) return send(403, 'personal_token_scope_denied', '缺少作用域 ' + target.scope);
    if (target.bench && !current.benches.includes(target.bench)) return send(403, 'personal_token_bench_denied', '令牌没有这个台的 ' + target.scope + ' 作用域');
    if (!markPersonalTokenUsed(current.id)) return invalid();
    personal.set(req, { ...current, authorizedBench: target.bench });
    next();
  };
}

export function registerPersonalTokenRoutes(app: HttpService, isVaultHost: (req: express.Request) => boolean): void {
  const guard = (fn: (req: express.Request, res: express.Response, principal: string) => unknown): express.RequestHandler =>
    (req, res, next) => { void (async () => {
      res.set('Cache-Control', 'private, no-store').vary('Cookie');
      const validSurface = surfaceOf(req) === 'market' && !isVaultHost(req);
      const sameOrigin = req.headers['sec-fetch-site'] !== 'cross-site' && (req.headers.origin ? originIsThisSurface(req, true)
        : req.method === 'GET' || req.method === 'HEAD' || (rawLoopback(req) && req.headers['sec-fetch-site'] === 'same-origin'));
      if (!validSurface || !sameOrigin || req.headers.authorization !== undefined || req.headers['x-admin-token'] !== undefined) {
        return res.status(403).json({ error: 'personal_token_owner_session_required' });
      }
      const { principal } = await requestPerson(req);
      if (!principal) return res.status(401).json({ error: 'personal_token_login_required' });
      if (!tokenTransport(req)) return res.status(403).json({ error: 'personal_token_surface_denied' });
      if (!svc<GrantService>('grants').isOwner(principal)) return res.status(403).json({ error: 'personal_token_owner_required' });
      return fn(req, res, principal);
    })().catch(next); };
  app.get('/api/owner/personal-tokens', { action: 'auth.personal-token-list', kind: 'read', statusNotVerdict: '只认属主本人登录' }, guard((_req, res, principal) => res.json({ personal_tokens: listPersonalTokens(principal) })));
  app.post('/api/owner/personal-tokens', { action: 'auth.personal-token-issue', kind: 'decide', statusNotVerdict: '只认同源属主本人登录' }, guard((req, res, principal) => res.status(201).json(issuePersonalToken(principal, req.body))));
  app.delete('/api/owner/personal-tokens/:id', { action: 'auth.personal-token-revoke', kind: 'decide', statusNotVerdict: '只认同源属主本人登录' }, guard((req, res, principal) => {
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f-]{36}$/.test(id) || !revokePersonalToken(principal, id)) return res.status(404).json({ error: 'personal_token_missing' });
    res.status(204).end();
  }));
}
