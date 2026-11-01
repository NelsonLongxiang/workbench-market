/** 凭据库板块（融合 dsh-vault@1.10.75）：REST 面 /api/vault/*。
 *  存储层原样复用上游（server/src/vault/，AES-256-GCM + scrypt，磁盘格式不变）。
 *  缺省库文件是市场自己的 DATA_DIR/vault/default.json。WM_VAULT_PATH 可指向 DSH 插件那份（$DSH_HOME/vault/default.json），
 *  但上游插件进程常驻一份内存库、写盘前不重读文件：两边同时写会互相覆盖（丢更新），所以不做缺省，页面会提示。
 *  安全口径：
 *    - 每个路由（**读也算**）都过 guard：浏览器只认控制面 + 口令；业务面一律 403（业务面跑着 /go/ 外站与 SOP 同源内容）。
 *    - 列表/回收站/健康报告只回无密摘要（自定义字段只给键名）；完整条目只在 GET /entries/:id 显式读取，且记入库内审计。
 *    - 主密码只在进程内存：解锁后闲置 WM_VAULT_IDLE_MIN 分钟（缺省 15）由定时器主动上锁；取验证码不算活动。
 *      环境变量 DSH_VAULT_PASSWORD 存在时按需自动解锁、不闲置上锁。
 *    - 解锁/上锁/重开串行执行；文件被别的进程改过就先重开再读写；重开不删别人正持有的写锁。
 *    - 新建库的主密码过 vault-policy 门槛（长度/全数字/常见口令/弱），不过就拒、不落盘；已有库照常解锁，只回 weak_master 提示。 */
import type express from 'express';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './db.ts';
import { defaultVaultPath, openVault, type VaultEntry, type VaultEntryPatch, type VaultEntrySummary, type VaultStore } from './vault/store.ts';
import { parseTotpSecret, totp } from './vault/totp.ts';
import { generatePassphrase, generatePassword } from './vault/password.ts';
import { estimateStrength } from './vault/password-strength.ts';
import { checkMasterPassword, COMMON_PASSWORD_COUNT, MASTER_POLICY } from './vault-policy/policy.ts';

export const VAULT_UPSTREAM = 'dsh-vault@1.10.75';
const KINDS = ['login', 'ssh', 'api-key', 'secret', 'oauth', 'cookie', 'card', 'custom'] as const;
/** 页面可编辑的字段（cookies/attachments/passwordHistory 等走 DSH 工具，不经页面改） */
const EDITABLE = ['title', 'kind', 'username', 'email', 'phone', 'password', 'host', 'port', 'privateKey', 'apiKey', 'secret',
  'accessToken', 'refreshToken', 'expiresAt', 'otpSecret', 'cardNumber', 'cardExpiry', 'cardCvv', 'cardHolder', 'url', 'notes',
  'tags', 'favorite', 'sensitivity', 'rotationDays', 'icon', 'fields'] as const;

type Guard = (req: express.Request, res: express.Response) => boolean;

