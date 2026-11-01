/**
 * SOP 执行数据分层治理——状态层（Redis）客户端。
 *
 * 分层语义（用户定案）：
 *   - 状态层（Redis，生产 <REDIS_HOST>:<PORT>）：进行中 run 的热数据（防抖写、亚毫秒读）、
 *     活跃 run 索引；finish/abandon 后整体落 SQLite 并 EXPIRE 平滑淘汰。
 *   - 持久层（SQLite sop_runs 表）：真源。开 run 即插行；30s checkpoint；finish 整体落盘。
 *     Redis 不可达时（降级模式）所有写直落 SQLite，功能保全。
 *
 * 凭据纪律：URL 不进源码/git。解析顺序：
 *   process.env.REDIS_URL → DATA_DIR/redis.url 文件（一行 URL，gitignore）→ 无则降级模式。
 */
import { createClient } from 'redis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './db.ts';

function resolveUrl(): string | null {
  // PR#45 TEST 红修复：空串/纯空白一律归入「未设」（评审席干净环境 '' 挂死；本机 6379 兜底掩盖）
  const env = (process.env.REDIS_URL ?? '').trim();
  if (env) return env;
  try {
    const line = readFileSync(join(dataDir, 'redis.url'), 'utf8').trim();
    return line || null;
  } catch {
    return null;
  }
}

let client: ReturnType<typeof createClient> | null = null;
let degraded = true; // 未连上即降级；连接成功后翻转

export function startRedis(): void {
  const url = resolveUrl();
  if (!url) {
    console.warn('[redis] 未配置 REDIS_URL（且无 server/data/redis.url）——SOP 状态层降级：直写 SQLite');
    return;
  }
  client = createClient({ url });
  client.on('error', (e: Error) => {
    if (degraded) return; // 降级态不再刷屏
    console.warn(`[redis] 连接错误，进入降级模式（直写 SQLite）：${e.message}`);
    degraded = true;
  });
  client
    .connect()
    .then(() => {
      degraded = false;
      console.log('[redis] 状态层已连接（SOP run 热数据走 Redis）');
    })
    .catch((e: Error) => {
      console.warn(`[redis] 首连失败，降级模式（直写 SQLite）：${e.message}`);
    });
}

export function redisHealthy(): boolean {
  return !degraded && client !== null && client.isReady;
}

// —— 领域函数：降级态一律 no-op / 返回空，调用方据此回落 SQLite ——

export interface RunMeta {
  slug: string; version: number; status: string; started_by: string; updated_at: number;
}

const kData = (id: number) => `wm:sop:run:${id}:data`;
const kMeta = (id: number) => `wm:sop:run:${id}:meta`;
const kActive = 'wm:sop:runs:active';

/** Legacy step adapter; callers must supply the current durable SQLite checkpoint. */
export async function runStateSave(id: number, meta: RunMeta, stepKey: string, value: unknown, checkpoint: string): Promise<boolean> {
  const hot = await runStateLoad(id, checkpoint);
  return runStateRestore(id, meta, { ...(hot?.data ?? {}), [stepKey]: value }, checkpoint);
}

/** One atomic field binds the whole hot snapshot to its durable SQLite generation. */
export async function runStateRestore(id: number, meta: RunMeta, data: Record<string, unknown>, checkpoint: string): Promise<boolean> {
  if (!redisHealthy() || !client || typeof checkpoint !== 'string' || checkpoint.length !== 64) return false;
  try {
    const c = client as unknown as { hSet: (k: string, a: string | Record<string, string>, v?: string) => Promise<unknown>; sAdd: (k: string, m: string) => Promise<unknown> };
    await c.hSet(kMeta(id), { slug: meta.slug, version: String(meta.version), status: meta.status, started_by: meta.started_by, updated_at: String(meta.updated_at) });
    // Never refresh a base marker separately from its data: a later HSET failure could bless old fields.
    if (meta.status === 'running') await c.sAdd(kActive, String(id));
    await c.hSet(kData(id), '__wm_snapshot_v2', JSON.stringify({ format: 2, checkpoint, meta, data })); // publication is last; failed metadata/index writes never publish rejected data
    return true;
  } catch { return false; }
}

/** Legacy, partial or stale snapshots are misses; SQLite stays authoritative after fallback/restart. */
export async function runStateLoad(id: number, checkpoint: string): Promise<{ meta: RunMeta; data: Record<string, unknown> } | null> {
  if (!redisHealthy() || !client || typeof checkpoint !== 'string' || checkpoint.length !== 64) return null;
  try {
    const d = await (client as unknown as { hGetAll: (k: string) => Promise<Record<string, string>> }).hGetAll(kData(id));
    const snapshot = JSON.parse(d.__wm_snapshot_v2 ?? 'null');
    if (snapshot?.format !== 2 || snapshot.checkpoint !== checkpoint || !snapshot.meta || typeof snapshot.meta.slug !== 'string' || !snapshot.data || typeof snapshot.data !== 'object' || Array.isArray(snapshot.data)) return null;
    return { meta: snapshot.meta, data: snapshot.data };
  } catch { return null; }
}

/** finish/abandon：退出活跃索引 + 热态 status 同步为最终态 + 条目 1h 平滑淘汰（SQLite 已是真源；热态必须同步最终态，否则 TTL 窗口内热读拿到过期 running） */
export async function runStateRetire(id: number, finalStatus = 'finished'): Promise<boolean> {
  if (!redisHealthy() || !client) return false;
  try {
    const c = client as unknown as {
      sRem: (k: string, m: string) => Promise<unknown>;
      expire: (k: string, s: number) => Promise<unknown>;
      hSet: (k: string, f: string, v: string) => Promise<unknown>;
    };
    await c.sRem(kActive, String(id));
    await c.hSet(kMeta(id), 'status', finalStatus);
    await c.expire(kMeta(id), 3600);
    await c.expire(kData(id), 3600);
    return true;
  } catch {
    return false;
  }
}

/** 活跃 run 索引（驾驶舱「我的进行中」热路径） */
export async function runActiveIds(): Promise<number[]> {
  if (!redisHealthy() || !client) return [];
  try {
    const c = client as unknown as { sMembers: (k: string) => Promise<string[]> };
    const ids = await c.sMembers(kActive);
    return ids.map(Number).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}
