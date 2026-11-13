/**
 * 共用状态层：Cordis 服务 `state`。Redis 是可选的热层，SQLite（以后是 PG）才是真源（docs/data-views.md 第十三节）。
 *
 * - 连接和健康状态只有一份，在 redis.ts：SOP 执行实例的热态和这里用的是同一条连接。
 * - 这里给别的域用。台的键一律是 `wm:bench:<台 id>:<段>…`，用 benchKey() 拼，删台时按这个前缀一起清（clearBench）。
 * - Redis 没配、没连上、这次出错：读返回 off / down / error，写和清返回 false / null；调用方回落 SQLite，功能不丢。
 *   down、error 时 Redis 里可能还有没落盘的东西，调用方不能把它当成「没有」。
 * - 台 id 是自增、不复用的：删台时 Redis 正好不通、键没清掉，也不会被以后的台读到。
 * - 别的域（现在只有 SOP 执行实例）经 stateDomain(<域>) 拿一个句柄：只许碰 wm:<域>: 开头的键，碰不到台的键，台的方法也碰不到它的键。
 *   句柄只是在同一条连接上加了键的界，命令原样转给连接（出错照样抛给调用方，降级时给 null），调用方原来的判断和兜底不变。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { redisClient, redisConfigured, stopRedis } from '../redis.ts';

/** 这里用到的几个命令（node-redis 的写法） */
type Client = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX: number }): Promise<unknown>;
  del(keys: string[]): Promise<number>;
  scanIterator(opts: { MATCH: string; COUNT?: number }): AsyncIterable<string[] | string>;
};

export type StateRead = { kind: 'off' | 'down' | 'error' | 'miss' } | { kind: 'hit'; value: string };

/** 按域的句柄能用的命令（SOP 执行实例用到的那几种） */
export type DomainOps = {
  hSet(key: string, fieldOrMap: string | Record<string, string>, value?: string): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
};
const DOMAIN_PREFIX = { sop: 'wm:sop:' } as const;
export type StateDomainName = keyof typeof DOMAIN_PREFIX;
export type StateDomain = {
  /** 配了 Redis（不论此刻连没连上） */
  configured(): boolean;
  /** 连着时给本域的命令；没配、不通都是 null */
  ops(): DomainOps | null;
};
/** 一个域的句柄：只许碰 wm:<域>: 开头的键（写错了是代码的错，当场抛 TypeError，不发出去） */
export function stateDomain(name: StateDomainName): StateDomain {
  const prefix = DOMAIN_PREFIX[name];
  const guard = (key: string): string => {
    if (typeof key !== 'string' || !key.startsWith(prefix) || key.length === prefix.length) throw new TypeError(`${name} 域只能碰 ${prefix} 开头的键`);
    return key;
  };
  return {
    configured: () => redisConfigured(),
    ops(): DomainOps | null {
      const c = redisClient() as Record<string, (...a: unknown[]) => Promise<unknown>> | null;
      if (!c) return null;
      return {
        // 和原来一样：给了 value 是「字段、值」两段，没给是整份对象
        hSet: (key, fieldOrMap, value) => (value === undefined ? c.hSet(guard(key), fieldOrMap) : c.hSet(guard(key), fieldOrMap, value)),
        hGetAll: (key) => c.hGetAll(guard(key)) as Promise<Record<string, string>>,
        sAdd: (key, member) => c.sAdd(guard(key), member),
        sRem: (key, member) => c.sRem(guard(key), member),
        sMembers: (key) => c.sMembers(guard(key)) as Promise<string[]>,
        expire: (key, seconds) => c.expire(guard(key), seconds),
      };
    },
  };
}

/** 键的每一段：字母、数字和 _ . -。不许有冒号（分段用）和通配符（清的时候按前缀匹配） */
const PART = /^[A-Za-z0-9_.-]{1,128}$/;
const BENCH_PREFIX = 'wm:bench:';