class VaultHttpError extends Error {
  status: number;
  code?: string;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

/** 新建库前的门槛：不过就抛 400，调用方此时还没碰磁盘 */
function assertNewMaster(password: string, who: string): void {
  const c = checkMasterPassword(password);
  if (!c.ok) throw new VaultHttpError(400, `${who}不满足新建库要求：${c.reasons.join('；')}`, 'vault_weak_master', { reasons: c.reasons, strength: { score: c.strength.score, verdict: c.strength.verdict } });
}

function idleMs(): number {
  const n = Number(process.env.WM_VAULT_IDLE_MIN ?? 15);
  return (Number.isFinite(n) && n >= 0 ? n : 15) * 60_000;
}

export function vaultPath(): string {
  return process.env.WM_VAULT_PATH?.trim() || join(dataDir, 'vault', 'default.json');
}

/** weak：主密码按新标准不达标的原因（旧库照常能开，只提示；空 = 达标） */
interface Open { store: VaultStore; password: string; fromEnv: boolean; mtimeMs: number; size: number; lastUsed: number; weak: string[] }
let open: Open | null = null;
let failures = 0;
let blockedUntil = 0;

/** 状态切换（解锁/上锁/重开/闲置上锁）一律串行：否则「重开中途有人点锁定」会把库又打开，并发解锁也能绕过限流 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function fileSig(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try { const s = await stat(path); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; }
}

async function doOpen(password: string, fromEnv: boolean): Promise<Open> {
  const path = vaultPath();
  // clearStaleLock:false —— 运行中重开不能删 DSH 插件等别的进程正持有的 <file>.lock
  const store = await openVault({ masterPassword: password, path, clearStaleLock: false });
  const sig = await fileSig(path);
  return { store, password, fromEnv, mtimeMs: sig?.mtimeMs ?? 0, size: sig?.size ?? 0, lastUsed: Date.now(), weak: checkMasterPassword(password).reasons };
}

/** 换下旧实例时把它的派生密钥清零（lock 会先落审计，再由新实例读入） */
async function retire(o: Open | null): Promise<void> {
  if (o) await o.store.lock().catch(() => {});
}

function idleExpired(o: Open | null): boolean {
  const idle = idleMs();
  return !!o && !o.fromEnv && idle > 0 && Date.now() - o.lastUsed > idle;
}

const lockNow = () => serial(async () => { const cur = open; open = null; await retire(cur); });

/** 主动闲置上锁：不等下一次请求（没人来时主密码与明文条目也不能一直留在内存） */
setInterval(() => { if (idleExpired(open)) void serial(async () => { if (idleExpired(open)) { const cur = open; open = null; await retire(cur); } }); }, Math.max(1000, Math.min(30_000, idleMs() / 4 || 30_000))).unref();

/** 取已解锁的库；闲置超时先上锁；文件被外部改过就重开。touch=false：取验证码这类被动轮询不算活动 */
function unlocked(touch = true): Promise<Open> {
  return serial(async () => {
    if (idleExpired(open)) { const cur = open; open = null; await retire(cur); }
    if (!open) {
      const envPw = process.env.DSH_VAULT_PASSWORD;
      if (!envPw) throw new VaultHttpError(423, '凭据库已锁定，请先输入主密码解锁', 'vault_locked');
      if (!(await fileSig(vaultPath()))) assertNewMaster(envPw, 'DSH_VAULT_PASSWORD ');
      open = await doOpen(envPw, true);
    }
    const sig = await fileSig(vaultPath());
    if (sig && (sig.mtimeMs !== open.mtimeMs || sig.size !== open.size)) {
      const cur = open;
      await retire(cur);
      open = await doOpen(cur.password, cur.fromEnv);
    }
    if (touch) open.lastUsed = Date.now();
    return open;
  });
}

/** 写完把签名同步成自己写出的那份，避免下次请求把自己的写当成外部改动而白重开一次 */
async function afterWrite(o: Open): Promise<void> {
  const sig = await fileSig(vaultPath());
  if (sig) { o.mtimeMs = sig.mtimeMs; o.size = sig.size; }
}

/** 摘要出口：上游摘要会带自定义字段的值（用户可能把 PIN/恢复码放在里面），这里只给键名 */
function summaryOut<T extends VaultEntrySummary>(r: T): Omit<T, 'fields'> & { fieldKeys?: string[] } {
  const { fields, ...rest } = r;
  return fields && Object.keys(fields).length ? { ...rest, fieldKeys: Object.keys(fields) } : rest;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const totpAudited = new Map<string, number>();

/** 列表行：与上游 search 摘要同口径，再补回收站时间；不含任何密钥 */
function trashRow(e: VaultEntry) {
  return { id: e.id, title: e.title, kind: e.kind, username: e.username, email: e.email, host: e.host, url: e.url, tags: e.tags, deletedAt: e.deletedAt, updatedAt: e.updatedAt };
}

/** 完整条目出口：附件只给文件名与大小、Cookie 只给数量、历史密码只给条数——这些大块/旧值走 DSH 工具取 */
function entryOut(e: VaultEntry) {
  const { attachments, cookies, passwordHistory, ...rest } = e;
  return {
    ...rest,
    attachments: attachments ? Object.entries(attachments).map(([name, a]) => ({ name, size: (a as { size?: number }).size ?? null })) : undefined,
    cookieCount: Array.isArray(cookies) ? cookies.length : undefined,
    passwordHistoryCount: passwordHistory?.length ?? 0,
  };
}

function pickPatch(body: unknown, creating: boolean): VaultEntryPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VaultHttpError(400, '请求体须为 JSON 对象');
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE) if (k in src) out[k] = src[k];
  const unknownKeys = Object.keys(src).filter((k) => !(EDITABLE as readonly string[]).includes(k));
  if (unknownKeys.length) throw new VaultHttpError(400, `不支持的字段：${unknownKeys.join(', ')}`);
  if (creating && (typeof out.title !== 'string' || !out.title.trim())) throw new VaultHttpError(400, 'title 必填');
  if (out.kind !== undefined && out.kind !== '' && !(KINDS as readonly string[]).includes(String(out.kind))) throw new VaultHttpError(400, `kind 只能是 ${KINDS.join('/')}`);
  if (typeof out.otpSecret === 'string' && out.otpSecret.trim()) {
    // 上游 parseTotpSecret 不校验裸 Base32，totp() 会真解码一次
    try { totp(out.otpSecret); } catch { throw new VaultHttpError(400, 'otpSecret 不是有效的 Base32 或 otpauth:// URI'); }
  }
  return out as VaultEntryPatch;
}

