/**
 * 「关注」各来源的答法（阶段八 8d）：提供方的 answer() 和 deny()。规格见产品化文档 02 附录 8d。
 *
 * 两种实现：
 *   · 转给原路由（attention-forward.ts）：MCP 权限申请、待属主看板、待对接清单、事项的放行和撤回。
 *     路径和方法只来自下面的 FORWARD 表，id 先核形状再编码填进去；请求体只由答法换算，表里没有的答法拒绝，
 *     调用方多带的字段一概不用。检查、状态变化、留痕都是原路由那一套，原路由回什么就交回什么。
 *     阶段三把这些处理函数抽出来之后，逐个换成直接调用，接口不变。
 *   · 直接实现：席位提问的答复、事项的验收和退回（以前没有旧入口）；变更申请的批准和拒绝（调旧入口用的同一个 changeRequestReview，
 *     审核人取认出来的管理员、不收自填的名字，不通过要写理由）。
 * 统一待办不提供答法。
 *
 * 重复答、并发答由「关注」服务的记账（once）给出：同一条再答返回第一次的结果，两个人同时答一个生效、另一个被告知。
 * 原路由本身不幂等的几个（变更申请批准后再批 400、MCP 申请处理过再批 409、看板答复常量已存在 409、绑定已绑 409）
 * 都靠这一层先查「答没答过」再转，第二次根本不会转到原路由。
 */
import { randomUUID } from 'node:crypto';
import type express from 'express';
import { svc } from './context.ts';
import { identity } from './identity.ts';
import { forward } from './attention-forward.ts';
import { answerBody, findBoardWorkbench } from './owner-pending.ts';
import { principalsAdmin } from './routes/principals.ts';
import { changeRequestReview } from './routes/change-requests.ts';
import { benchMcpDecider } from './routes/bench-views.ts';
import { sopRunAcceptance } from './routes/sop-run-lifecycle.ts';
import { HttpError } from './errors.ts';
import { askLogRow, currentAskOfDelivery, pendingAskOfDelivery, pendingPrincipalAppearance } from './services/attention-sources.ts';
import { askTaskOf, deliveryTarget, eventDispatched, inReplyTx, queueReply, returnTargetOfEvent } from './services/a2a-replies.ts';
import { kickWorkbenchEvents, logDeliveryFact } from './workbench-events.ts';
import { listVars, workbenchScope } from './workbench-vars.ts';
import type { AnswerOutcome, AttentionProvider, AttentionService } from './services/attention.ts';
import type { HttpService } from './http.ts';
import type { WorkbenchService } from './services/workbench.ts';
import { itemIdForEvent, type WorkItemRow, type WorkItemService } from './services/work-item.ts';
import { itemDecisionVerdict, requestViewer } from './work-item-access.ts';

export type AnswerDeps = {
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  varsAuthorizeRead: (req: express.Request, res: express.Response, scope: { id: number; cls: 'app' | 'sop' | 'external'; slug: string | null }) => Promise<unknown>;
};
type Req = express.Request;
type Input = Record<string, unknown>;
type Route = { method: 'POST' | 'PUT'; path: string; body: Record<string, unknown> } | { error: AnswerOutcome };

/** 截下旧守卫判不过时写的状态码和正文：看不到的来源，用它回旧入口无权时那个拒绝 */
function capturing(): { res: express.Response; out: () => AnswerOutcome } {
  const box: AnswerOutcome = { status: 200, body: null };
  const res: Record<string, unknown> = { statusCode: 200, headersSent: false };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = (...a: unknown[]) => {
    if (m === 'status') { box.status = Number(a[0]); res.statusCode = a[0]; }
    if (m === 'json' || m === 'send') box.body = a[0];
    return res;
  };
  return { res: res as unknown as express.Response, out: () => box };
}
const guardDenial = (guard: (req: Req, res: express.Response) => boolean, req: Req): AnswerOutcome => {
  const c = capturing();
  return guard(req, c.res) ? { status: 403, body: { error: 'forbidden' } } : c.out();
};

