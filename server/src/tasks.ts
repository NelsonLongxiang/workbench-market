/**
 * 统一待办（omni-inbox · 总工程师设计 9c5557c1c0）：只读聚合，勾销回原系统。
 *
 * 任务信封（字段冻结 snake_case）：
 *   { id: "<source>:<native_id>", source, title, status: todo|doing|done, due, link, project }
 *
 * 适配器：
 *   - ygl-trees：project list 枚举 active 项目 → 逐项目 `task list --json --project <name>`（不改用户 selection）；
 *              并发上限/总预算/单源失败显式降级（direct-c4c460a6：旧单次调用只读当前 selection，跨项目任务丢失）
 *   - market：站内 SOP run（含未指派，running=doing）+ 任务中心已发布任务（#263 页面整链）——
 *              复用现有 sop_runs/a2a_run_ctx/tasks schema，零侵入（J4）
 *   - A2A：v2 预留，不实现
 *   - lifecycle：按查看人列 lc inbox（server/src/lifecycle.ts·不进本模块 30s 共享缓存，由 /api/tasks 路由合并）
 */
import { execFile } from 'node:child_process';

export interface TaskEnvelope {
  id: string;
  source: 'ygl-trees' | 'market' | 'a2a' | 'lifecycle';
  title: string;
  status: 'todo' | 'doing' | 'done';
  due: string | null;
  link: string | null;
  project: string | null;
  /** 仅 lifecycle 源：批准动作所需的提议与授权（POST /api/lifecycle/approve） */
  lc?: LcTaskRef;
}

export interface LcTaskRef {
  proposal_id: string; grant: string; object: string; machine: string; from: string; to: string;
  effective_at: string | null; proposed_by: string; approvals: number; levels: number;
}

export interface SourceMeta { ok: boolean; count: number; latency_ms: number; error?: string }
export interface TasksReadScope {
  subject: string;
  admin: boolean;
  yglProjects: 'all' | readonly string[];
  marketRunIds: 'all' | readonly number[];
  a2a: boolean;
}
export interface TasksPayload {
  tasks: TaskEnvelope[];
  /** a2a 键仅在 A2A_STATE_URL 已配置（源启用）时出现——未配置=源缺席≠降级（总工程师三裁①）；
   *  lifecycle 键同理，仅在 LC_* 已配置时出现，按查看人计 */
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta; a2a?: SourceMeta; lifecycle?: SourceMeta & { viewer: string | null; error?: string } };
  generated_at: string;
}

type SopServiceLike = {
  runsDispatchedAll(ids?: readonly number[]): { id: number; sop_slug: string; started_by: string; status: string; updated_at: string }[];
  runsRunning(ids?: readonly number[]): { id: number; sop_slug: string; started_by: string; status: string; updated_at: string }[];
};

// #324: no shared payload cache. Every request applies fresh identity and source/object grants.

/** 跨项目枚举常量（direct-c4c460a6）：并发、单项目超时、总预算、项目数上限 */
const YGL_CONCURRENCY = 4;
const YGL_PER_CALL_TIMEOUT_MS = 3_000;
/** 项目数上限与总预算可经环境变量 YGL_MAX_PROJECTS / YGL_TOTAL_BUDGET_MS 覆盖（.156 现网 52 个 active 项目，旧上限 40 会跳过 12 个）；
 *  缺省上限 200、总预算 8s；非整数或越界回落缺省。超限/超预算照旧在 degraded_projects 里如实上报，不静默截断。 */
function envInt(name: string, def: number, min: number, max: number): number {
  const raw = String(process.env[name] ?? '').trim();
  if (!/^\d+$/.test(raw)) return def;
  const n = Number(raw);
  return n >= min && n <= max ? n : def;
}
const yglMaxProjects = () => envInt('YGL_MAX_PROJECTS', 200, 1, 10_000);
const yglTotalBudgetMs = () => envInt('YGL_TOTAL_BUDGET_MS', 8_000, 500, 120_000);
/** 项目名边界（direct-150a721a：无 shell 后 argv 传值天然安全，合法 Unicode 名必须支持——不限制业务命名凑安全）；仅防空/超长 */
function yglProjectNameOk(name: string): boolean { return name.length >= 1 && name.length <= 128 && !name.includes('\0'); }

