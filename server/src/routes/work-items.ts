/**
 * 事项的读（阶段八 8d 界面要用）：GET /api/work-items/:id 返回一件事项和它的事项日志，事项页的时间线直接渲染日志。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。可见性和「关注」里事项这个来源同一个口径：
 *   管理员（口令或会话登录）看全部；登录的人只看自己建立的（只认事项上的建立人主体，isCreator；建立人主体空着的只有管理员看得到）；
 *   别的一律 404（不说有没有这件事项）；没登录 401。
 * 跨站、别的站的页面来的请求拒。
 *
 * 事项上的 outputs（结果）和 evidence（依据）：字符串字段，内容约定是 JSON 数组。
 *   evidence 每项只有 { kind, id }；outputs 每项是 { kind, id, title, submitted_by, at }：
 *     kind、id   和回执信封里的 artifacts 同一个形状，清洗规则只有一处（非空字符串，各 ≤200 字，最多 16 项）
 *     title      对端给的文件名或一句说明，清洗同进展摘要、≤200 字，只当显示文字；上游 artifacts 现在没有这个键，先一直是 null
 *     submitted_by  这条回执信封里的 by.seat（≤200 字）；对端自报，只显示、不授予任何东西；by.name 是显示名，不当身份用
 *     at         市场采信这条回执、写事件日志那一刻的时间（服务端生成，YYYY-MM-DD hh:mm:ss），不用对端报的时间
 *   按 kind+id 去重，第一次交的那条为准；后来才带上的 title 补上。旧数据、对端没给的，title、submitted_by、at 是 null，不回填。
 *   · 只存标识和显示文字，不存正文、不存 url（evidence 只存标识，见 02 号文档）。页面按 kind 自己拼本站的链接，不跟随数据里的地址。
 *   · 上游没有定死 kind 的取值表；目前约定 sop-run（id 写成 <SOP slug>/<run id>，链到 /sops/<slug>/runs/<run id>）、
 *     table（台数据）、file（文件），别的值原样存。id 是市场里的标识，对端不校验存不存在。
 *     table、file 现在还没有对应的详情页，页面先只显示 kind 和 id，不出链接；不认得的 kind 一样只显示。
 *   · 能不能点开，由目标页面按看的人自己的权限判。这里只给标识，不因为事项里写了编号就把目标内容带出来。
 *   · 老库里 outputs 的缺省值是 '{}'，当空数组读。
 *   · 谁写：采信的回执（进展、只记录、终局都算）带了 artifacts，事项服务应用这条事实时并进 outputs，按 kind+id 去重，
 *     上限 16（阶段七接上，清洗函数在事项服务里只留一处）。接上之前 outputs 是空的，artifacts 只在事项日志那一行的 detail 里。
 *     evidence 目前没有写入方。
 *
 * 8e：POST /api/work-items/:id/decision——建立人本人验收、退回自己的事项。这一个入口不经管理门
 * （index.ts 的写请求总门对它放行，只放这一条路径）；认人、同源、主体是不是启用的人在这里判，
 * 「是不是这件事项的建立人、能不能由建立人答、是不是等验收」由事项服务判。只收 verify、return 两种。
 *
 * 阶段七 R2：事项对话里的席位消息（跟进）。读接口带出 messages 和 unread；两个写入口：
 *   POST /api/work-items/:id/messages/read          看过：未读的标成已读
 *   POST /api/work-items/:id/messages/:mid/reply    回复：同一 context 的新任务发回发消息的团队
 *   POST /api/work-items/:id/asks/:qid/answer       回答这件事项上的一条席位提问（qid = 详情里 asks[].id；{ answer?, text? }；同一 context 的新任务发回）
 * 谁能写和 decision 同一个口径再加管理员：管理员；或者建立人本人（启用的人、事项可由建立人处理）。
 * 和 decision 一样经写请求总门放行这两条子路径，认人在这里做；别的人一律 404（不说有没有这件事项）。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity, IDENTITY_UNAVAILABLE, sourceDown } from '../identity.ts';
import { COCKPIT_ID_MAX, dueAtOf, isCreator, overdueOf, STATES, type WorkItemService, type WorkItemState } from '../services/work-item.ts';
import type { PrincipalService } from '../services/principal.ts';
import type { TeamService } from '../services/team.ts';
import { answerItemAsk, CREATOR_ANSWERS, decideItemAnswer } from '../attention-answers.ts';
import { markSeatMessagesRead, replySeatMessage, seatAsksOf, seatMessagesOf, seatProgressOf, seatSubitemsOf, SEAT_REPLY_MAX } from '../seat-messages.ts';
import { principalsAdmin } from './principals.ts';
import { canOf, canSee, creatorOf, decidesNow, itemDecisionVerdict, itemRoles, releaseBy, turnOf, VIEW_ALL_ACTION, VIEW_ALL_KIND, VIEWS, viewScopes, workItemViewer, writerVerdict, type ItemRole, type ViewName } from '../work-item-access.ts';
import { arrangeTask } from '../task-center.ts';
import { assignableTeams, kickWorkbenchEvents, logEventFact, releaseCore } from '../workbench-events.ts';
import { eventOfItem } from '../seat-messages.ts';
import { attachmentsOfEvent } from '../services/work-item-attachments.ts';
import { deliveryTarget, eventDispatched, inReplyTx, liveDeliveriesOfEvent, queueReply } from '../services/a2a-replies.ts';

export type WorkItemRouteDeps = {
  markOdooAdmin: (req: express.Request) => Promise<void>;
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  crossOriginDenied: (req: express.Request) => boolean;
};

const ITEM_ID = /^wi_[A-Za-z0-9_-]{1,96}$/;

/** 不落地的应答：管理门判不过时写的 403 写到这里 */
function silentRes(): express.Response {
  const res: Record<string, unknown> = { statusCode: 200 };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = () => res;
  return res as unknown as express.Response;
}

