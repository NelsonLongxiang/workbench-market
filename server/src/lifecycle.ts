/**
 * 生命周期待办与审批（lifecycle-os · ygl-trees lc 插件）：工作台作为 lc 断言签发入口 `workbench`。
 *
 * - 身份：浏览器带来的 Odoo session_id（SSO v1：Odoo 与市场同主机名，cookie 跨端口共享）→ 服务端调
 *   LC_ODOO_URL 的 /web/session/get_session_info 取登录名；只为人签：sub = user:<Odoo 登录名>。
 *   Odoo 地址只认环境变量——注册表里的 Odoo 类台可经 MCP workbench_register 登记，不能当身份源。
 * - 断言：与 lifecycle-os tools/assert.cjs、plugins/ygl-lc 同一契约（逻辑复制，不跨仓 import）：
 *   base64url(声明 JSON) + "." + base64url(ed25519 签名)；每次 lc 调用现签一张，绑定这一次请求（动作 + 全部旗标），
 *   插件首次出示即作废（含被拒、用法错误、noop）。
 * - 私钥只从 LC_WORKBENCH_KEY_FILE 读：绝对路径、在仓库外、权限 600；公钥由属主登记进 lifecycle-os decl/identity.yaml。
 * - 调用：node "$LC_YGL_BIN" lc <动作> --旗标 值…，子进程环境只给 YGL_HOME/YGL_SESSION=lc-proto/LC_ASSERTION
 *   （不透传 LC_ACTOR 等自报身份）；引擎钉 0.116.1。LC_TEST/LC_IDENTITY_FILE 仅在本进程 LC_TEST=1 时透传（端到端测试用）。
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { odooSessionOf } from './odoo-session.ts';
import type { TaskEnvelope, SourceMeta } from './tasks.ts';

export const LC_ISSUER = 'workbench';
export const LC_ENGINE_PIN = '0.116.1';
export const LC_TTL_S = 300;
const LC_TTL_MAX_S = 600; // decl/identity.yaml assertion_ttl
const LC_SESSION = 'lc-proto';
const COMMON_FLAGS = ['trace-id', 'json'];
const SPKI_ED25519_LEN = 12;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_KEYS = ['LC_YGL_BIN', 'LC_YGL_HOME', 'LC_WORKBENCH_KEY_FILE', 'LC_ODOO_URL'] as const;
const RUNTIME_HOME = resolve(homedir(), '.ygl-trees-lc'); // decl/identity.yaml runtime_homes

export type LcFlags = Record<string, string | true>;
export interface LcEnvelope {
  status: string;
  data: any;
  checks: unknown[];
  error: { code: string; message: string; hint?: string | null; retryable?: boolean } | null;
  trace_id: string | null;
  next: string[];
}
export interface LcSourceMeta extends SourceMeta { viewer: string | null; error?: string }
export interface Viewer { login: string; uid: number; sub: string }
type Result = { http: number; body: Record<string, unknown> };

// ---------- 断言契约（与插件逐字节一致） ----------

/** req = sha256hex(JSON.stringify([动作, 旗标按名排序（kebab 名、字符串值，不含 trace-id/json）])) */
export function lcReqHash(action: string, flags: LcFlags): string {
  const canon = JSON.stringify([action, Object.entries(flags || {}).filter(([k]) => !COMMON_FLAGS.includes(k)).map(([k, v]) => [k, String(v)]).sort()]);
  return createHash('sha256').update(canon).digest('hex');
}

/** 为一次具体请求签断言（iss 固定 workbench；只签人：sub 必须 user:<登录名>） */
export function signLcAssertion(key: KeyObject | string, o: { sub: string; action: string; flags: LcFlags; ttl?: number; now?: number; nonce?: string }): string {
  const ttl = o.ttl ?? LC_TTL_S;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > LC_TTL_MAX_S) throw new Error(`断言有效期须为 1–${LC_TTL_MAX_S} 秒`);
  if (!/^user:/.test(o.sub) || !loginOk(o.sub.slice(5))) throw new Error(`工作台只为人签断言（sub 须 user:<登录名>）：${o.sub}`);
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? randomBytes(16).toString('hex');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error('nonce 须为 16–64 位 [A-Za-z0-9_-]');
  const p64 = Buffer.from(JSON.stringify({ iss: LC_ISSUER, sub: o.sub, aud: 'lc', req: lcReqHash(o.action, o.flags), iat: now, exp: now + ttl, nonce })).toString('base64url');
  return `${p64}.${edSign(null, Buffer.from(p64), key).toString('base64url')}`;
}

function loginOk(login: string): boolean {
  return login.length > 0 && login.length <= 128 && login === login.trim() && !/[\x00-\x1f\x7f]/.test(login);
}

