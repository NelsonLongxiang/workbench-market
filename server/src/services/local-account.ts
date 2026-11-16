/**
 * 站内账号（docs/local-accounts.md）：登录方式 local 背后的账号表。Cordis 服务 `localAccounts`。
 *
 * 只管账号本身：用户名、密码、要不要先改密码、输错计数和锁定，以及登录过程中的一次性码。
 * 账号对应哪个主体、停用与否、发会话，都不在这里：主体经外部身份（provider=local, external_id=用户名）连着，由主体服务和核心管。
 *
 * 密码：
 *   · 只存 scrypt 的结果（Node 自带，N=2^15、r=8、p=1、每个账号单独加盐、64 字节），连参数一起存（scrypt$N$r$p$盐$哈希），以后能升级参数；
 *   · 校验用定长比较；用户名不存在时拿一个假的哈希也算一次，「没这个人」和「密码不对」耗时相同；
 *   · 连续输错 LOCK_AFTER 次锁 LOCK_MS；同一来源一分钟内输错 SOURCE_MAX 次，这个来源先歇一分钟（只在内存里，进程重启清零）。
 * 一次性码（表单校验过了、交给回调换人）和改密码票（临时密码对了、还要先改密码）只在内存里、只存哈希，绑着这次登录的 state，到点作废、用一次作废。
 * 密码、临时密码、码、票，都不进日志，不进应答（临时密码只在生成它的那一次应答里给管理员）。
 */
import { Service } from '@deepseek-ai/cordis';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { db } from '../db.ts';

/** 用户名：小写字母、数字和 . _ -，2～32 位，以字母或数字开头 */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60_000;
const SOURCE_WINDOW_MS = 60_000;
const SOURCE_MAX = 10;
/** 自己注册：同一来源一小时最多试这么多次（成功、失败都算，不让人拿注册去探哪些用户名占着） */
export const SIGNUP_WINDOW_MS = 60 * 60_000;
export const SIGNUP_MAX = 5;
const CODE_TTL_MS = 60_000;
const TICKET_TTL_MS = 5 * 60_000;
const ONE_TIME_MAX = 10_000;

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const MAXMEM = 128 * 1024 * 1024;

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const sameText = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((ok, fail) => scrypt(password, salt, keylen, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? fail(err) : ok(key))));
}

