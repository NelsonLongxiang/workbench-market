/**
 * 经验库（/knowledge 页面的接口）：
 *   GET /api/knowledge?kind=claim|kb|skill|verify  这个人看得到的条目（新的在前）。
 *   GET /api/knowledge/status                      同步状态（管理员看：上次成功、上次失败的原因、条数；不带条目内容）。
 *   GET /api/knowledge/:key                        一条的详情（正文现取）。看不到的和不存在的回同一个 404。
 *
 * 认人和拒法（和数据视图同一个口径）：跨站 403；管理口令 403（经验是业务内容，系统管理员缺省看不到）；没登录 401；
 * 登录的人逐条按授予判（services/knowledge.ts 的 visibility）。这两条读路由报的是「按条目的范围判」，状态码不代表授权。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { originIsThisSurface } from '../surfaces.ts';
import { actorResolver } from '../judgment-compare.ts';
import type { JudgedActor } from '../judgment.ts';
import { KINDS, PAGE_KIND, type KnowledgeService, type YglKind } from '../services/knowledge.ts';

export type KnowledgeRouteDeps = {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  adminTokenOk: (req: express.Request) => boolean;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  devOriginOk: (req: express.Request) => boolean;
};

const BY_SCOPE = '按条目的范围判：全公司的认业务的看，部门的认这个部门范围的授予，只给管理层的认拍板类；看不到的和不存在的一样回 404';
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
const knowledge = () => svc<KnowledgeService>('knowledge');

export function registerKnowledgeRoutes(app: HttpService, deps: KnowledgeRouteDeps): void {
  const { wrap } = deps;
  const actorOf = actorResolver({ adminTokenOk: deps.adminTokenOk });

  /** 认人：跨站 403、管理口令 403、没登录 401（已经回了应答，返回 null） */
  async function who(req: express.Request, res: express.Response): Promise<JudgedActor | null> {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !deps.devOriginOk(req))) { res.status(403).json({ error: 'knowledge_cross_origin_denied' }); return null; }
    const { actor } = await actorOf(req);
    if (actor.type === 'builtin' && actor.name === 'admin-token') { res.status(403).json({ error: 'knowledge_admin_token_denied', message: '经验库是业务内容，管理口令看不了；用有授予的账号登录' }); return null; }
    if (actor.type === 'builtin' && actor.name === 'anonymous') { res.status(401).json({ error: 'login_required' }); return null; }
    return actor;
  }

  app.get('/api/knowledge', { action: 'knowledge.list', kind: 'read', statusNotVerdict: BY_SCOPE }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    const raw = req.query.kind;
    let kind: YglKind | undefined;
    if (raw !== undefined) {
      kind = KINDS.find((k) => PAGE_KIND[k] === raw);
      if (!kind) return void res.status(400).json({ error: 'kind_invalid', message: 'kind 只能是 claim、kb、skill、verify' });
    }
    const items = knowledge().list(actor, { kind });
    // 来源的大致状态（不带原因、不带条数）：not_connected「未接入」、not_ready「还在准备」、degraded「可能不是最新的」、ok
    res.json({ items, source: knowledge().sourceState() });
  }));

  // 同步状态：运维信息，不是业务内容，给管理员（口令、身份来源的管理员、本机命令行）
  app.get('/api/knowledge/status', { action: 'knowledge.sync-status', kind: 'admin' }, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!deps.adminGuard(req, res)) return;
    res.json({ kinds: knowledge().status() });
  }));

  app.get('/api/knowledge/:key', { action: 'knowledge.read', kind: 'read', statusNotVerdict: BY_SCOPE }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    const key = String(req.params.key ?? '');
    const missing = () => res.status(404).json({ error: 'knowledge_missing', message: '没有这一条' });
    if (!KEY_RE.test(key)) return void missing();
    const r = await knowledge().show(actor, key);
    if (r === null) return void missing();
    if (r === 'unavailable') return void res.status(503).json({ error: 'knowledge_unavailable', message: '暂时读不到这一条，稍后再试' });
    res.json(r);
  }));
}
