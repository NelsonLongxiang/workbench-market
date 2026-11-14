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
 *   · 由市场维持的登录提供方会话（用 Odoo 这类身份来源登录的人）：发会话时把浏览器带来的提供方会话凭据加密存下（upstream_sealed），
 *     认人时交给身份服务，照旧拿它去问提供方。凭据按密码对待：AES-256-GCM（vault/crypto.ts），密钥是数据目录里的
 *     .wm-login-session.key（权限 600，不在库里——单拿到库解不开）；只在本文件里加解密，不进应答、日志、留痕；
 *     会话注销、到期、主体停用或不再是启用的人时清空这一列。解不开（密钥换了、数据被改）的会话当场注销。
 */
import { Service } from '@deepseek-ai/cordis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, db } from '../db.ts';
import { decrypt, encrypt } from '../vault/crypto.ts';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** 随机值：32 字节，base64url（43 个字符）。cookie 和查询串里的值先过这一关再去查库 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const newToken = (): string => randomBytes(32).toString('base64url');

export const STATE_TTL_MS = 10 * 60_000;
/** 一个来源手里同时有效的 state 最多这么多（防有人刷满表） */
export const STATES_PER_SOURCE = 20;
const STATES_MAX = 20_000;

export type SessionRecord = { principal: string; provider: string; externalId: string; displayName: string; createdAt: number; expiresAt: number;
  /** 由市场维持的提供方会话：发会话时存下的提供方会话凭据（已解开）；普通的市场会话是 null。只交给身份服务，不往别处传 */
  upstream: string | null;
  /** 来源轮换过几次（市场跟着换了存下的凭据） */
  renewals: number };

// ---------- 提供方会话凭据的加密存放 ----------
const KEY_FILE = (): string => join(dataDir, '.wm-login-session.key');
let sealKey: Buffer | null = null;
/** 密钥：数据目录里的 .wm-login-session.key（64 位十六进制，权限 600）；第一次用时生成。写不进去（只读卷）就用进程内随机的——重启后存下的凭据解不开，那些会话注销、要重新登录 */
function key(): Buffer {
  if (sealKey) return sealKey;
  let hex = '';
  try { hex = String(readFileSync(KEY_FILE(), 'utf8')).trim(); } catch { /* 第一次 */ }
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    hex = randomBytes(32).toString('hex');
    try { writeFileSync(KEY_FILE(), hex, { mode: 0o600 }); chmodSync(KEY_FILE(), 0o600); } catch { /* 只读卷：进程内随机 */ }
  }
  sealKey = Buffer.from(hex, 'hex');
  return sealKey;
}
/** 加密：v1.<iv>.<tag>.<密文>（十六进制） */
export function sealUpstream(plain: string): string {
  const b = encrypt(Buffer.from(plain, 'utf8'), key());
  return `v1.${b.ivHex}.${b.tagHex}.${b.dataHex}`;
}
/** 解开；格式不对、密钥不对、被改过一律 null */
export function openUpstream(sealed: unknown): string | null {
  const m = /^v1\.([0-9a-f]{24})\.([0-9a-f]{32})\.([0-9a-f]{2,4096})$/.exec(String(sealed ?? ''));
  if (!m) return null;
  try { return decrypt({ ivHex: m[1], tagHex: m[2], dataHex: m[3] }, key()).toString('utf8'); } catch { return null; }
}
/**
 * 启动自检那一行：加解密能往返；密文里看不出原文；同一个原文两次加密不一样；改过一个字节的解不开；密钥文件（在的话）权限是 600。
 * 不碰库、不带任何真实凭据（原文是这次随机生成的）
 */