/** 算一个新的密码哈希（新盐、当前参数） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** 核对密码。存的东西形状不对、参数越界，一律当不对（不抛错） */
export async function checkPassword(stored: string, password: string): Promise<boolean> {
  const m = /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,128})$/.exec(stored);
  if (!m) return false;
  const N = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  if (N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const want = Buffer.from(m[5], 'base64url');
  try {
    const got = await scryptAsync(password, Buffer.from(m[4], 'base64url'), N, r, p, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}

/** 密码规则：长度、不含控制字符、不能和用户名一样。不合规返回一句说明 */
export function passwordProblem(username: string, password: unknown): string | null {
  if (typeof password !== 'string') return '密码要是一段文字';
  const len = [...password].length;
  if (len < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (len > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  if (/[\x00-\x1f\x7f]/.test(password)) return '密码里不能有控制字符';
  if (password.toLowerCase() === username.toLowerCase()) return '密码不能和用户名一样';
  return null;
}

/** 临时密码：16 位，去掉容易看错的字符（0/o、1/l/i），约 78 位熵 */
export function tempPassword(): string {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += A[randomInt(A.length)];
  return out;
}

/** 给页面和接口的一行账号（不含任何密码材料） */
export type LocalAccountView = {
  username: string; display_name: string; must_change: boolean; locked: boolean; locked_until: number | null;
  created_at: number; created_by: string; updated_at: number; last_login_at: number | null;
};
type Row = { username: string; display_name: string; password_hash: string; must_change: number; failed_count: number; locked_until: number;
  created_at: number; created_by: string; updated_at: number; last_login_at: number | null };

const COLS = 'username, display_name, must_change, failed_count, locked_until, created_at, created_by, updated_at, last_login_at';
const view = (r: Omit<Row, 'password_hash'>, now = Date.now()): LocalAccountView => ({
  username: r.username, display_name: r.display_name, must_change: r.must_change === 1,
  locked: Number(r.locked_until) > now, locked_until: Number(r.locked_until) > now ? Number(r.locked_until) : null,
  created_at: Number(r.created_at), created_by: r.created_by, updated_at: Number(r.updated_at), last_login_at: r.last_login_at === null ? null : Number(r.last_login_at),
});

/** 显示名：可空，最多 64 个字，不含控制字符，两头空白去掉 */
export function displayNameOk(v: unknown): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || /[\x00-\x1f\x7f]/.test(v)) return null;
  const t = v.trim();
  return [...t].length <= 64 ? t : null;
}

export type VerifyResult = { ok: true; username: string; mustChange: boolean } | { ok: false; reason: 'invalid' | 'locked' | 'throttled' };

export class LocalAccountService extends Service {
  /** 假哈希：用户名不存在时也算一次 scrypt，耗时和真核对一样 */
  private dummy: Promise<string> | null = null;
  private readonly sourceFails = new Map<string, number[]>();
  private readonly signups = new Map<string, number[]>();
  private readonly codes = new Map<string, { username: string; state: string; exp: number }>();
  private readonly tickets = new Map<string, { username: string; state: string; exp: number }>();

  constructor(ctx: any) {
    super(ctx, 'localAccounts');
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= hashPassword(randomBytes(24).toString('base64url'));
    return this.dummy;
  }

  get(username: string, now = Date.now()): LocalAccountView | null {
    if (!USERNAME_RE.test(username)) return null;
    const r = db.prepare(`SELECT ${COLS} FROM local_accounts WHERE username = ?`).get(username) as Omit<Row, 'password_hash'> | undefined;
    return r ? view(r, now) : null;
  }

  list(now = Date.now()): LocalAccountView[] {
    return (db.prepare(`SELECT ${COLS} FROM local_accounts ORDER BY username`).all() as Omit<Row, 'password_hash'>[]).map((r) => view(r, now));
  }

  /** 建一个账号，发一个临时密码（下次登录先改）。用户名不合规 invalid，已经有了 taken */
  async create(input: { username: unknown; displayName?: unknown }, actor: string, now = Date.now()):
    Promise<{ ok: true; tempPassword: string; account: LocalAccountView } | { ok: false; reason: 'invalid' | 'taken'; message: string }> {
    const username = input.username;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return { ok: false, reason: 'invalid', message: '用户名只能用小写字母、数字和 . _ -，2～32 位，以字母或数字开头' };
    const displayName = displayNameOk(input.displayName);
    if (displayName === null) return { ok: false, reason: 'invalid', message: '显示名最多 64 个字，不能有控制字符' };
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    const ins = db.prepare(`INSERT INTO local_accounts (username, display_name, password_hash, must_change, failed_count, locked_until, created_at, created_by, updated_at)
      VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?) ON CONFLICT (username) DO NOTHING`).run(username, displayName, hash, now, actor, now);
    if (ins.changes !== 1) return { ok: false, reason: 'taken', message: '这个用户名不能用' };
    return { ok: true, tempPassword: temp, account: this.get(username, now)! };
  }

  /**
   * 自己注册（docs/local-accounts.md 第 4 节）：只建站内账号（不用改密码），不建主体、不绑定——登录后核心发现没对接，进待对接清单、给等待页，
   * 管理员核准才绑到新主体上。同一来源一小时最多试 SIGNUP_MAX 次（throttled）。用户名占着（已有账号，或 reserved 说占着：已有同名主体、等价写法的外部身份）
   * 一律 taken、同一句「这个用户名不能用」，不说是哪种。
   */
  async register(input: { username: unknown; displayName?: unknown; password: unknown; confirm: unknown }, source: string, reserved: (username: string) => boolean, now = Date.now()):
    Promise<{ ok: true; username: string } | { ok: false; reason: 'throttled' | 'invalid' | 'taken'; message: string }> {
    const hits = (this.signups.get(source) ?? []).filter((t) => t > now - SIGNUP_WINDOW_MS);
    if (hits.length >= SIGNUP_MAX) { this.signups.set(source, hits); return { ok: false, reason: 'throttled', message: '注册太频繁了，请过一会儿再试。' }; }
    hits.push(now);
    this.signups.set(source, hits);
    if (this.signups.size > ONE_TIME_MAX) this.signups.delete(this.signups.keys().next().value as string);
    const username = input.username;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return { ok: false, reason: 'invalid', message: '用户名只能用小写字母、数字和 . _ -，2～32 位，以字母或数字开头。' };
    const displayName = displayNameOk(input.displayName);
    if (displayName === null) return { ok: false, reason: 'invalid', message: '显示名最多 64 个字，不能有控制字符。' };
    if (input.password !== input.confirm) return { ok: false, reason: 'invalid', message: '两次输的密码不一样。' };
    const problem = passwordProblem(username, input.password);
    if (problem) return { ok: false, reason: 'invalid', message: problem };
    let taken = true;
    try { taken = reserved(username) === true; } catch { taken = true; } // 查不了就当占着（失败关闭）
    if (taken || this.get(username, now)) return { ok: false, reason: 'taken', message: '这个用户名不能用。' };
    const hash = await hashPassword(input.password as string);
    const ins = db.prepare(`INSERT INTO local_accounts (username, display_name, password_hash, must_change, failed_count, locked_until, created_at, created_by, updated_at)
      VALUES (?, ?, ?, 0, 0, 0, ?, 'signup', ?) ON CONFLICT (username) DO NOTHING`).run(username, displayName, hash, now, now);
    if (ins.changes !== 1) return { ok: false, reason: 'taken', message: '这个用户名不能用。' };
    return { ok: true, username };
  }

  /** 删掉一个账号（建人时绑主体没成，撤回刚建的账号用） */
  remove(username: string): boolean {
    return USERNAME_RE.test(username) && db.prepare('DELETE FROM local_accounts WHERE username = ?').run(username).changes === 1;
  }

  /** 重置成一个新的临时密码（下次登录先改），顺手解锁。没有这个账号返回 null */
  async resetPassword(username: string, now = Date.now()): Promise<string | null> {
    if (!this.get(username, now)) return null;
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    const up = db.prepare('UPDATE local_accounts SET password_hash = ?, must_change = 1, failed_count = 0, locked_until = 0, updated_at = ? WHERE username = ?').run(hash, now, username);
    return up.changes === 1 ? temp : null;
  }

  /** 解锁：清掉输错计数 */
  unlock(username: string, now = Date.now()): boolean {
    return USERNAME_RE.test(username) && db.prepare('UPDATE local_accounts SET failed_count = 0, locked_until = 0, updated_at = ? WHERE username = ?').run(now, username).changes === 1;
  }

  /** 这个来源一分钟内输错太多了没有（只看，不记） */
  throttled(source: string, now = Date.now()): boolean {
    const hits = (this.sourceFails.get(source) ?? []).filter((t) => t > now - SOURCE_WINDOW_MS);
    if (hits.length) this.sourceFails.set(source, hits); else this.sourceFails.delete(source);
    return hits.length >= SOURCE_MAX;
  }

  private noteSourceFail(source: string, now: number): void {
    const hits = (this.sourceFails.get(source) ?? []).filter((t) => t > now - SOURCE_WINDOW_MS);
    hits.push(now);
    this.sourceFails.set(source, hits);
    if (this.sourceFails.size > ONE_TIME_MAX) this.sourceFails.delete(this.sourceFails.keys().next().value as string);
  }

  /**
   * 核对用户名和密码。没这个人、密码不对，都是 invalid，而且耗时一样；锁着的是 locked（也照样算一次哈希）；
   * 这个来源输错太多是 throttled（不算哈希，直接拒）。对了清零输错计数。
   */
  async verify(username: unknown, password: unknown, source: string, now = Date.now()): Promise<VerifyResult> {
    if (this.throttled(source, now)) return { ok: false, reason: 'throttled' };
    const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const pw = typeof password === 'string' && password.length <= PASSWORD_MAX * 4 ? password : '';
    const row = USERNAME_RE.test(name)
      ? db.prepare('SELECT username, password_hash, must_change, locked_until FROM local_accounts WHERE username = ?').get(name) as Pick<Row, 'username' | 'password_hash' | 'must_change' | 'locked_until'> | undefined
      : undefined;
    if (!row) { await checkPassword(await this.dummyHash(), pw); this.noteSourceFail(source, now); return { ok: false, reason: 'invalid' }; }
    if (Number(row.locked_until) > now) { await checkPassword(await this.dummyHash(), pw); this.noteSourceFail(source, now); return { ok: false, reason: 'locked' }; }
    const good = pw !== '' && await checkPassword(row.password_hash, pw);
    if (!good) {
      this.noteSourceFail(source, now);
      // 计数到点就锁；锁的时候计数清零，解锁之后重新数
      db.prepare(`UPDATE local_accounts SET failed_count = CASE WHEN failed_count + 1 >= ? THEN 0 ELSE failed_count + 1 END,
        locked_until = CASE WHEN failed_count + 1 >= ? THEN ? ELSE locked_until END, updated_at = ? WHERE username = ?`).run(LOCK_AFTER, LOCK_AFTER, now + LOCK_MS, now, row.username);
      return { ok: false, reason: 'invalid' };
    }
    db.prepare('UPDATE local_accounts SET failed_count = 0, updated_at = ? WHERE username = ?').run(now, row.username);
    return { ok: true, username: row.username, mustChange: row.must_change === 1 };
  }

  /** 记下一次成功登录的时间（换出会话那一刻） */
  noteLogin(username: string, now = Date.now()): void {
    if (USERNAME_RE.test(username)) db.prepare('UPDATE local_accounts SET last_login_at = ? WHERE username = ?').run(now, username);
  }

  /** 设新密码（改密码、先改密码那一步）：合规才设，清掉要改密码和输错计数。不合规返回说明 */
  async setPassword(username: string, next: unknown, now = Date.now()): Promise<string | null> {
    const problem = passwordProblem(username, next);
    if (problem) return problem;
    const hash = await hashPassword(next as string);
    const up = db.prepare('UPDATE local_accounts SET password_hash = ?, must_change = 0, failed_count = 0, locked_until = 0, updated_at = ? WHERE username = ?').run(hash, now, username);
    return up.changes === 1 ? null : '没有这个账号';
  }

  private sweep(map: Map<string, { exp: number }>, now: number): void {
    for (const [k, v] of map) if (v.exp <= now) map.delete(k);
    while (map.size > ONE_TIME_MAX) map.delete(map.keys().next().value as string);
  }

  private issue(map: Map<string, { username: string; state: string; exp: number }>, username: string, state: string, ttl: number, now: number): string {
    this.sweep(map, now);
    const v = randomBytes(32).toString('base64url');
    map.set(sha(v), { username, state: sha(state), exp: now + ttl });
    return v;
  }

  private take(map: Map<string, { username: string; state: string; exp: number }>, value: unknown, state: unknown, now: number): string | null {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || typeof state !== 'string' || !state) return null;
    const key = sha(value), rec = map.get(key);
    if (!rec) return null;
    map.delete(key); // 用一次就作废，对不上也作废（不留给别人再试）
    return rec.exp > now && sameText(rec.state, sha(state)) ? rec.username : null;
  }

  /** 表单核对过了：发一个一次性码交给回调（60 秒、用一次、绑着这次的 state） */
  issueCode(username: string, state: string, now = Date.now()): string { return this.issue(this.codes, username, state, CODE_TTL_MS, now); }
  /** 回调拿码换用户名：过期、用过、state 对不上，都是 null */
  takeCode(code: unknown, state: unknown, now = Date.now()): string | null { return this.take(this.codes, code, state, now); }
  /** 临时密码对了、要先改密码：发一张改密码票（5 分钟、用一次、绑着这次的 state） */
  issueTicket(username: string, state: string, now = Date.now()): string { return this.issue(this.tickets, username, state, TICKET_TTL_MS, now); }
  takeTicket(ticket: unknown, state: unknown, now = Date.now()): string | null { return this.take(this.tickets, ticket, state, now); }
}
