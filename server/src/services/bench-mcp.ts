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
import { getBench } from './bench-registry.ts';
import { BENCH_TOOL_DEFS, BENCH_TOOL_NAMES } from '../bench-mcp-tools.ts';

export const BENCH_REQUEST_HOURLY_MAX = 10;
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
const forSession = (r: Row): BenchRequest => ({ id: Number(r.id), bench: String(r.bench), tools: parseTools(r.tools), reason: String(r.reason), status: String(r.status), note: String(r.note), created_at: Number(r.created_at), decided_at: r.decided_at === null ? null : Number(r.decided_at) });
export function benchRequestsOf(sessionId: number): BenchRequest[] {
  return (db.prepare('SELECT * FROM bench_mcp_requests WHERE session_id = ? ORDER BY id DESC LIMIT 50').all(sessionId) as Row[]).map(forSession);
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
  const note = '台的管理层批准之后生效；台的标识要是写错了，这条申请不会有人看到';
  db.exec('BEGIN IMMEDIATE');
  try {
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
const audit = (bench: string, sessionId: number, action: string, tools: string[], actor: string, at: number, requestId: number | null, note: string): void => {
  db.prepare('INSERT INTO bench_mcp_audit (bench, session_id, action, tools, actor, request_id, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(bench, sessionId, action, JSON.stringify(tools), actor, requestId, note.slice(0, 500), at);
};
/** 一个台上：哪些会话有哪些工具、有哪些申请、最近的留痕 */
export function listBenchMcp(bench: string) {
  const grants = new Map<number, { session_id: number; session: string; revoked: boolean; tools: { tool: string; category: string; granted_by: string; granted_at: number }[] }>();
  for (const r of db.prepare(`SELECT g.session_id, g.tool, g.granted_by, g.granted_at, s.name, s.revoked_at FROM bench_mcp_grants g LEFT JOIN mcp_sessions s ON s.id = g.session_id WHERE g.bench = ? ORDER BY g.session_id, g.tool`).all(bench) as Row[]) {
    const id = Number(r.session_id);
    const e = grants.get(id) ?? { session_id: id, session: r.name === null ? '' : String(r.name), revoked: r.name === null || String(r.revoked_at ?? '') !== '', tools: [] };
    e.tools.push({ tool: String(r.tool), category: CATEGORY.get(String(r.tool)) ?? 'write', granted_by: String(r.granted_by), granted_at: Number(r.granted_at) });
    grants.set(id, e);
  }
  const requests = (db.prepare(`SELECT q.*, s.name FROM bench_mcp_requests q LEFT JOIN mcp_sessions s ON s.id = q.session_id WHERE q.bench = ? ORDER BY q.id DESC LIMIT 100`).all(bench) as Row[])
    .map((r) => ({ ...forSession(r), session_id: Number(r.session_id), session: r.name === null ? '' : String(r.name), decided_by: String(r.decided_by) }));
  const log = (db.prepare('SELECT id, session_id, action, tools, actor, request_id, note, at FROM bench_mcp_audit WHERE bench = ? ORDER BY id DESC LIMIT 100').all(bench) as Row[])
    .map((r) => ({ id: Number(r.id), session_id: Number(r.session_id), action: String(r.action), tools: parseTools(r.tools), actor: String(r.actor), request_id: r.request_id === null ? null : Number(r.request_id), note: String(r.note), at: Number(r.at) }));
  return { grants: [...grants.values()], requests, log };
}
/** 所有登记过的台上还没定的申请（「关注」里的待批清单用）。台没登记的申请不在里面：没有人能批它 */
export function pendingBenchRequests(limit = 200) {
  return (db.prepare(`SELECT q.id, q.bench, q.tools, q.reason, q.created_at, s.name AS session, b.title AS bench_title
    FROM bench_mcp_requests q JOIN bench_views b ON b.slug = q.bench LEFT JOIN mcp_sessions s ON s.id = q.session_id
    WHERE q.status = 'pending' ORDER BY q.id LIMIT ?`).all(limit) as Row[]).map((r) => ({
    id: Number(r.id), bench: String(r.bench), bench_title: String(r.bench_title), session: r.session === null ? '' : String(r.session), reason: String(r.reason), created_at: Number(r.created_at),
    tools: parseTools(r.tools).map((t) => ({ tool: t, category: CATEGORY.get(t) ?? 'write' })),
  }));
}
/** 批准或驳回一条申请。申请得是这个台的、还没定过的 */
export function decideBenchRequest(bench: string, id: number, approve: unknown, actor: string, note: unknown, at: number) {
  if (typeof approve !== 'boolean') throw new BenchError('invalid', '要给 approve（true 批准 / false 驳回）');
  const why = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const q = db.prepare('SELECT * FROM bench_mcp_requests WHERE id = ? AND bench = ?').get(id, bench) as Row | undefined;
    if (!q) throw new BenchError('not_found', `这个台上没有申请 #${id}`);
    if (String(q.status) !== 'pending') throw new BenchError('conflict', `申请 #${id} 已经${String(q.status) === 'approved' ? '批准' : '驳回'}过了`);
    const sessionId = Number(q.session_id), tools = parseTools(q.tools).filter((t) => BENCH_TOOL_NAMES.has(t));
    if (approve) {
      const s = db.prepare('SELECT revoked_at FROM mcp_sessions WHERE id = ?').get(sessionId) as Row | undefined;
      if (!s || String(s.revoked_at ?? '') !== '') throw new BenchError('conflict', '提这条申请的会话已经吊销或删除，批不了');
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
  const bench = (args && typeof args === 'object' && !Array.isArray(args) ? (args as Row).bench : undefined);
  if (typeof bench !== 'string' || !BENCH_SLUG_RE.test(bench)) return null;
  if (!hasBenchGrant(sessionId, bench, toolName)) return null;
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
    default: throw new BenchError('invalid', `不是数据视图的工具：${toolName.slice(0, 60)}`);
  }
}
