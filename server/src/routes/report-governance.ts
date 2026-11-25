import type express from 'express';
import type { HttpService } from '../http.ts';
import { HttpError } from '../errors.ts';
import { BenchError } from '../bench-query.ts';
import { requestPerson } from '../request-person.ts';
import { confirmReportGovernance, governanceForbidden, governanceInbox, proposalId, proposeReportGovernance,
  rejectReportGovernance, resultReportGovernance } from '../services/report-governance.ts';

type Deps = {
  wrap: (run: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  session: (req: express.Request) => { id: number } | null;
  crossOriginDenied: (req: express.Request) => boolean;
  enabled: boolean;
};
const SITE_PERSON = '按登录的启用自然人和本台权限确认，不接受管理口令或会话代办';
const SESSION_GATES = '认会话和当前责任人，再以该人授予和操作的精确作用域交集判权';

export function registerReportGovernanceRoutes(app: HttpService, deps: Deps) {
  const wrap = (run: (req: express.Request, res: express.Response) => Promise<unknown>) => deps.wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!deps.enabled) governanceForbidden();
    try { return await run(req, res); }
    catch (error) {
      if (error instanceof BenchError && error.http < 500) throw new HttpError(error.http, error.message, { code: error.code });
      throw error;
    }
  });
  const identity = async (req: express.Request): Promise<string> => {
    if (deps.crossOriginDenied(req) || req.headers['x-admin-token'] !== undefined || req.headers.authorization !== undefined) governanceForbidden();
    const p = await requestPerson(req);
    if (!p.principal) throw new HttpError(401, '请以本站自然人账户登录', { code: 'report_governance_person_required' });
    if (req.method === 'POST' && !req.headers.origin && req.headers['sec-fetch-site'] !== 'same-origin') governanceForbidden();
    return p.principal;
  };
  app.post('/api/report-governance/proposals', { action: 'report.governance-propose', kind: 'decide', statusNotVerdict: SESSION_GATES }, wrap(async (req, res) => {
    res.status(202).json(await proposeReportGovernance(deps.session(req), req.body, 'rest'));
  }));
  app.get('/api/report-governance/proposals/:id', { action: 'report.governance-result', kind: 'read', statusNotVerdict: SESSION_GATES }, wrap(async (req, res) => {
    res.json(resultReportGovernance(deps.session(req), { id: req.params.id }, 'rest'));
  }));
  app.get('/api/report-governance/inbox', { action: 'report.governance-inbox', kind: 'read', statusNotVerdict: SITE_PERSON }, wrap(async (req, res) => {
    const principal = await identity(req);
    const raw = req.query.after;
    if (raw !== undefined && (typeof raw !== 'string' || !/^[0-9]{1,15}$/.test(raw))) throw new HttpError(400, '分页游标无效');
    res.json(governanceInbox(principal, raw ? Number(raw) : 0));
  }));
  app.post('/api/report-governance/inbox/:id/confirm', { action: 'report.governance-confirm', kind: 'decide', statusNotVerdict: SITE_PERSON }, wrap(async (req, res) => {
    const principal = await identity(req);
    const body = req.body;
    if (!body || typeof body.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.snapshot_sha256) || Object.keys(body).length !== 1) {
      throw new HttpError(400, '确认须核对冻结提案的摘要');
    }
    res.json(await confirmReportGovernance(principal, proposalId(req.params.id), body.snapshot_sha256));
  }));
  app.post('/api/report-governance/inbox/:id/reject', { action: 'report.governance-reject', kind: 'decide', statusNotVerdict: SITE_PERSON }, wrap(async (req, res) => {
    res.json(rejectReportGovernance(await identity(req), proposalId(req.params.id)));
  }));
}
