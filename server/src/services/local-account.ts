/**
 * 站内账号（docs/local-accounts.md）：登录方式 local 背后的账号表。Cordis 服务 `localAccounts`。
 *
 * 只管账号本身：用户名、密码、要不要先改密码、输错计数和锁定，以及登录过程中的一次性码。
 * 账号对应哪个主体、停用与否、发会话，都不在这里：主体经外部身份（provider=local, external_id=用户名）连着，由主体服务和核心管。
 *
 * 密码：
 *   · 只存 scrypt 的结果（Node 自带，N=2^15、r=8、p=1、每个账号单独加盐、64 字节），连参数一起存（scrypt$N$r$p$盐$哈希），以后能升级参数；
 *   · 校验用定长比较；用户名不存在时拿一个假的哈希也算一次，「没这个人」和「密码不对」耗时相同；
 *   · 连续输错 LOCK_AFTER 次锁 LOCK_MS；同一来源一分钟内尝试 SOURCE_MAX 次（对了的不算），这个来源先歇一分钟（只在内存里，进程重启清零）。
 *   · 算哈希之前先占名额（admit）：这一次先记进来源的尝试数，再看三道「同时在算」的上限——同一来源 SOURCE_INFLIGHT_MAX（1）、
 *     同一用户名 1、全进程 HASH_INFLIGHT_MAX（scrypt 每次约 32MB、占一个 libuv 线程）。超了直接回 throttled，不进哈希。
 *     这样并发提交越不过按来源的限额，也占不满线程池；同一用户名同时只核一个，输错计数和锁定不会被并发绕过。
 *     名额只在内存里（单实例）；多实例要换成共用的存储时，接口不变。
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
/** 系统管理员重置过密码，多久之内放行业务授予时要提示（见 credentialSetBySystem） */
export const SYSTEM_CREDENTIAL_WINDOW_MS = 7 * 24 * 3_600_000;
/** 自己注册：同一来源一小时最多试这么多次（成功、失败都算，不让人拿注册去探哪些用户名占着） */
export const SIGNUP_WINDOW_MS = 60 * 60_000;
export const SIGNUP_MAX = 5;
/** 同一来源同时在算的核对个数（同一来源的登录排队一个一个核，每次约 110ms） */
export const SOURCE_INFLIGHT_MAX = 1;
/** 全进程同时在算的核对个数（libuv 线程池缺省 4 个线程，留一半给别的活） */
export const HASH_INFLIGHT_MAX = 2;
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

export type VerifyResult = { ok: true; username: string; mustChange: boolean } | { ok: false; reason: 'invalid' | 'locked' | 'throttled' | 'stale' };

