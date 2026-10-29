/**
 * 统一待办（omni-inbox · 总工程师设计 9c5557c1c0）：只读聚合，勾销回原系统。
 *
 * 任务信封（字段冻结 snake_case）：
 *   { id: "<source>:<native_id>", source, title, status: todo|doing|done, due, link, project }
 *
 * 适配器：
 *   - ygl-trees：exec `ygl-trees task list --json`（超时 5s，跨项目全量）；CLI 缺失/超时 → ok=false 降级不阻塞（J5）
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

export interface SourceMeta { ok: boolean; count: number; latency_ms: number }
export interface TasksPayload {
  tasks: TaskEnvelope[];
  /** a2a 键仅在 A2A_STATE_URL 已配置（源启用）时出现——未配置=源缺席≠降级（总工程师三裁①）；
   *  lifecycle 键同理，仅在 LC_* 已配置时出现，按查看人计 */
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta; a2a?: SourceMeta; lifecycle?: SourceMeta & { viewer: string | null; error?: string } };
  generated_at: string;
}

type SopServiceLike = {
  runsDispatchedAll(): { id: number; sop_slug: string; started_by: string; status: string; updated_at: string }[];
  runsRunning(): { id: number; sop_slug: string; started_by: string; status: string; updated_at: string }[];
};

const CACHE_TTL_MS = 30_000;
let cache: { at: number; payload: TasksPayload } | null = null;

function execYglTasks(): Promise<{ ok: boolean; tasks: TaskEnvelope[]; latencyMs: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    try {
      // Windows：ygl-trees 是无扩展名 bash shim，execFile 无 shell 会 ENOENT（评审席 direct-a989374f S1）
      // 参数为固定字面量数组，shell:true 无注入面
      execFile('ygl-trees', ['task', 'list', '--json'], { timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: true }, (err, stdout) => {
        const latencyMs = Date.now() - t0;
        if (err) return resolve({ ok: false, tasks: [], latencyMs });
        try {
          const parsed = JSON.parse(String(stdout));
          const rows: any[] = Array.isArray(parsed) ? parsed : (parsed?.tasks ?? []);
          const tasks: TaskEnvelope[] = rows.map((r) => ({
            id: `ygl-trees:${String(r.id ?? r.task_id ?? '')}`,
            source: 'ygl-trees' as const,
            title: String(r.title ?? r.name ?? r.summary ?? '(untitled)'),
            status: r.status === 'done' ? 'done' : (r.status === 'doing' || r.status === 'in_progress' ? 'doing' : 'todo'),
            due: typeof r.due === 'string' && r.due ? r.due : null,
            link: typeof r.link === 'string' && r.link ? r.link : null,
            project: typeof r.project === 'string' && r.project ? r.project : (typeof r.tree === 'string' ? r.tree : null),
          }));
          resolve({ ok: true, tasks, latencyMs });
        } catch {
          resolve({ ok: false, tasks: [], latencyMs });
        }
      });
    } catch {
      resolve({ ok: false, tasks: [], latencyMs: Date.now() - t0 });
    }
  });
}

function marketTasks(sop: SopServiceLike): TaskEnvelope[] {
  try {
    // #263 页面整链：统一待办呈现人开的任务与指派 run，未指派任务不静默消失
    const dispatched = new Set(sop.runsDispatchedAll().map((r) => Number(r.id)));
    const rows = sop.runsRunning() as Array<{ id: number; sop_slug: string; started_by: string; status: string; updated_at: string }>;
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
        link: `/sop/${r.sop_slug}/`,
        project: r.sop_slug,
      });
    }
    // 任务中心已发布任务（人工录入→发布链）：标题/截止日期入待办，链接回录入 run 溯源
    try {
      const tcRows = ((globalThis as any).__wmDb?.prepare?.("SELECT t.id, t.title, t.intake_run_id, t.published_at FROM tasks t WHERE t.status = 'published' ORDER BY t.id DESC LIMIT 100")?.all?.() ?? []) as Array<{ id: number; title: string; intake_run_id: number | null; published_at: string }>;
      for (const t of tcRows) {
        const key = `market:task-${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          source: 'market' as const,
          title: String(t.title ?? '(untitled)'),
          status: 'todo' as const,
          due: null,
          link: t.intake_run_id ? `/sop/task-center/` : null,
          project: 'task-center',
        });
      }
    } catch { /* tasks 表不可读时降级：不阻塞其余 market 条目 */ }
    return out;
  } catch {
    return [];
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

/** 聚合入口（30s 缓存；ygl 源 5s 超时降级 ok=false 不阻塞 market 源）。 */
export async function collectTasks(sop: SopServiceLike): Promise<TasksPayload> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  const jobs: [Promise<{ ok: boolean; tasks: TaskEnvelope[]; latencyMs: number }>, Promise<TaskEnvelope[]>] =
    [execYglTasks(), Promise.resolve(marketTasks(sop))];
  const [yglSettled, mktSettled, a2aSettled] = await Promise.all([
    jobs[0].then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected' as const, reason: e })),
    jobs[1].then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected' as const, reason: e })),
    a2aEnabled() ? fetchA2aTasks().then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected' as const, reason: e })) : Promise.resolve(null),
  ]);
  const ygl = yglSettled.status === 'fulfilled' ? yglSettled.value : { ok: false, tasks: [], latencyMs: 0 };
  const mktRows = mktSettled.status === 'fulfilled' ? mktSettled.value : [];
  const payload: TasksPayload = {
    tasks: [...ygl.tasks, ...mktRows, ...changeRequestTasks(), ...(a2aSettled?.status === 'fulfilled' ? a2aSettled.value.tasks : [])], // S1 人审门入待办
    sources: {
      'ygl-trees': { ok: ygl.ok, count: ygl.tasks.filter((t) => t.status !== 'done').length, latency_ms: ygl.latencyMs },
      market: { ok: true, count: mktRows.length, latency_ms: 0 },
      // count=在途数（对账口径）；源缺席（未配置 env）时无 a2a 键——降级只发生在已启用但失败时
      ...(a2aSettled ? { a2a: { ok: a2aSettled.status === 'fulfilled' && a2aSettled.value.ok, count: a2aSettled.status === 'fulfilled' ? a2aSettled.value.tasks.filter((t) => t.status !== 'done').length : 0, latency_ms: a2aSettled.status === 'fulfilled' ? a2aSettled.value.latencyMs : 0 } } : {}),
    },
    generated_at: new Date(now).toISOString(),
  };
  cache = { at: now, payload };
  return payload;
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
  } catch { return []; }
}