/** 台的一个键：wm:bench:<台 id>:<段>…。台 id 是市场卡片的 id */
export function benchKey(workbenchId: number, ...parts: string[]): string {
  if (!Number.isSafeInteger(workbenchId) || workbenchId < 1) throw new TypeError('台 id 须为正整数');
  if (!parts.length || !parts.every((p) => typeof p === 'string' && PART.test(p))) throw new TypeError('键的各段只能用字母、数字和 _ . -，至少一段');
  return `${BENCH_PREFIX}${workbenchId}:${parts.join(':')}`;
}

/** 这个服务只碰台的键；SOP 执行实例的键（wm:sop:…）归 redis.ts */
function ownKey(key: string): boolean {
  if (typeof key !== 'string' || !key.startsWith(BENCH_PREFIX)) return false;
  const [id, ...parts] = key.slice(BENCH_PREFIX.length).split(':');
  return /^[1-9]\d{0,15}$/.test(id ?? '') && parts.length > 0 && parts.every((p) => PART.test(p));
}

export class StateLayerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'state');
    // 随根上下文停：断开连接（进程能自己退出）
    ctx.effect(() => () => stopRedis(), 'state.stopRedis');
  }

  /** 别的域的句柄（见 stateDomain） */
  domain(name: StateDomainName): StateDomain { return stateDomain(name); }

  /** off：没配 Redis；down：配了但此刻不通；up：可用 */
  mode(): 'off' | 'down' | 'up' {
    if (!redisConfigured()) return 'off';
    return redisClient() ? 'up' : 'down';
  }

  private client(): Client | null {
    return redisClient() as Client | null;
  }

  async get(key: string): Promise<StateRead> {
    if (!ownKey(key)) throw new TypeError('键须用 benchKey() 拼');
    if (!redisConfigured()) return { kind: 'off' };
    const c = this.client();
    if (!c) return { kind: 'down' };
    try {
      const v = await c.get(key);
      return v === null ? { kind: 'miss' } : { kind: 'hit', value: v };
    } catch { return { kind: 'error' }; }
  }

  /** 写一个键；ttlSeconds 给了就到期自动淘汰。不可用时返回 false，调用方以 SQLite 为准 */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!ownKey(key)) throw new TypeError('键须用 benchKey() 拼');
    if (typeof value !== 'string') throw new TypeError('值须为字符串');
    if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)) throw new TypeError('ttlSeconds 须为正整数');
    const c = this.client();
    if (!c) return false;
    try { await c.set(key, value, ttlSeconds === undefined ? undefined : { EX: ttlSeconds }); return true; } catch { return false; }
  }

  /** 删几个键（缓存失效用）。不可用时返回 false */
  async del(...keys: string[]): Promise<boolean> {
    if (!keys.length || !keys.every(ownKey)) throw new TypeError('键须用 benchKey() 拼');
    const c = this.client();
    if (!c) return false;
    try { await c.del(keys); return true; } catch { return false; }
  }

  /**
   * 删台时清掉这个台在 Redis 里的全部键（按 wm:bench:<id>: 前缀）。返回清掉的个数；没配 Redis 返回 0；
   * 不通或出错返回 null（键留着也读不到别的台：台 id 不复用）。
   */
  async clearBench(workbenchId: number): Promise<number | null> {
    if (!Number.isSafeInteger(workbenchId) || workbenchId < 1) throw new TypeError('台 id 须为正整数');
    if (!redisConfigured()) return 0;
    const c = this.client();
    if (!c) return null;
    let n = 0;
    try {
      for await (const batch of c.scanIterator({ MATCH: `${BENCH_PREFIX}${workbenchId}:*`, COUNT: 200 })) {
        const keys = (Array.isArray(batch) ? batch : [batch]).filter(ownKey);
        if (keys.length) n += await c.del(keys);
      }
      return n;
    } catch { return null; }
  }
}
