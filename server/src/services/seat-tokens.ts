/**
 * 阶段七：席位用签名换短期 MCP 令牌。团队不再拿长期令牌，节点宿主按需来换，令牌只放宿主内存，由宿主代成员调用 MCP。
 *
 * 用哪把私钥签：节点私钥（宿主的 Ed25519 节点键，名片上的那把）。理由：
 *   · 上游（dsh-open-a2a-net）每个宿主只有这一把键，团队、席位都没有自己的键；名册里也只有它能把席位绑到宿主——
 *     a2a_roster_seats 的 host 就是这把公钥的指纹（sha256 前 8 位十六进制），名册入站时由这把键验过签。
 *   · 市场这边钉住的也只有它（a2a_peers.public_key，管理员确认过的那把）。验签只用钉住的公钥，不取名片、不往外发请求。
 *   · 换令牌时核：签名方的公钥指纹 = 请求里的 host，名册里这台宿主的根地址 = 节点登记的根地址，seat_id 在这台宿主的名册里。
 *     所以一个宿主换不出别的宿主上的席位；同一宿主上的几个团队本来就在同一个进程里、共用这把键（成员也是宿主代着跑），
 *     按团队、按席位隔开要等上游给团队或席位发自己的键，那时在名册里登记公钥、这里改成按那把验，令牌的形状不变。
 *
 * 请求（POST /api/a2a/seat-token，JSON）：{ v: 1, root, host, seat_id, ts, nonce, aud, sig }
 *   sig = base64(Ed25519(节点私钥, JSON.stringify(['wm-seat-token/1', root, host, seat_id, ts, nonce, aud])))
 *   root：节点登记的根地址（origin）；host：节点公钥指纹前 8 位；seat_id：名册里宿主给成员位的稳定 id；ts：毫秒；
 *   nonce：16～64 位 base64url 随机串；aud：市场的对外地址（origin）。
 * 防重放：ts 在 ±5 分钟内；同一个签名只认一次（a2a_sig_seen，保留到时间窗结束之后）。nonce 让同一秒里的两次请求签名不同。
 *
 * 令牌绑定到席位（host + seat_id），1 小时到期，不续期，到期重换。每次调用都复核：节点还是 active、钉住的公钥指纹还是 host、
 * 名册里还有这个席位、席位的授权主体没被吊销——任一不成立，这张令牌当场失效（和无效令牌同一个 401）。
 *
 * 授权挂在席位上、不挂在令牌上：每个席位有一个长期的授权主体（a2a_seat_subjects → mcp_sessions 的一行），
 * 工具授权（grants）、按台批的「工具@台」（bench_mcp_grants，按 session_id 记）都记在这个主体上，换几次令牌都还在。
 * 主体那一行的令牌列写的是一个不会被任何令牌命中的值（不是 64 位十六进制），只能经这里换出来的短期令牌用它。
 * 主体建的时候记下节点公钥的完整指纹（sha256 全长）和根地址；换令牌、每次调用都核这两样和此刻钉住的一致，
 * 对不上就拒（401），不复用这个主体——host 只是指纹前 8 位，主体活得比名册久，不能只凭它认。
 *
 * SQL 都在这里；时间由代码生成后传进 SQL。
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify as edVerify, type KeyObject } from 'node:crypto';
import { db } from '../db.ts';
import { sqlTime } from './a2a-replies.ts';
import { claimSignatureOnce } from './a2a-receipts.ts';

export const SEAT_TOKEN_TAG = 'wm-seat-token/1';
export const SEAT_TOKEN_TTL_MS = 60 * 60_000;
export const SEAT_TOKEN_SKEW_MS = 5 * 60_000;
/** 授权主体在 mcp_sessions 里的名字前缀：管理员建会话时不许用（routes/mcp.ts） */
export const SEAT_SUBJECT_PREFIX = 'seat-';

