/**
 * 事项的读（阶段八 8d 界面要用）：GET /api/work-items/:id 返回一件事项和它的事项日志，事项页的时间线直接渲染日志。
 *
 * app 是 HTTP 服务，不是 Express 应用本身。可见性和「关注」里事项这个来源同一个口径：
 *   管理员（口令或会话登录）看全部；登录的人只看自己建立的（只认事项上的建立人主体，isCreator；建立人主体空着的只有管理员看得到）；
 *   别的一律 404（不说有没有这件事项）；没登录 401。
 * 跨站、别的站的页面来的请求拒。
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
import { isCreator, type WorkItemService } from '../services/work-item.ts';
import type { PrincipalService } from '../services/principal.ts';
import { creatorAnswer } from '../attention-answers.ts';
import { markSeatMessagesRead, replySeatMessage, seatMessagesOf, SEAT_REPLY_MAX } from '../seat-messages.ts';
import { principalsAdmin } from './principals.ts';

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

export function registerWorkItemRoutes(app: HttpService, deps: WorkItemRouteDeps): void {
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
      res.json({ item, log: items.log(id), ...seatMessagesOf(item) });
    })().catch(next);
  });

  /**
   * 写席位消息的人：管理员（记管理员的名字），或者这件事项的建立人本人（启用的人、事项可由建立人处理）。
   * 判不过就已经写好应答并返回 null：没登录 401，看不到 404，主体没启用 403。
   */
  async function seatWriter(req: express.Request, res: express.Response, id: string): Promise<{ actor: string; item: NonNullable<ReturnType<WorkItemService['get']>> } | null> {
    await deps.markOdooAdmin(req);
    const items = svc<WorkItemService>('workItems');
    if (deps.adminGuard(req, silentRes())) {
      const item = items.get(id);
      if (!item) { res.status(404).json({ error: 'work_item_not_found' }); return null; }
      return { actor: (principalsAdmin ? await principalsAdmin(req, silentRes()) : null) || 'admin', item };
    }
    const cookie = String(req.headers.cookie ?? '');
    if (!cookie) { res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    const who = await identity().resolveViewer(cookie);
    if (!who.ok) { res.status(401).json({ error: 'work_items_auth_required' }); return null; }
    const verdict = items.creatorCheck(id, who.viewer.sub);
    if (verdict === 'not_found') { res.status(404).json({ error: 'work_item_not_found' }); return null; }
    const principal = svc<PrincipalService>('principals').get(who.viewer.sub) as { kind?: string; status?: string } | undefined;
    if (!principal || principal.kind !== 'person' || principal.status !== 'active') { res.status(403).json({ error: 'work_items_principal_not_active' }); return null; }
    if (verdict === 'not_eligible') { res.status(403).json({ error: 'work_item_creator_not_eligible' }); return null; }
    const item = items.get(id);
    if (!item) { res.status(404).json({ error: 'work_item_not_found' }); return null; }
    return { actor: who.viewer.sub, item };
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
  app.post('/api/work-items/:id/decision', { action: 'work-items.accept', kind: 'decide' }, (req, res, next) => {
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
