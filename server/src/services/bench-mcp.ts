/**
 * 数据视图的 MCP 工具：授予和执行（docs/data-views.md 第十节 3b）。
 *
 * 授予按「会话 × 台 × 工具」记在这里自己的表里，不放进会话的 grants：
 *   · 会话的 grants 由系统管理员经 MCP 网关页整体改写；台里是业务数据，系统管理员不该能把它批给一个会话；
 *   · 所以这些工具的授予只有台的管理层能给（/api/bench-views/<台>/mcp-…，经统一判定），留痕记谁批的、哪个台。
 * 读也按台限定：没有「不带台」的授予。
 *
 * 这是过渡做法：会话还不是主体。以后 AI 员工成了主体、对象范围接进统一判定，这张表并过去（见设计稿「以后」）。
 */
import { db } from '../db.ts';
import { BenchError } from '../bench-query.ts';
import { BENCH_SLUG_RE } from './bench-store-core.ts';
import { benchStore, type BenchStore } from './bench-store.ts';
import { benchAliases, cardSlug, getBench, resolveBenchRef, unopenedCard } from './bench-registry.ts';
import { BENCH_TOOL_DEFS, BENCH_TOOL_NAMES } from '../bench-mcp-tools.ts';
import { generateReport, listReports, readReport, respondReport } from './bench-report.ts';

export const BENCH_REQUEST_HOURLY_MAX = 10;
/**
 * 台的权限申请没人处理的总期限（WM_BENCH_REQUEST_TTL_HOURS，缺省 72 小时，1～720）。启动时读一次（benchRequestTtlConfig），不合法拒绝启动。
 * 到期还没定的申请标成「失效：没有人处理」：申请的会话查状态时看得到这个结局（status = expired），「关注」里那条也一起消失。
 * 库里存成驳回（status = rejected、decided_by = system、note 是这句话）：表上的取值约束不用改；对外由 forSession 换成 expired。
 * 标识写错的台和有台但没人管的，结局完全一样——不因此透露一个台存不存在。
 */
export const BENCH_REQUEST_TTL_DEFAULT_HOURS = 72;
let ttlMs = BENCH_REQUEST_TTL_DEFAULT_HOURS * 3_600_000;
export function benchRequestTtlConfig(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.WM_BENCH_REQUEST_TTL_HOURS ?? '').trim();
  if (raw === '') return BENCH_REQUEST_TTL_DEFAULT_HOURS;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > 720) throw new Error(`WM_BENCH_REQUEST_TTL_HOURS 要是 1～720 的整数（小时），现在是 ${JSON.stringify(raw)}`);
  return n;
}
export function setBenchRequestTtlHours(hours: number): void { ttlMs = hours * 3_600_000; }
export const EXPIRED_NOTE = '失效：没有人处理';
/** 把到期还没定的申请标成失效，各留一行痕（谁做的记 system）。读申请、提申请、批申请之前都先做一遍 */
export function expireBenchRequests(at: number): number {
  const due = db.prepare("SELECT id, bench, session_id, tools FROM bench_mcp_requests WHERE status = 'pending' AND created_at <= ? ORDER BY id").all(at - ttlMs) as Row[];
  for (const q of due) {
    db.prepare("UPDATE bench_mcp_requests SET status = 'rejected', decided_by = 'system', decided_at = ?, note = ? WHERE id = ? AND status = 'pending'").run(at, EXPIRED_NOTE, Number(q.id));
    db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, request_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(String(q.bench), Number(q.session_id), 'expire', String(q.tools), 'system', Number(q.id), EXPIRED_NOTE, at);
  }
  return due.length;
}
const REASON_MAX = 500;
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CATEGORY = new Map(BENCH_TOOL_DEFS.map((t) => [t.name, t.category]));

