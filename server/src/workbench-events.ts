// 工作台事件层 v1：人提交 → 事件 → 投递到团队接单节点 → 接单节点回写决定。
// 契约（跨项目接口）：dsh-open-a2a-net docs/protocol/workbench-event.md。
//   · 「是不是人提交的」在这里判（submitter_kind）；a2a 只负责送达和来源签名。
//   · 「接不接」由接单节点判，凭投递里的 reply token 回写；GitHub issue 是工作记录。
//   · 每个事件必有下文：unrouted，或每个投递落到 sent / dead / cancelled；held 是等人确认，不是终态。
import { outboundOff, noteBlocked } from './outbound-gate.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { db } from './db.ts';
import { a2aKeyPath, a2aSendOutbound, MARKET_TEAM, marketPublicUrl, sopNode8 } from './a2a.ts';
import { MAX_ROUTE_BODY_BYTES } from '@nelsonlongxiang/dsh-open-a2a-net/transport-caps';
import { root } from './root-context.ts';
import type { HttpService } from './http.ts';
import { recordSentTask } from './services/a2a-receipts.ts';
import { peerCard, peerRoot } from './a2a/peer-card.ts';
import { replyTick } from './a2a/reply-outbound.ts';

/** 8b：每写一行事件日志，在同一个事务里多发一个事件（事项服务听它）。这张表和它的写法都不变。 */
export type WorkbenchEventLogged = { id: number; event_id: string; delivery_id: number | null; action: string };
declare module '@deepseek-ai/cordis' {
  interface Events {
    'workbench-event/logged'(row: WorkbenchEventLogged): void;
  }
}

export const WORKBENCH_EVENT_VERSION = 1;
const DECISIONS = new Set(['accept', 'decline', 'ask']);
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000]; // 与 SOP 回执 outbox 同一退避：1m/5m/15m/1h，5 次后 dead
export const MAX_ATTEMPTS = 5;
const EVENT_ID = /^wbe-[0-9a-f]{16}$/;
/** 对端判为不可重试的线码：-32001 载荷超限、-32002 同 task_id 不同载荷、-32003 同 task_id 重放（每次尝试的 task_id 都唯一，出现即异常） */
export const TERMINAL_CODES = new Set([-32001, -32002, -32003]);
const REPLY_TTL_DAYS = 7; // reply token 自送达起 7 天有效（ask 之后也不例外）
const WORKER_CONCURRENCY = 8;

