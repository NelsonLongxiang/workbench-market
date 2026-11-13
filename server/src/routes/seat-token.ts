/**
 * 阶段七：POST /api/a2a/seat-token——席位用节点签名换一张 1 小时的 MCP 令牌（services/seat-tokens.ts 写了为什么用节点私钥、
 * 令牌怎么绑席位、每次调用怎么复核）。登录门放行到这里，由签名、钉住的节点公钥和名册判。
 *
 * 应答：
 *   200 { token, token_type: 'Bearer', expires_at（ISO）, expires_in: 3600, seat: { host, seat_id } }
 *   400 { error: 'seat_token_bad_request' }   请求体不成形（字段缺、类型或字符集不对）——不涉及任何节点、席位存不存在
 *   401 { error: 'seat_token_refused' }       验签不过、时间窗外、签名用过了、节点停用或公钥待确认、席位不在名册、主体被吊销——一律这一句
 *   429 { error: 'seat_token_rate_limited' }  限频（Retry-After 秒数）：按来源地址数请求，按席位数发出去的令牌
 * 不往外发任何请求（不取名片）；不读也不认 X-Team-Seat。
 * 每次换令牌（成不成、限频、不成形都算）单独记一行（a2a_seat_token_log：节点、席位、时间、结果、拒的原因、令牌引用）。
 *
 * GET /api/a2a/seat-token/log（只给管理员）：换令牌的记录，按时间倒序；?host=&seat_id=&since=&until=（毫秒）&limit=（1～500，缺省 100）。
 * 对上调用：记录里的 token_ref 等于 GET /api/mcp/calls 里的 token_ref。
 */
import type express from 'express';
import type { HttpService } from '../http.ts';
import { audiencesOf, originOf } from '../a2a-direct-sig.ts';
import { exchangeSeatToken, logSeatTokenExchange, parseSeatTokenRequest, seatTokenLog, SEAT_TOKEN_TTL_MS, type SeatTokenRefusal } from '../services/seat-tokens.ts';

/** 每个来源地址 10 分钟最多来这么多次（不管成不成）；每个席位 1 小时最多发这么多张令牌 */
export const SEAT_TOKEN_PER_SOURCE_10MIN = 60;
export const SEAT_TOKEN_PER_SEAT_HOUR = 12;
const WINDOW_SOURCE_MS = 10 * 60_000;
const WINDOW_SEAT_MS = 60 * 60_000;
const MAX_KEYS = 10_000;

/** 固定窗口计数（只在内存里：重启清零，可以接受——令牌本身只有 1 小时） */
function windowCounter(windowMs: number, max: number) {
  const hits = new Map<string, { start: number; n: number }>();
  return {
    /** 计一次；超了返回还要等几秒，没超返回 0 */
    take(key: string, now: number): number {
      let h = hits.get(key);
      if (!h || now - h.start >= windowMs) { h = { start: now, n: 0 }; hits.delete(key); hits.set(key, h); }
      if (h.n >= max) return Math.max(1, Math.ceil((h.start + windowMs - now) / 1000));
      h.n++;
      if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value as string);
      return 0;
    },
  };
}

export type SeatTokenRouteDeps = {
  /** 市场对外地址（MARKET_PUBLIC_URL）：aud 必须是它或请求实际到达的本端地址 */
  audiences: () => string[];
  /** 管理门（口令或身份来源的管理员）：换令牌的记录只给管理员看 */
  adminGuard: (req: express.Request, res: express.Response) => boolean;
  now?: () => number;
};

const refusals = new Map<SeatTokenRefusal, number>();
/** 拒的原因计数（只给内部看，不带任何标识） */
export function seatTokenRefusalCounts(): Record<string, number> { return Object.fromEntries(refusals); }

export function registerSeatTokenRoutes(app: HttpService, deps: SeatTokenRouteDeps): void {
  const perSource = windowCounter(WINDOW_SOURCE_MS, SEAT_TOKEN_PER_SOURCE_10MIN);
  const perSeat = windowCounter(WINDOW_SEAT_MS, SEAT_TOKEN_PER_SEAT_HOUR);
  const now = deps.now ?? Date.now;
  app.post('/api/a2a/seat-token', { action: 'a2a.seat-token', kind: 'write', statusNotVerdict: '席位签名、钉住的节点公钥和名册判，不是登录身份的结论' }, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const t = now();
    const source = String(req.socket?.remoteAddress ?? '');
    const log = (e: Omit<Parameters<typeof logSeatTokenExchange>[0], 'at' | 'source' | 'body'>) => logSeatTokenExchange({ at: t, source, body: req.body, ...e });
    const wait = perSource.take(source, t);
    if (wait > 0) { log({ outcome: 'rate-limited', reason: 'per-source' }); res.set('Retry-After', String(wait)); return void res.status(429).json({ error: 'seat_token_rate_limited' }); }
    const r = parseSeatTokenRequest(req.body);
    if (!r) { log({ outcome: 'bad-request' }); return void res.status(400).json({ error: 'seat_token_bad_request' }); }
    const audOk = originOf(r.aud) !== '' && audiencesOf(req, deps.audiences()).has(originOf(r.aud));
    // 席位的限额在验过签、认过签名之后、发令牌之前计：只有真能换到的才占这个席位的额度，别人冒名、重放都占不了
    const out = exchangeSeatToken(r, audOk, t, () => perSeat.take(`${r.host}\u0000${r.seat_id}`, t));
    if (!out.ok) {
      if (out.reason === 'rate-limited') { log({ outcome: 'rate-limited', reason: 'rate-limited' }); res.set('Retry-After', String(out.retryAfter)); return void res.status(429).json({ error: 'seat_token_rate_limited' }); }
      refusals.set(out.reason, (refusals.get(out.reason) ?? 0) + 1);
      log({ outcome: 'refused', reason: out.reason });
      if (out.reason === 'subject-name-taken') console.error('[seat-token] 席位授权主体的名字被一个普通会话占了，换不出令牌（改掉那个会话的名字）');
      return void res.status(401).json({ error: 'seat_token_refused' });
    }
    log({ outcome: 'issued', session_id: out.session_id, token_ref: out.token_ref, expires_at: out.expires_at });
    res.json({ token: out.token, token_type: 'Bearer', expires_at: new Date(out.expires_at).toISOString(), expires_in: Math.round(SEAT_TOKEN_TTL_MS / 1000), seat: { host: r.host, seat_id: r.seat_id } });
  });
  app.get('/api/a2a/seat-token/log', { action: 'a2a.seat-token-log', kind: 'admin' }, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!deps.adminGuard(req, res)) return;
    const int = (v: unknown) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : undefined);
    const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined);
    const limit = Math.min(500, Math.max(1, int(req.query.limit) ?? 100));
    res.json({ entries: seatTokenLog({ host: str(req.query.host, /^[0-9a-f]{8}$/), seat_id: str(req.query.seat_id, /^[A-Za-z0-9._:-]{1,64}$/), since: int(req.query.since), until: int(req.query.until), limit }) });
  });
}
