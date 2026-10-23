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
  source: 'ygl-trees' | 'market';
  title: string;
  status: 'todo' | 'doing' | 'done';
  due: string | null;
  link: string | null;
  project: string | null;
}

export interface SourceMeta { ok: boolean; count: number; latency_ms: number }
export interface TasksPayload {
  tasks: TaskEnvelope[];
  sources: { 'ygl-trees': SourceMeta; market: SourceMeta };
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
      execFile('ygl-trees', ['task', 'list', '--json'], { timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
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

/** 聚合入口（30s 缓存；ygl 源 5s 超时降级 ok=false 不阻塞 market 源）。 */
export async function collectTasks(sop: SopServiceLike): Promise<TasksPayload> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  const [ygl, mktRows] = await Promise.all([execYglTasks(), Promise.resolve(marketTasks(sop))]);
  const payload: TasksPayload = {
    tasks: [...ygl.tasks, ...mktRows],
    sources: {
      'ygl-trees': { ok: ygl.ok, count: ygl.tasks.length, latency_ms: ygl.latencyMs },
      market: { ok: true, count: mktRows.length, latency_ms: 0 },
    },
    generated_at: new Date(now).toISOString(),
  };
  cache = { at: now, payload };
  return payload;
}