const bad = (error: string, status = 400): { error: AnswerOutcome } => ({ error: { status, body: { error } } });
const text = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const NUM = /^[1-9]\d{0,15}$/;
const bjToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

/** 谁在答：管理员落到人（口令是 admin-token，会话登录的是 odoo:<登录名>，本机命令行是 cli）；不是管理员的用登录的人 */
export async function actorOf(req: Req): Promise<string> {
  if (principalsAdmin) { const a = await principalsAdmin(req, capturing().res); if (a) return a; }
  const cookie = String(req.headers.cookie ?? '');
  if (cookie) { const who = await identity().resolveViewer(cookie); if (who.ok) return who.viewer.sub; }
  return 'anonymous';
}

/**
 * 转给原路由的表：来源 → 答法 → 换算出（方法、路径、请求体）。路径里的 id 都先核形状、再编码；
 * 请求体只取这一种答法要的字段。表里没有的答法，入口直接拒。
 */
const FORWARD: Record<string, Record<string, (id: string, input: Input) => Route>> = {
  'mcp-access': Object.fromEntries((['approve', 'reject'] as const).map((op) => [op, (id: string, input: Input): Route =>
    NUM.test(id) ? { method: 'POST', path: `/api/mcp/access-requests/${encodeURIComponent(id)}/${op}`, body: { note: text(input.note, 500) } } : bad('attention_id_invalid')])),
  // 台的 MCP 授予申请：条目 id 是「台的标识:申请编号」。批可以带一句话；不批要写理由（记在申请的 note 里，申请的会话看得到）
  'bench-mcp': Object.fromEntries((['approve', 'reject'] as const).map((op) => [op, (id: string, input: Input): Route => {
    const m = /^([a-z0-9][a-z0-9-]{0,63}):([1-9]\d{0,8})$/.exec(id);
    if (!m) return bad('attention_id_invalid');
    // 不批的理由：reason 或 note 都认（别的来源两种叫法都有），先取 reason
    const note = op === 'approve' ? text(input.note, 500) : text(input.reason, 500) || text(input.note, 500);
    if (op === 'reject' && !note) return bad('reason_required');
    return { method: 'POST', path: `/api/bench-views/${m[1]}/mcp-requests/${m[2]}`, body: { approve: op === 'approve', note } };
  }])),
  'owner-pending': {
    answer: (no, input) => {
      if (!/^\d{1,4}$/.test(no)) return bad('attention_id_invalid');
      const list = (svc<WorkbenchService>('workbench').all() as { id: number; url: string }[]).map((w) => ({ id: w.id, url: w.url }));
      const found = findBoardWorkbench(list, 'http://localhost');
      if ('error' in found) return bad('owner_board_missing', 404);
      const summary = text(input.summary);
      return { method: 'PUT', path: `/api/workbenches/${found.id}/vars/${encodeURIComponent(`answer.${no}`)}`, body: answerBody(summary, bjToday(), null) };
    },
  },
  'principal-pending': {
    bind: (id, input) => {
      const cut = id.indexOf(':');
      if (cut <= 0 || cut === id.length - 1) return bad('attention_id_invalid');
      return { method: 'POST', path: '/api/principals/bind', body: { provider: id.slice(0, cut), external_id: id.slice(cut + 1), principal: text(input.principal, 160), create: input.create === true, reason: text(input.reason, 500) } };
    },
  },
  'work-items': {
    release: (id) => {
      const it = svc<WorkItemService>('workItems').get(id);
      if (!it) return bad('work_item_not_found', 404);
      if (!/^wbe-[0-9a-f]{16}$/.test(it.source_ref)) return bad('work_item_not_from_event', 409);
      // 和过目条目的 answer_via 同一个入口：谁能放、代办留痕都在那里判（管理层在团队没有负责人时代办）
      return { method: 'POST', path: `/api/work-items/${encodeURIComponent(it.id)}/release`, body: {} };
    },
    withdraw: (id) => {
      const it = svc<WorkItemService>('workItems').get(id);
      if (!it) return bad('work_item_not_found', 404);
      let task = '';
      try { task = String((JSON.parse(it.context) as { item?: unknown }).item ?? ''); } catch { /* 没有 */ }
      const m = /^task:([1-9]\d{0,15})$/.exec(task);
      if (it.source_kind !== 'task-center' || !m) return bad('work_item_not_from_task_center', 409);
      return { method: 'POST', path: `/api/task-center/tasks/${encodeURIComponent(m[1])}/withdraw`, body: {} };
    },
  },
};

