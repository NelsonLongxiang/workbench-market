/**
 * 统一待办（omni-inbox · 总工程师设计 9c5557c1c0）：只读聚合，勾销回原系统。
 *
 * 任务信封（字段冻结 snake_case）：
 *   { id: "<source>:<native_id>", source, title, status: todo|doing|done, due, link, project }
 *
 * 适配器：
 *   - ygl-trees：exec `ygl-trees task list --json`（超时 5s，跨项目全量）；CLI 缺失/超时 → ok=false 降级不阻塞（J5）
 *   - market：站内 SOP 派单 run 的待办语义（running=doing，finished=done 不聚合）——
 *              复用现有 sop_runs/a2a_run_ctx schema，零侵入（J4）
 *   - A2A：v2 预留，不实现
 */
import { execFile } from 'node:child_process';

export interface TaskEnvelope {
  id: string;
  source: 'ygl-trees' | 'market' | 'a2a';
  title: string;
  status: 'todo' | 'doing' | 'done';
  due: string | null;
  link: string | null;
  project: string | null;
}

export interface SourceMeta { ok: boolean; count: number; latency_ms: number }
export interface TasksPayload {
  tasks: TaskEnvelope[];
  /** a2a 键仅在 A2A_STATE_URL 已配置（源启用）时出现——未配置=源缺席≠降级（总工程师三裁①） */
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta; a2a?: SourceMeta };
  generated_at: string;
}

type SopServiceLike = {
  runsDispatchedAll(): { id: number; sop_slug: string; started_by: string; status: string; updated_at: string }[];
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
    const rows = sop.runsDispatchedAll();
    return rows
      .filter((r) => r.status === 'running')
      .map((r) => ({
        id: `market:run-${r.id}`,
        source: 'market' as const,
        title: `SOP ${r.sop_slug} run#${r.id} 待验收`,
        status: 'doing' as const,
        due: null,
        link: `/sop/${r.sop_slug}/`,
        project: r.sop_slug,
      }));
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
  brief?: string;
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
    // FIELD 校准点（PR#32 形状）：tasks[] 在途 / tasksRecent[] ≤20 归档（endedBy/outcome/late/brief）
    const inFlight: A2aStateRow[] = Array.isArray(j?.tasks) ? j.tasks : [];
    const recent: A2aStateRow[] = Array.isArray(j?.tasksRecent) ? j.tasksRecent : [];
    const seen = new Set<string>();
    const tasks: TaskEnvelope[] = [];
    for (const row of inFlight) { // 在途 → doing（在途优先：竞态窗口内同 taskId 不重复）
      const id = String(row.taskId ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tasks.push({
        id: `a2a:${id}`, source: 'a2a',
        title: row.brief ? String(row.brief) : `${String(row.team ?? '')} · ${String(row.peer ?? '')} ${id}`,
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
        title: `${row.brief ?? id}${row.endedBy ? `（${row.endedBy}）` : ''}`,
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
    tasks: [...ygl.tasks, ...mktRows, ...(a2aSettled?.status === 'fulfilled' ? a2aSettled.value.tasks : [])],
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
