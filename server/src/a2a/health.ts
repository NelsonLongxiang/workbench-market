/**
 * /api/health 的 a2a 块（阶段七第 5 步）。/api/health 是公开端点，所以这里只放：
 *   · 开关的生效值（入站签名、body 签名、v1 旧签名是否还发）——试一次请求就能知道，不算新信息；
 *   · 名片有效期、幂等窗口与存储；
 *   · 出站积压：两张出站表按状态的计数、最老一条待发多久、最近 50 条回执从入队到发出的时长；
 *   · 拒收计数：按 errors.ts 的公开桶计（对外同答的原因并成一个桶），进程内、重启清零。
 *   · 团队名册：入站名册各种结果的次数和最近一次的时间（roster-stats.ts），来源个数、最久没收下的那个的时间、超过 15 分钟没收下的个数。
 * 不出团队名、地址、task_id、内容。读数缓存 5 秒：匿名请求打不穿到数据库聚合。
 */
import { CARD_TTL_MS, originClaimV1Enabled } from '../a2a.ts';
import { A2A_IDEM_TTL_MS } from '../services/a2a-idempotency.ts';
import { eventDeliveryStats, receiptOutboxStats } from '../services/a2a-stats.ts';
import { a2aErrorCounts } from './errors.ts';
import { pendingFollowupReceipts } from '../services/a2a-replies.ts';
import { rosterSourceStats } from '../services/a2a-roster.ts';
import { rosterOutcomeCounts } from './roster-stats.ts';

/** 阶段七 R2：还没发出去的跟进回执（发不出去会一直重试）：条数与最多试了几次；表还没建时为 null */
function followupReceiptsSafe(): { pending: number; max_attempts: number } | null {
  try { return pendingFollowupReceipts(); } catch { return null; }
}

export interface A2aHealthConfig {
  /** 生效的入站签名模式（登录门 enforce 时已强制成 require） */
  directSig: string;
  directSigBody: string;
}

const CACHE_MS = 5000;
let cached: { at: number; outbox: unknown } | null = null;

function outbox(now: number): unknown {
  if (cached && now - cached.at < CACHE_MS) return cached.outbox;
  const value = { receipts: receiptOutboxStats(now), events: eventDeliveryStats(), followup_receipts: followupReceiptsSafe() };
  cached = { at: now, outbox: value };
  return value;
}

let cachedSources: { at: number; value: ReturnType<typeof rosterSourceStats> | null } | null = null;
/** 名册来源的汇总，同样缓存 5 秒；表还没建时为 null */
function rosterSources(now: number): ReturnType<typeof rosterSourceStats> | null {
  if (cachedSources && now - cachedSources.at < CACHE_MS) return cachedSources.value;
  let value: ReturnType<typeof rosterSourceStats> | null = null;
  try { value = rosterSourceStats(now); } catch { value = null; }
  cachedSources = { at: now, value };
  return value;
}

export function a2aHealth(cfg: A2aHealthConfig, now = Date.now()): Record<string, unknown> {
  try {
    return {
      inbound: { signature: cfg.directSig, body_signature: cfg.directSigBody },
      outbound: { origin_claim_v1: originClaimV1Enabled() ? 'on' : 'off' },
      card: { ttl_s: Math.round(CARD_TTL_MS / 1000) },
      idempotency: { store: 'sqlite', window_s: Math.round(A2A_IDEM_TTL_MS / 1000) },
      outbox: outbox(now),
      refused: a2aErrorCounts(),
      roster: { ...rosterOutcomeCounts(), sources: rosterSources(now) },
    };
  } catch {
    return { error: 'unavailable' }; // 健康检查本身不因 a2a 读数出错而 500
  }
}

/** 测试用：丢掉缓存 */
export function resetA2aHealthCache(): void { cached = null; cachedSources = null; }
