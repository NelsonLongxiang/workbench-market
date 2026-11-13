/**
 * 经验库（/knowledge 页面的接口）：
 *   GET /api/knowledge?kind=claim|kb|skill|verify  这个人看得到的条目（新的在前）。
 *   GET /api/knowledge/status                      同步状态（管理员看：上次成功、上次失败的原因、条数；不带条目内容）。
 *   GET/PUT /api/knowledge/project-depts           「项目 → 部门」对照（管理层、属主看和改；改了记一行）。
 *   GET /api/knowledge/:key                        一条的详情（正文现取）。看不到的和不存在的回同一个 404。
 *
 * 认人和拒法（和数据视图同一个口径）：跨站 403；管理口令 403（经验是业务内容，系统管理员缺省看不到）；没登录 401；
 * 登录的人逐条按授予判（services/knowledge.ts 的 visibility）。这两条读路由报的是「按条目的范围判」，状态码不代表授权。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { originIsThisSurface } from '../surfaces.ts';
import { actorResolver, migrateOnSight } from '../judgment-compare.ts';
import { judge, type JudgedActor } from '../judgment.ts';
import { KINDS, PAGE_KIND, type KnowledgeService, type YglKind } from '../services/knowledge.ts';
import { parseRemember, rememberAnswer } from '../knowledge-remember.ts';

export type KnowledgeRouteDeps = {
  wrap: (fn: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
  adminTokenOk: (req: express.Request) => boolean;
  devOriginOk: (req: express.Request) => boolean;
};

const BY_SCOPE = '按条目的范围判：全公司的认业务的看，部门的认这个部门范围的授予，只给管理层的认拍板类；看不到的和不存在的一样回 404';
const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
/** 判定出错（判定服务抛错）：安全地拒——回 503，不冒成 500，更不放行 */
const JUDGMENT_DOWN = { error: 'knowledge_judgment_unavailable', message: '暂时判不了谁能看，稍后再试' };
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
    let items;
    try { items = knowledge().list(actor, { kind }); } catch { return void res.status(503).json(JUDGMENT_DOWN); }
    // 来源的大致状态（不带原因、不带条数）：not_connected「未接入」、not_ready「还在准备」、degraded「可能不是最新的」、ok
    res.json({ items, source: knowledge().sourceState() });
  }));

  // 同步状态：运维信息（不带条目内容）。直接按统一判定判，和判定比对零差异：认管理类（knowledge.sync-status）的授予——
  // 管理口令、本机命令行（属主，judgment-builtins.ts 里逐条列了）、持系统管理员预设的人、属主；普通员工、管理层没有。跨站 403、没登录 401
  app.get('/api/knowledge/status', { action: 'knowledge.sync-status', kind: 'admin' }, wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !deps.devOriginOk(req))) return void res.status(403).json({ error: 'knowledge_cross_origin_denied' });
    const { actor, admin } = await actorOf(req);
    // 没登录：直接 401，不进判定（判定出错时匿名也照样是 401）
    if (actor.type === 'builtin' && actor.name === 'anonymous') return void res.status(401).json({ error: 'login_required' });
    let allowed: boolean;
    try {
      // 和判定切换的门同一个口径：身份来源说是管理员的人，第一次见到时迁移出系统管理员预设（同一个人只迁一次），再问判定
      migrateOnSight(actor, admin);
      allowed = judge({ actor, action: 'knowledge.sync-status', kind: 'admin', declared: true }).verdict === 'allow';
    } catch { return void res.status(503).json(JUDGMENT_DOWN); }
    if (!allowed) return void res.status(403).json({ error: 'knowledge_status_denied', message: '同步状态给管理员看' });
    res.json({ kinds: knowledge().status(), writes: knowledge().writeStatus() });
  }));

  // 「项目 → 部门」对照：改它等于改谁能看，所以看和改都只给能对经验库拍板的人（管理层、属主；系统管理员、管理口令不行）。
  // 直接按统一判定判（knowledge.project-depts，拍板类）；跨站 403、没登录 401
  async function decider(req: express.Request, res: express.Response): Promise<JudgedActor | null> {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !deps.devOriginOk(req))) { res.status(403).json({ error: 'knowledge_cross_origin_denied' }); return null; }
    const { actor } = await actorOf(req);
    // 没登录：直接 401，不进判定（判定出错时匿名也照样是 401）
    if (actor.type === 'builtin' && actor.name === 'anonymous') { res.status(401).json({ error: 'login_required' }); return null; }
    let allowed: boolean;
    // 判定出错：安全地拒——回 503，不冒成 500，更不放行
    try { allowed = judge({ actor, action: 'knowledge.project-depts', kind: 'decide', declared: true }).verdict === 'allow'; } catch {
      res.status(503).json({ error: 'knowledge_judgment_unavailable', message: '暂时判不了谁能看，稍后再试' }); return null;
    }
    if (!allowed) {
      res.status(403).json({ error: 'knowledge_project_depts_denied', message: '项目对到哪个部门决定谁能看，只有管理层和属主能看、能改' });
      return null;
    }
    return actor;
  }

  app.get('/api/knowledge/project-depts', { action: 'knowledge.project-depts', kind: 'decide' }, wrap(async (req, res) => {
    if (!(await decider(req, res))) return;
    res.json(knowledge().projectDepts());
  }));

  // 设或清：{ project, department }，department 给 null 是清掉（那个项目的条目回到只给管理层）
  app.put('/api/knowledge/project-depts', { action: 'knowledge.project-depts', kind: 'decide' }, wrap(async (req, res) => {
    const actor = await decider(req, res);
    if (!actor) return;
    const b = req.body as { project?: unknown; department?: unknown } | undefined;
    if (!b || typeof b !== 'object' || typeof b.project !== 'string' || !(b.department === null || typeof b.department === 'string'))
      return void res.status(400).json({ error: 'body_invalid', message: '要 { project: 项目名, department: 部门标识或 null }' });
    const by = actor.type === 'principal' ? actor.id : `builtin:${actor.name}`;
    const r = knowledge().setProjectDept(b.project, b.department as string | null, by, Date.now());
    if (!r.ok) return void res.status(r.error === 'department_missing' ? 404 : 400).json({ error: r.error });
    res.json({ changed: r.changed, ...knowledge().projectDepts() });
  }));

  // 答完以后补记成经验（「我处理过的」里那个入口）：{ source, source_id, lesson, cue?, visibility? }。
  // 跨站 403、管理口令 403、没登录 401；没有对经验库拍板的授予 403；这个人 48 小时内没答过这一条 404（别人答的、没答过的一样）
  app.post('/api/knowledge/remember', { action: 'knowledge.remember', kind: 'decide' }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const source = typeof b.source === 'string' ? b.source : '', sourceId = typeof b.source_id === 'string' ? b.source_id : '';
    if (!source || source.length > 64 || !sourceId || sourceId.length > 300) return void res.status(400).json({ error: 'remember_invalid', message: '要有 source、source_id' });
    const parsed = parseRemember({ lesson: b.lesson, ...(b.cue !== undefined ? { cue: b.cue } : {}), ...(b.visibility !== undefined ? { visibility: b.visibility } : {}) });
    if (!parsed.ok) return void res.status(400).json({ error: 'remember_invalid', message: parsed.message });
    const r = await rememberAnswer(actor, { source, sourceId, ...parsed.value });
    if (!r.ok) return void res.status(r.http).json({ error: r.error, message: r.message });
    res.status(r.outcome.duplicate ? 200 : 201).json({ status: r.outcome.status, duplicate: r.outcome.duplicate, scope_label: r.scope_label });
  }));

  app.get('/api/knowledge/:key', { action: 'knowledge.read', kind: 'read', statusNotVerdict: BY_SCOPE }, wrap(async (req, res) => {
    const actor = await who(req, res);
    if (!actor) return;
    const key = String(req.params.key ?? '');
    const missing = () => res.status(404).json({ error: 'knowledge_missing', message: '没有这一条' });
    if (!KEY_RE.test(key)) return void missing();
    let r: Awaited<ReturnType<KnowledgeService['show']>>;
    try { r = await knowledge().show(actor, key); } catch { return void res.status(503).json(JUDGMENT_DOWN); }
    if (r === null) return void missing();
    if (r === 'unavailable') return void res.status(503).json({ error: 'knowledge_unavailable', message: '暂时读不到这一条，稍后再试' });
    res.json(r);
  }));
}