/** 旗标 → lc 命令行（--k v；不带值的旗标为 true）。值不许以 - 开头：插件解析会把它当成下一个旗标，签的请求就对不上 */
export function lcArgv(action: string, flags: LcFlags): string[] {
  if (!/^[a-z][a-z-]{0,31}$/.test(action)) throw new Error(`lc 动作非法：${action}`);
  const out = ['lc', action];
  for (const [k, v] of Object.entries(flags)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(k) || COMMON_FLAGS.includes(k)) throw new Error(`lc 旗标名非法：${k}`);
    if (v === true) { out.push(`--${k}`); continue; }
    if (typeof v !== 'string' || v === '' || v.startsWith('-') || v.length > 512 || /[\x00-\x1f\x7f]/.test(v)) throw new Error(`lc 旗标 --${k} 的值非法`);
    out.push(`--${k}`, v);
  }
  return out;
}

// ---------- 配置与私钥 ----------

export function lifecycleConfigured(): boolean {
  return ENV_KEYS.some((k) => String(process.env[k] ?? '').trim() !== '');
}

function lcConfig(): { bin: string; home: string; keyFile: string; odooUrl: string; missing: string[]; problem: string | null } {
  const v = (k: string) => String(process.env[k] ?? '').trim();
  const cfg = { bin: v('LC_YGL_BIN'), home: v('LC_YGL_HOME'), keyFile: v('LC_WORKBENCH_KEY_FILE'), odooUrl: v('LC_ODOO_URL').replace(/\/+$/, ''), missing: ENV_KEYS.filter((k) => !v(k)) };
  let problem: string | null = null;
  if (cfg.missing.length) problem = `生命周期源未配置：缺 ${cfg.missing.join('、')}`;
  else if (!isAbsolute(cfg.home)) problem = 'LC_YGL_HOME 须为绝对路径';
  else if (process.env.LC_TEST === '1' && inside(resolve(cfg.home), RUNTIME_HOME)) problem = 'LC_TEST=1 不能指向运行工作区 ~/.ygl-trees-lc（测试模式只用于全新测试工作区）';
  return { ...cfg, problem };
}

/** 启动自检：配置了生命周期源却不可用时给出原因（index.ts 启动时打印） */
export function lifecycleConfigProblem(): string | null {
  return lifecycleConfigured() ? lcConfig().problem : null;
}

const inside = (p: string, root: string) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
let keyCache: { file: string; mtimeMs: number; key: KeyObject; pubkey: string } | null = null;