const HOST_RE = /^[0-9a-f]{8}$/;
const SEAT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_RE = /^[A-Za-z0-9+/_=-]{40,200}$/;
const ROOT_RE = /^https?:\/\/[^/?#\s]{1,253}$/;

export type SeatTokenRequest = { root: string; host: string; seat_id: string; ts: number; nonce: string; aud: string; sig: string };
/** 拒的内部原因：只进日志和计数，对外一律同一个 401（不透露节点、席位存不存在） */
export type SeatTokenRefusal = 'wrong-audience' | 'bad-ts' | 'not-live' | 'bad-sig' | 'replay' | 'subject-revoked' | 'subject-name-taken' | 'subject-mismatch';
export type SeatTokenOutcome = { ok: true; token: string; token_ref: string; expires_at: number; session_id: number } | { ok: false; reason: SeatTokenRefusal } | { ok: false; reason: 'rate-limited'; retryAfter: number };

/** 请求体成形吗：字段齐、类型对、长度和字符集在范围里。不成形返回 null（400，不涉及任何存不存在） */
export function parseSeatTokenRequest(body: unknown): SeatTokenRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return null;
  const s = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  const r = { root: s('root'), host: s('host'), seat_id: s('seat_id'), ts: typeof b.ts === 'number' ? b.ts : NaN, nonce: s('nonce'), aud: s('aud'), sig: s('sig') };
  if (!ROOT_RE.test(r.root) || !HOST_RE.test(r.host) || !SEAT_ID_RE.test(r.seat_id) || !Number.isSafeInteger(r.ts) || r.ts <= 0) return null;
  if (!NONCE_RE.test(r.nonce) || !ROOT_RE.test(r.aud) || !SIG_RE.test(r.sig)) return null;
  return r;
}

export function seatTokenCanonical(r: Omit<SeatTokenRequest, 'sig'>): string {
  return JSON.stringify([SEAT_TOKEN_TAG, r.root, r.host, r.seat_id, r.ts, r.nonce, r.aud]);
}

const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** 公钥（base64 SPKI DER）的指纹前 8 位，和名册的 host、上游 canvasOwnerFingerprint 同一个算法 */
export const hostOfKey = (publicKey: string): string => sha256Hex(Buffer.from(publicKey, 'base64')).slice(0, 8);
/** 公钥的完整指纹（sha256 全长十六进制）：席位主体绑它，不只绑前 8 位 */
export const keyFingerprint = (publicKey: string): string => sha256Hex(Buffer.from(publicKey, 'base64'));

/**
 * 节点和席位现在都还有效吗：名册里有这台宿主、宿主的根地址登记成了对端且 active、钉住的公钥指纹就是 host、
 * 这个 seat_id 在这台宿主的名册里。给了 root 的还要等于名册记下的根地址。有效时返回钉住的公钥和根地址
 */
function liveSeat(host: string, seatId: string, root?: string): { publicKey: string; root: string } | null {
  const row = db.prepare(`SELECT r.peer_root AS root, p.public_key AS pk, p.status AS status FROM a2a_rosters r
    JOIN a2a_roster_seats s ON s.host = r.host AND s.seat_id = ?
    JOIN a2a_peers p ON p.root_url = r.peer_root
    WHERE r.host = ? LIMIT 1`).get(seatId, host) as { root: string; pk: string; status: string } | undefined;
  if (!row || row.status !== 'active' || row.pk === '' || hostOfKey(row.pk) !== host) return null;
  if (root !== undefined && row.root !== root) return null;
  return { publicKey: row.pk, root: row.root };
}

let dummyKey: KeyObject | null = null;
function verifies(publicKey: string | null, canonical: string, sig: string): boolean {
  try {
    // 节点或席位无效时也照样验一次（用一把一次性生成的键），应答时间不因存不存在而不同
    const key = publicKey ? createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }) : (dummyKey ??= generateKeyPairSync('ed25519').publicKey);
    return edVerify(undefined, Buffer.from(canonical, 'utf8'), key, Buffer.from(sig, 'base64')) && publicKey !== null;
  } catch { return false; }
}

/**
 * 席位的授权主体：没有就建（mcp_sessions 一行 + a2a_seat_subjects 一行，同一个保存点），建时记下公钥完整指纹和根地址。
 * 已有的：被吊销返回 revoked；公钥完整指纹或根地址和建时记下的不一样返回 mismatch（不复用）
 */
