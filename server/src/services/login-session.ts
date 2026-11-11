/**
 * 登录与市场会话域（login_states + market_sessions）。
 *
 * 登录过程里的 state（防伪造、防重放）：
 *   · 发起登录时签一个随机 state，同时给浏览器一个随机的「浏览器半边」（放在只给登录回调用的 cookie 里）；库里两者都只存哈希。
 *   · 回调时三样对得上才算数：state 在、没过期、是这个登录方式的，而且浏览器半边对得上——别人截获的回调链接在另一个浏览器里用不了。
 *   · 一次性：核对和删除是同一条语句（DELETE … RETURNING），重放、并发重放都只有一次能成。
 *   · 按来源限额，过期的随手清掉。
 *
 * 市场会话：
 *   · cookie 里是随机值，库里只存哈希。绝对期限，不续期；注销就记下 revoked_at，立即失效。
 *   · 认人时现查，而且和主体表、外部身份表连着查：主体停用（或者不是人了）、发会话时凭的那条外部身份已经不绑在这个主体上，
 *     都查不到，会话立即失效——以后任何停用、解绑、改绑的路径都管得住，不用一条条去吊销。
 */
import { Service } from '@deepseek-ai/cordis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '../db.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** 随机值：32 字节，base64url（43 个字符）。cookie 和查询串里的值先过这一关再去查库 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const newToken = (): string => randomBytes(32).toString('base64url');

export const STATE_TTL_MS = 10 * 60_000;
/** 一个来源手里同时有效的 state 最多这么多（防有人刷满表） */
export const STATES_PER_SOURCE = 20;
const STATES_MAX = 20_000;

export type SessionRecord = { principal: string; provider: string; externalId: string; displayName: string; createdAt: number; expiresAt: number };

export class LoginSessionService extends Service {
  constructor(ctx: any) {
    super(ctx, 'loginSessions');
  }

  // ---------- 登录过程的 state ----------

  /** 签一个 state。返回 state 和浏览器半边；这个来源手里的有效 state 到上限了返回 null */
  issueState(flow: string, next: string, source: string, now = Date.now()): { state: string; browser: string; expiresAt: number } | null {
    db.prepare('DELETE FROM login_states WHERE expires_at <= ?').run(now);
    const held = (db.prepare('SELECT COUNT(*) AS n FROM login_states WHERE source = ?').get(source) as { n: number }).n;
    if (held >= STATES_PER_SOURCE) return null;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM login_states').get() as { n: number }).n;
    if (total >= STATES_MAX) return null;
    const state = newToken(), browser = newToken(), expiresAt = now + STATE_TTL_MS;
    db.prepare('INSERT INTO login_states (state_sha256, flow, next, browser_sha256, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha(state), flow, next, sha(browser), source, now, expiresAt);
    return { state, browser, expiresAt };
  }

  /**
   * 核对并作废一个 state：在、没过期、是这个登录方式的、浏览器半边对得上，才返回当初记下的 next，同时删掉它。
   * 任何一样对不上都返回 null，而且不删（不能让别人拿着截获的 state 把真正的登录作废）。
   */
  takeState(flow: string, state: unknown, browser: unknown, now = Date.now()): { next: string } | null {
    if (typeof state !== 'string' || !TOKEN_RE.test(state) || typeof browser !== 'string' || !TOKEN_RE.test(browser)) return null;
    const row = db.prepare('SELECT browser_sha256, flow FROM login_states WHERE state_sha256 = ? AND expires_at > ?').get(sha(state), now) as { browser_sha256: string; flow: string } | undefined;
    if (!row || row.flow !== flow || !sameHex(row.browser_sha256, sha(browser))) return null;
    const taken = db.prepare('DELETE FROM login_states WHERE state_sha256 = ? AND browser_sha256 = ? AND flow = ? AND expires_at > ? RETURNING next').get(sha(state), sha(browser), flow, now) as { next: string } | undefined;
    return taken ? { next: taken.next } : null;
  }

  // ---------- 登录方式推来的事件：防重放 ----------

  /** 记下一个事件号；第一次见到返回 true，见过返回 false（多个实例共用这张表，同一个事件只处理一次）。顺手清掉 7 天前的 */
  firstSeen(flow: string, eventId: string, now = Date.now()): boolean {
    db.prepare('DELETE FROM login_events_seen WHERE seen_at < ?').run(now - 7 * 86_400_000);
    return db.prepare('INSERT OR IGNORE INTO login_events_seen (flow, event_id, seen_at) VALUES (?, ?, ?)').run(flow, eventId, now).changes === 1;
  }

  /**
   * 一个事件只处理一次，而且「记下事件号」和「处理」在同一个事务里，同生共死：
   * 处理出错，事件号一起撤回，对方重推时照常处理（不会被当成重复跳过）；见过的事件不调 work。
   * work 里只能做本库的同步写（停用、注销会话），不能等别的东西。
   */
  once<T>(flow: string, eventId: string, work: () => T, now = Date.now()): { seen: true } | { seen: false; result: T } {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.firstSeen(flow, eventId, now)) { db.exec('ROLLBACK'); return { seen: true }; }
      const result = work();
      db.exec('COMMIT');
      return { seen: false, result };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
      throw e;
    }
  }

  // ---------- 市场会话 ----------

  /** 发一个会话。principal 必须是启用的人（调用方已经对到主体）；返回放进 cookie 的值和到期时刻 */
  createSession(principal: string, provider: string, externalId: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error('会话期限不对');
    const token = newToken(), expiresAt = now + ttlMs;
    db.prepare('INSERT INTO market_sessions (token_sha256, principal_id, provider, external_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha(token), principal, provider, externalId, now, expiresAt);
    db.prepare('DELETE FROM market_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').run(now - 86_400_000, now - 86_400_000);
    return { token, expiresAt };
  }

  /** 这个会话现在还算不算数：在、没注销、没过期、主体是启用的人。都满足才返回 */
  lookupSession(token: unknown, now = Date.now()): SessionRecord | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const row = db.prepare(`SELECT s.principal_id AS principal, s.provider AS provider, s.external_id AS externalId, p.display_name AS displayName, s.created_at AS createdAt, s.expires_at AS expiresAt
      FROM market_sessions s JOIN principals p ON p.id = s.principal_id
      JOIN principal_identities i ON i.provider = s.provider AND i.external_id = s.external_id AND i.principal_id = s.principal_id
      WHERE s.token_sha256 = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND p.status = 'active' AND p.kind = 'person'`).get(sha(token), now) as SessionRecord | undefined;
    return row ?? null;
  }

  /** 注销一个主体的全部会话（停用时调）：恢复之后要重新登录，旧会话不会活过来。返回注销了几个 */
  revokeAllFor(principal: string, now = Date.now()): number {
    return Number(db.prepare('UPDATE market_sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL AND expires_at > ?').run(now, principal, now).changes);
  }

  /** 注销凭某一条外部身份发出的全部会话（解绑时调）：重新绑回去之后，旧会话也不复活。返回注销了几个 */
  revokeForIdentity(provider: string, externalId: string, now = Date.now()): number {
    return Number(db.prepare('UPDATE market_sessions SET revoked_at = ? WHERE provider = ? AND external_id = ? AND revoked_at IS NULL AND expires_at > ?').run(now, provider, externalId, now).changes);
  }

  /** 注销一个会话：立即失效。返回它原来是不是有效的 */
  revokeSession(token: unknown, now = Date.now()): boolean {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
    return db.prepare('UPDATE market_sessions SET revoked_at = ? WHERE token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?').run(now, sha(token), now).changes === 1;
  }
}