type Row = Record<string, unknown>;
const parseTools = (raw: unknown): string[] => { try { const v = JSON.parse(String(raw ?? '[]')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
/** 工具名的数组：都得是数据视图的工具，去重、排好 */
function toolList(raw: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) throw new BenchError('invalid', 'tools 须为工具名的数组');
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string' || !BENCH_TOOL_NAMES.has(t)) throw new BenchError('invalid', `不是数据视图的工具：${String(t).slice(0, 60)}`);
    out.add(t);
  }
  return [...out].sort();
}

// —— 授予 ——
/** 这个会话在这个台上有没有这个工具的授予 */
export function hasBenchGrant(sessionId: number, bench: string, toolName: string): boolean {
  return !!db.prepare('SELECT 1 FROM bench_mcp_grants WHERE session_id = ? AND bench = ? AND tool = ?').get(sessionId, bench, toolName);
}
/** 这个会话的全部授予：工具 → 台的清单（access_info 用） */
export function benchGrantsOf(sessionId: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db.prepare('SELECT tool, bench FROM bench_mcp_grants WHERE session_id = ? ORDER BY tool, bench').all(sessionId) as Row[]) {
    const k = String(r.tool); out.set(k, [...(out.get(k) ?? []), String(r.bench)]);
  }
  return out;
}

// —— 申请（会话提，台的管理层批） ——
export type BenchRequest = { id: number; bench: string; tools: string[]; reason: string; status: string; note: string; created_at: number; decided_at: number | null };
const statusOf = (r: Row): string => (String(r.status) === 'rejected' && String(r.decided_by) === 'system' && String(r.note) === EXPIRED_NOTE ? 'expired' : String(r.status));
const forSession = (r: Row): BenchRequest => ({ id: Number(r.id), bench: String(r.bench), tools: parseTools(r.tools), reason: String(r.reason), status: statusOf(r), note: String(r.note), created_at: Number(r.created_at), decided_at: r.decided_at === null ? null : Number(r.decided_at) });
export function benchRequestsOf(sessionId: number, at = Date.now()): BenchRequest[] {
  expireBenchRequests(at);
  return (db.prepare('SELECT * FROM bench_mcp_requests WHERE session_id = ? ORDER BY id DESC LIMIT 50').all(sessionId) as Row[]).map(forSession);
}
/** 本会话的一条台申请（别的会话的和不存在的都是 null） */
export function benchRequestOfSession(sessionId: number, id: number, at = Date.now()): BenchRequest | null {
  expireBenchRequests(at); // 和清单一样先把到期的标成失效，单查和清单说法一致
  const r = db.prepare('SELECT * FROM bench_mcp_requests WHERE id = ? AND session_id = ?').get(id, sessionId) as Row | undefined;
  return r ? forSession(r) : null;
}
/**
 * 会话申请在一个台上用几个工具。台的标识只核写法，不核存不存在：没有授予的会话看不出台存不存在。
 * 写错了标识的申请不会有人看到，应答里说明这一点。
 */