export class LocalAccountService extends Service {
  /** 假哈希：用户名不存在时也算一次 scrypt，耗时和真核对一样 */
  private dummy: Promise<string> | null = null;
  private readonly sourceFails = new Map<string, number[]>();
  private readonly signups = new Map<string, number[]>();
  /** 同时在算的核对：按来源、按用户名、全进程 */
  private readonly inflightBySource = new Map<string, number>();
  private readonly inflightByName = new Set<string>();
  private inflight = 0;
  /** 进程起来以后同时在算的最多是几个（诊断、测试看「没超上限」） */
  private inflightPeak = 0;
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
  /** bySystem：建账号的是系统管理员（主体），记下来（见 credentialSetBySystem） */
  async create(input: { username: unknown; displayName?: unknown; bySystem?: string }, actor: string, now = Date.now()):
    Promise<{ ok: true; tempPassword: string; account: LocalAccountView } | { ok: false; reason: 'invalid' | 'taken'; message: string }> {
    const username = input.username;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return { ok: false, reason: 'invalid', message: '用户名只能用小写字母、数字和 . _ -，2～32 位，以字母或数字开头' };
    const displayName = displayNameOk(input.displayName);
    if (displayName === null) return { ok: false, reason: 'invalid', message: '显示名最多 64 个字，不能有控制字符' };
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    const ins = db.prepare(`INSERT INTO local_accounts (username, display_name, password_hash, must_change, failed_count, locked_until, created_at, created_by, updated_at, credential_by_system, credential_by_system_at)
      VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING`).run(username, displayName, hash, now, actor, now, input.bySystem ?? '', input.bySystem ? now : null);
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
    // 算哈希和登录核对共用「同时在算」的上限（同一来源 1、全进程 HASH_INFLIGHT_MAX）；占不上回 throttled，不进哈希
    const release = this.hashSlot(source);
    if (!release) return { ok: false, reason: 'throttled', message: '系统正忙，请稍后再试。' };
    let hash: string;
    try { hash = await hashPassword(input.password as string); } finally { release(); }
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
  /** bySystem：重置的是系统管理员（主体），记下来（见 credentialSetBySystem）；别人重置的清掉 */
  async resetPassword(username: string, now = Date.now(), bySystem = ''): Promise<string | null> {
    if (!this.get(username, now)) return null;
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    const up = db.prepare('UPDATE local_accounts SET password_hash = ?, must_change = 1, failed_count = 0, locked_until = 0, updated_at = ?, credential_by_system = ?, credential_by_system_at = ? WHERE username = ?').run(hash, now, bySystem, bySystem ? now : null, username);
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

  /** 退回先记的那一次尝试（核对对了、或者没进哈希就放弃了） */
  private refundSourceAttempt(source: string, at: number): void {
    const hits = this.sourceFails.get(source);
    const i = hits ? hits.lastIndexOf(at) : -1;
    if (hits && i >= 0) { hits.splice(i, 1); if (!hits.length) this.sourceFails.delete(source); }
  }

  /**
   * 算哈希之前先占名额：来源这一分钟的尝试数、三道「同时在算」的上限都过得去，才记下这一次、占上名额，返回放名额的函数；
   * 过不去返回 null（调用方直接回 throttled，不进哈希）。全是同步的：同一轮事件里并发进来的请求，先到的占上，后到的看得见
   */
  private admit(source: string, name: string, now: number): (() => void) | null {
    if (this.throttled(source, now)) return null;
    if ((this.inflightBySource.get(source) ?? 0) >= SOURCE_INFLIGHT_MAX) return null;
    if (name && this.inflightByName.has(name)) return null;
    if (this.inflight >= HASH_INFLIGHT_MAX) return null;
    this.noteSourceFail(source, now);
    this.inflightBySource.set(source, (this.inflightBySource.get(source) ?? 0) + 1);
    if (name) this.inflightByName.add(name);
    this.inflight++;
    this.inflightPeak = Math.max(this.inflightPeak, this.inflight);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.inflightBySource.get(source) ?? 1) - 1;
      if (n > 0) this.inflightBySource.set(source, n); else this.inflightBySource.delete(source);
      if (name) this.inflightByName.delete(name);
      this.inflight--;
    };
  }

  /** 核对的负载：现在同时在算几个、进程起来以后最多几个、上限是几 */
  hashLoad(): { inflight: number; peak: number; max: number; per_source: number } {
    return { inflight: this.inflight, peak: this.inflightPeak, max: HASH_INFLIGHT_MAX, per_source: SOURCE_INFLIGHT_MAX };
  }

