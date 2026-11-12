/**
 * 关系的提议（规范 14「关系由谁说了算」，services/relation-proposal.ts）：
 *
 *   GET  /api/relations/proposals              待确认的提议（和最近处理过的），每条带 can_approve / approve_denied_text / can_reject。登录的人、管理员
 *   POST /api/relations/proposals/:id/approve  确认：负责人只有属主；团队认领要管理层或接收部门的负责人
 *   POST /api/relations/proposals/:id/reject   驳回或撤回 { reason }：能确认的人、提议的人、管理员
 *
 * 确认的人大多不是管理员（管理层、部门负责人），所以这两条写不经管理员门：写请求总门对它们放行（index.ts 的 REMOTE_ALLOW_PREFIX），
 * 认人、同源在这里判，能不能确认由服务的 confirmRefusal 判（和页面的 can_approve 同一处）。路由声明「状态码不代表授权」。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { browserMarked, rawLoopback } from '../surfaces.ts';
import { HttpError } from '../errors.ts';
import { identity } from '../identity.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { GrantService } from '../services/grant.ts';
import { CONFIRM_BY, CONFIRM_TEXT, type ProposalActor, type ProposalRow, type RelationProposalService } from '../services/relation-proposal.ts';

export type RelationRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminHeaderOk: (req: express.Request) => boolean;
  adminActor: (req: express.Request) => string;
  crossOriginDenied: (req: express.Request) => boolean;
};

const proposals = () => svc<RelationProposalService>('relationProposals');
const principals = () => svc<PrincipalService>('principals');
const grants = () => svc<GrantService>('grants');
const CONFIRMER_DECIDES = '确认人由提议的种类判（负责人只有属主；团队认领要管理层或接收部门的负责人），按对象的范围，统一判定还不认（L13）';

export function registerRelationRoutes(app: HttpService, deps: RelationRouteDeps): void {
  const route = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
    (req, res, next) => { fn(req, res).catch(next); };

  /** 认人：本机命令行（属主）、管理员（同源）、登录的人（启用的人）。不过就已经写好应答，返回 null */
  async function who(req: express.Request, res: express.Response): Promise<{ actor: ProposalActor; admin: boolean } | null> {
    res.set('Cache-Control', 'private, no-store');
    if (!browserMarked(req) && rawLoopback(req)) return { actor: { by: 'cli', principal: null, owner: true }, admin: true };
    if (deps.crossOriginDenied(req)) { res.status(403).json({ error: 'relations_cross_origin_denied' }); return null; }
    await deps.markOdooAdmin(req);
    const admin = deps.adminHeaderOk(req);
    const cookie = String(req.headers.cookie ?? '');
    const v = cookie ? await identity().resolveViewer(cookie) : null;
    const bound = v && v.ok ? (principals().principalOf(identity().providerName() ?? '', v.viewer.login) ?? v.viewer.sub) : null;
    if (admin) return { actor: { by: deps.adminActor(req), principal: bound, owner: grants().isOwner(bound) }, admin: true };
    if (!bound) { res.status(401).json({ error: 'relations_auth_required' }); return null; }
    const p = principals().get(bound);
    if (!p || p.status !== 'active' || p.kind !== 'person') { res.status(403).json({ error: 'relations_principal_not_active' }); return null; }
    return { actor: { by: bound, principal: bound, owner: grants().isOwner(bound) }, admin: false };
  }
  const idOf = (req: express.Request): number => {
    const raw = String(req.params.id);
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new HttpError(404, `提议 ${raw} 不存在`);
    return Number(raw);
  };
  const shape = (p: ProposalRow, w: { actor: ProposalActor; admin: boolean }) => {
    const no = proposals().confirmRefusal(p, w.actor);
    const mine = p.proposed_by === w.actor.by || (!!w.actor.principal && p.proposed_by_principal === w.actor.principal);
    return {
      ...p, confirm_by_text: CONFIRM_BY[p.kind], can_approve: !no, approve_denied: no?.code ?? null, approve_denied_text: no ? (CONFIRM_TEXT[no.code] ?? no.message) : null,
      can_reject: p.status === 'pending' && (w.admin || mine || !no),
    };
  };
  const logged = (event: string, p: ProposalRow, by: string) =>
    console.log(JSON.stringify({ source: 'relations', event, id: p.id, kind: p.kind, department: p.department_id, host: p.host, team: p.team, principal: p.principal_id, by, at: new Date().toISOString() }));

  app.get('/api/relations/proposals', { action: 'relation.proposal-list', kind: 'read' }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    // 不是管理员的人只看到自己能确认的、自己提的
    const rows = proposals().list().map((p) => shape(p, w)).filter((p) => w.admin || p.can_approve || p.proposed_by_principal === w.actor.principal);
    res.json({ proposals: rows });
  }));

  app.post('/api/relations/proposals/:id/approve', { action: 'relation.proposal-approve', kind: 'decide', statusNotVerdict: CONFIRMER_DECIDES }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    const r = proposals().approve(idOf(req), w.actor, Date.now());
    if (!r.ok) return void res.status(r.http).json({ error: r.code, message: r.message });
    logged('approve', r.proposal, w.actor.by);
    res.json({ proposal: shape(r.proposal, w) });
  }));

  app.post('/api/relations/proposals/:id/reject', { action: 'relation.proposal-reject', kind: 'write', statusNotVerdict: CONFIRMER_DECIDES }, route(async (req, res) => {
    const w = await who(req, res);
    if (!w) return;
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const reason = typeof b.reason === 'string' ? b.reason : '';
    const r = proposals().reject(idOf(req), w.actor, w.admin, reason, Date.now());
    if (!r.ok) return void res.status(r.http).json({ error: r.code, message: r.message });
    logged('reject', r.proposal, w.actor.by);
    res.json({ proposal: shape(r.proposal, w) });
  }));
}