/** 无 shell 调 ygl-trees：node + 包内真实入口 dist/bundle/bin.cjs（Windows shim 不再经 shell:true）。
 *  入口解析边界：①node同目录node_modules ②PNPM_HOME ③APPDATA/npm。Linux全局PATH可达但非node同级布局不在支持内（降级ok=false），不引大解析系统。 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';

export function taskWorkspaceKey(): string | null {
  const home = process.env.YGL_HOME;
  if (!home || !isAbsolute(home)) return null;
  try {
    const file = join(home, 'ygl-trees.db');
    if (!statSync(file).isFile()) return null;
    return createHash('sha256').update(realpathSync(file)).digest('hex');
  } catch { return null; }
}
function yglCliEntry(): string | null {
  for (const base of [dirname(process.execPath), process.env.PNPM_HOME, process.env.APPDATA ? process.env.APPDATA + '\\npm' : null]) {
    if (!base) continue;
    const cand = join(base, 'node_modules', 'ygl-trees', 'dist', 'bundle', 'bin.cjs');
    if (existsSync(cand)) return cand;
  }
  return null;
}

function execYglJson(args: string[], timeoutMs: number, home: string): Promise<{ ok: boolean; parsed: unknown }> {
  return new Promise((resolve) => {
    const entry = yglCliEntry();
    if (!entry) return resolve({ ok: false, parsed: null });
    try {
      execFile(process.execPath, [entry, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, YGL_HOME: home } }, (err, stdout) => {
        if (err) return resolve({ ok: false, parsed: null });
        try {
          const parsed = JSON.parse(String(stdout));
          resolve({ ok: true, parsed });
        } catch { resolve({ ok: false, parsed: null }); }
      });
    } catch { resolve({ ok: false, parsed: null }); }
  });
}

function execYglTasks(allowed: 'all' | readonly string[]): Promise<{ ok: boolean; tasks: TaskEnvelope[]; latencyMs: number; error?: string; degradedProjects?: string[] }> {
  const t0 = Date.now();
  const maxProjects = yglMaxProjects(), totalBudgetMs = yglTotalBudgetMs();
  return (async () => {
    if (allowed !== 'all' && allowed.length === 0) return { ok: false, tasks: [], latencyMs: 0, error: 'source_not_authorized' };
    if (!taskWorkspaceKey()) return { ok: false, tasks: [], latencyMs: 0, error: 'ygl_home_required' };
    const home = process.env.YGL_HOME!;
    // Only admin enumerates workspace projects. Scoped users never query ungranted project metadata.
    let names: string[];
    if (allowed === 'all') {
      const projRes = await execYglJson(['project', 'list', '--json'], YGL_PER_CALL_TIMEOUT_MS, home);
      if (!projRes.ok || !Array.isArray(projRes.parsed)) return { ok: false, tasks: [], latencyMs: Date.now() - t0, error: 'ygl_source_failed' };
      names = (projRes.parsed as { name: string; status: string }[]).filter(x => x && typeof x.name === 'string' && x.status === 'active').map(x => x.name);
    } else names = [...new Set(allowed)];
    const projects = names.slice(0, maxProjects);
    const capSkipped = Math.max(0, names.length - maxProjects);

    // ② 逐项目读（并发上限；单项目超时= min(3s, 剩余预算)——总预算不被超）
    const deadline = t0 + totalBudgetMs;
    const queue = [...projects];
    const results: { project: string; ok: boolean; rows: unknown[] }[] = [];
    async function worker() {
      while (queue.length > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break; // 预算耗尽：剩余项目计入 budget-exhausted
        const name = queue.shift()!;
        if (!yglProjectNameOk(name)) { results.push({ project: name, ok: false, rows: [] }); continue; } // 空名/超长/null字节：显式拒绝
        const res = await execYglJson(['task', 'list', '--json', '--project=' + name], Math.max(200, Math.min(YGL_PER_CALL_TIMEOUT_MS, remaining)), home);
        // 形状校验：task list 合法输出是数组；{error:...} 对象/rc0 视为该源失败（S3）
        const rows = res.ok && Array.isArray(res.parsed) ? (res.parsed as unknown[]) : [];
        results.push({ project: name, ok: res.ok && Array.isArray(res.parsed), rows });
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(YGL_CONCURRENCY, projects.length)) }, worker));
    const budgetSkipped = queue.length; // 预算耗尽未读

    // ③ 信封映射 + (native id, project) 去重 + 项目名取自枚举（防行内伪字段）
    const seen = new Set<string>();
    const tasks: TaskEnvelope[] = [];
    const degradedProjects: string[] = [];
    for (const r of results) {
      if (!r.ok) degradedProjects.push('(project-source-failed)');
      for (const row of r.rows as any[]) {
        const nativeId = String(row?.id ?? row?.task_id ?? '');
        const dedupeKey = nativeId + '|' + r.project;
        if (!nativeId || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        tasks.push({
          id: `ygl-trees:${nativeId}`,
          source: 'ygl-trees' as const,
          title: String(row.title ?? row.name ?? row.summary ?? '(untitled)'),
          status: row.status === 'done' ? 'done' : (row.status === 'doing' || row.status === 'in_progress' ? 'doing' : 'todo'),
          due: typeof row.due === 'string' && row.due ? row.due : null,
          link: typeof row.link === 'string' && row.link ? row.link : null,
          project: r.project,
        });
      }
    }
    if (capSkipped > 0) degradedProjects.push(`(cap-exceeded:${capSkipped} active projects beyond ${maxProjects} not read)`);
    if (budgetSkipped > 0) degradedProjects.push(`(budget-exhausted:${budgetSkipped} unread)`);
    const fullyOk = degradedProjects.length === 0;
    return { ok: fullyOk, tasks, latencyMs: Date.now() - t0, ...(!fullyOk ? { error: 'ygl_source_failed', degradedProjects } : {}) };
  })();
}

// 任务中心发布时冻结的录入数据里取截止日期：步骤值是 { value } 或裸值；空串/非字符串记 null
function frozenDue(payloadJson: string): string | null {
  try {
    const d = (JSON.parse(payloadJson) as Record<string, unknown>)?.due;
    const v = d && typeof d === 'object' && !Array.isArray(d) && 'value' in d ? (d as { value: unknown }).value : d;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch { return null; }
}

function marketTasks(sop: SopServiceLike, scope: TasksReadScope): TaskEnvelope[] {
  try {
    // #263 页面整链：统一待办呈现人开的任务与指派 run，未指派任务不静默消失
    const ids = scope.marketRunIds === 'all' ? undefined : scope.marketRunIds;
    if (ids?.length === 0) return [];
    const canRead = (id: number) => ids === undefined || ids.includes(Number(id));
    const dispatched = new Set(sop.runsDispatchedAll(ids).filter(r => canRead(r.id)).map(r => Number(r.id)));
    const rows = sop.runsRunning(ids).filter(r => canRead(r.id));
    const seen = new Set<string>();
    const out: TaskEnvelope[] = [];
    for (const r of rows) {
      if (r.sop_slug === 'task-center') continue; // 录入模板 run 不入待办，发布后的 tasks 表条目才入
      const key = `market:run-${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        source: 'market' as const,
        title: dispatched.has(Number(r.id)) ? `SOP ${r.sop_slug} run#${r.id} 待验收` : `SOP ${r.sop_slug} run#${r.id} 进行中（未指派）`,
        status: 'doing' as const,
        due: null,
        link: `/sop/${r.sop_slug}/?run=${r.id}`,
        project: r.sop_slug,
      });
    }
    // 任务中心已发布任务（人工录入→发布链）：标题与截止日期（取自发布冻结的录入数据）入待办，链接回录入 run 溯源
    try {
      const sql = "SELECT t.id, t.title, t.intake_run_id, t.published_at, t.payload_json FROM tasks t WHERE t.status = 'published'" + (ids ? ' AND t.intake_run_id IN (SELECT value FROM json_each(?))' : '') + ' ORDER BY t.id DESC LIMIT 100';
      const tcRows = ((globalThis as any).__wmDb?.prepare?.(sql)?.all?.(...(ids ? [JSON.stringify(ids)] : [])) ?? []) as Array<{ id: number; title: string; intake_run_id: number | null; published_at: string; payload_json: string }>;
      for (const t of tcRows) {
        const key = `market:task-${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          source: 'market' as const,
          title: String(t.title ?? '(untitled)'),
          status: 'todo' as const,
          due: frozenDue(t.payload_json),
          link: t.intake_run_id ? `/sop/task-center/?run=${t.intake_run_id}` : null,
          project: 'task-center',
        });
      }
    } catch { throw new Error('market_source_failed'); }
    return out;
  } catch {
    throw new Error('market_source_failed');
  }
}

/** A2A 源（omni-inbox v2 · 设计稿 docs/omni-inbox-a2a-source.md，依赖 dsh-open-a2a-net PR#32）。
 *  鉴权：X-API-Key（不是 X-Market-Client 头族）；字段校准点集中在下方 FIELD 注释，#32 合并后核对。 */