function subjectOf(host: string, seatId: string, keyFp: string, root: string, now: number): { id: number } | 'revoked' | 'name-taken' | 'mismatch' {
  const hit = db.prepare('SELECT s.session_id AS id, s.key_fp AS key_fp, s.root AS root, m.revoked_at AS revoked FROM a2a_seat_subjects s JOIN mcp_sessions m ON m.id = s.session_id WHERE s.host = ? AND s.seat_id = ?')
    .get(host, seatId) as { id: number; key_fp: string; root: string; revoked: string } | undefined;
  if (hit) {
    if (hit.key_fp !== keyFp || hit.root !== root) return 'mismatch';
    return hit.revoked === '' ? { id: Number(hit.id) } : 'revoked';
  }
  const name = `${SEAT_SUBJECT_PREFIX}${host}-${sha256Hex(seatId).slice(0, 12)}`;
  db.exec('SAVEPOINT seat_subject');
  try {
    if (db.prepare('SELECT 1 FROM mcp_sessions WHERE name = ?').get(name)) { db.exec('RELEASE seat_subject'); return 'name-taken'; }
    // 令牌列写一个不会被命中的值：查令牌按 64 位十六进制的 sha256 查，这里带前缀、不是十六进制
    const info = db.prepare('INSERT INTO mcp_sessions (name, token_sha256, grants, created_at) VALUES (?, ?, ?, ?)')
      .run(name, `seat-subject:${randomBytes(16).toString('hex')}`, '[]', sqlTime(now));
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO a2a_seat_subjects (host, seat_id, key_fp, root, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(host, seatId, keyFp, root, id, now);
    db.exec('RELEASE seat_subject');
    return { id };
  } catch (e) { db.exec('ROLLBACK TO seat_subject'); db.exec('RELEASE seat_subject'); throw e; }
}

/**
 * 换令牌。audOk：请求里的 aud 是不是本市场（路由按配置的对外地址和本端地址核）。
 * seatQuota：验过签、认过签名（重放的不占额度）之后计这个席位的额度，超了返回要等的秒数（这个签名已用掉，过会儿重新签一份来）
 */
export function exchangeSeatToken(r: SeatTokenRequest, audOk: boolean, now = Date.now(), seatQuota: () => number = () => 0): SeatTokenOutcome {
  if (!audOk) return { ok: false, reason: 'wrong-audience' };
  if (Math.abs(now - r.ts) > SEAT_TOKEN_SKEW_MS) return { ok: false, reason: 'bad-ts' };
  const live = liveSeat(r.host, r.seat_id, r.root);
  if (!verifies(live?.publicKey ?? null, seatTokenCanonical(r), r.sig)) return { ok: false, reason: live ? 'bad-sig' : 'not-live' };
  if (!claimSignatureOnce(r.sig, r.ts + SEAT_TOKEN_SKEW_MS + 60_000, now)) return { ok: false, reason: 'replay' };
  const wait = seatQuota();
  if (wait > 0) return { ok: false, reason: 'rate-limited', retryAfter: wait };
  const subject = subjectOf(r.host, r.seat_id, keyFingerprint(live!.publicKey), live!.root, now);
  if (subject === 'mismatch') return { ok: false, reason: 'subject-mismatch' };
  if (subject === 'revoked') return { ok: false, reason: 'subject-revoked' };
  if (subject === 'name-taken') return { ok: false, reason: 'subject-name-taken' };
  db.prepare('DELETE FROM a2a_seat_tokens WHERE expires_at <= ?').run(now);
  const token = randomBytes(32).toString('hex');
  const expiresAt = now + SEAT_TOKEN_TTL_MS;
  db.prepare('INSERT INTO a2a_seat_tokens (token_sha256, host, seat_id, session_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256Hex(token), r.host, r.seat_id, subject.id, now, expiresAt);
  return { ok: true, token, token_ref: tokenRef(sha256Hex(token)), expires_at: expiresAt, session_id: subject.id };
}

/** 令牌的引用：sha256 的前 16 位。换令牌的记录和调用审计都记它，对得上又不留能用的东西 */
export const tokenRef = (tokenSha256: string): string => tokenSha256.slice(0, 16);

/** 验签这一步之后才拒的原因：host、seat_id 是签名证实过的 */
const VERIFIED_REFUSALS: ReadonlySet<string> = new Set(['replay', 'subject-revoked', 'subject-name-taken', 'subject-mismatch', 'rate-limited']);
const LOG_KEEP_MS = 180 * 24 * 3_600_000;
const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');

/**
 * 每次换令牌记一行，成不成都记（属主 2026-11-13）：节点侧报「有成员读了节点私钥」时，按时间段对上有没有人换过令牌、
 * 换到的令牌拿去调了什么（token_ref 对 mcp_calls.token_ref）。请求体不成形的也记，字段按收到的截短记下（verified = 0）
 */
export function logSeatTokenExchange(e: { at: number; source: string; body: unknown; outcome: 'issued' | 'refused' | 'rate-limited' | 'bad-request'; reason?: string; session_id?: number; token_ref?: string; expires_at?: number }): void {
  const b = (e.body && typeof e.body === 'object' && !Array.isArray(e.body) ? e.body : {}) as Record<string, unknown>;
  const verified = e.outcome === 'issued' || (e.reason !== undefined && VERIFIED_REFUSALS.has(e.reason));
  db.prepare('DELETE FROM a2a_seat_token_log WHERE at < ?').run(e.at - LOG_KEEP_MS);
  db.prepare(`INSERT INTO a2a_seat_token_log (at, host, seat_id, root, source, outcome, reason, verified, session_id, token_ref, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.at, clip(b.host, 16), clip(b.seat_id, 64), clip(b.root, 260), clip(e.source, 64), e.outcome, e.reason ?? '',
    verified ? 1 : 0, e.session_id ?? null, e.token_ref ?? '', e.expires_at ?? null);
}

/** 换令牌的记录（管理员看）：按时间倒序，可按节点、席位、起止时间筛 */
export function seatTokenLog(f: { host?: string; seat_id?: string; since?: number; until?: number; limit: number }): Record<string, unknown>[] {
  const where: string[] = [], args: (string | number)[] = [];
  if (f.host) { where.push('host = ?'); args.push(f.host); }
  if (f.seat_id) { where.push('seat_id = ?'); args.push(f.seat_id); }
  if (f.since !== undefined) { where.push('at >= ?'); args.push(f.since); }
  if (f.until !== undefined) { where.push('at < ?'); args.push(f.until); }
  return db.prepare(`SELECT at, host, seat_id, root, source, outcome, reason, verified, session_id, token_ref, expires_at FROM a2a_seat_token_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, f.limit) as Record<string, unknown>[];
}

/**
 * MCP 网关认令牌时调：是换来的席位令牌、没到期、席位和节点此刻仍有效、主体没被吊销，返回主体会话（带上席位）；否则 null。
 * 每次调用都走一遍，名册撤掉席位、停用节点、公钥变了待确认、吊销主体，下一次调用就失效；
 * 主体建时记下的公钥完整指纹、根地址和此刻钉住的对不上，也失效。
 */
export function seatTokenSession(tokenSha256: string, now = Date.now()): { id: number; name: string; grants: string[]; seat: string; tokenRef: string } | null {
  const t = db.prepare('SELECT host, seat_id, session_id, expires_at FROM a2a_seat_tokens WHERE token_sha256 = ?').get(tokenSha256) as { host: string; seat_id: string; session_id: number; expires_at: number } | undefined;
  if (!t || Number(t.expires_at) <= now) return null;
  const live = liveSeat(t.host, t.seat_id);
  if (!live) return null;
  const bound = db.prepare('SELECT key_fp, root FROM a2a_seat_subjects WHERE session_id = ? AND host = ? AND seat_id = ?').get(t.session_id, t.host, t.seat_id) as { key_fp: string; root: string } | undefined;
  if (!bound || bound.key_fp !== keyFingerprint(live.publicKey) || bound.root !== live.root) return null;
  const s = db.prepare("SELECT id, name, grants FROM mcp_sessions WHERE id = ? AND revoked_at = ''").get(t.session_id) as { id: number; name: string; grants: string } | undefined;
  if (!s) return null;
  let grants: string[] = [];
  try { const g = JSON.parse(s.grants || '[]'); if (Array.isArray(g)) grants = g.filter((x) => typeof x === 'string'); } catch { grants = []; }
  return { id: Number(s.id), name: s.name, grants, seat: `${t.host}:${t.seat_id}`, tokenRef: tokenRef(tokenSha256) };
}

/** 这个会话是不是席位的授权主体（管理员页、审计用） */
export function seatOfSubject(sessionId: number): { host: string; seat_id: string } | null {
  return (db.prepare('SELECT host, seat_id FROM a2a_seat_subjects WHERE session_id = ?').get(sessionId) as { host: string; seat_id: string } | undefined) ?? null;
}
