/**
 * SOP 执行数据分层治理——状态层（Redis）客户端。
 *
 * 分层语义（用户定案）：
 *   - 状态层（Redis，生产 192.168.3.88:16379）：进行中 run 的热数据（防抖写、亚毫秒读）、
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
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
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

/** 防抖保存一个步骤值 + 刷 meta.updated_at；活跃索引入集合 */
export async function runStateSave(id: number, meta: RunMeta, stepKey: string, value: unknown): Promise<boolean> {
  if (!redisHealthy() || !client) return false;
  try {
    const c = client as unknown as {
      hSet: (k: string, f: string, v: string) => Promise<unknown>;
      sAdd: (k: string, m: string) => Promise<unknown>;
    };
    await c.hSet(kMeta(id), 'slug', meta.slug);
    await c.hSet(kMeta(id), 'version', String(meta.version));
    await c.hSet(kMeta(id), 'status', meta.status);
    await c.hSet(kMeta(id), 'started_by', meta.started_by);
    await c.hSet(kMeta(id), 'updated_at', String(meta.updated_at));
    await c.hSet(kData(id), stepKey, JSON.stringify(value));
    await c.sAdd(kActive, String(id));
    return true;
  } catch {
    return false;
  }
}

/** 整体写回（SQLite 行恢复 Redis 热态用）：data 为 stepKey→value 对象 */
export async function runStateRestore(id: number, meta: RunMeta, data: Record<string, unknown>): Promise<boolean> {
  if (!redisHealthy() || !client) return false;
  try {
    const c = client as unknown as { hSet: (k: string, a: string | Record<string, string>, v?: string) => Promise<unknown> };
    await c.hSet(kMeta(id), {
      slug: meta.slug, version: String(meta.version), status: meta.status,
      started_by: meta.started_by, updated_at: String(meta.updated_at),
    });
    const entries = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v)]));
    if (Object.keys(entries).length > 0) await c.hSet(kData(id), entries);
    return true;
  } catch {
    return false;
  }
}

/** 读回热数据（恢复现场）；miss 返回 null，调用方查 SQLite */
export async function runStateLoad(id: number): Promise<{ meta: RunMeta; data: Record<string, unknown> } | null> {
  if (!redisHealthy() || !client) return null;
  try {
    const c = client as unknown as {
      hGetAll: (k: string) => Promise<Record<string, string>>;
    };
    const m = await c.hGetAll(kMeta(id));
    if (!m || !m.slug) return null;
    const d = await c.hGetAll(kData(id));
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) {
      try { data[k] = JSON.parse(v); } catch { data[k] = v; }
    }
    return {
      meta: { slug: m.slug, version: Number(m.version), status: m.status, started_by: m.started_by, updated_at: Number(m.updated_at) },
      data,
    };
  } catch {
    return null;
  }
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