function a2aEnabled(): boolean {
  return String(process.env.A2A_STATE_URL ?? '').trim() !== '';
}

interface A2aStateRow {
  taskId?: string; team?: string; peer?: string; direction?: string;
  startedAt?: string; resolvedAt?: string; endedBy?: string; outcome?: string;
  brief?: string; summary?: string; // summary≤160（d7573ca 新增）
}

async function fetchA2aTasks(): Promise<{ ok: boolean; tasks: TaskEnvelope[]; latencyMs: number }> {
  const base = String(process.env.A2A_STATE_URL ?? '').trim().replace(/\/+$/, '');
  const key = String(process.env.A2A_API_KEY ?? '').trim();
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/__dsh_a2a/state`, {
      headers: key ? { 'X-API-Key': key } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return { ok: false, tasks: [], latencyMs: Date.now() - t0 };
    const j: any = await r.json();
    // FIELD 校准点（已对 d7573ca）：tasks[] 在途（含 settleable/receiptExpected，信封不消费）
    // / archived[] ≤64 归档 newest-first（endedBy/outcome/late/brief/summary≤160）
    // ——PR#32 时代的 tasksRecent 在合并版改名 archived（ARCHIVE_CAP 64）
    const inFlight: A2aStateRow[] = Array.isArray(j?.tasks) ? j.tasks : [];
    const recent: A2aStateRow[] = Array.isArray(j?.archived) ? j.archived : (Array.isArray(j?.tasksRecent) ? j.tasksRecent : []);
    const seen = new Set<string>();
    const tasks: TaskEnvelope[] = [];
    for (const row of inFlight) { // 在途 → doing（在途优先：竞态窗口内同 taskId 不重复）
      const id = String(row.taskId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tasks.push({
        id: `a2a:${id}`, source: 'a2a',
        title: row.brief ? String(row.brief) : (row.summary ? String(row.summary) : `${String(row.team ?? '')} · ${String(row.peer ?? '')} ${id}`),
        status: 'doing', due: null, link: null,
        project: row.team ? String(row.team) : null,
      });
    }
    for (const row of recent) { // 归档 → done（title 带 endedBy）
      const id = String(row.taskId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tasks.push({
        id: `a2a:${id}`, source: 'a2a',
        title: `${row.brief ?? row.summary ?? id}${row.endedBy ? `（${row.endedBy}）` : ''}`,
        status: 'done', due: null, link: null,
        project: row.team ? String(row.team) : null,
      });
    }
    return { ok: true, tasks, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false, tasks: [], latencyMs: Date.now() - t0 };
  }
}

/** #324: query only authorized sources; no cross-user payload cache or in-flight sharing. */
export async function collectTasks(sop: SopServiceLike, scope: TasksReadScope): Promise<TasksPayload> {
  if (!scope?.subject || typeof scope.admin !== 'boolean' || (scope.yglProjects !== 'all' && !Array.isArray(scope.yglProjects)) || (scope.marketRunIds !== 'all' && !Array.isArray(scope.marketRunIds))) throw new Error('tasks_scope_required');
  if (!scope.admin && (scope.yglProjects === 'all' || scope.marketRunIds === 'all' || scope.a2a)) throw new Error('tasks_scope_invalid');
  const authorizedMarket = scope.marketRunIds === 'all' || scope.marketRunIds.length > 0;
  const [yglResult, marketResult, a2aResult] = await Promise.allSettled([
    execYglTasks(scope.yglProjects),
    Promise.resolve().then(() => authorizedMarket ? [...marketTasks(sop, scope), ...(scope.admin ? changeRequestTasks() : [])] : []),
    a2aEnabled() && scope.a2a ? fetchA2aTasks() : Promise.resolve(null),
  ]);
  const ygl = yglResult.status === 'fulfilled' ? yglResult.value : { ok: false, tasks: [], latencyMs: 0, error: 'ygl_source_failed' };
  const market = marketResult.status === 'fulfilled' ? marketResult.value : [];
  const a2a = a2aResult.status === 'fulfilled' ? a2aResult.value : null;
  return {
    tasks: [...ygl.tasks, ...market, ...(a2a?.tasks ?? [])],
    sources: {
      'ygl-trees': { ok: ygl.ok, count: ygl.tasks.filter(t => t.status !== 'done').length, latency_ms: ygl.latencyMs, ...(ygl.error ? { error: ygl.error } : {}), ...('degradedProjects' in ygl && ygl.degradedProjects?.length ? { degraded_projects: ygl.degradedProjects } : {}) },
      market: { ok: authorizedMarket && marketResult.status === 'fulfilled', count: market.length, latency_ms: 0, ...(!authorizedMarket ? { error: 'source_not_authorized' } : marketResult.status === 'rejected' ? { error: 'market_source_failed' } : {}) },
      ...(a2aEnabled() ? { a2a: { ok: !!a2a?.ok, count: a2a?.tasks.filter(t => t.status !== 'done').length ?? 0, latency_ms: a2a?.latencyMs ?? 0, ...(!scope.a2a ? { error: 'source_not_authorized' } : !a2a?.ok ? { error: 'a2a_source_failed' } : {}) } } : {}),
    },
    generated_at: new Date().toISOString(),
  };
}


/** #94 v3 S1 人审门：pending change_requests 入统一待办（批准/拒绝回 REST 原系统） */
function changeRequestTasks(): TaskEnvelope[] {
  try {
    const rows = (globalThis as any).__wmDb?.prepare?.("SELECT id, kind, slug, op, reason, requested_by, created_at FROM change_requests WHERE status='pending' ORDER BY id DESC LIMIT 50")?.all?.() ?? [];
    return rows.map((r: any) => ({
      id: `change-request:${r.id}`, source: 'market' as const,
      title: `人审·${r.kind === 'skill' ? '技能' : '台'}${r.op === 'delete' ? '删除' : '回滚'} ${r.slug}${r.reason ? '（' + String(r.reason).slice(0, 60) + '）' : ''}`,
      status: 'todo' as const, due: '', link: '/api/change-requests', project: 'review-gate',
    }));
  } catch { throw new Error('market_source_failed'); }
}