/** 换算表的一次查表（单测用；入口经 withAnswers 走同一张表）。表里没有的答法返回 null */
export function forwardRoute(source: string, answer: string, id: string, input: Input): Route | null {
  const make = FORWARD[source]?.[answer];
  return make ? make(id, input) : null;
}

/** 直接实现的答法（以前没有旧入口） */
/** actingFor：替谁做的（itemDecisionVerdict 给的；空串是本人的事），记进事实，事项时间线照它写「代某某办」。不是事项上的动作的来源不管它 */
const DIRECT: Record<string, Record<string, (req: Req, id: string, input: Input, actor: string, actingFor?: string) => Promise<AnswerOutcome>>> = {
  'change-requests': {
    approve: async (req, id, _input, actor) => reviewed(req, id, actor, (n, who) => changeRequestReview!.approve(n, who, who)),
    reject: async (req, id, input, actor) => {
      const reason = text(input.reason, 500);
      if (!reason) return { status: 400, body: { error: 'reason_required' } };
      return reviewed(req, id, actor, async (n, who) => changeRequestReview!.reject(n, who, who, reason));
    },
  },
  'work-items': {
    verify: async (_req, id, _input, actor, actingFor) => applied(id, { kind: 'verify', source: 'attention', id: randomUUID(), actor, ...(actingFor ? { acting_for: actingFor } : {}) }),
    /**
     * 打回重做：在事项上记一笔 return（ready → progress），同一个保存点里把打回作为同一 context 的新任务发回做这件事的团队
     * （和答复一个办法；只对派出去的事件发）。正文开头按上游建议写明「[打回重做] 原事项《…》（原任务 <task>）：理由」——
     * superagent 不解析信封、总工只看正文；信封带 kind:'return' 和原任务号 return.of，宿主以后认 reworkReturns 时直接用。
     * 重做的回执照常回到这件事项：新任务的 ack、进展、completed（推回等验收）。
     */
    return: async (_req, id, input, actor, actingFor) => {
      const reason = text(input.reason, 500);
      if (!reason) return { status: 400, body: { error: 'reason_required' } };
      const items = svc<WorkItemService>('workItems');
      const it = items.get(id);
      const ev = it && /^wbe-[0-9a-f]{16}$/.test(it.source_ref) && itemIdForEvent(it.source_ref) === id ? it.source_ref : null;
      const result = inReplyTx(() => {
        const out = items.apply(id, { kind: 'return', source: 'attention', id: randomUUID(), actor, reason, ...(actingFor ? { acting_for: actingFor } : {}) });
        if (!out.ok || !ev || !eventDispatched(ev)) return { out, queued: false };
        const to = returnTargetOfEvent(ev);
        const target = to ? deliveryTarget(to.delivery_id) : undefined;
        if (!to || !target) return { out, queued: false };
        const seq = items.lastEntrySeq(id, ['progress']) ?? 0;
        const queued = queueReply({ kind: 'answer', eventId: ev, deliveryId: to.delivery_id, ref: -seq, qid: to.task, team: target.team, callerSession: target.caller_session,
          contextId: target.context_id, targetUrl: target.target_url, message: JSON.stringify({ text: reason, by: actor, return: { of: to.task, title: it!.title } }) }) !== null;
        if (queued) logDeliveryFact(ev, to.delivery_id, actor, 'return-sent', { of: to.task, reason: reason.slice(0, 500) });
        return { out, queued };
      });
      if (!result.out.ok) return { status: 409, body: { error: `work_item_${result.out.reason}`, state: result.out.state ?? null } };
      if (result.queued) kickWorkbenchEvents();
      return { status: 200, body: { ok: true, item_id: id, state: result.out.state, sent: result.queued, reason: result.queued ? 'queued' : ev ? 'not_queued' : 'not_from_event' } };
    },
  },
  'sop-runs': {
    /**
     * 待验收的派单 run：验收通过 = 完成这个 run（和 POST /api/sop/runs/:id/finish 同一个执行：字段校验、完成、给派单方发回执）。
     * 谁能做和完成接口里不靠上传令牌的那两条同一处（管理员、本机命令行）；字段没填全照旧 400，run 不动。没有打回（run 没有退回的语义）
     */
    finish: async (req, id) => {
      if (!NUM.test(id)) return { status: 400, body: { error: 'attention_id_invalid' } };
      if (!sopRunAcceptance) return { status: 503, body: { error: 'sop_run_acceptance_unavailable' } };
      if (!(await sopRunAcceptance.allowed(req))) return { status: 403, body: { error: 'forbidden' } };
      try { return { status: 200, body: await sopRunAcceptance.finish(Number(id)) as Record<string, unknown> }; } catch (e) {
        if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.extra ?? {}) } };
        throw e;
      }
    },
  },
  'seat-asks': {
    /**
     * 答席位的提问：在事项上记答复，合上这条提问。
     *   · v1（decision:ask，接单节点凭回复令牌回写的提问）：照旧只记不发——v1 接单节点不认识回答事件。
     *   · 阶段七 R2（receipt:attention，席位 A2A 回执里的提问）：记答复的同时排一条答复任务，作为同一 context 的新任务发回那个团队
     *     （superagent 的约定）；只通知的事件（dispatch:false）没有回写通道，不发。记答复和排发送在同一个保存点里。
     */
    answer: async (_req, id, input, actor, actingFor) => {
      const answer = text(input.text);
      if (!answer) return { status: 400, body: { error: 'text_required' } };
      if (!/^[1-9]\d{0,15}$/.test(id)) return { status: 400, body: { error: 'attention_id_invalid' } };
      const ask = pendingAskOfDelivery(Number(id));
      if (!ask) return { status: 409, body: { error: 'seat_ask_not_pending' } };
      const itemId = itemIdForEvent(ask.event_id);
      const fact = { kind: 'answer' as const, source: 'attention', id: randomUUID(), actor, ask_id: String(ask.ask_log_id), answer, ...(actingFor ? { acting_for: actingFor } : {}) };
      if (ask.ask_kind !== 'receipt') {
        const out = svc<WorkItemService>('workItems').apply(itemId, fact);
        if (!out.ok) return { status: 409, body: { error: `work_item_${out.reason}`, state: out.state ?? null } };
        return { status: 200, body: { ok: true, item_id: itemId, state: out.state, sent: false, reason: 'receiver_is_v1', message: '答复记在事项上；对方是 v1 接单节点，按 06 的兼容规则不发回答事件' } };
      }
      const dispatched = eventDispatched(ask.event_id);
      const target = deliveryTarget(Number(id));
      const result = inReplyTx(() => {
        const out = svc<WorkItemService>('workItems').apply(itemId, fact);
        if (!out.ok) return { out, queued: false };
        const queued = dispatched && !!target && queueReply({ kind: 'answer', eventId: ask.event_id, deliveryId: Number(id), ref: ask.ask_log_id, qid: askTaskOf(ask.ask_log_id),
          team: target.team, callerSession: target.caller_session, contextId: target.context_id, targetUrl: target.target_url, message: JSON.stringify({ text: answer, by: actor }) }) !== null;
        return { out, queued };
      });
      if (!result.out.ok) return { status: 409, body: { error: `work_item_${result.out.reason}`, state: result.out.state ?? null } };
      if (result.queued) kickWorkbenchEvents();
      return { status: 200, body: dispatched
        ? { ok: true, item_id: itemId, state: result.out.state, sent: result.queued, reason: result.queued ? 'queued' : 'already_queued', message: '答复记在事项上，并作为同一 context 的新任务发回那个团队' }
        : { ok: true, item_id: itemId, state: result.out.state, sent: false, reason: 'event_not_dispatched', message: '答复记在事项上；这个事件只通知、不派发，没有回写通道，不发' } };
    },
  },
};

