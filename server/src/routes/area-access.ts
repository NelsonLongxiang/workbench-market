/** Approver controls for scoped MCP access requests. Caller identity always comes from login. */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { HttpError } from '../errors.ts';
import { requestPerson } from '../request-person.ts';
import { AREA_ID_RE } from '../services/area.ts';
import { AREA_ACCESS_APPROVE, AREA_ACCESS_LIMIT, AREA_ACCESS_LIST, type AreaAccessService } from '../services/area-access.ts';

const scope = '认登录的人，按领域、申请与授予的当前业务状态判定';
const service = () => svc<AreaAccessService>('areaAccess');

function numeric(raw: unknown): number {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,11}$/.test(raw)) throw new HttpError(400, '路径编号不合法');
  return Number(raw);
}

export function registerAreaAccessRoutes(app: HttpService, crossOriginDenied: (req: express.Request) => boolean,
  publicPerson: (req: express.Request) => string | undefined): void {
  const withPerson = (run: (req: express.Request, actor: string, area: string) => unknown): express.RequestHandler =>
    (req, res, next) => {
      res.set('Cache-Control', 'private, no-store');
      const verified = publicPerson(req);
      if (!verified && crossOriginDenied(req)) { res.status(403).json({ error: 'area_access_cross_origin_denied' }); return; }
      const person = verified ? Promise.resolve({ principal: verified, hasCredential: true }) : requestPerson(req);
      void person.then(who => {
        if (!who.principal) {
          res.status(who.hasCredential ? 403 : 401).json({ error: 'area_access_person_required' });
          return;
        }
        const area = String(req.params.id);
        if (!AREA_ID_RE.test(area)) throw new HttpError(400, '领域标识不合法');
        res.json(run(req, who.principal, area));
      }).catch(next);
    };

  app.get('/api/areas/:id/access-requests', { action: AREA_ACCESS_LIST, kind: 'read', statusNotVerdict: scope },
    withPerson((_req, actor, area) => ({ requests: service().pending(actor, area) })));
  app.put('/api/areas/:id/access-limits/:grantId', { action: AREA_ACCESS_LIMIT, kind: 'decide', statusNotVerdict: scope },
    withPerson((req, actor, area) => ({ limit: service().setLimit(actor, area, numeric(req.params.grantId), req.body?.actions) })));
  app.post('/api/areas/:id/access-requests/:requestId/approve', { action: AREA_ACCESS_APPROVE, kind: 'decide', statusNotVerdict: scope },
    withPerson((req, actor, area) => ({ request: service().decide(actor, area, numeric(req.params.requestId), 'approved', req.body?.note) })));
  app.post('/api/areas/:id/access-requests/:requestId/reject', { action: AREA_ACCESS_APPROVE, kind: 'decide', statusNotVerdict: scope },
    withPerson((req, actor, area) => ({ request: service().decide(actor, area, numeric(req.params.requestId), 'rejected', req.body?.note) })));
}