export function sealSelfCheck(): { ok: boolean; reason: string | null } {
  try {
    const plain = `self-check-${randomBytes(16).toString('hex')}`;
    const a = sealUpstream(plain), b = sealUpstream(plain);
    if (openUpstream(a) !== plain) return { ok: false, reason: 'round-trip' };
    if (a.includes(plain) || a.includes(Buffer.from(plain).toString('hex')) || a === b) return { ok: false, reason: 'not-sealed' };
    const last = a.slice(-1);
    if (openUpstream(a.slice(0, -1) + (last === '0' ? '1' : '0')) !== null) return { ok: false, reason: 'tamper-accepted' };
    try { if (process.platform !== 'win32' && (statSync(KEY_FILE()).mode & 0o077) !== 0) return { ok: false, reason: 'key-file-mode' }; } catch { /* 只读卷：没有密钥文件，进程内随机 */ }
    return { ok: true, reason: null };
  } catch { return { ok: false, reason: 'error' }; }
}

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
  /** upstream：由市场维持的提供方会话，发会话时浏览器带来的提供方会话凭据（加密存下）；普通的市场会话不给 */
  createSession(principal: string, provider: string, externalId: string, ttlMs: number, now = Date.now(), upstream?: string): { token: string; expiresAt: number } {
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error('会话期限不对');
    if (upstream !== undefined && (typeof upstream !== 'string' || !upstream || upstream.length > 1024)) throw new Error('提供方会话凭据不对');
    const token = newToken(), expiresAt = now + ttlMs;
    db.prepare('INSERT INTO market_sessions (token_sha256, principal_id, provider, external_id, created_at, expires_at, upstream_sealed) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha(token), principal, provider, externalId, now, expiresAt, upstream === undefined ? null : sealUpstream(upstream));
    db.prepare('DELETE FROM market_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').run(now - 86_400_000, now - 86_400_000);
    this.sweepUpstream(now, true);
    return { token, expiresAt };
  }

  private lastSweep = 0;
  /** 清掉不再算数的会话里存着的提供方凭据：注销了的、到期了的、主体不再是启用的人的。认人时顺手做，一分钟最多一次 */
  sweepUpstream(now = Date.now(), force = false): number {
    if (!force && now - this.lastSweep < 60_000) return 0;
    this.lastSweep = now;
    return Number(db.prepare(`UPDATE market_sessions SET upstream_sealed = NULL WHERE upstream_sealed IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at <= ?
      OR principal_id NOT IN (SELECT id FROM principals WHERE status = 'active' AND kind = 'person'))`).run(now).changes);
  }

  /** 这个会话现在还算不算数：在、没注销、没过期、主体是启用的人。都满足才返回 */
  lookupSession(token: unknown, now = Date.now()): SessionRecord | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    this.sweepUpstream(now);
    const row = db.prepare(`SELECT s.principal_id AS principal, s.provider AS provider, s.external_id AS externalId, p.display_name AS displayName, s.created_at AS createdAt, s.expires_at AS expiresAt,
        s.upstream_sealed AS sealed, s.upstream_renewals AS renewals
      FROM market_sessions s JOIN principals p ON p.id = s.principal_id
      JOIN principal_identities i ON i.provider = s.provider AND i.external_id = s.external_id AND i.principal_id = s.principal_id
      WHERE s.token_sha256 = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND p.status = 'active' AND p.kind = 'person'`).get(sha(token), now) as (Omit<SessionRecord, 'upstream'> & { sealed: string | null }) | undefined;
    if (!row) return null;
    const { sealed, ...fields } = row;
    const rest = { ...fields, renewals: Number(fields.renewals ?? 0) };
    if (sealed === null) return { ...rest, upstream: null };
    const upstream = openUpstream(sealed);
    // 解不开（密钥换了、只读卷重启、数据被改）：这个会话当场注销，要重新登录（诊断一行，不带会话和人）
    if (upstream === null) {
      this.revokeSession(token, now);
      console.warn(JSON.stringify({ source: 'identity', event: 'session-ended', cause: 'undecryptable', at: new Date(now).toISOString() }));
      return null;
    }
    return { ...rest, upstream };
  }

  /** 来源轮换了：换掉存下的提供方凭据（只换还算数的、本来就存着凭据的会话），轮换计数加一。返回换没换成 */
  renewUpstream(token: unknown, upstream: string, now = Date.now()): boolean {
    if (typeof token !== 'string' || !TOKEN_RE.test(token) || typeof upstream !== 'string' || !upstream || upstream.length > 1024) return false;
    return db.prepare(`UPDATE market_sessions SET upstream_sealed = ?, upstream_renewals = upstream_renewals + 1
      WHERE token_sha256 = ? AND revoked_at IS NULL AND expires_at > ? AND upstream_sealed IS NOT NULL`).run(sealUpstream(upstream), sha(token), now).changes === 1;
  }

  /** 注销一个主体的全部会话（停用时调）：恢复之后要重新登录，旧会话不会活过来。返回注销了几个 */
  revokeAllFor(principal: string, now = Date.now()): number {
    return Number(db.prepare('UPDATE market_sessions SET revoked_at = ?, upstream_sealed = NULL WHERE principal_id = ? AND revoked_at IS NULL AND expires_at > ?').run(now, principal, now).changes);
  }

  /** 注销凭某一条外部身份发出的全部会话（解绑时调）：重新绑回去之后，旧会话也不复活。返回注销了几个 */
  revokeForIdentity(provider: string, externalId: string, now = Date.now()): number {
    return Number(db.prepare('UPDATE market_sessions SET revoked_at = ?, upstream_sealed = NULL WHERE provider = ? AND external_id = ? AND revoked_at IS NULL AND expires_at > ?').run(now, provider, externalId, now).changes);
  }

  /** 注销一个会话：立即失效。返回它原来是不是有效的 */
  revokeSession(token: unknown, now = Date.now()): boolean {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
    return db.prepare('UPDATE market_sessions SET revoked_at = ?, upstream_sealed = NULL WHERE token_sha256 = ? AND revoked_at IS NULL AND expires_at > ?').run(now, sha(token), now).changes === 1;
  }
}