/**
 * 审核卡片当场批：只有管理员（和旧入口同一个管理门；「关注」列表本来就只给管理员看这个来源，这里再判一次）。
 * 审核人就是认出来的管理员（actorOf），请求里自报的名字不收。判断和执行都在 changeRequestReview，判不过抛的 HttpError 换成同样的应答。
 */
async function reviewed(req: Req, id: string, actor: string, run: (id: number, reviewer: string) => Promise<Record<string, unknown>>): Promise<AnswerOutcome> {
  if (!NUM.test(id)) return { status: 400, body: { error: 'attention_id_invalid' } };
  const admin = principalsAdmin ? await principalsAdmin(req, capturing().res) : null;
  if (!admin || admin !== actor) return { status: 403, body: { error: 'forbidden' } };
  if (!changeRequestReview) return { status: 503, body: { error: 'change_request_review_unavailable' } };
  try { return { status: 200, body: await run(Number(id), actor) }; } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.extra ?? {}) } };
    throw e;
  }
}

function applied(id: string, fact: Parameters<WorkItemService['apply']>[1]): AnswerOutcome {
  const out = svc<WorkItemService>('workItems').apply(id, fact);
  return out.ok ? { status: 200, body: { ok: true, item_id: id, state: out.state } } : { status: 409, body: { error: `work_item_${out.reason}`, state: out.state ?? null } };
}