/** 席位消息的已读与回复：建立人本人或管理员能做，是事项上的规则（判定这一步还不知道落在哪件事项上），401、403、404 不拿来和统一判定比 */
const SEAT_WRITER_DECIDES = '按事项的建立人判：建立人本人或管理员，是事项上的规则不是角色授权';
/** 建立人验收、退回自己的事项：只有这件事项的建立人本人能答，是事项上的规则；判定这一步还不知道落在哪件事项上 */
const CREATOR_DECIDES = '按事项判：建立人本人验收、退回；负责人可退回本团队的；持有管理层授予的人代办，是事项上的规则不是角色授权';
/** 回复席位消息：替人做决定的动作，和验收同一处判（itemDecisionVerdict） */
const ITEM_REPLY_DECIDES = '按事项判：建立人本人回复；持有管理层授予的人代办（过了管理门不算），是事项上的规则不是角色授权';
/** 放行：团队的负责人（缺位时管理层代办），是事项上的规则；判定这一步还不知道落在哪件事项上 */
const LEAD_RELEASES = '按事项交给的团队判：负责人放行，团队没有负责人时持有管理层授予的人代办，是事项上的规则不是角色授权';

export function registerWorkItemRoutes(app: HttpService, deps: WorkItemRouteDeps): void {
  // 列表：GET /api/work-items?state=&object=&phase=&limit=&cursor=。可见范围和详情同一个判断（管理员看全部，别人只看自己是建立人的），
  // 看不到的不出现也不计数。按 updated_at、id 倒序，游标翻页（limit 缺省 100、上限 200）；另带可见范围里按状态的计数
  app.get('/api/work-items', { action: 'work-items.list', kind: 'read', unauthenticated: 401, refine: [{ action: VIEW_ALL_ACTION, kind: VIEW_ALL_KIND, why: '「全部」视角只给管理层（按动作认，不按角色名；类别见 VIEW_ALL_KIND）', when: (req) => req.query.view === 'all' }] }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const q = req.query as Record<string, unknown>;
    const str = (k: string) => (typeof q[k] === 'string' ? q[k] as string : undefined);
    const state = str('state');
    if (state !== undefined && !(STATES as readonly string[]).includes(state)) return void res.status(400).json({ error: 'work_items_state_invalid' });
    for (const k of ['object', 'phase']) if (str(k) !== undefined && str(k)!.length > 200) return void res.status(400).json({ error: `work_items_${k}_invalid` });
    const limitRaw = str('limit');
    const limit = limitRaw === undefined ? 100 : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!(limit >= 1 && limit <= 200)) return void res.status(400).json({ error: 'work_items_limit_invalid' });
    let after: { updated_at: string; id: string } | undefined;
    const cursor = str('cursor');
    if (cursor !== undefined) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { u?: unknown; i?: unknown };
        if (typeof c.u !== 'string' || typeof c.i !== 'string' || !ITEM_ID.test(c.i) || c.u.length > 40) throw new Error('bad');
        after = { updated_at: c.u, id: c.i };
      } catch { return void res.status(400).json({ error: 'work_items_cursor_invalid' }); }
    }
    const viewRaw = str('view');
    if (viewRaw !== undefined && !(VIEWS as readonly string[]).includes(viewRaw)) return void res.status(400).json({ error: 'work_items_view_invalid' });
    const seat = str('seat');
    if (seat !== undefined && (seat === '' || seat.length > 200)) return void res.status(400).json({ error: 'work_items_seat_invalid' });
    // 按驾驶舱筛（驾驶舱的 id）：只有形状不对才 400；不存在的驾驶舱回空列表
    const cockpitRaw = str('cockpit');
    if (cockpitRaw !== undefined && (!/^[1-9]\d{0,9}$/.test(cockpitRaw) || Number(cockpitRaw) > COCKPIT_ID_MAX)) return void res.status(400).json({ error: 'work_items_cockpit_invalid' });
    const cockpit = cockpitRaw === undefined ? undefined : Number(cockpitRaw);
    (async () => {
      const viewer = await workItemViewer(req, deps);
      if (!viewer.admin && !viewer.principal) return void (viewer.sourceDown ? res.status(502).json({ error: IDENTITY_UNAVAILABLE }) : res.status(401).json({ error: 'work_items_auth_required' }));
      // 视角（规范 14 第九节第 4 条）：服务端按身份给出哪些视角可用、各几件；不带 view 时落在第一个有内容的（都没有就第一个可用的）
      const scopes = viewScopes(viewer);
      const items = svc<WorkItemService>('workItems');
      // decide：这个视角里轮到看的人、能当场办的件数（decidesNow，和「关注」里事项来源的 mine、答法同一处判，侧栏角标数的就是这些）。
      // 先只取可能轮到他的候选（他建的、他负责的团队里等过目的），逐件判一次；各视角只和自己的范围求交，
      // 再按 itemRoles 过一遍这个视角对应的那种人（和下面的列表同一个口径）。不可用的视角不给 decide
      const roleOf: Record<ViewName, ItemRole> = { mine: 'creator', seats: 'owner', team: 'lead', all: 'management' };
      const now = viewer.principal ? items.turnCandidates(viewer.principal, scopes.team).filter((w) => decidesNow(w, viewer)) : [];
      const decideIn = (v: ViewName) => {
        if (!now.length) return 0;
        const inScope = items.idsIn(scopes[v]!, now.map((w) => w.id));
        return now.filter((w) => inScope.has(w.id) && itemRoles(w, viewer).includes(roleOf[v])).length;
      };
      const views = Object.fromEntries(VIEWS.map((v) => [v, scopes[v] ? { available: true, count: items.countIn(scopes[v]!), decide: decideIn(v) } : { available: false, count: 0 }])) as Record<ViewName, { available: boolean; count: number; decide?: number }>;
      if (viewRaw !== undefined && !scopes[viewRaw as ViewName]) return void res.status(403).json({ error: 'work_items_view_unavailable', views });
      const view = (viewRaw as ViewName | undefined) ?? VIEWS.find((v) => views[v].available && views[v].count > 0) ?? VIEWS.find((v) => views[v].available);
      if (!view) return void res.json({ view: null, views, items: [], counts: Object.fromEntries(STATES.map((st) => [st, 0])), total: 0, next_cursor: null });
      const page = items.page({ scope: scopes[view]!, state: state as WorkItemState | undefined, object: str('object'), phase: str('phase'), seat, cockpit, limit, after });
      // 视角的 SQL 只是加速：筛出来的每一条再按 itemRoles 过一遍，这个视角对应的那种人不成立的不给（列表里有、详情 404 的情况不允许出现）。
      // SQL 和 itemRoles 同一个口径时这里一条都不会少；计数照 SQL，测试守「列表里每一条详情都是 200」和件数一致
      const shown = page.items.filter((w) => itemRoles(w, viewer).includes(roleOf[view]));
      // 等谁放行：这一页有 held 的才取一次全部团队视图（负责人名字按看的人裁）
      const teamViews = shown.some((w) => w.state === 'held') ? svc<TeamService>('teams').allViews() : [];
      const nowMs = Date.now();
      res.json({
        view, views,
        items: shown.map((w) => ({
          id: w.id, title: w.title, state: w.state, object: w.object, phase: w.phase, seat: w.seat, cockpit_id: w.cockpit_id,
          last_progress: w.last_log, updated_at: w.updated_at, due: w.due_at ? w.due_at.slice(0, 10) : null, overdue: overdueOf(w, nowMs), release_by: releaseBy(w, viewer, teamViews),
        })),
        counts: page.counts, total: page.total,
        next_cursor: page.next ? Buffer.from(JSON.stringify({ u: page.next.updated_at, i: page.next.id }), 'utf8').toString('base64url') : null,
      });
    })().catch(next);
  });

  /**
   * 认登录的人（「安排一件事」的两个入口用）：只经身份服务认 cookie，主体须是启用的人。请求体里自报的谁都不看。
   * 判不过就写好应答返回 null：没登录、认不出 401，主体不是启用的人 403。
   */
  async function person(req: express.Request, res: express.Response): Promise<string | null> {
    const cookie = String(req.headers.cookie ?? '');
    if (!cookie) { res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    const who = await identity().resolveViewer(cookie);
    if (!who.ok) { if (sourceDown(who)) res.status(502).json({ error: IDENTITY_UNAVAILABLE }); else res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    const principal = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | undefined;
    if (!principal || principal.kind !== 'person' || principal.status !== 'active') { res.status(403).json({ error: 'work_items_principal_not_active' }); return null; }
    return who.viewer.sub;
  }

  // 「安排一件事」能派给的团队：绑在任务中心上的通知绑定（和建事项时的校验同一个函数）。管理员和登录的人能读。名册落地前 name 就是团队标识
  app.get('/api/work-items/teams', { action: 'work-items.teams', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    (async () => {
      await deps.markOdooAdmin(req);
      if (!deps.adminGuard(req, silentRes()) && !(await person(req, res))) return;
      res.json({ teams: assignableTeams().map((t) => ({ team: t.agent_node, name: t.agent_node })) });
    })().catch(next);
  });

  // 「安排一件事」：登录的人直接建一件事项，建立人是本人。只认 cookie 认出的启用的人（口令、命令行、MCP 都不是人，不能用）。
  // 写请求总门对这一条路径放行（index.ts），认人在这里；规则（派给、先过目、幂等、限流）在 task-center.ts 的 arrangeTask
  app.post('/api/work-items', { action: 'work-items.create', kind: 'write', unauthenticated: 401 }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    (async () => {
      const requester = await person(req, res);
      if (!requester) return;
      const out = arrangeTask(req.body, requester);
      res.status(out.status).json(out.body);
      if (out.status === 201 && out.body.held === false) kickWorkbenchEvents();
    })().catch(next);
  });

  app.get('/api/work-items/:id', { action: 'work-item.read', kind: 'read', unauthenticated: 401 }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    (async () => {
      const items = svc<WorkItemService>('workItems');
      const viewer = await workItemViewer(req, deps);
      if (!viewer.admin && !viewer.principal) return void (viewer.sourceDown ? res.status(502).json({ error: IDENTITY_UNAVAILABLE }) : res.status(401).json({ error: 'work_items_auth_required' }));
      // 看得到的：建立人、成员的主人、负责人、管理层（itemRoles，规范 14 第九节第 1 条）。别的一律 404，不说有没有这件
      const item = items.get(id);
      if (!item || !canSee(item, viewer)) return void res.status(404).json({ error: 'work_item_not_found' });
      // 只增：这个人能做什么（can）、是不是轮到他（turn）、建立人是谁（creator）。判断都在 work-item-access.ts，和各动作接口同一处
      res.json({ item, due: item.due_at ? item.due_at.slice(0, 10) : null, overdue: overdueOf(item), attachments: attachmentsOfEvent(item.source_ref).map((a) => ({ name: a.name, size: a.size, url: `/api/work-items/${id}/attachments/${a.id}`, id: a.id, mime: a.mime, sha256: a.sha256 })), log: items.log(id), ...seatMessagesOf(item), progress: seatProgressOf(item), subitems: seatSubitemsOf(item), asks: seatAsksOf(item), can: canOf(item, viewer), turn: turnOf(item, viewer), creator: creatorOf(item), release_by: releaseBy(item, viewer) });
    })().catch(next);
  });

  /**
   * 写席位消息的人：管理员（记管理员的名字），或者这件事项的建立人本人（启用的人、事项可由建立人处理）。
   * 判不过就已经写好应答并返回 null：没登录 401，看不到 404，主体没启用 403。
   */
  async function seatWriter(req: express.Request, res: express.Response, id: string): Promise<{ actor: string; item: NonNullable<ReturnType<WorkItemService['get']>> } | null> {
    const viewer = await workItemViewer(req, deps);
    const verdict = writerVerdict(viewer, id);
    const items = svc<WorkItemService>('workItems');
    if (verdict === 'unauthenticated') { if (viewer.sourceDown) res.status(502).json({ error: IDENTITY_UNAVAILABLE }); else res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    if (verdict === 'not_found') { res.status(404).json({ error: 'work_item_not_found' }); return null; }
    if (verdict === 'inactive') { res.status(403).json({ error: 'work_items_principal_not_active' }); return null; }
    if (verdict === 'not_eligible') { res.status(403).json({ error: 'work_item_creator_not_eligible' }); return null; }
    const item = items.get(id);
    if (!item) { res.status(404).json({ error: 'work_item_not_found' }); return null; }
    if (verdict === 'admin') return { actor: (principalsAdmin ? await principalsAdmin(req, silentRes()) : null) || 'admin', item };
    return { actor: viewer.principal!, item };
  }

  // 阶段七：回答事项上的一条席位提问（建立人本人，或持有管理层授予的人代办；只过了管理门的不能答——itemDecisionVerdict，和详情的 can.answer 同一处）。
  // 请求体只读 answer、text，别的字段（自报的主体、建立人、答法）一概不看
  app.post('/api/work-items/:id/asks/:qid/answer', { action: 'work-items.asks-answer', kind: 'decide', statusNotVerdict: SEAT_WRITER_DECIDES }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    const qid = String(req.params.qid ?? '');
    if (!/^[1-9]\d{0,15}$/.test(qid)) return void res.status(400).json({ error: 'seat_ask_id_invalid' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    (async () => {
      const viewer = await workItemViewer(req, deps);
      if (!viewer.admin && !viewer.principal) return void (viewer.sourceDown ? res.status(502).json({ error: IDENTITY_UNAVAILABLE }) : res.status(401).json({ error: 'work_items_auth_required' }));
      const item = svc<WorkItemService>('workItems').get(id);
      // 读不到这件事项的：一律 404，和不存在一样（和详情同一处 canSee）。读得到但不能答的才是 403——
      // 管理口令、身份来源管理员过了读的门（isManagement 认管理门），对他们是 403，不是 404
      if (!item || !canSee(item, viewer)) return void res.status(404).json({ error: 'work_item_not_found' });
      // 谁能答只看 itemDecisionVerdict（建立人本人，或持有管理层授予的人代办，acting_for 记 creator；和详情的 can.answer、「关注」同一处）。
      // 拒绝的错误码照 #567 的：停用的、事项不能由建立人处理的说清原因，其余 seat_ask_answer_forbidden
      const v = itemDecisionVerdict(item, viewer, 'answer');
      if (!v.ok) {
        const w = writerVerdict(viewer, id, false);
        if (w === 'inactive') return void res.status(403).json({ error: 'work_items_principal_not_active' });
        if (w === 'not_eligible') return void res.status(403).json({ error: 'work_item_creator_not_eligible' });
        return void res.status(403).json({ error: 'seat_ask_answer_forbidden', message: '答席位的提问是替建立人做决定：建立人本人，或持有管理层授予的人；只过了管理门的不行' });
      }
      // 认得的只有登录的人（管理口令没有人，上面已拒），答的人记这个主体
      const answerer = viewer.principal;
      if (!answerer) return void res.status(403).json({ error: 'seat_ask_answer_forbidden' });
      const out = await answerItemAsk(id, Number(qid), answerer, { answer: b.answer, text: b.text }, v.acting_for);
      res.status(out.status).json({ item_id: id, duplicate: out.duplicate === true, result: out.body });
    })().catch(next);
  });

  app.post('/api/work-items/:id/messages/read', { action: 'work-items.messages-read', kind: 'write', statusNotVerdict: SEAT_WRITER_DECIDES }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    (async () => {
      const w = await seatWriter(req, res, id);
      if (!w) return;
      res.json({ ok: true, item_id: id, marked: markSeatMessagesRead(w.item, w.actor) });
    })().catch(next);
  });

  app.post('/api/work-items/:id/messages/:mid/reply', { action: 'work-items.messages-reply', kind: 'write', statusNotVerdict: ITEM_REPLY_DECIDES }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    const mid = String(req.params.mid ?? '');
    if (!/^[1-9]\d{0,15}$/.test(mid)) return void res.status(400).json({ error: 'seat_message_id_invalid' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) return void res.status(400).json({ error: 'text_required' });
    if (text.length > SEAT_REPLY_MAX) return void res.status(400).json({ error: 'text_too_long', max: SEAT_REPLY_MAX });
    (async () => {
      // 回复是替人做决定的动作：谁能回只看 itemDecisionVerdict（建立人本人、持有管理层授予的人代办；过了管理门不算）
      const viewer = await workItemViewer(req, deps);
      if (!viewer.admin && !viewer.principal) return void (viewer.sourceDown ? res.status(502).json({ error: IDENTITY_UNAVAILABLE }) : res.status(401).json({ error: 'work_items_auth_required' }));
      const item = svc<WorkItemService>('workItems').get(id);
      const v = itemDecisionVerdict(item, viewer, 'reply');
      if (!v.ok) return void res.status(v.status).json({ error: v.error });
      const out = replySeatMessage(item!, Number(mid), text, viewer.principal!, v.acting_for);
      res.status(out.status).json(out.body);
    })().catch(next);
  });

  /**
   * 放行（规范 14 第九节）：POST /api/work-items/:id/release，请求体不看。谁能放由 releaseRole 判（和详情的 can.release 同一处）：
   * 负责人；团队没有负责人时管理层代办（事件日志、事项日志记 acting_for = team-lead）；勾了先过目的由建立人本人放。
   * 写请求总门对这一条子路径放行，认人在这里。「关注」里过目条目的 answer_via 指向这里，所以自己做幂等：
   * 已经放行过的再来一次回 200、duplicate=true，不再放、不再记。放行的事只在 workbench-events 的 releaseCore 一处。
   *   401 没登录；404 看不到（不说有没有这件）；403 看得到但不归他放；409 不在等过目（没放行过）或事件、任务不让放
   */
  app.post('/api/work-items/:id/release', { action: 'work-items.release', kind: 'decide', statusNotVerdict: LEAD_RELEASES }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    (async () => {
      const items = svc<WorkItemService>('workItems');
      const viewer = await workItemViewer(req, deps);
      if (!viewer.admin && !viewer.principal) return void res.status(401).json({ error: 'work_items_auth_required' });
      const item = items.get(id);
      if (!item || !canSee(item, viewer)) return void res.status(404).json({ error: 'work_item_not_found' });
      const role = itemDecisionVerdict(item, viewer, 'release');
      if (!role.ok) return void res.status(403).json({ error: 'work_item_release_not_yours' });
      if (item.state !== 'held') {
        if (items.log(id).some((l) => l.fact === 'release' && !l.rejected)) return void res.json({ ok: true, item_id: id, duplicate: true, released: 0 });
        return void res.status(409).json({ error: 'work_item_not_held', state: item.state });
      }
      const ev = eventOfItem(item);
      if (!ev) return void res.status(409).json({ error: 'work_item_not_from_event' });
      const actor = viewer.principal ?? ((principalsAdmin ? await principalsAdmin(req, silentRes()) : null) || 'admin');
      const out = releaseCore(ev, actor, role.acting_for);
      res.status(out.status).json({ item_id: id, duplicate: false, ...out.body });
    })().catch(next);
  });

  // 动作类别是「决定」：建立人替自己的事项拍板
  // 改截止日期（安排时填的，建立人可以改）：只有建立人本人（writerVerdict 为 ok），管理员也不行——截止是建立人对这件事的要求。
  // 请求体只读 due：'YYYY-MM-DD' 或 null（清掉）；事项结束了不能改（409）。事件日志记一行 due-changed（从几号改成几号、谁改的）
  // 同步到节点：派工正文里的 due 不改（那是发出去了什么的证据），改为给这个事件每一条还活着的投递排一条「[截止变更]」，
  // 作为同一 context 的新任务发给接这件事的团队；投递还在等过目、排队时，等它发出去了再发；投递撤回、判死了就不发；出站关着整轮不发。
  // 应答多带 notified：排了几条
  app.post('/api/work-items/:id/due', { action: 'work-items.due-set', kind: 'write', statusNotVerdict: CREATOR_DECIDES }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    if (!('due' in b)) return void res.status(400).json({ error: 'due_required' });
    const dueAt = b.due === null ? '' : dueAtOf(b.due);
    if (b.due !== null && dueAt === '') return void res.status(400).json({ error: 'due_invalid' });
    (async () => {
      const viewer = await workItemViewer(req, deps);
      if (!viewer.principal) return void res.status(401).json({ error: 'work_items_auth_required' });
      const verdict = writerVerdict(viewer, id, false); // 只认建立人本人：管理员不代改
      if (verdict === 'not_found') return void res.status(404).json({ error: 'work_item_not_found' });
      if (verdict === 'inactive') return void res.status(403).json({ error: 'work_items_principal_not_active' });
      if (verdict !== 'ok' && verdict !== 'not_eligible') return void res.status(404).json({ error: 'work_item_not_found' });
      const items = svc<WorkItemService>('workItems');
      const item = items.get(id);
      if (!item) return void res.status(404).json({ error: 'work_item_not_found' });
      const at = new Date().toISOString();
      const actor = viewer.principal;
      // 改截止、留痕、给节点排变更在同一个保存点里：改了就一定留痕、一定排上
      const out = inReplyTx(() => {
        if (!items.setDue(id, dueAt, at.replace('T', ' ').slice(0, 19))) return null;
        const ev = /^wbe-[0-9a-f]{16}$/.test(item.source_ref) ? item.source_ref : '';
        if (!ev) return { notified: 0 };
        const factId = logEventFact(ev, actor, 'due-changed', { from: item.due_at, to: dueAt });
        if (!eventDispatched(ev)) return { notified: 0 };
        // 同步到节点：正文里的 due 已经随派工发出去了（或者等放行时照原样发），所以给这个事件每一条还活着的投递排一条变更，
        // 作为同一 context 的新任务发给那个团队；等那次投递真的发出去了才发，出站关着就不发（reply-outbound 的闸）
        const text = `[截止变更] 原事项《${item.title.replace(/\s+/g, ' ').slice(0, 200)}》的截止日期${dueAt ? `改为 ${dueAt.slice(0, 10)}` : '取消了'}（原来是 ${item.due_at ? item.due_at.slice(0, 10) : '没有截止'}）`;
        let n = 0;
        for (const d of liveDeliveriesOfEvent(ev)) {
          const target = deliveryTarget(d.id);
          if (!target) continue;
          if (queueReply({ kind: 'answer', eventId: ev, deliveryId: d.id, ref: factId, team: target.team, callerSession: target.caller_session, contextId: target.context_id, targetUrl: target.target_url,
            message: JSON.stringify({ text, by: actor, notice: 'due-changed' }) }) !== null) n++;
        }
        return { notified: n };
      });
      if (!out) return void res.status(409).json({ error: 'work_item_ended', state: item.state });
      if (out.notified > 0) kickWorkbenchEvents();
      const after = items.get(id)!;
      res.json({ item_id: id, due: after.due_at ? after.due_at.slice(0, 10) : null, overdue: overdueOf(after), notified: out.notified });
    })().catch(next);
  });

  app.post('/api/work-items/:id/decision', { action: 'work-items.accept', kind: 'decide', statusNotVerdict: CREATOR_DECIDES }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const answer = typeof b.answer === 'string' ? b.answer : '';
    (async () => {
      // 认人只经身份服务；请求体里写的任何「我是谁」都不看
      const cookie = String(req.headers.cookie ?? '');
      if (!cookie) return void res.status(401).json({ error: 'work_items_auth_required' });
      const who = await identity().resolveViewer(cookie);
      if (!who.ok) return void (sourceDown(who) ? res.status(502).json({ error: IDENTITY_UNAVAILABLE }) : res.status(401).json({ error: 'work_items_auth_required' }));
      const principal = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | undefined;
      if (!principal || principal.kind !== 'person' || principal.status !== 'active') return void res.status(403).json({ error: 'work_items_principal_not_active' });
      if (!(CREATOR_ANSWERS as readonly string[]).includes(answer)) return void res.status(400).json({ item_id: id, answer, duplicate: false, result: { error: 'creator_answer_not_allowed', allowed: CREATOR_ANSWERS } });
      // 谁能验收、退回只看 itemDecisionVerdict：建立人本人；退回还认负责人；持有管理层授予的人代办（acting_for 记 creator）
      const viewer = await workItemViewer(req, deps);
      const v = itemDecisionVerdict(svc<WorkItemService>('workItems').get(id), viewer, answer as 'verify' | 'return');
      if (!v.ok) return void res.status(v.status).json({ item_id: id, answer, duplicate: false, result: { error: v.error } });
      const out = await decideItemAnswer(id, who.viewer.sub, answer, { reason: b.reason }, v.acting_for);
      res.status(out.status).json({ item_id: id, answer, duplicate: out.duplicate === true, result: out.body });
    })().catch(next);
  });
}
