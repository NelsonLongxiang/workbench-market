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
 * 谁能写和 decision 同一个口径再加管理员：管理员；或者建立人本人（启用的人、事项可由建立人处理）。
 * 和 decision 一样经写请求总门放行这两条子路径，认人在这里做；别的人一律 404（不说有没有这件事项）。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { svc } from '../context.ts';
import { identity } from '../identity.ts';
import { isCreator, STATES, type WorkItemService, type WorkItemState } from '../services/work-item.ts';
import type { PrincipalService } from '../services/principal.ts';
import { creatorAnswer } from '../attention-answers.ts';
import { markSeatMessagesRead, replySeatMessage, seatMessagesOf, seatProgressOf, SEAT_REPLY_MAX } from '../seat-messages.ts';
import { principalsAdmin } from './principals.ts';
import { canOf, creatorOf, turnOf, workItemViewer, writerVerdict } from '../work-item-access.ts';
import { arrangeTask } from '../task-center.ts';
import { assignableTeams, kickWorkbenchEvents } from '../workbench-events.ts';

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
const CREATOR_DECIDES = '按事项的建立人判：只有建立人本人能验收、退回自己的事项，是事项上的规则不是角色授权';

export function registerWorkItemRoutes(app: HttpService, deps: WorkItemRouteDeps): void {
  // 列表：GET /api/work-items?state=&object=&phase=&limit=&cursor=。可见范围和详情同一个判断（管理员看全部，别人只看自己是建立人的），
  // 看不到的不出现也不计数。按 updated_at、id 倒序，游标翻页（limit 缺省 100、上限 200）；另带可见范围里按状态的计数
  app.get('/api/work-items', { action: 'work-items.list', kind: 'read' }, (req, res, next) => {
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
    (async () => {
      await deps.markOdooAdmin(req);
      let viewer: string | null = null;
      if (!deps.adminGuard(req, silentRes())) {
        const cookie = String(req.headers.cookie ?? '');
        if (!cookie) return void res.status(401).json({ error: 'work_items_auth_required' });
        const who = await identity().resolveViewer(cookie);
        if (!who.ok) return void res.status(401).json({ error: 'work_items_auth_required' });
        viewer = who.viewer.sub;
      }
      const page = svc<WorkItemService>('workItems').page({ viewer, state: state as WorkItemState | undefined, object: str('object'), phase: str('phase'), limit, after });
      res.json({
        items: page.items.map((w) => ({
          id: w.id, title: w.title, state: w.state, object: w.object, phase: w.phase, seat: w.seat,
          last_progress: w.last_log, updated_at: w.updated_at,
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
    if (!who.ok) { res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    const principal = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | undefined;
    if (!principal || principal.kind !== 'person' || principal.status !== 'active') { res.status(403).json({ error: 'work_items_principal_not_active' }); return null; }
    return who.viewer.sub;
  }

  // 「安排一件事」能派给的团队：绑在任务中心上的通知绑定（和建事项时的校验同一个函数）。登录的人能读。名册落地前 name 就是团队标识
  app.get('/api/work-items/teams', { action: 'work-items.teams', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    (async () => {
      if (!(await person(req, res))) return;
      res.json({ teams: assignableTeams().map((t) => ({ team: t.agent_node, name: t.agent_node })) });
    })().catch(next);
  });

  // 「安排一件事」：登录的人直接建一件事项，建立人是本人。只认 cookie 认出的启用的人（口令、命令行、MCP 都不是人，不能用）。
  // 写请求总门对这一条路径放行（index.ts），认人在这里；规则（派给、先过目、幂等、限流）在 task-center.ts 的 arrangeTask
  app.post('/api/work-items', { action: 'work-items.create', kind: 'write' }, (req, res, next) => {
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

  app.get('/api/work-items/:id', { action: 'work-item.read', kind: 'read' }, (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie'); res.vary('X-Admin-Token');
    if (deps.crossOriginDenied(req)) return void res.status(403).json({ error: 'work_items_cross_origin_denied' });
    const id = String(req.params.id ?? '');
    if (!ITEM_ID.test(id)) return void res.status(400).json({ error: 'work_item_id_invalid' });
    (async () => {
      await deps.markOdooAdmin(req);
      const items = svc<WorkItemService>('workItems');
      if (!deps.adminGuard(req, silentRes())) {
        const cookie = String(req.headers.cookie ?? '');
        if (!cookie) return void res.status(401).json({ error: 'work_items_auth_required' });
        const who = await identity().resolveViewer(cookie);
        if (!who.ok) return void res.status(401).json({ error: 'work_items_auth_required' });
        const item = items.get(id);
        if (!item || !isCreator(item, who.viewer.sub)) return void res.status(404).json({ error: 'work_item_not_found' });
      }
      const item = items.get(id);
      if (!item) return void res.status(404).json({ error: 'work_item_not_found' });
      // 只增：这个人能做什么（can）、是不是轮到他（turn）、建立人是谁（creator）。判断都在 work-item-access.ts，和各动作接口同一处
      const viewer = await workItemViewer(req, deps);
      res.json({ item, log: items.log(id), ...seatMessagesOf(item), progress: seatProgressOf(item), can: canOf(item, viewer), turn: turnOf(item, viewer), creator: creatorOf(item) });
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
    if (verdict === 'unauthenticated') { res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    if (verdict === 'not_found') { res.status(404).json({ error: 'work_item_not_found' }); return null; }
    if (verdict === 'inactive') { res.status(403).json({ error: 'work_items_principal_not_active' }); return null; }
    if (verdict === 'not_eligible') { res.status(403).json({ error: 'work_item_creator_not_eligible' }); return null; }
    const item = items.get(id);
    if (!item) { res.status(404).json({ error: 'work_item_not_found' }); return null; }
    if (verdict === 'admin') return { actor: (principalsAdmin ? await principalsAdmin(req, silentRes()) : null) || 'admin', item };
    return { actor: viewer.principal!, item };
  }

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

  app.post('/api/work-items/:id/messages/:mid/reply', { action: 'work-items.messages-reply', kind: 'write', statusNotVerdict: SEAT_WRITER_DECIDES }, (req, res, next) => {
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
      const w = await seatWriter(req, res, id);
      if (!w) return;
      const out = replySeatMessage(w.item, Number(mid), text, w.actor);
      res.status(out.status).json(out.body);
    })().catch(next);
  });

  // 动作类别是「决定」：建立人替自己的事项拍板
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
      if (!who.ok) return void res.status(401).json({ error: 'work_items_auth_required' });
      const principal = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | undefined;
      if (!principal || principal.kind !== 'person' || principal.status !== 'active') return void res.status(403).json({ error: 'work_items_principal_not_active' });
      const out = await creatorAnswer(id, who.viewer.sub, answer, { reason: b.reason });
      res.status(out.status).json({ item_id: id, answer, duplicate: out.duplicate === true, result: out.body });
    })().catch(next);
  });
}