/** 记账的键。席位的提问按「投递:那次提问」记：同一个投递答过一次之后又问了一次，是一条新的待决 */
/**
 * 记账的键：分开同一个 id 的每一轮待决。答完之后键要不变（重复答才认得出），再次进入待处理时键要变。
 *   · 席位的提问：「投递:那次提问」——同一个投递答过之后又问一次，是新的一轮
 *   · 事项：「事项 id:最近一次进入 ready 或 held 那一行日志的 seq」——退回之后再进 ready 是新的一轮；验收、放行之后 seq 不变
 *   · 待属主看板：「编号:事项那条常量的 revision」——登记方改了事项（重新提出）是新的一轮
 *   · 待对接清单：「来源:标识@出现序号」——绑定之后这条外部身份又出现在清单里，清单那一行是新插入的、序号只增，是新的一轮
 *     （不靠时间分轮：时间只到秒，同一秒里又出现就分不开）
 *   · 变更申请、MCP 权限申请：每次申请都是新的一行、新的 id，不会再次进入待处理，键就是 id
 */
function keyOf(source: string, sourceId: string): string {
  if (source === 'seat-asks' && /^[1-9]\d{0,15}$/.test(sourceId)) {
    const ask = currentAskOfDelivery(Number(sourceId));
    return ask ? `${sourceId}:${ask.ask_log_id}` : sourceId;
  }
  if (source === 'work-items') {
    const seq = svc<WorkItemService>('workItems').lastEntrySeq(sourceId, ['ready', 'held']);
    return seq === null ? sourceId : `${sourceId}:${seq}`;
  }
  if (source === 'owner-pending' && /^\d{1,4}$/.test(sourceId)) {
    const list = (svc<WorkbenchService>('workbench').all() as { id: number; url: string }[]).map((w) => ({ id: w.id, url: w.url }));
    const found = findBoardWorkbench(list, 'http://localhost');
    if ('error' in found) return sourceId;
    const v = (listVars(workbenchScope(found.id), `item.${sourceId}`).items as { key: string; revision: number }[]).find((x) => x.key === `item.${sourceId}`);
    return v ? `${sourceId}:${v.revision}` : sourceId;
  }
  if (source === 'principal-pending') {
    // 在清单里：「来源:标识@这一次出现的序号」；已经不在（答完了）：这条外部身份最近记过的那一轮，重复答才认得出
    const cut = sourceId.indexOf(':');
    const appearance = cut > 0 ? pendingPrincipalAppearance(sourceId.slice(0, cut), sourceId.slice(cut + 1)) : null;
    if (appearance !== null) return `${sourceId}@${appearance}`;
    return svc<AttentionService>('attention').latestKey(source, sourceId) ?? sourceId;
  }
  return sourceId;
}