export function initWorkbenchEvents(): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS workbench_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('task-center','app-data')),
  workbench TEXT NOT NULL,
  item TEXT NOT NULL,
  context_id TEXT NOT NULL,
  submitter_kind TEXT NOT NULL CHECK (submitter_kind IN ('human','agent','unverified')),
  submitter TEXT NOT NULL DEFAULT '',
  form_version INTEGER,
  data_sha256 TEXT NOT NULL,
  dispatch INTEGER NOT NULL,
  routed TEXT NOT NULL CHECK (routed IN ('target','default','unrouted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workbench_event_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES workbench_events(event_id),
  target_team TEXT NOT NULL,
  target_url TEXT NOT NULL,
  caller_session TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','pending','sent','dead','cancelled')),
  message TEXT NOT NULL DEFAULT '', -- 待投递的完整信封（含 reply token 明文）；sent/dead 后清空，明文只在待投期间存在
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL DEFAULT '',
  reply_token_sha256 TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '' CHECK (decision IN ('','accept','decline','ask')),
  decision_reason TEXT NOT NULL DEFAULT '',
  decision_ref TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, target_team)
);
CREATE INDEX IF NOT EXISTS idx_wbe_deliveries_due ON workbench_event_deliveries(status, next_at);
CREATE TABLE IF NOT EXISTS workbench_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  delivery_id INTEGER,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS wbe_log_no_update BEFORE UPDATE ON workbench_event_log BEGIN SELECT RAISE(ABORT,'workbench event log append only'); END;
CREATE TRIGGER IF NOT EXISTS wbe_log_no_delete BEFORE DELETE ON workbench_event_log BEGIN SELECT RAISE(ABORT,'workbench event log append only'); END;
CREATE TRIGGER IF NOT EXISTS wbe_events_no_delete BEFORE DELETE ON workbench_events BEGIN SELECT RAISE(ABORT,'workbench events are never deleted'); END;
`);
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export function sqliteUtcIn(ms: number): string {
  return new Date(Date.now() + ms + 1_000).toISOString().slice(0, 19).replace('T', ' ');
}
/** 阶段七 R3：入站回执经它写事件日志（同一个 log()，事项服务照常听到）。调用方负责事务。 */
export function logDeliveryFact(eventId: string, deliveryId: number, actor: string, action: string, detail: Record<string, unknown> = {}): void {
  log(eventId, deliveryId, actor, action, detail);
}
function log(eventId: string, deliveryId: number | null, actor: string, action: string, detail: Record<string, unknown> = {}): void {
  const info = db.prepare('INSERT INTO workbench_event_log (event_id, delivery_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)').run(eventId, deliveryId, actor, action, JSON.stringify(detail));
  // 听的一方出什么错都不影响这里：它自己回滚、计数，漏掉的由回填补上
  try { root.emit('workbench-event/logged', { id: Number(info.lastInsertRowid), event_id: eventId, delivery_id: deliveryId, action }); }
  catch (e) { console.error(`[workbench-events] 发事件日志事件失败（不影响本次写入）：${(e as Error)?.message ?? e}`); }
}

interface Target { agent_node: string; notify_url: string }
function notifyTargets(type: 'sop' | 'app', slug: string): Target[] {
  // 同一节点可以同时有 notify 与 both 两行（自然键含 direction）——按节点去重，先绑的那行为准
  const rows = db.prepare("SELECT agent_node, notify_url FROM bindings WHERE target_type = ? AND target_slug = ? AND direction IN ('notify','both') AND revoked_at = '' AND notify_url != '' ORDER BY id").all(type, slug) as unknown as Target[];
  const seen = new Map<string, string>();
  return rows.filter((r) => {
    const first = seen.get(r.agent_node);
    if (first === undefined) { seen.set(r.agent_node, r.notify_url); return true; }
    if (first !== r.notify_url) console.warn(`[workbench-events] ${type}/${slug} 上 ${r.agent_node} 有两条通知绑定且地址不同，按先绑的 ${first} 投递，忽略 ${r.notify_url}`);
    return false;
  });
}

/** 任务录入的「目标 SOP 台」：按 slug 或标题匹配一个已发布的 SOP；匹配不到返回 '' */
function resolveTargetSop(value: unknown): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v === '') return '';
  const hit = db.prepare("SELECT slug FROM apps WHERE kind = 'sop' AND status = 'published' AND (slug = ? OR title = ?) ORDER BY id LIMIT 1").get(v, v) as { slug: string } | undefined;
  return hit?.slug ?? '';
}

interface EventCore {
  source: 'task-center' | 'app-data';
  workbench: string;
  item: string;
  contextId: string;
  submitterKind: 'human' | 'agent' | 'unverified';
  submitter: string;
  formVersion: number | null;
  dataSha256: string;
  dispatch: boolean;
  /** 8f：提需求的人（建录入时经身份服务认出来的主体），事项的建立人取它；发布的人只留痕。
   *  都只记在事件层自己写的「recorded」那一行里，不进发给接收方的信封 */
  requester?: string | null;
  publisher?: string | null;
  /** 8f-2：requester 是怎么认出来的。'ticket' = 台页面带回的提交人票据，服务端验过（对外的 submitter_kind 照旧 unverified） */
  via?: 'ticket';
}

/** 写事件行 + 每个目标一行投递。调用方负责事务。返回 event_id。 */
function recordEvent(core: EventCore, targets: Target[], routed: 'target' | 'default' | 'unrouted', held: boolean, callerSession: string, envelopeOf: (eventId: string, createdAt: string) => Record<string, unknown>): string {
  const eventId = 'wbe-' + randomBytes(8).toString('hex');
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO workbench_events (event_id, source, workbench, item, context_id, submitter_kind, submitter, form_version, data_sha256, dispatch, routed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(eventId, core.source, core.workbench, core.item, core.contextId, core.submitterKind, core.submitter, core.formVersion, core.dataSha256, core.dispatch ? 1 : 0, routed);
  log(eventId, null, 'market', 'recorded', { source: core.source, routed, submitter_kind: core.submitterKind, targets: targets.length, ...(core.requester ? { requester: core.requester } : {}), ...(core.via ? { via: core.via } : {}), ...(core.publisher ? { publisher: core.publisher } : {}) });
  const envelope = envelopeOf(eventId, createdAt);
  for (const t of targets) {
    let token = '';
    let message: Record<string, unknown> = envelope;
    if (core.dispatch) {
      token = randomBytes(24).toString('base64url');
      message = { ...envelope, reply: { url: `${marketPublicUrl()}/api/workbench-events/${eventId}/decision`, token, decisions: [...DECISIONS] } };
    }
    const info = db.prepare('INSERT INTO workbench_event_deliveries (event_id, target_team, target_url, caller_session, status, message, reply_token_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(eventId, t.agent_node, t.notify_url, callerSession, held ? 'held' : 'pending', JSON.stringify(message), token === '' ? '' : sha256(token));
    log(eventId, Number(info.lastInsertRowid), 'market', held ? 'held' : 'queued', { target_team: t.agent_node });
  }
  return eventId;
}

/**
 * 任务中心人工发布 → human 事件。在 publishTaskIntake 的同一事务里调用（发布与事件同生同灭）。
 * 派发开关（任务级 × 中心级）没全开时投递记为 held：只记录「本来会派给谁」，管理员 release 后才发。
 */
export function recordTaskCenterEvent(task: { id: number; data: Record<string, unknown>; stepValue: (key: string) => unknown; publishedBy: string; requesterPrincipal?: string | null; publisherPrincipal?: string | null; templateVersion: number; materialSha256: string; agentDispatch: boolean; centerOn: boolean }): string {
  const targetSop = resolveTargetSop(task.stepValue('target'));
  let targets = targetSop !== '' ? notifyTargets('sop', targetSop) : [];
  let routed: 'target' | 'default' | 'unrouted' = 'target';
  if (targets.length === 0) { targets = notifyTargets('sop', 'task-center'); routed = 'default'; }
  if (targets.length === 0) routed = 'unrouted';
  const contextId = `wb:task-center:${task.id}`;
  const core: EventCore = {
    source: 'task-center', workbench: targetSop !== '' ? targetSop : 'task-center', item: `task:${task.id}`, contextId,
    submitterKind: 'human', submitter: `human:${task.publishedBy}`, formVersion: task.templateVersion, dataSha256: task.materialSha256, dispatch: true,
    requester: task.requesterPrincipal ?? null, publisher: task.publisherPrincipal ?? null,
  };
  const fields: Record<string, unknown> = { id: task.id };
  for (const key of ['title', 'intent', 'references', 'deliverable', 'target', 'due']) fields[key] = task.stepValue(key) ?? '';
  return recordEvent(core, targets, routed, !(task.agentDispatch && task.centerOn), `${MARKET_TEAM}/${sopNode8('task-center')}`, (eventId, createdAt) => ({
    type: 'workbench-event', v: WORKBENCH_EVENT_VERSION, event_id: eventId, source: core.source, workbench: core.workbench, item: core.item,
    context_id: contextId, submitter_kind: core.submitterKind, submitter: core.submitter, form_version: core.formVersion,
    data_sha256: core.dataSha256, created_at: createdAt, dispatch: true, task: fields,
  }));
}

/**
 * 自产台表单提交 → 数据通知。提交面是匿名的、created_by 由提交方自填，分不出人与 agent：
 * SSO v2 覆盖到这里之前一律 unverified、dispatch:false——只通知，不派发，不要决定。
 * 旧字段（type/slug/id/data/created_at/hint）原样保留，现有接收方不受影响。
 */
export function recordAppDataEvent(item: { slug: string; id: number; data: unknown; json: string; createdBy: string; createdAt: string; submitterPrincipal?: string | null }): string | null {
  const targets = notifyTargets('app', item.slug);
  if (targets.length === 0) return null; // 无通知绑定：不建事件（数据真源在 app_data，人类事件判据不涉及 unverified）
  const contextId = `wb:${item.slug}:${item.id}`;
  const core: EventCore = {
    source: 'app-data', workbench: item.slug, item: `item:${item.id}`, contextId, submitterKind: 'unverified',
    submitter: item.createdBy, formVersion: null, dataSha256: sha256(item.json), dispatch: false,
  };
  // 8f-2：带了验得过的提交人票据。对外不升级信任：submitter_kind 照旧 unverified、submitter 照旧是自填的显示名（和今天逐字节相同），
  // 信封只多两个字段 submitter_principal、submitter_via:"ticket"。市场内部：提需求的人记进 recorded（via:ticket），事项的建立人取它。
  // 判断「是谁」只读主体字段（submitter_principal、recorded.requester）；submitter（user:<id>、human:<名>）是显示用的存量，不拿来判断。
  // 只通知、不派发（dispatch:false）照旧
  const ticketed = item.submitterPrincipal ? { submitter_principal: item.submitterPrincipal, submitter_via: 'ticket' as const } : {};
  if (item.submitterPrincipal) { core.requester = item.submitterPrincipal; core.via = 'ticket'; }
  let eventId = '';
  db.exec('BEGIN IMMEDIATE');
  try {
    eventId = recordEvent(core, targets, 'target', false, `${MARKET_TEAM}/${sopNode8(item.slug)}`, (id) => ({
      type: 'app-data-submitted', slug: item.slug, id: item.id, data: item.data, created_at: item.createdAt,
      hint: '经 MCP app_data_list（slug + before_id 增量）读取；真源在 app_data',
      v: WORKBENCH_EVENT_VERSION, event_id: id, source: core.source, workbench: core.workbench, item: core.item, context_id: contextId,
      submitter_kind: core.submitterKind, submitter: core.submitter, ...ticketed, data_sha256: core.dataSha256, dispatch: false,
    }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return eventId;
}

// ---------- 投递 worker ----------
interface DeliveryRow { id: number; event_id: string; target_team: string; target_url: string; caller_session: string; message: string; attempts: number; context_id: string; source: string; item: string }
export function backoffScale(): number {
  const v = Number(process.env.A2A_OUTBOX_BACKOFF_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
}
/** 正在发送的投递（进程内）。撤回不动它们，由发送结果落定，见 cancelTaskCenterDeliveries。 */
const inFlight = new Set<number>();
/** attempts = 已尝试次数（含成功的那次）。只从 pending 落定，别的状态不覆盖。 */
function settle(row: DeliveryRow, status: 'sent' | 'dead' | 'cancelled', error = '', attempts = row.attempts): void {
  const r = db.prepare("UPDATE workbench_event_deliveries SET status = ?, message = '', attempts = ?, last_error = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END WHERE id = ? AND status = 'pending'").run(status, attempts, error.slice(0, 300), status, row.id);
  if (Number(r.changes) === 0) return; // 已被别处落定（不应发生：撤回跳过在途行）
  // 发送途中任务被撤回：接单方确实收到了，如实记 sent，另记一条，供撤回方追查
  const action = status === 'sent' && taskWithdrawn(row.source, row.item) ? 'sent-after-withdraw' : status;
  log(row.event_id, row.id, 'market', action, error === '' ? {} : { error: error.slice(0, 300) });
}
/** 任务中心事件对应的任务已撤回？（撤回后不再派发） */
/**
 * 放行之前的判断（只有这一处）：事件在、任务没撤回。放行接口和事项详情的 can.release、turn.release 都用它
 * （「有没有 held 的投递」接口在事务里数；事项那边看事项状态是不是 held，两者同进同退）。
 * 能放行返回 null；不能返回旧接口的应答。
 */
export function releaseBlock(eventId: string): { status: number; body: Record<string, unknown> } | null {
  const ev = db.prepare('SELECT source, item FROM workbench_events WHERE event_id = ?').get(eventId) as { source: string; item: string } | undefined;
  if (!ev) return { status: 404, body: { error: 'event not found' } };
  if (taskWithdrawn(ev.source, ev.item)) return { status: 409, body: { error: '任务已撤回，不再派发', event_id: eventId } };
  return null;
}

function taskWithdrawn(source: string, item: string): boolean {
  if (source !== 'task-center') return false;
  const id = Number(item.replace(/^task:/, ''));
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string } | undefined;
  return t?.status === 'withdrawn';
}
/**
 * 任务撤回：把该任务事件里还没发出的投递（held / pending）转为 cancelled。在撤回的同一事务里调用。
 * 正在发送的那次不动——它可能已经到了对端；返回 in_flight 如实报告，落定时记 sent-after-withdraw。
 */
export function cancelTaskCenterDeliveries(taskId: number, actor: string): { cancelled: number; in_flight: number } {
  const rows = db.prepare("SELECT d.id, d.event_id FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE e.source = 'task-center' AND e.item = ? AND d.status IN ('held','pending')").all(`task:${taskId}`) as { id: number; event_id: string }[];
  let cancelled = 0, in_flight = 0;
  for (const r of rows) {
    if (inFlight.has(r.id)) { in_flight++; continue; }
    db.prepare("UPDATE workbench_event_deliveries SET status = 'cancelled', message = '' WHERE id = ?").run(r.id);
    log(r.event_id, r.id, actor, 'cancelled', { reason: 'task withdrawn' });
    cancelled++;
  }
  return { cancelled, in_flight };
}
async function deliver(row: DeliveryRow): Promise<void> {
  if (taskWithdrawn(row.source, row.item)) return settle(row, 'cancelled', 'task withdrawn');
  inFlight.add(row.id);
  try { await attemptDelivery(row); } finally { inFlight.delete(row.id); }
}
async function attemptDelivery(row: DeliveryRow): Promise<void> {
  const attempt = row.attempts + 1;
  // 每次尝试一个 task_id：对端幂等键按 task_id 全机唯一，且登记在「判定能否投递」之前——
  // 同一 task_id 重试拿到的 -32003 不能证明上次送到了；同机多团队共用一个 id 会撞 -32002。
  // 代价是对端丢了响应时可能收到两次，接单方按 event_id 去重（契约 §5）。
  const taskId = `${row.event_id}.d${row.id}.a${attempt}`;
  const body = JSON.stringify({ team: row.target_team, message: row.message, caller_session: row.caller_session, context_id: row.context_id, wait: false, task_id: taskId });
  if (Buffer.byteLength(body, 'utf8') > MAX_ROUTE_BODY_BYTES) return settle(row, 'dead', 'payload exceeds the direct-route transport cap', attempt);
  // 阶段七 R3：发出之前记下这个任务号和对端是谁（名片 team 与根地址）；回执只认这台宿主的签名。取不到名片也照发，回执届时只记「收到未采信」
  const peer = await peerCard(row.target_url).catch(() => null);
  recordSentTask({ taskId, eventId: row.event_id, deliveryId: row.id, peerRoot: peerRoot(row.target_url), peerZone: peer?.team ?? '' });
  let out: any;
  try {
    out = await a2aSendOutbound(a2aKeyPath(), { baseUrl: row.target_url, team: row.target_team }, row.message, row.context_id, row.caller_session, { taskId, async: true });
  } catch (e: any) {
    out = { ok: false, error: String(e?.message ?? e) };
  }
  if (out?.ok === true) return settle(row, 'sent', '', attempt);
  const error = String(out?.error ?? 'unknown failure');
  if (typeof out?.code === 'number' && TERMINAL_CODES.has(out.code)) return settle(row, 'dead', `${out.code}: ${error}`, attempt);
  if (attempt >= MAX_ATTEMPTS) return settle(row, 'dead', error, attempt);
  const delay = (BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 3_600_000) * backoffScale();
  db.prepare("UPDATE workbench_event_deliveries SET attempts = ?, next_at = ?, last_error = ? WHERE id = ? AND status = 'pending'").run(attempt, sqliteUtcIn(delay), error.slice(0, 300), row.id);
  log(row.event_id, row.id, 'market', 'retry', { attempts: attempt, error: error.slice(0, 300) });
}
let ticking = false;
let kickAgain = false;
export async function workbenchEventTick(): Promise<void> {
  // 对外断开（预发）：整轮跳过——不发、不加 attempts、不判死，在途的保持 pending，开关打开以后原样接着投
  if (outboundOff()) { noteBlocked('event-delivery'); return; }
  if (ticking) { kickAgain = true; return; }
  ticking = true;
  try {
    do {
      kickAgain = false;
      const due = db.prepare("SELECT d.id, d.event_id, d.target_team, d.target_url, d.caller_session, d.message, d.attempts, e.context_id, e.source, e.item FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id WHERE d.status = 'pending' AND d.next_at <= datetime('now') ORDER BY d.id LIMIT 20").all() as unknown as DeliveryRow[];
      // 并发投递：一台宕机的主机（每次可能等满 15s）不拖住发往其他主机的投递
      for (let i = 0; i < due.length; i += WORKER_CONCURRENCY) {
        await Promise.allSettled(due.slice(i, i + WORKER_CONCURRENCY).map((row) => deliver(row).catch((e) => console.error(`[workbench-events] delivery ${row.id} failed: ${String(e).slice(0, 120)}`))));
      }
      // 阶段七 R2：回给团队的消息（答复、来信回复、跟进回执），同一个 worker、同一套发送与退避
      await replyTick();
    } while (kickAgain);
  } finally { ticking = false; }
}
/** 立即试投（发布/提交后调用）；失败留给定时 worker 按退避重试 */
export function kickWorkbenchEvents(): void {
  setImmediate(() => { void workbenchEventTick(); });
}
export function startWorkbenchEventWorker(): void {
  if (!process.env.MARKET_PUBLIC_URL) console.warn('[workbench-events] MARKET_PUBLIC_URL 未设：派发信封里的 reply.url 与 OriginClaim 的 callerUrl 都是回环地址，远程接单节点回写不了决定、对端也取不到市场卡片');
  // 挂在根上下文的 effect 上，卸载时一起停
  root.effect(() => {
    const timer = setInterval(() => { void workbenchEventTick(); }, 5_000);
    timer.unref?.();
    return () => { clearInterval(timer); };
  }, 'workbench-events.worker(5s)');
}

// ---------- HTTP 面 ----------
function eventView(e: any) {
  const deliveries = db.prepare('SELECT id, target_team, target_url, status, attempts, last_error, sent_at, decision, decision_reason, decision_ref, decided_by, decided_at, created_at FROM workbench_event_deliveries WHERE event_id = ? ORDER BY id').all(e.event_id);
  return { ...e, dispatch: e.dispatch === 1, deliveries };
}

export function registerWorkbenchEventRoutes(app: HttpService, guards: { admin: (req: express.Request, res: express.Response) => boolean; sameOrigin: (req: express.Request) => boolean;
  /** 放行的人（留痕里的写法）：本机命令行 cli，口令 admin-token，会话登录的管理员 odoo:<登录名>。以前写死成 human:admin */
  actor: (req: express.Request) => string }): void {
  // 列表 / 详情：管理员读（含目标团队与地址；reply token 永不出现在读面）
  app.get('/api/workbench-events', { action: 'workbench-event.list', kind: 'admin' }, (req, res) => {
    if (!guards.admin(req, res)) return;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = db.prepare('SELECT * FROM workbench_events ORDER BY id DESC LIMIT ?').all(limit);
    res.set('Cache-Control', 'no-store').json(rows.map(eventView));
  });
  app.get('/api/workbench-events/:eventId', { action: 'workbench-event.read', kind: 'admin' }, (req, res) => {
    if (!guards.admin(req, res)) return;
    const e = db.prepare('SELECT * FROM workbench_events WHERE event_id = ?').get(req.params.eventId);
    if (!e) return res.status(404).json({ error: 'event not found' });
    const logRows = db.prepare('SELECT delivery_id, at, actor, action, detail FROM workbench_event_log WHERE event_id = ? ORDER BY id').all(req.params.eventId);
    res.set('Cache-Control', 'no-store').json({ ...eventView(e), log: logRows });
  });
  // release：观察期的人工确认——把这个事件的 held 投递转为 pending
  app.post('/api/workbench-events/:eventId/release', { action: 'workbench-event.release', kind: 'decide' }, (req, res) => {
    if (!guards.sameOrigin(req)) return res.status(403).json({ error: '跨源拒绝' });
    if (!guards.admin(req, res)) return;
    const eventId = req.params.eventId;
    const blocked = releaseBlock(eventId);
    if (blocked) return res.status(blocked.status).json(blocked.body);
    const who = guards.actor(req);
    db.exec('BEGIN IMMEDIATE');
    let released: { id: number }[] = [];
    try {
      released = db.prepare("SELECT id FROM workbench_event_deliveries WHERE event_id = ? AND status = 'held'").all(eventId) as { id: number }[];
      for (const r of released) {
        db.prepare("UPDATE workbench_event_deliveries SET status = 'pending', next_at = datetime('now') WHERE id = ?").run(r.id);
        log(eventId, r.id, who, 'released');
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (released.length === 0) return res.status(409).json({ error: '该事件没有待确认（held）的投递', event_id: eventId });
    kickWorkbenchEvents();
    res.json({ ok: true, event_id: eventId, released: released.length });
  });
  // 决定：接单节点凭投递里的 reply token 回写。ask 可再改；accept/decline 是终态。
  app.post('/api/workbench-events/:eventId/decision', { action: 'workbench-event.decision', kind: 'write', statusNotVerdict: '接单节点凭投递里的 reply token 回写，不是登录身份的结论' }, (req, res) => {
    const eventId = req.params.eventId;
    const b = req.body ?? {};
    if (!EVENT_ID.test(eventId)) return res.status(404).json({ error: 'event not found' });
    const token = typeof b.token === 'string' ? b.token : '';
    const decision = typeof b.decision === 'string' ? b.decision : '';
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    const ref = typeof b.ref === 'string' ? b.ref.trim() : '';
    const by = typeof b.by === 'string' ? b.by.trim().slice(0, 128) : '';
    if (!DECISIONS.has(decision)) return res.status(400).json({ error: 'decision 只许 accept|decline|ask' });
    if (reason === '' || reason.length > 500) return res.status(400).json({ error: 'reason 必填，≤500 字' });
    if (ref.length > 300 || (ref !== '' && !/^https?:\/\/\S+$/.test(ref))) return res.status(400).json({ error: 'ref 须为 http(s) 链接，≤300 字' });
    // 凭 token 找到唯一一条投递；找不到与 token 错同答 404（不泄露事件是否存在）
    const hash = Buffer.from(sha256(token), 'hex');
    const rows = db.prepare("SELECT id, status, decision, reply_token_sha256, (sent_at != '' AND datetime(sent_at, '+' || ? || ' days') > datetime('now')) AS live FROM workbench_event_deliveries WHERE event_id = ? AND reply_token_sha256 != ''").all(REPLY_TTL_DAYS, eventId) as { id: number; status: string; decision: string; reply_token_sha256: string; live: number }[];
    const row = token === '' ? undefined : rows.find((r) => { const h = Buffer.from(r.reply_token_sha256, 'hex'); return h.length === hash.length && timingSafeEqual(h, hash); });
    if (!row) return res.status(404).json({ error: 'event not found' });
    if (row.status !== 'sent') return res.status(409).json({ error: `投递状态为 ${row.status}，只有已送达的投递才能回写决定` });
    if (row.decision === 'accept' || row.decision === 'decline') return res.status(409).json({ error: `已有终态决定：${row.decision}`, decision: row.decision });
    if (row.live !== 1) return res.status(410).json({ error: `reply token 已过期（送达后 ${REPLY_TTL_DAYS} 天）` });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE workbench_event_deliveries SET decision = ?, decision_reason = ?, decision_ref = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(decision, reason, ref, by, row.id);
      log(eventId, row.id, by === '' ? 'receiver' : `receiver:${by}`, `decision:${decision}`, { reason, ref });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, event_id: eventId, decision });
  });
}