  /** 只占「同时在算」的名额（同一来源、全进程），不记登录尝试：自己注册算哈希用。占不上返回 null */
  private hashSlot(source: string): (() => void) | null {
    if ((this.inflightBySource.get(source) ?? 0) >= SOURCE_INFLIGHT_MAX) return null;
    if (this.inflight >= HASH_INFLIGHT_MAX) return null;
    this.inflightBySource.set(source, (this.inflightBySource.get(source) ?? 0) + 1);
    this.inflight++;
    this.inflightPeak = Math.max(this.inflightPeak, this.inflight);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.inflightBySource.get(source) ?? 1) - 1;
      if (n > 0) this.inflightBySource.set(source, n); else this.inflightBySource.delete(source);
      this.inflight--;
    };
  }

  /**
   * 核对用户名和密码。没这个人、密码不对，都是 invalid，而且耗时一样；锁着的是 locked（也照样算一次哈希）；
   * 名额占不上（这个来源尝试太多、同时在算的超了上限）是 throttled（不算哈希，直接拒）。对了清零输错计数，先记的那次尝试退回。
   * claim：占上名额之后、算哈希之前调一次（站内表单拿它换掉一次性的 state）；返回 false 就放掉名额、退回尝试，回 stale，不算哈希。
   */
  async verify(username: unknown, password: unknown, source: string, now = Date.now(), opts: { claim?: () => boolean } = {}): Promise<VerifyResult> {
    const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const release = this.admit(source, USERNAME_RE.test(name) ? name : '', now);
    if (!release) return { ok: false, reason: 'throttled' };
    try {
      if (opts.claim && !opts.claim()) { this.refundSourceAttempt(source, now); return { ok: false, reason: 'stale' }; }
      const pw = typeof password === 'string' && password.length <= PASSWORD_MAX * 4 ? password : '';
      const row = USERNAME_RE.test(name)
        ? db.prepare('SELECT username, password_hash, must_change, locked_until FROM local_accounts WHERE username = ?').get(name) as Pick<Row, 'username' | 'password_hash' | 'must_change' | 'locked_until'> | undefined
        : undefined;
      if (!row) { await checkPassword(await this.dummyHash(), pw); return { ok: false, reason: 'invalid' }; }
      if (Number(row.locked_until) > now) { await checkPassword(await this.dummyHash(), pw); return { ok: false, reason: 'locked' }; }
      const good = pw !== '' && await checkPassword(row.password_hash, pw);
      if (!good) {
        // 计数到点就锁；锁的时候计数清零，解锁之后重新数
        const after = db.prepare(`UPDATE local_accounts SET failed_count = CASE WHEN failed_count + 1 >= ? THEN 0 ELSE failed_count + 1 END,
          locked_until = CASE WHEN failed_count + 1 >= ? THEN ? ELSE locked_until END, updated_at = ? WHERE username = ? RETURNING locked_until`).get(LOCK_AFTER, LOCK_AFTER, now + LOCK_MS, now, row.username) as { locked_until: number } | undefined;
        // 这一次把账号锁住了：记下是哪个来源（被人故意锁别人时查得到，docs/local-accounts.md 第 9 节）
        if (after && Number(after.locked_until) === now + LOCK_MS) console.log(JSON.stringify({ source: 'local-accounts', event: 'locked', username: row.username, from: source, until: new Date(now + LOCK_MS).toISOString(), at: new Date(now).toISOString() }));
        return { ok: false, reason: 'invalid' };
      }
      this.refundSourceAttempt(source, now);
      db.prepare('UPDATE local_accounts SET failed_count = 0, updated_at = ? WHERE username = ?').run(now, row.username);
      return { ok: true, username: row.username, mustChange: row.must_change === 1 };
    } finally {
      release();
    }
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
    // 改密码不清系统管理员那条记录：拿着临时密码的人（可能就是系统管理员自己）也能走这一步，分不出是不是本人
    const up = db.prepare('UPDATE local_accounts SET password_hash = ?, must_change = 0, failed_count = 0, locked_until = 0, updated_at = ? WHERE username = ?').run(hash, now, username);
    return up.changes === 1 ? null : '没有这个账号';
  }

  /**
   * 这个账号的凭据是不是系统管理员设的：账号是他建的（一直算），或者他在 SYSTEM_CREDENTIAL_WINDOW_MS（7 天）内重置过密码。是就回谁、什么时候、哪一种，不是回 null。
   * 之后改过密码也照样算：拿着临时密码的人（可能就是系统管理员自己）也能改，分不出是不是本人；完整管理员再重置一次才清掉。
   * 放行给业务数据的授予时据此提示放行人、要他确认（docs/local-accounts.md 第 5 节）：系统管理员可能知道这份凭据，放行后能借这个账号看业务
   */
  credentialSetBySystem(username: string, now = Date.now()): { by: string; at: number; kind: 'create' | 'reset' } | null {
    if (!USERNAME_RE.test(username)) return null;
    const r = db.prepare('SELECT credential_by_system AS by, credential_by_system_at AS at, created_at FROM local_accounts WHERE username = ?').get(username) as { by: string; at: number | null; created_at: number } | undefined;
    if (!r || !r.by) return null;
    const at = Number(r.at ?? 0), kind = at === Number(r.created_at) ? 'create' : 'reset';
    return kind === 'create' || now - at < SYSTEM_CREDENTIAL_WINDOW_MS ? { by: r.by, at, kind } : null;
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