/**
 * 事项的验收、退回（8e 起）。谁能做由调用方先用 itemDecisionVerdict 判过（建立人本人、退回时还有负责人、持有管理层授予的人代办），
 * 这里按「这一次进入等验收」记账（和「关注」答复入口同一本账，谁先答谁生效，另一个拿到第一次的结果），再应用事实。只收验收、退回两种。
 * actingFor 记进事实：负责人退回、管理层代办时是 creator。
 */
export const CREATOR_ANSWERS = ['verify', 'return'] as const;
export async function decideItemAnswer(id: string, actor: string, answer: string, input: Input, actingFor: string): Promise<AnswerOutcome> {
  if (!(CREATOR_ANSWERS as readonly string[]).includes(answer)) return { status: 400, body: { error: 'creator_answer_not_allowed', allowed: CREATOR_ANSWERS } };
  return svc<AttentionService>('attention').once('work-items', keyOf('work-items', id), answer, actor, async () => {
    const st = svc<WorkItemService>('workItems').get(id)?.state;
    if (st !== 'ready') return { status: 409, body: { error: 'work_item_not_ready', state: st ?? null } };
    return DIRECT['work-items'][answer](undefined as unknown as Req, id, input, actor, actingFor);
  });
}

/** 席位提问对应的事项（在等的、或者最近那一轮已经答过的）：判谁能答用 */
function itemOfAsk(deliveryId: string): WorkItemRow | undefined {
  if (!/^[1-9]\d{0,15}$/.test(deliveryId)) return undefined;
  const ask = pendingAskOfDelivery(Number(deliveryId)) ?? currentAskOfDelivery(Number(deliveryId));
  return ask ? svc<WorkItemService>('workItems').get(itemIdForEvent(ask.event_id)) : undefined;
}

/**
 * 阶段七：回答一件事项上的一条席位提问（入口 POST /api/work-items/:id/asks/:qid/answer，认人在路由里：itemDecisionVerdict）。
 *   actingFor：持有管理层授予的人代办时是 creator，记进事件日志和事项日志
 *   · qid 是提问那一行事件日志的 id（事项详情 asks[].id）；它必须属于这件事项、且是那次投递当前在等的提问；
 *   · 请求体 { answer?, text? }：带选项的提问，answer 必须是选项之一；text 是自由文本；两者都给时以 answer 为准；
 *     别的字段一概不看。答复作为同一 context 的新任务发回（v1 接单节点照旧只记不发）；
 *   · 和「关注」里管理员的答复共用一本账（同一个去重键）：两个人同时答，一个生效、另一个 409（已处理，或正在处理）；本人重复答拿回第一次的结果。
 */
export async function answerItemAsk(itemId: string, askLogId: number, actor: string, body: Record<string, unknown>, actingFor = ''): Promise<AnswerOutcome & { duplicate?: boolean }> {
  const row = askLogRow(askLogId);
  if (!row || itemIdForEvent(row.event_id) !== itemId) return { status: 404, body: { error: 'seat_ask_not_found' } };
  let detail: { question?: { options?: unknown } } = {};
  try { detail = JSON.parse(row.detail || '{}'); } catch { /* 坏的 detail 当没有选项 */ }
  const options = Array.isArray(detail.question?.options) ? (detail.question!.options as unknown[]).filter((o): o is string => typeof o === 'string') : [];
  const picked = typeof body.answer === 'string' ? body.answer.trim() : '';
  if (picked !== '' && options.length > 0 && !options.includes(picked)) return { status: 400, body: { error: 'answer_not_an_option', options } };
  const answer = (picked !== '' ? picked : typeof body.text === 'string' ? body.text.trim() : '').slice(0, 4000);
  if (!answer) return { status: 400, body: { error: 'text_required' } };
  const attention = svc<AttentionService>('attention');
  const key = `${row.delivery_id}:${row.id}`;
  const pending = pendingAskOfDelivery(row.delivery_id);
  if (!pending || pending.ask_log_id !== row.id) {
    // 不在等了：按同一本账走（#657 的口径）——本人用同一种答法答成过的拿回第一次的结果，别人答过的 409 已处理；
    // 谁都没答过（被后来的提问或接单、结果合上了）就是已合上（run 返回 409，账上不留占位）
    return attention.once('seat-asks', key, 'answer', actor, async () => ({ status: 409, body: { error: 'seat_ask_not_pending' } }));
  }
  return attention.once('seat-asks', key, 'answer', actor, async () =>
    DIRECT['seat-asks'].answer(undefined as unknown as Req, String(row.delivery_id), { text: answer }, actor, actingFor));
}