function totpPeriod(secret: string): number {
  try { return parseTotpSecret(secret).periodSeconds || 30; } catch { return 30; }
}

export function mountVault(app: express.Express, guard: Guard): void {
  const route = (method: 'get' | 'post' | 'put' | 'delete', path: string, fn: (req: express.Request, res: express.Response) => Promise<unknown>) => {
    app[method](path, (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!guard(req, res)) return;
      fn(req, res).then((body) => { if (!res.headersSent) res.json(body); }).catch((e: unknown) => {
        if (e instanceof VaultHttpError) return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra });
        const msg = String((e as Error)?.message ?? e);
        // 写失败时内存可能已改、磁盘没改：强制下次从磁盘重开，丢掉这次没落盘的改动
        if (method !== 'get' && open) open.mtimeMs = -1;
        if (/timed out waiting for the writer lock/.test(msg)) {
          return res.status(503).json({ error: `库文件正被其他进程写入（${vaultPath()}.lock），请稍后重试；若确认没有进程在写，可手动删除该锁文件`, code: 'vault_busy' });
        }
        // 上游 validatePatchTypes / title 校验抛的是普通 Error：按 400 回，不当 500
        if (/^vault[:\s]/i.test(msg)) return res.status(400).json({ error: msg });
        next(e);
      });
    });
  };

  route('get', '/api/vault/status', async () => {
    const path = vaultPath();
    const sig = await fileSig(path);
    const idle = idleMs();
    if (idleExpired(open)) await lockNow();
    return {
      upstream: VAULT_UPSTREAM,
      path,
      shared_with_dsh: path === defaultVaultPath('default'),
      exists: sig !== null,
      unlocked: open !== null,
      env_password: Boolean(process.env.DSH_VAULT_PASSWORD),
      idle_lock_minutes: idle / 60_000,
      count: open ? open.store.list().length : null,
      weak_master: open ? open.weak.length > 0 : null,
      weak_reasons: open?.weak ?? [],
      master_policy: { min_length: MASTER_POLICY.minLength, common_list: COMMON_PASSWORD_COUNT },
    };
  });

  route('post', '/api/vault/unlock', async (req) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password) throw new VaultHttpError(400, '请输入主密码');
    return serial(async () => {
      if (Date.now() < blockedUntil) throw new VaultHttpError(429, `尝试过多，请 ${Math.ceil((blockedUntil - Date.now()) / 1000)} 秒后再试`);
      if (!(await fileSig(vaultPath()))) assertNewMaster(password, '主密码'); // 库还不存在 = 这次是新建
      let next: Open;
      try {
        next = await doOpen(password, false);
      } catch (e) {
        if (/incorrect/.test(String((e as Error).message))) {
          failures++;
          if (failures >= 5) { blockedUntil = Date.now() + 30_000; failures = 0; }
          throw new VaultHttpError(401, '主密码不正确', 'vault_bad_password'); // 已解锁的会话不受影响
        }
        throw e;
      }
      failures = 0;
      const cur = open;
      open = next;
      await retire(cur);
      return { unlocked: true, count: next.store.list().length, weak_master: next.weak.length > 0, weak_reasons: next.weak };
    });
  });

  route('post', '/api/vault/lock', async () => { await lockNow(); return { unlocked: false }; });

  route('get', '/api/vault/entries', async (req) => {
    const o = await unlocked();
    const q = String(req.query.q ?? '');
    const kind = String(req.query.kind ?? '');
    const tag = String(req.query.tag ?? '');
    let rows = o.store.search(q, 10_000);
    if (kind) rows = rows.filter((r) => (r.kind ?? 'login') === kind);
    if (tag) rows = rows.filter((r) => r.tags?.includes(tag));
    const stats = o.store.stats();
    return { entries: rows.map(summaryOut), stats: { total: stats.total, byKind: stats.byKind, byTag: stats.byTag, withTotp: stats.withTotp, trashCount: stats.trashCount, favoriteCount: stats.favoriteCount, expired: stats.expired } };
  });

  route('get', '/api/vault/entries/:id', async (req) => {
    const o = await unlocked();
    const e = o.store.get(req.params.id);
    if (!e) throw new VaultHttpError(404, '条目不存在');
    o.store.audit('read', e.id, e.title);
    return entryOut(e);
  });

  route('post', '/api/vault/entries', async (req, res) => {
    const o = await unlocked();
    const e = await o.store.add(pickPatch(req.body, true) as VaultEntryPatch & { title: string });
    await afterWrite(o);
    res.status(201);
    return entryOut(e);
  });

  route('put', '/api/vault/entries/:id', async (req) => {
    const o = await unlocked();
    const e = await o.store.update(req.params.id, pickPatch(req.body, false));
    if (!e) throw new VaultHttpError(404, '条目不存在');
    await afterWrite(o);
    return entryOut(e);
  });

  route('delete', '/api/vault/entries/:id', async (req) => {
    const o = await unlocked();
    if (!(await o.store.delete(req.params.id))) throw new VaultHttpError(404, '条目不存在或已在回收站');
    await afterWrite(o);
    return { ok: true, trashed: true };
  });

  route('get', '/api/vault/trash', async () => {
    const o = await unlocked();
    return o.store.listTrash().map(trashRow).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  });

  route('post', '/api/vault/trash/:id/restore', async (req) => {
    const o = await unlocked();
    if (!(await o.store.restore(req.params.id))) throw new VaultHttpError(404, '回收站里没有这个条目');
    await afterWrite(o);
    return { ok: true };
  });

  /** 永久删除只对回收站里的条目开放（先软删、再清除，两步才能真删） */
  route('delete', '/api/vault/trash/:id', async (req) => {
    const o = await unlocked();
    const e = o.store.getIncludingTrash(req.params.id);
    if (!e || e.deletedAt === undefined) throw new VaultHttpError(404, '回收站里没有这个条目');
    await o.store.purge(e.id);
    await afterWrite(o);
    return { ok: true, purged: true };
  });

  route('get', '/api/vault/entries/:id/totp', async (req) => {
    const o = await unlocked(false);
    const e = o.store.get(req.params.id);
    if (!e?.otpSecret) throw new VaultHttpError(404, '该条目没有 TOTP 密钥');
    // 详情抽屉每 30 秒自动刷新一次：同一条目 10 分钟内只记一次，免得挤掉审计里的真实事件（上限 600 条）
    if (Date.now() - (totpAudited.get(e.id) ?? 0) > 600_000) { totpAudited.set(e.id, Date.now()); o.store.audit('totp', e.id, e.title); }
    const period = totpPeriod(e.otpSecret);
    const now = Date.now();
    return { code: totp(e.otpSecret, now), period, remaining: period - (Math.floor(now / 1000) % period) };
  });

  /** 生成与评估不碰库：不需解锁（仍要口令） */
  route('post', '/api/vault/generate', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const password = b.passphrase
      ? generatePassphrase({ words: clampInt(b.words, 2, 12, 4), separator: typeof b.separator === 'string' && b.separator ? b.separator.slice(0, 3) : undefined })
      : generatePassword({
          length: clampInt(b.length, 8, 128, 20),
          symbols: b.symbols === undefined ? undefined : Boolean(b.symbols),
          digits: b.digits === undefined ? undefined : Boolean(b.digits),
          excludeAmbiguous: b.excludeAmbiguous === undefined ? undefined : Boolean(b.excludeAmbiguous),
        });
    return { password, strength: estimateStrength(password) };
  });

  route('post', '/api/vault/strength', async (req) => {
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 1024) : '';
    return estimateStrength(password);
  });

  /** 新建库页面的实时校验：和 unlock 用同一个门槛 */
  route('post', '/api/vault/master-check', async (req) => {
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 1024) : '';
    const c = checkMasterPassword(password);
    return { ok: c.ok, reasons: c.reasons, strength: c.strength };
  });

  /** 健康报告：上游 health().reused 带着被复用的明文值——这里去掉，只回哪些条目在复用 */
  route('get', '/api/vault/health', async () => {
    const o = await unlocked();
    const h = o.store.health();
    return {
      ...h,
      weak: h.weak.map(summaryOut), no2fa: h.no2fa.map(summaryOut), httpSites: h.httpSites.map(summaryOut),
      reused: h.reused.map((r) => ({ count: r.entries.length, entries: r.entries.map(summaryOut) })),
      rotation: o.store.rotationReport().map(summaryOut),
    };
  });

  route('get', '/api/vault/history', async () => {
    const o = await unlocked();
    return o.store.getHistory().slice(0, 200); // 上游已是新→旧
  });
}