export function requestBenchTools(sessionId: number, bench: string, tools: unknown, reason: unknown, at: number): { ok: true; duplicate: boolean; request: BenchRequest; note: string } {
  if (typeof bench !== 'string' || !BENCH_SLUG_RE.test(bench)) throw new BenchError('invalid', '台的标识写法不对');
  const want = toolList(tools, false).filter((t) => !hasBenchGrant(sessionId, bench, t));
  if (!want.length) throw new BenchError('invalid', '申请的工具本会话在这个台上都已可用，无需申请');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new BenchError('invalid', 'reason 必填：写清要用这些工具做什么');
  if ([...why].length > REASON_MAX) throw new BenchError('invalid', `reason 超过 ${REASON_MAX} 字`);
  const json = JSON.stringify(want);
  const note = `台的管理层批准之后生效。${Math.round(ttlMs / 3_600_000)} 小时内没人处理，申请会标成「${EXPIRED_NOTE}」。台的标识只核写法、不核存不存在：写错了不会有人批，也是这个结局`;
  db.exec('BEGIN IMMEDIATE');
  try {
    expireBenchRequests(at);
    const dup = db.prepare("SELECT * FROM bench_mcp_requests WHERE session_id = ? AND bench = ? AND tools = ? AND status = 'pending'").get(sessionId, bench, json) as Row | undefined;
    let out;
    if (dup) out = { ok: true as const, duplicate: true, request: forSession(dup), note };
    else {
      const n = Number((db.prepare('SELECT COUNT(*) AS n FROM bench_mcp_requests WHERE session_id = ? AND created_at > ?').get(sessionId, at - 3_600_000) as { n: number }).n);
      if (n >= BENCH_REQUEST_HOURLY_MAX) throw new BenchError('busy', `每个会话每小时最多提 ${BENCH_REQUEST_HOURLY_MAX} 条台的权限申请，稍后再试`);
      const r = db.prepare('INSERT INTO bench_mcp_requests (session_id, bench, tools, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, bench, json, why, at);
      out = { ok: true as const, duplicate: false, request: forSession(db.prepare('SELECT * FROM bench_mcp_requests WHERE id = ?').get(Number(r.lastInsertRowid)) as Row), note };
    }
    db.exec('COMMIT');
    return out;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// —— 台的管理层这一侧 ——
/**
 * 一条申请里写的台指的是哪个台。申请表照会话写的原样存，这里统一换算：
 *   · 登记过的台（写台标识、卡片 id 都认）：registered，slug 是台标识；
 *   · 一张还在、还没开台库的卡片（写卡片 id 或 wb-<卡片 id>）：没登记，slug 是批准时会给它开的台标识 wb-<卡片 id>；
 *   · 别的（标识写错了、卡片已删）：null，没有人能批，不进待批清单。
 */
export type RequestTarget = { slug: string; title: string; registered: boolean; workbench_id: number | null };
export function requestTarget(ref: string): RequestTarget | null {
  const b = getBench(resolveBenchRef(ref));
  if (b) return { slug: b.slug, title: b.title, registered: true, workbench_id: b.workbench_id };
  const c = unopenedCard(ref);
  return c ? { slug: cardSlug(c.workbench_id), title: c.name, registered: false, workbench_id: c.workbench_id } : null;
}
const audit =(bench: string, sessionId: number, action: string, tools: string[], actor: string, at: number, requestId: number | null, note: string): void => {
  db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, request_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(bench, sessionId, action, JSON.stringify(tools), actor, requestId, note.slice(0, 500), at);
};
/** 一个台上：哪些会话有哪些工具、有哪些申请、最近的留痕 */
export function listBenchMcp(bench: string, at = Date.now()) {
  expireBenchRequests(at);
  const grants = new Map<number, { session_id: number; session: string; revoked: boolean; tools: { tool: string; category: string; granted_by: string; granted_at: number }[] }>();
  for (const r of db.prepare(`SELECT g.session_id, g.tool, g.granted_by, g.granted_at, s.name, s.revoked_at FROM bench_mcp_grants g LEFT JOIN mcp_sessions s ON s.id = g.session_id WHERE g.bench = ? ORDER BY g.session_id, g.tool`).all(bench) as Row[]) {
    const id = Number(r.session_id);
    const e = grants.get(id) ?? { session_id: id, session: r.name === null ? '' : String(r.name), revoked: r.name === null || String(r.revoked_at ?? '') !== '', tools: [] };
    e.tools.push({ tool: String(r.tool), category: CATEGORY.get(String(r.tool)) ?? 'write', granted_by: String(r.granted_by), granted_at: Number(r.granted_at) });
    grants.set(id, e);
  }
  // 写成卡片号的申请也算这个台的
  const b = getBench(bench), refs = b ? benchAliases(b) : [bench];
  const requests = (db.prepare(`SELECT q.*, s.name FROM bench_mcp_requests q LEFT JOIN mcp_sessions s ON s.id = q.session_id WHERE q.bench IN (${refs.map(() => '?').join(', ')}) ORDER BY q.id DESC LIMIT 100`).all(...refs) as Row[])
    .map((r) => ({ ...forSession(r), session_id: Number(r.session_id), session: r.name === null ? '' : String(r.name), decided_by: String(r.decided_by) }));
  const log = (db.prepare('SELECT id, session_id, action, tools, actor, request_id, note, at FROM bench_mcp_audit WHERE bench = ? ORDER BY id DESC LIMIT 100').all(bench) as Row[])
    .map((r) => ({ id: Number(r.id), session_id: Number(r.session_id), action: String(r.action), tools: parseTools(r.tools), actor: String(r.actor), request_id: r.request_id === null ? null : Number(r.request_id), note: String(r.note), at: Number(r.at) }));
  return { grants: [...grants.values()], requests, log };
}
/**
 * 还没定、批得了的申请（「关注」里的待批清单用）：登记过的台上的，和写成「还没开台库的卡片」的（批准时顺带开台库，bench_registered 为 false）。
 * 标识写错的、卡片已删的、会话已吊销或删除的不在里面：批不了，列出来只能让人去点一个必然失败的「同意」。
 * bench 是换算后的台标识（没开台库的卡片是 wb-<卡片 id>），批的时候照它找台。
 */
export type PendingBenchRequest = {
  id: number; bench: string; bench_title: string; bench_registered: boolean; workbench_id: number | null;
  session: string; reason: string; created_at: number; tools: { tool: string; category: string }[];
};
export function pendingBenchRequests(limit = 200, at = Date.now()): PendingBenchRequest[] {
  expireBenchRequests(at);
  const out: PendingBenchRequest[] = [];
  // 批不了的要滤掉，所以多取一些；每个会话每小时最多 10 条，写错标识的不会把清单挤满
  for (const r of db.prepare(`SELECT q.id, q.bench, q.tools, q.reason, q.created_at, s.name AS session
    FROM bench_mcp_requests q JOIN mcp_sessions s ON s.id = q.session_id AND s.revoked_at = ''
    WHERE q.status = 'pending' ORDER BY q.id LIMIT ?`).all(limit * 5) as Row[]) {
    const t = requestTarget(String(r.bench));
    if (!t) continue;
    out.push({
      id: Number(r.id), bench: t.slug, bench_title: t.title, bench_registered: t.registered, workbench_id: t.workbench_id,
      session: r.session === null ? '' : String(r.session), reason: String(r.reason), created_at: Number(r.created_at),
      tools: parseTools(r.tools).map((x) => ({ tool: x, category: CATEGORY.get(x) ?? 'write' })),
    });
    if (out.length >= limit) break;
  }
  return out;
}
/** 申请 #id 对的是台 bench（台标识，或没开台库的卡片的 wb-<卡片 id>）、还没定、提申请的会话还在：批得了就返回那一行，批不了抛出（和 decideBenchRequest 同样的说法）。不写库 */
function decidable(bench: string, id: number, approve: boolean): Row {
  const q = db.prepare('SELECT * FROM bench_mcp_requests WHERE id = ?').get(id) as Row | undefined;
  if (!q || requestTarget(String(q.bench))?.slug !== bench) throw new BenchError('not_found', `这个台上没有申请 #${id}`);
  if (String(q.status) !== 'pending') throw new BenchError('conflict', statusOf(q) === 'expired' ? `申请 #${id} 已经失效（没有人处理，过了期限）` : `申请 #${id} 已经${String(q.status) === 'approved' ? '批准' : '驳回'}过了`);
  if (approve) {
    const s = db.prepare('SELECT revoked_at FROM mcp_sessions WHERE id = ?').get(Number(q.session_id)) as Row | undefined;
    if (!s || String(s.revoked_at ?? '') !== '') throw new BenchError('conflict', '提这条申请的会话已经吊销或删除，批不了');
  }
  return q;
}
/** 批之前先核一遍批不批得了（给没开台库的卡片开库之前用：批不了就不白开一个台库）。不写库 */
export function checkBenchRequest(bench: string, id: number, approve: boolean, at = Date.now()): void {
  expireBenchRequests(at);
  decidable(bench, id, approve);
}
/**
 * 批准或驳回一条申请。申请得是这个台的（会话写成卡片号的也算，见 requestTarget）、还没定过的。
 * 批准时台必须已经登记（没开台库的卡片由路由先开库再调这里）；驳回不需要
 */
export function decideBenchRequest(bench: string, id: number, approve: unknown, actor: string, note: unknown, at: number) {
  if (typeof approve !== 'boolean') throw new BenchError('invalid', '要给 approve（true 批准 / false 驳回）');
  const why = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  db.exec('BEGIN IMMEDIATE');
  try {
    expireBenchRequests(at);
    const q = decidable(bench, id, false);
    // 不批要写理由：申请的会话看得到这句话。在路由这一层就要求，卡片不经答复入口直接调过来时也一样
    if (!approve && !why) throw new BenchError('invalid', '不批要写理由（note）');
    const sessionId = Number(q.session_id), tools = parseTools(q.tools).filter((t) => BENCH_TOOL_NAMES.has(t));
    if (approve) {
      decidable(bench, id, true);
      // 授予按台标识记：台得已经登记（不然工具调用时也认不出这个台）
      if (!getBench(bench)) throw new BenchError('not_found', '这个台还没登记，先开台库再批');
      for (const t of tools) db.prepare('INSERT OR IGNORE INTO bench_mcp_grants (session_id, bench, tool, granted_by, granted_at, request_id) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, bench, t, actor, at, id);
    }
    db.prepare('UPDATE bench_mcp_requests SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', actor, at, why, id);
    audit(bench, sessionId, approve ? 'approve' : 'reject', tools, actor, at, id, why);
    db.exec('COMMIT');
    return { ok: true, id, status: approve ? 'approved' : 'rejected', granted: approve ? tools : [] };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/** 把一个会话在这个台上的工具整份改成给定的这些（空数组就是全收回） */
export function setBenchGrants(bench: string, input: unknown, actor: string, at: number) {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Row;
  if (typeof o.session !== 'string' || !SESSION_NAME_RE.test(o.session)) throw new BenchError('invalid', '要给 session（会话名）');
  const tools = toolList(o.tools, true);
  const why = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const s = db.prepare('SELECT id, revoked_at FROM mcp_sessions WHERE name = ?').get(o.session) as Row | undefined;
    if (!s) throw new BenchError('not_found', `没有会话 ${o.session}`);
    if (tools.length && String(s.revoked_at ?? '') !== '') throw new BenchError('conflict', '这个会话已经吊销，不能再给它授予');
    const sessionId = Number(s.id);
    const before = (db.prepare('SELECT tool FROM bench_mcp_grants WHERE session_id = ? AND bench = ? ORDER BY tool').all(sessionId, bench) as Row[]).map((r) => String(r.tool));
    const added = tools.filter((t) => !before.includes(t)), removed = before.filter((t) => !tools.includes(t));
    for (const t of removed) db.prepare('DELETE FROM bench_mcp_grants WHERE session_id = ? AND bench = ? AND tool = ?').run(sessionId, bench, t);
    for (const t of added) db.prepare('INSERT INTO bench_mcp_grants (session_id, bench, tool, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, bench, t, actor, at);
    if (added.length) audit(bench, sessionId, 'grant', added, actor, at, null, why);
    if (removed.length) audit(bench, sessionId, 'revoke', removed, actor, at, null, why);
    db.exec('COMMIT');
    return { ok: true, session: o.session, tools, added, removed };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// —— 执行 ——
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const need = <T>(v: T | undefined, what: string): T => { if (v === undefined) throw new BenchError('invalid', `要给 ${what}`); return v; };
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const KEYS = new Map<string, readonly string[]>(BENCH_TOOL_DEFS.map((t) => [t.name, Object.keys((t.inputSchema as { properties: Row }).properties)]));

/**
 * 核对这次调用能不能做，能做就把台库交出来。返回 null 就是「没有这个工具」：
 * 入口关着、没有会话（网关关着也一样：台里的数据不因为网关关了就放开）、台的标识不对、没有授予、台没登记，对外都是同一个样子。
 */
export async function benchToolTarget(on: boolean, sessionId: number | null, toolName: string, args: unknown): Promise<BenchStore | null> {
  if (!on || sessionId === null || !BENCH_TOOL_NAMES.has(toolName)) return null;
  const ref = (args && typeof args === 'object' && !Array.isArray(args) ? (args as Row).bench : undefined);
  if (typeof ref !== 'string' || !BENCH_SLUG_RE.test(ref)) return null;
  const bench = resolveBenchRef(ref); // 写卡片 id 也认：授予按台标识记
  if (!hasBenchGrant(sessionId, bench, toolName)) return null;
  // 回应要读得了这份报告（规格第五节第 14 条）：会话在这个台上还要有 report_get 的授予（#932 独立验收）
  if (toolName === 'report_respond' && !hasBenchGrant(sessionId, bench, 'report_get')) return null;
  if (!getBench(bench)) return null;
  return benchStore(bench);
}
/** 执行一个工具。actor 写进留痕（mcp:<会话名>） */
export async function runBenchTool(s: BenchStore, toolName: string, input: unknown, actor: string, at: number): Promise<unknown> {
  const a = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Row;
  const extra = Object.keys(a).filter((k) => !(KEYS.get(toolName) ?? []).includes(k));
  if (extra.length) throw new BenchError('invalid', `${toolName} 不认识这些参数：${extra.map((k) => k.slice(0, 40)).join('、')}`);
  const ctx = { actor, at, idemKey: text(a.idempotency_key), note: text(a.note) };
  const dataset = () => need(text(a.dataset), 'dataset（数据集名）');
  switch (toolName) {
    case 'dataset_list': return { datasets: await s.datasets() };
    case 'dataset_query': return s.query(a.query, a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params as Record<string, unknown> : {});
    case 'dataset_snapshots': return { snapshots: await s.snapshots(dataset()) };
    case 'view_get': return { view: await s.getView(a.version === undefined ? undefined : need(int(a.version), 'version（整数）')) };
    case 'view_versions': return { versions: await s.viewVersions() };
    case 'view_diff': return { diff: await s.diffViews(need(int(a.a), 'a（版本号）'), need(int(a.b), 'b（版本号）')) };
    case 'dataset_define': return s.defineDataset(a.definition as never, ctx);
    case 'dataset_replace': return s.replace(dataset(), a.rows as never, ctx);
    case 'dataset_upsert': return s.upsert(dataset(), a.rows as never, ctx);
    case 'dataset_append': return s.append(dataset(), a.rows as never, ctx);
    case 'dataset_delete_rows': return s.deleteRows(dataset(), a.keys as never, ctx);
    case 'dataset_snapshot': return s.snapshot(dataset(), ctx);
    case 'dataset_restore': return s.restore(need(int(a.snapshot_id), 'snapshot_id（快照编号）'), ctx);
    case 'view_put': return s.putView(a.doc, { ...ctx, base: need(int(a.base), 'base（你是基于第几版改的）') });
    case 'view_rollback': return s.rollbackView(need(int(a.to), 'to（让第几版重新生效）'), { ...ctx, base: need(int(a.base), 'base（你看到的生效版本）') });
    // 报告（PR C）：和 REST 走同一处（services/bench-report.ts）；actor 是 mcp:<会话名>，记 AI
    case 'report_list': return listReports(s, { dimension: a.dimension, subject: a.subject, limit: int(a.limit) });
    case 'report_get': return readReport(s, a.id, actor);
    case 'report_generate': { const b = getBench(s.slug); if (!b) throw new BenchError('not_found', '没有这个台'); const { bench: _b, ...body } = a; return generateReport(b, s, body, actor, at); }
    case 'report_respond': { const { bench: _b, id, ...body } = a; return respondReport(s, id, body, actor, at); }
    default: throw new BenchError('invalid', `不是数据视图的工具：${toolName.slice(0, 60)}`);
  }
}