/** 这个来源有哪些答法（换算表和直接实现的并起来）：入口拿它核答法 */
export function answersOf(source: string): string[] {
  return [...Object.keys(FORWARD[source] ?? {}), ...Object.keys(DIRECT[source] ?? {})];
}

/** 给一个提供方加上 answer 和 deny。listDeny：这个人在这个来源看不到东西时，旧入口会怎么拒 */
export function withAnswers(p: AttentionProvider<Req>, deps: AnswerDeps): AttentionProvider<Req> {
  const forwards = FORWARD[p.source], directs = DIRECT[p.source];
  if (!forwards && !directs) return p;
  const attention = () => svc<AttentionService>('attention');
  return {
    ...p,
    deny: (req) => denial(p.source, req, deps),
    key: (sourceId) => keyOf(p.source, sourceId),
    answer: async (req, sourceId, answer, input) => {
      // 事项上替人做决定的答法（验收、退回、答席位提问）：谁能答只看 itemDecisionVerdict（和事项自己的入口、详情的 can 同一处），
      // 过了管理门不等于能答；看得到也不等于能答
      const decision = p.source === 'work-items' && (CREATOR_ANSWERS as readonly string[]).includes(answer) ? answer as 'verify' | 'return'
        : p.source === 'seat-asks' && answer === 'answer' ? 'answer' : null;
      if (decision) {
        const viewer = await requestViewer(req, deps.adminGuard(req, capturing().res));
        const item = decision === 'answer' ? itemOfAsk(sourceId) : svc<WorkItemService>('workItems').get(sourceId);
        const v = itemDecisionVerdict(item, viewer, decision);
        if (!v.ok) return { status: v.status, body: { error: v.error } };
        // 记账和留痕的人和答复入口认「答过没有」用的同一个（actorOf）：会话登录的管理员记成身份来源的那个名字，别人记主体
        const who = await actorOf(req);
        if (decision !== 'answer') return decideItemAnswer(sourceId, who, answer, input, v.acting_for);
        return attention().once(p.source, keyOf(p.source, sourceId), answer, who, async () => DIRECT['seat-asks'].answer(req, sourceId, input, who, v.acting_for));
      }
      const actor = await actorOf(req);
      return attention().once(p.source, keyOf(p.source, sourceId), answer, actor, async () => {
        const direct = directs?.[answer];
        if (direct) return direct(req, sourceId, input, actor);
        const make = forwards?.[answer];
        if (!make) return { status: 400, body: { error: 'attention_answer_not_offered' } };
        const route = make(sourceId, input);
        if ('error' in route) return route.error;
        return forward(svc<HttpService>('http').expressApp(), req, route.method, route.path, route.body);
      });
    },
  };
}

/** 看不到这个来源时的拒绝：和旧入口无权时一样（同一个守卫写出来的那个） */
async function denial(source: string, req: Req, deps: AnswerDeps): Promise<AnswerOutcome> {
  if (source === 'principal-pending' && principalsAdmin) { const c = capturing(); await principalsAdmin(req, c.res); return c.out(); }
  if (source === 'owner-pending') { const c = capturing(); await deps.varsAuthorizeRead(req, c.res, { id: 0, cls: 'external', slug: null }); return c.out(); }
  if (source === 'work-items') return { status: 401, body: { error: 'work_items_auth_required' } };
  if (source === 'bench-mcp') { if (!benchMcpDecider) return { status: 404, body: { error: 'bench_views_off' } }; const c = capturing(); await benchMcpDecider(req, c.res, null); return c.out(); }
  return guardDenial(deps.adminGuard, req);
}