/** 读签发私钥：绝对路径、仓库外（含软链目标）、权限 600、ed25519；按 mtime 缓存 */
export function loadIssuerKey(file: string, repoRoot = REPO_ROOT): { key: KeyObject; pubkey: string } {
  if (!file || !isAbsolute(file)) throw new Error('LC_WORKBENCH_KEY_FILE 须为绝对路径');
  const real = realpathSync(file);
  if (inside(resolve(file), repoRoot) || inside(real, realpathSync(repoRoot))) throw new Error('签发私钥不得放在仓库内');
  const st = statSync(real);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error(`签发私钥权限须为 600（当前 ${(st.mode & 0o777).toString(8)}）`);
  if (keyCache && keyCache.file === real && keyCache.mtimeMs === st.mtimeMs) return keyCache;
  const key = createPrivateKey(readFileSync(real, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('签发私钥须为 ed25519');
  const pubkey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(SPKI_ED25519_LEN).toString('hex');
  keyCache = { file: real, mtimeMs: st.mtimeMs, key, pubkey };
  return keyCache;
}

// ---------- 引擎调用 ----------

/** 子进程环境白名单：不继承本进程的 LC_ACTOR/LC_CLOCK 等，只给运行所需与本次断言 */
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { YGL_NO_UPDATE_CHECK: '1', ...extra };
  for (const k of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (process.env[k]) env[k] = process.env[k];
  return env;
}
function lcEnv(home: string, assertion: string): NodeJS.ProcessEnv {
  const env = childEnv({ YGL_HOME: home, YGL_SESSION: LC_SESSION, LC_ASSERTION: assertion });
  if (process.env.LC_TEST === '1') {
    env.LC_TEST = '1';
    if (process.env.LC_IDENTITY_FILE) env.LC_IDENTITY_FILE = process.env.LC_IDENTITY_FILE;
  }
  return env;
}

let pinCache: { id: string; version: string } | null = null;
/** 引擎版本：按真实路径 + 大小 + mtime 缓存——LC_YGL_BIN 指向的文件被换掉就重新核对钉版 */
function engineVersion(bin: string): Promise<string> {
  let id: string;
  try { const real = realpathSync(bin); const st = statSync(real); id = `${real}|${st.size}|${st.mtimeMs}`; } catch { return Promise.resolve('unknown'); }
  if (pinCache?.id === id) return Promise.resolve(pinCache.version);
  return new Promise((done) => {
    execFile(process.execPath, [bin, '--version'], { env: childEnv(), timeout: 10_000, windowsHide: true }, (err, stdout) => {
      const version = err ? 'unknown' : ((String(stdout).trim().split('\n')[0] ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown');
      if (!err) pinCache = { id, version };
      done(version);
    });
  });
}

/** 跑一次 lc：返回退出码与最后一行 JSON 信封（rc 2 用法错误也带信封） */
export function runLc(cfg: { bin: string; home: string }, action: string, flags: LcFlags, assertion: string): Promise<{ rc: number | null; envelope: LcEnvelope | null; ms: number }> {
  const argv = lcArgv(action, flags);
  const t0 = Date.now();
  return new Promise((done) => {
    execFile(process.execPath, [cfg.bin, ...argv], { env: lcEnv(cfg.home, assertion), timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const code = (err as { code?: unknown } | null)?.code;
      const rc = err ? (typeof code === 'number' ? code : null) : 0; // 超时被杀 → null
      let envelope: LcEnvelope | null = null;
      try {
        const last = String(stdout).trim().split('\n').pop() ?? '';
        const j = JSON.parse(last);
        if (j && typeof j.status === 'string') envelope = j;
      } catch { /* 无信封 */ }
      done({ rc, envelope, ms: Date.now() - t0 });
    });
  });
}

/** 为 viewer 的这一次请求现签断言并调 lc（配置/引擎/私钥任何一项不对都不调） */
async function signedLc(viewer: Viewer, action: string, flags: LcFlags): Promise<{ ok: true; rc: number | null; envelope: LcEnvelope | null; ms: number } | { ok: false; error: string }> {
  const cfg = lcConfig();
  if (cfg.problem) return { ok: false, error: cfg.problem };
  const version = await engineVersion(cfg.bin);
  if (version !== LC_ENGINE_PIN) return { ok: false, error: `ygl-trees 引擎版本 ${version} ≠ 钉版 ${LC_ENGINE_PIN}` };
  let key: KeyObject;
  try { key = loadIssuerKey(cfg.keyFile).key; } catch (e) { return { ok: false, error: `签发私钥不可用：${(e as Error).message}` }; }
  const assertion = signLcAssertion(key, { sub: viewer.sub, action, flags });
  return { ok: true, ...(await runLc(cfg, action, flags, assertion)) };
}

// ---------- Odoo 身份 ----------

/** 用浏览器的 Odoo session_id 向 LC_ODOO_URL 现查登录名（每次都查：Odoo 侧注销即刻生效） */
export async function resolveOdooViewer(cookieHeader: string, odooUrl = lcConfig().odooUrl): Promise<{ ok: true; viewer: Viewer } | { ok: false; http: number; error: string }> {
  if (!odooUrl) return { ok: false, http: 503, error: '未配置 LC_ODOO_URL' };
  const sid = odooSessionOf(cookieHeader);
  if (!sid) return { ok: false, http: 401, error: '未登录 Odoo（请先经门户 Odoo 单点登录）' };
  if (!/^[A-Za-z0-9_.=-]{16,512}$/.test(sid)) return { ok: false, http: 401, error: 'Odoo 会话格式不对' };
  let j: any;
  try {
    const r = await fetch(`${odooUrl}/web/session/get_session_info`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json', Cookie: `session_id=${sid}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
    });
    if (!r.ok) return { ok: false, http: 401, error: `Odoo 会话无效（HTTP ${r.status}）` };
    j = await r.json();
  } catch (e) {
    return { ok: false, http: 502, error: `Odoo 不可达：${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  const info = j?.result;
  const login = typeof info?.username === 'string' ? info.username : '';
  if (j?.error || !info?.uid || !login) return { ok: false, http: 401, error: 'Odoo 会话已失效，请重新登录' };
  if (!loginOk(login)) return { ok: false, http: 401, error: 'Odoo 登录名不可用作 lc 主体' };
  return { ok: true, viewer: { login, uid: Number(info.uid), sub: `user:${login}` } };
}

// ---------- 统一待办：生命周期源 ----------

const INBOX_TTL_MS = 30_000; // 与统一待办同口径；每次实际调 lc 都现签断言，缓存只省调用
const inboxCache = new Map<string, { at: number; tasks: TaskEnvelope[]; meta: LcSourceMeta }>();

function toEnvelope(it: any): TaskEnvelope | null {
  const pid = typeof it?.proposal_id === 'string' ? it.proposal_id : '';
  const grant = typeof it?.grant === 'string' ? it.grant : '';
  if (!pid || !grant) return null;
  return {
    id: `lifecycle:${pid}`, source: 'lifecycle',
    title: `${it.machine ?? ''} ${it.object ?? ''}：${it.from ?? ''} → ${it.to ?? ''}（${Number(it.approvals) || 0}/${Number(it.levels) || 1} 级）`,
    status: 'todo', due: null, link: null, project: typeof it.domain === 'string' ? it.domain : null,
    lc: {
      proposal_id: pid, grant, object: String(it.object ?? ''), machine: String(it.machine ?? ''), from: String(it.from ?? ''), to: String(it.to ?? ''),
      effective_at: it.effective_at ?? null, proposed_by: String(it.proposed_by ?? ''), approvals: Number(it.approvals) || 0, levels: Number(it.levels) || 1,
    },
  };
}

/** 按查看人列 lc inbox（未登录/未配置/引擎失败 → ok=false 降级，不阻塞其它源） */
export async function lifecycleSourceFor(cookieHeader: string): Promise<{ meta: LcSourceMeta; tasks: TaskEnvelope[] }> {
  const t0 = Date.now();
  const fail = (error: string, viewer: string | null = null) => ({ meta: { ok: false, count: 0, latency_ms: Date.now() - t0, viewer, error }, tasks: [] });
  const cfg = lcConfig();
  if (cfg.problem) return fail(cfg.problem);
  const who = await resolveOdooViewer(cookieHeader, cfg.odooUrl);
  if (!who.ok) return fail(who.error);
  const hit = inboxCache.get(who.viewer.sub);
  if (hit && Date.now() - hit.at < INBOX_TTL_MS) return { meta: hit.meta, tasks: hit.tasks };
  const r = await signedLc(who.viewer, 'inbox', {});
  if (!r.ok) return fail(r.error, who.viewer.sub);
  if (r.envelope?.status !== 'applied') return fail(`lc inbox ${r.envelope ? `${r.envelope.status}：${r.envelope.error?.code ?? ''} ${r.envelope.error?.message ?? ''}` : `无信封（rc ${r.rc}）`}`.trim(), who.viewer.sub);
  const items: unknown[] = Array.isArray(r.envelope.data?.items) ? r.envelope.data.items : [];
  const tasks = items.map(toEnvelope).filter((t): t is TaskEnvelope => t !== null);
  const meta: LcSourceMeta = { ok: true, count: tasks.length, latency_ms: Date.now() - t0, viewer: who.viewer.sub };
  inboxCache.set(who.viewer.sub, { at: Date.now(), tasks, meta });
  return { meta, tasks };
}

// ---------- 审批 ----------

/** 审批写面的请求门：只接工作台页面同源发起的 JSON 请求（门户 /go/ 下的台与本站同源，靠这道门挡不住——见交付说明） */
export function lcWriteGuard(h: Record<string, string | string[] | undefined>): string | null {
  if (String(h['x-wm-lifecycle'] ?? '') !== '1') return '缺少 X-WM-Lifecycle 头（只接受工作台页面发起的审批）';
  if (!/^application\/json\b/i.test(String(h['content-type'] ?? ''))) return '审批请求须为 application/json';
  const site = String(h['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin') return `跨站审批被拒（Sec-Fetch-Site=${site}）`;
  if (h.origin !== undefined) {
    const origin = String(h.origin);
    try { if (origin === 'null' || new URL(origin).host !== String(h.host ?? '')) return '跨源审批被拒'; } catch { return 'Origin 非法'; }
  }
  return null;
}

/** Same-origin portal/SOP scripts can impersonate a click: HTTP approval is unavailable until source isolation is verified. */
export async function lifecycleApprove(_headers: Record<string, string | string[] | undefined>, _body: any): Promise<Result> {
  // No configuration, cookie, private key, Odoo fetch or engine call may precede this refusal.
  return { http: 503, body: { ok: false, error: { code: 'LC_APPROVAL_READ_ONLY', message: '生命周期审批为只读模式：同源门户/SOP隔离未完成，不能在工作台批准。' } } };
}

/** GET /api/lifecycle/status（管理员口令）：签发入口自检（公钥给属主登记用；不回私钥路径与环境变量值） */
export async function lifecycleStatus(): Promise<Record<string, unknown>> {
  const cfg = lcConfig();
  const out: Record<string, unknown> = { configured: lifecycleConfigured(), issuer: LC_ISSUER, approval_mode: 'read-only', approval_blocked_reason: 'SAME_ORIGIN_ISOLATION_REQUIRED', missing: cfg.missing, problem: cfg.problem, engine_pin: LC_ENGINE_PIN, test_mode: process.env.LC_TEST === '1' };
  if (cfg.bin) out.engine_version = await engineVersion(cfg.bin);
  if (cfg.keyFile) { try { out.pubkey = loadIssuerKey(cfg.keyFile).pubkey; } catch (e) { out.key_error = (e as Error).message; } }
  return out;
}
