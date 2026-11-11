/** 全站强制登录门（WM_LOGIN_GATE=enforce|off，缺省 off）。
 *  enforce 时挂在最前面（仅次于 #326 启动自检门）：没有身份就什么都拿不到——页面 302 到 /login，API 回 401。
 *  身份（命中任意一条即放行）：
 *    - 本机命令行（回环直连、无浏览器标记、无反代转发头，见 surfaces.ts）；
 *    - 有效的 X-Admin-Token 头；
 *    - 登录 cookie（口令登录后签发：HMAC 签名、HttpOnly、SameSite=Lax、12 小时；不含口令，口令轮换即全部失效）；
 *    - Odoo 内部员工会话（现查 get_session_info，只认 is_internal_user；按会话哈希缓存 30 秒）。
 *  无身份也放行的（各自有认证或本身公开）：
 *    - /mcp 与 #385 的 /openapi.json、/api/mcp-rest/*：网关自己的 Bearer 会话认证（enforce 时网关强制开）；
 *    - 签名卡片 GET /.well-known/agent-card.json；工作台事件回执（凭投递里的随机 reply token，库存 sha256、有效期）；
 *    - /api/health（存活）与 /api/health/ready（就绪）、登录页与登录/登出/身份接口、设计 token 样式表（公开仓库里的设计变量）；
 *    - 发往 /api/apps/<slug>/(data|files) 与 /api/workbenches/<id>/vars 且带本台 X-App-Token 的请求（沙箱页是不透明源，带不了 cookie）；
 *    - SOP run 的按 run 凭据（/a2a/direct 建单时发给派单方）：GET /api/sop/runs/<id>[/files[/<fileId>]] 带该 run 有效的
 *      X-Run-Read-Capability（未吊销、未过期），POST /api/sop/runs/<id>/files 带该 run 的 X-Run-Upload-Token（run 仍在执行）；
 *    - 自产台查看凭证：沙箱页的子资源（脚本、样式、图片）同样带不了 cookie。已登录的人打开 /apps/<slug>/（或指向自产台的 /go/<id>/）时
 *      302 到 /apps/<slug>/~wm/<凭证>/…，凭证按台签名、12 小时有效，相对路径的子资源自然带上；凭证段由本中间件剥掉，下游路由无感。
 *      凭证不能当顶层页面打开（浏览器顶层导航必带 Sec-Fetch-Dest: document，此时仍要身份），复制出去的链接打不开；
 *    - Odoo 登录中继：GET /go/<登录用 Odoo 台>/?return=/login（只出跳转页，不代理 Odoo 内容）。
 *    - 技能包下载票据：GET /api/skills/dl/<64 位十六进制票号>（MCP skill_download 签发、10 分钟有效、单票至多 5 次，路由内查票，无效 404）。
 *    - POST /a2a/direct：只放行到路由，由路由按 OriginClaim 签名判定（enforce 时 WM_A2A_DIRECT_SIG 强制 require，无签名或验不过 401）。 */
import type express from 'express';
import type { IncomingMessage } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlockList, isIP } from 'node:net';
import { browserMarked, rawLoopback, surfaceOf } from './surfaces.ts';
import { identity as identityService, loginRelay, SESSION_COOKIE } from './identity.ts';

export type LoginGateMode = 'enforce' | 'off';
/** 取开关；值不合法返回 null（调用方拒绝启动，参照 MCP_GATEWAY） */
export function loginGateMode(env: NodeJS.ProcessEnv = process.env): LoginGateMode | null {
  const raw = String(env.WM_LOGIN_GATE ?? '');
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'enforce') return 'enforce';
  return null;
}

export type Identity = { via: 'cli' | 'token' | 'cookie' | 'odoo' | 'session'; login: string | null; admin: boolean };
type Deps = {
  mode: LoginGateMode;
  dataDir: string;
  adminTokenCheck: (provided: string | undefined) => boolean;
  /** 当前口令的指纹（env 口令或库存哈希）；无口令时空串。签进 cookie：口令一换，旧 cookie 全部失效 */
  adminTokenFingerprint: () => string;
  /** Odoo 内部员工（未配置 Odoo、门户账号、会话无效一律 null）。登录是成功的、卡在主体那一步（停用了或还没对到主体）回 { held: true }。
   *  fresh=true 每次都问提供方；false 时提供方的回答可以用缓存的（期限由装配方定）。主体停没停用总是现查，这里不再自己缓存 */
  odooViewer: (cookieHeader: string, fresh: boolean) => Promise<{ login: string; admin: boolean; via?: 'session' } | { held: true } | null>;
  /** 登录页上列出的登录方式（发市场会话的那几种，比如飞书）：名字和按钮上的字 */
  loginFlows?: () => { name: string; label: string }[];
  appToken: (slug: string) => string;
  /** /api/workbenches/<id>/vars 带的 X-App-Token 是否属于该台 */
  varsAppTokenOk: (req: express.Request) => boolean;
  /** 按 run 凭据：read = X-Run-Read-Capability 对该 run 有效；upload = X-Run-Upload-Token 等于该 run 的上传令牌且 run 在执行 */
  runCapOk: (kind: 'read' | 'upload', runId: number, presented: string) => Promise<boolean>;
  /** /go/<id>/ 指向自产台时返回其 slug，否则 null */
  goAppSlug: (id: number) => string | null;
  /** 登录用 Odoo 中继入口（/go/<id>/?return=/login），没有可信 Odoo 台时 null */
  odooLoginHref: (req: express.Request) => string | null;
  tokensCss: () => string;
  log?: (row: object) => void;
};

export const LOGIN_COOKIE = 'wm_login';
const SESSION_MS = 12 * 3600 * 1000;
const CAP_SEG = '~wm';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP_DATA_RE = /^\/api\/apps\/([a-z0-9][a-z0-9-]*)\/(data|files)(\/|$)/;
const APP_FILE_RE = /^\/api\/apps\/([a-z0-9][a-z0-9-]*)\/files\/\d+$/;
const VARS_RE = /^\/api\/workbenches\/\d+\/vars(\/|$)/;
const RUN_READ_RE = /^\/api\/sop\/runs\/(\d+)(\/files(\/\d+)?)?$/;
const RUN_UPLOAD_RE = /^\/api\/sop\/runs\/(\d+)\/files$/;
const CAP_PATH_RE = /^\/(apps\/([a-z0-9][a-z0-9-]*)|go\/(\d+))\/~wm\/([0-9a-z]+\.[0-9a-f]{32})(\/.*)?$/i;
const APP_DOC_RE = /^\/(apps\/([a-z0-9][a-z0-9-]*)|go\/(\d+))(\/.*)?$/;

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** 登录后去向：只收同站相对路径（防开放重定向）；不回 /login 自己与 /api 接口 */
export function safeNext(v: unknown): string {
  const s = String(v ?? '');
  const bad = (x: string) => !x.startsWith('/') || x.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(x);
  if (!s || s.length > 1024 || bad(s)) return '/';
  try {
    const u = new URL(s, 'http://wm.invalid');
    const out = u.pathname + u.search + u.hash;
    if (u.origin !== 'http://wm.invalid' || bad(out) || /^\/(login|api\/)/i.test(u.pathname)) return '/';
    return out;
  } catch { return '/'; }
}

/**
 * 等管理员处理的页：登录成功了，但停用了、还没对到主体、或者不是本组织的人。几种情况同一页、同一个状态码，逐字节相同，
 * 不透露系统里有没有这个人、是不是被停用了；也不叫人重新登录（重登没用），不给回登录页的链接。页上不带任何数据。
 * 登录方式的回调（routes/login-flows.ts）和登录门共用这一份
 */
export function holdPage(res: express.Response): void {
  res.status(403).set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" })
    .type('html').send('<!doctype html><meta charset="utf-8"><title>等管理员处理</title><h1>等管理员处理</h1><p>登录成功了，但你的账号还需要管理员处理，处理好之前用不了本站。请联系管理员。</p>');
}

/** 想要页面的请求（浏览器导航）：给 302；其余给 401 JSON */
function wantsPage(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const dest = String(req.headers['sec-fetch-dest'] ?? '');
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  return String(req.headers.accept ?? '').includes('text/html');
}

/** 可信反代（WM_TRUSTED_PROXIES）：逗号分隔的 IP 或 CIDR（IPv4/IPv6），如容器里看到的 docker 网桥网关 172.17.0.1 或反代主机网段。
 *  回环恒为可信。非法项列进 invalid（index.ts 启动时拒绝启动）；按原值缓存，测试改环境变量即时生效 */
export function trustedProxies(raw = String(process.env.WM_TRUSTED_PROXIES ?? '')): { list: BlockList; entries: string[]; invalid: string[] } {
  const list = new BlockList(), entries: string[] = [], invalid: string[] = [];
  for (const item of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [addr, bits, extra] = item.split('/');
    const fam = isIP(addr);
    const max = fam === 4 ? 32 : 128;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
    if (!fam || extra !== undefined || prefix < 0 || prefix > max) { invalid.push(item); continue; }
    list.addSubnet(addr, prefix, fam === 4 ? 'ipv4' : 'ipv6');
    entries.push(item);
  }
  return { list, entries, invalid };
}
let proxyCache: { raw: string; list: BlockList } | null = null;
function trustedPeer(peer: string): boolean {
  if (peer === '127.0.0.1' || peer === '::1') return true;
  const raw = String(process.env.WM_TRUSTED_PROXIES ?? '');
  if (!raw.trim()) return false;
  if (proxyCache?.raw !== raw) proxyCache = { raw, list: trustedProxies(raw).list };
  const fam = isIP(peer);
  return fam !== 0 && proxyCache.list.check(peer, fam === 4 ? 'ipv4' : 'ipv6');
}

/** 来源 IP（限频与审计用）：TCP 对端是可信反代（本机回环，或 WM_TRUSTED_PROXIES 里的地址/网段）时，取反代写进来的 X-Real-IP，
 *  没有则取 X-Forwarded-For 最右一项（nginx 的 $proxy_add_x_forwarded_for 把它见到的对端追加在最右；更左边的是客户端自报，不可信）。
 *  对端不可信时只认 TCP 对端：外部直连者自带的转发头一律不信，伪造不了。
 *  前提：可信反代要覆盖 X-Real-IP（proxy_set_header X-Real-IP $remote_addr），不能原样透传客户端的值。 */
export function clientIp(req: IncomingMessage): string {
  const peer = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!trustedPeer(peer)) return peer;
  const pick = (v: unknown) => { const s = String(v ?? '').trim().replace(/^::ffff:/, ''); return isIP(s) ? s : ''; };
  const real = pick(req.headers['x-real-ip']);
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',');
  return pick(xff[xff.length - 1]) || peer;
}

export function createLoginGate(deps: Deps) {
  const enforced = deps.mode === 'enforce';
  const log = deps.log ?? ((row: object) => console.log(JSON.stringify(row)));

  // ---------- 密钥（DATA_DIR/.wm-login-gate.key，权限 600） ----------
  const KEY_FILE = join(deps.dataDir, '.wm-login-gate.key');
  let key = '';
  function gateKey(): string {
    if (key) return key;
    try { key = String(readFileSync(KEY_FILE, 'utf8')).trim(); } catch { /* 首次 */ }
    if (!/^[0-9a-f]{64}$/.test(key)) {
      key = randomBytes(32).toString('hex');
      try { writeFileSync(KEY_FILE, key, { mode: 0o600 }); chmodSync(KEY_FILE, 0o600); } catch { /* 只读卷：进程内随机（重启后要重新登录） */ }
    }
    return key;
  }
  const mac = (s: string) => createHmac('sha256', gateKey()).update(s, 'utf8').digest('hex');

  // ---------- 登录 cookie ----------
  const revoked = new Map<string, number>(); // 登出的 jti → 到期时刻（进程内；重启后靠 cookie 自身到期）
  function issueCookie(): { value: string; exp: number } {
    const exp = Date.now() + SESSION_MS;
    const body = b64(JSON.stringify({ v: 1, sub: 'admin-token', jti: randomBytes(9).toString('base64url'), exp, ak: mac('ak|' + deps.adminTokenFingerprint()).slice(0, 32) }));
    return { value: `${body}.${mac('c1|' + body)}`, exp };
  }
  function cookieValue(req: IncomingMessage): string {
    const m = new RegExp(`(?:^|;\\s*)${LOGIN_COOKIE}=([^;\\s]+)`).exec(String(req.headers.cookie ?? ''));
    return m ? m[1] : '';
  }
  function verifyCookie(raw: string): { jti: string; exp: number } | null {
    const i = raw.lastIndexOf('.');
    if (i <= 0 || raw.length > 1024) return null;
    const body = raw.slice(0, i), sig = raw.slice(i + 1);
    if (!/^[0-9a-f]{64}$/.test(sig) || !eq(sig, mac('c1|' + body))) return null;
    let p: any;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (p?.v !== 1 || typeof p.jti !== 'string' || typeof p.exp !== 'number' || p.exp <= Date.now()) return null;
    const fp = deps.adminTokenFingerprint();
    if (!fp || typeof p.ak !== 'string' || !eq(p.ak, mac('ak|' + fp).slice(0, 32))) return null; // 口令已换或已清
    if (revoked.has(p.jti)) return null;
    return { jti: p.jti, exp: p.exp };
  }

  // ---------- 自产台查看凭证 ----------
  function issueCap(slug: string): string {
    const exp = Math.floor((Date.now() + SESSION_MS) / 1000).toString(36);
    return `${exp}.${mac(`av1|${slug}|${exp}`).slice(0, 32)}`;
  }
  function capOk(slug: string, cap: string): boolean {
    const [exp, sig] = cap.split('.');
    if (!exp || !sig || !SLUG_RE.test(slug)) return false;
    const at = parseInt(exp, 36) * 1000;
    return Number.isFinite(at) && at > Date.now() && eq(sig, mac(`av1|${slug}|${exp}`).slice(0, 32));
  }
  const viewCaps = new WeakMap<IncomingMessage, { slug: string; cap: string; base: string }>();

  // ---------- Odoo 内部员工 ----------
  async function odooOf(cookie: string): Promise<{ login: string; admin: boolean; via?: 'session' } | { held: true } | null> {
    if (!identityService().hasCredential(cookie)) return null;
    // Relay mode supports explicit Odoo logout: do not keep a stale positive identity
    // after the upstream session has been revoked. 其余情况提供方的回答可以用缓存的（缓存在身份服务里，主体状态不进缓存）。
    try { return await deps.odooViewer(cookie, loginRelay().relayLogin()); } catch { return null; }
  }

  // ---------- 身份 ----------
  const identities = new WeakMap<IncomingMessage, Identity | null>();
  /** 登录成功、卡在主体那一步的请求：没有身份（照旧什么都不给），只是要页面时给等待页而不是登录页 */
  const held = new WeakSet<IncomingMessage>();
  async function identity(req: IncomingMessage): Promise<Identity | null> {
    if (identities.has(req)) return identities.get(req)!;
    let id: Identity | null = null;
    if (rawLoopback(req) && !browserMarked(req)) id = { via: 'cli', login: null, admin: true };
    else if (req.headers['x-admin-token'] !== undefined && deps.adminTokenCheck(String(req.headers['x-admin-token']))) id = { via: 'token', login: null, admin: true };
    else if (verifyCookie(cookieValue(req))) id = { via: 'cookie', login: null, admin: false };
    else {
      const who = await odooOf(String(req.headers.cookie ?? ''));
      if (who && 'held' in who) held.add(req);
      else if (who) id = { via: who.via === 'session' ? 'session' : 'odoo', login: who.login, admin: who.admin };
    }
    identities.set(req, id);
    return id;
  }

  // ---------- 拦截 ----------
  function block(req: express.Request, res: express.Response, nextPath?: string): void {
    res.setHeader('Cache-Control', 'no-store');
    if (wantsPage(req) && !req.path.toLowerCase().startsWith('/api/')) {
      const next = safeNext(nextPath ?? req.originalUrl ?? req.url);
      res.redirect(302, next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
      return;
    }
    res.setHeader('X-WM-Login-Required', '1');
    res.status(401).json({ error: 'login_required', message: '需要登录：用 Odoo 内部账号或管理员口令登录', login_url: '/login' });
  }

  /** 无身份也放行的精确清单（方法 + 路径） */
  function publicRoute(req: express.Request, p: string): boolean {
    const m = req.method;
    const get = m === 'GET' || m === 'HEAD';
    if (surfaceOf(req) === 'market' && loginRelay().publicRoute(m, String(req.url ?? '').split('?')[0])) return true;
    if (p === '/mcp') return true; // 网关 Bearer 会话认证；enforce 时网关强制开
    // #385 MCP 工具的 REST 开放：路由内只认网关会话令牌（mcpGatewaySession，无效 401），同 /mcp 不走浏览器登录
    if ((get && p === '/openapi.json') || p.startsWith('/api/mcp-rest/')) return true;
    if (get && (p === '/api/health' || p === '/api/health/ready' || p === '/login' || p === '/api/auth/me' || p === '/.well-known/agent-card.json')) return true;
    if (m === 'POST' && (p === '/api/auth/login' || p === '/api/auth/logout')) return true;
    if (get && /^\/login\/[a-z0-9][a-z0-9-]{0,31}(\/callback)?$/.test(p)) return true; // 登录方式的发起和回调（还没有身份才要登录）；路由里核 state
    if (m === 'POST' && /^\/login\/[a-z0-9][a-z0-9-]{0,31}\/events$/.test(p)) return true; // 失效通知：路由里由插件验签，验不过 401
    if (m === 'POST' && p === '/a2a/direct') return true; // 路由内验签（a2a-direct-sig.ts），enforce 下无签名 401
    if (m === 'POST' && /^\/api\/workbench-events\/wbe-[0-9a-f]{16}\/decision$/.test(p)) return true; // reply token 认证
    if (get && /^\/design\/tokens@[0-9.]+\.css$/.test(p)) return true;
    if (get && /^\/api\/skills\/dl\/[0-9a-f]{64}$/.test(p)) return true; // 技能包下载票据：路由内查票（10 分钟有效、单票至多 5 次），无效 404
    // 沙箱页对本台数据面/变量面的预检：只回允许头，不带数据（实际请求再凭令牌）
    if (m === 'OPTIONS' && String(req.headers.origin ?? '') === 'null' && (APP_DATA_RE.test(p) || VARS_RE.test(p))) return true;
    return false;
  }

  function appTokenOk(req: express.Request, p: string): boolean {
    if (req.headers['x-app-token'] === undefined) return false;
    const m = APP_DATA_RE.exec(p);
    if (m) return eq(String(req.headers['x-app-token']).trim(), deps.appToken(m[1]));
    if (VARS_RE.test(p)) return deps.varsAppTokenOk(req);
    return false;
  }

  async function runCapOk(req: express.Request, p: string): Promise<boolean> {
    const get = req.method === 'GET' || req.method === 'HEAD';
    const read = get ? RUN_READ_RE.exec(p) : null;
    const cap = String(req.headers['x-run-read-capability'] ?? '').trim();
    if (read && cap) return deps.runCapOk('read', Number(read[1]), cap);
    const up = req.method === 'POST' ? RUN_UPLOAD_RE.exec(p) : null;
    const tok = String(req.headers['x-run-upload-token'] ?? '').trim();
    if (up && tok) return deps.runCapOk('upload', Number(up[1]), tok);
    return false;
  }

  function odooRelay(req: express.Request, p: string): boolean {
    if (req.method !== 'GET' || !/^\/go\/\d+\/$/.test(p) || req.query.state !== undefined) return false;
    const href = deps.odooLoginHref(req);
    if (!href) return false;
    const u = new URL(href, 'http://wm.invalid');
    return u.pathname === req.path && req.query.return === u.searchParams.get('return');
  }

  async function middleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    if (!enforced || surfaceOf(req) === 'content') return next(); // 内容面自带 Odoo 查看人认证
    try {
      const p = req.path.toLowerCase();
      // 自产台查看凭证段：校验后剥掉，下游路由看到的是原路径
      const cm = CAP_PATH_RE.exec(req.path);
      if (cm) {
        const slug = cm[2] ? cm[2].toLowerCase() : deps.goAppSlug(Number(cm[3]));
        const stripped = '/' + cm[1] + (cm[5] ?? '/');
        const qs = String(req.url ?? '').includes('?') ? String(req.url).slice(String(req.url).indexOf('?')) : '';
        if (!slug || !capOk(slug, cm[4])) return block(req, res, stripped + qs);
        if (req.headers['sec-fetch-dest'] === 'document' && !(await identity(req))) return block(req, res, stripped + qs);
        viewCaps.set(req, { slug, cap: cm[4], base: '/' + cm[1] });
        req.url = stripped + qs;
        return next();
      }
      if (publicRoute(req, p)) return next();
      const id = await identity(req);
      if (id) {
        // 已登录的人打开自产台页面：换到带查看凭证的地址，沙箱页的相对子资源才能加载
        const dm = wantsPage(req) && id.via !== 'cli' ? APP_DOC_RE.exec(req.path) : null;
        const slug = dm ? (dm[2] ? dm[2].toLowerCase() : deps.goAppSlug(Number(dm[3]))) : null;
        if (dm && slug) {
          const qs = String(req.url ?? '').includes('?') ? String(req.url).slice(String(req.url).indexOf('?')) : '';
          res.setHeader('Cache-Control', 'no-store');
          return res.redirect(302, `/${dm[1]}/${CAP_SEG}/${issueCap(slug)}${dm[4] ?? '/'}${qs}`);
        }
        return next();
      }
      if (appTokenOk(req, p)) return next();
      if (await runCapOk(req, p)) return next(); // 派单方凭按 run 凭据直连 REST（路由内照旧判同一凭据）
      const fm = (req.method === 'GET' || req.method === 'HEAD') ? APP_FILE_RE.exec(p) : null;
      if (fm && typeof req.query.wm_av === 'string' && capOk(fm[1], req.query.wm_av)) return next(); // 沙箱页 <img src> / 下载链接
      // Odoo 登录入口本身照旧放行：同一个人有两个 Odoo 账号时，管理员会让他换已经接上的那个账号登录
      if (odooRelay(req, p)) return next();
      // 登录成功、卡在主体那一步的人要页面：给等待页，说清楚是等管理员处理，不送回登录页。接口照旧 401
      if (held.has(req) && wantsPage(req) && !p.startsWith('/api/')) return holdPage(res);
      return block(req, res);
    } catch (e) {
      return next(e);
    }
  }

  /** WebSocket 升级不经 Express：/go/ 代理的升级照样要身份 */
  async function upgradeAllowed(req: IncomingMessage): Promise<boolean> {
    if (!enforced) return true;
    return !!(await identity(req));
  }

  /** 自产台 HTML 注入：把页面里指向本台的绝对地址补上查看凭证（静态属性在服务端改，运行期生成的 src/href 与 window.open 由脚本改）。
   *  不改 fetch/XHR：沙箱页跨源读本台静态文件本来就没有 CORS 放行，读数据走 X-App-Token（登录门直接认令牌） */
  function rewriteAppHtml(req: IncomingMessage, html: string): string {
    const vc = viewCaps.get(req);
    if (!vc) return html;
    const appBase = `/apps/${vc.slug}`;
    const capSeg = `/${CAP_SEG}/${vc.cap}`;
    const filesBase = `/api/apps/${vc.slug}/files/`;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let out = html.replace(new RegExp(`((?:src|href)=["'])${esc(appBase)}/(?!${esc(CAP_SEG)}/)`, 'gi'), `$1${appBase}${capSeg}/`);
    out = out.replace(new RegExp(`((?:src|href)=["'])(${esc(filesBase)}\\d+)(["'])`, 'gi'), `$1$2?wm_av=${vc.cap}$3`);
    const cfg = JSON.stringify({ bases: [...new Set([vc.base, appBase])], cap: capSeg, files: filesBase, av: vc.cap }).replace(/</g, '\\u003c');
    const script = `<script>(function(c){var H=location.host;function fx(u){try{var x=new URL(String(u),location.href);if(x.host!==H)return u;var p=x.pathname;`
      + `if(p.indexOf(c.files)===0&&/^\\d+$/.test(p.slice(c.files.length))){if(x.searchParams.get('wm_av')===c.av)return u;x.searchParams.set('wm_av',c.av);return x.href}`
      + `for(var i=0;i<c.bases.length;i++){var b=c.bases[i];if((p===b||p.indexOf(b+'/')===0)&&p.indexOf(b+c.cap+'/')!==0){x.pathname=b+c.cap+(p.slice(b.length)||'/');return x.href}}return u}catch(e){return u}}`
      + `var W=window.open;window.open=function(u){if(u)arguments[0]=fx(u);return W.apply(this,arguments)};`
      + `function el(n){if(!n||n.nodeType!==1)return;['src','href'].forEach(function(a){var v=n.getAttribute(a);if(v){var f=fx(v);if(f!==v)n.setAttribute(a,f)}});var q=n.querySelectorAll?n.querySelectorAll('[src],[href]'):[];for(var j=0;j<q.length;j++)el1(q[j])}`
      + `function el1(n){['src','href'].forEach(function(a){var v=n.getAttribute(a);if(v){var f=fx(v);if(f!==v)n.setAttribute(a,f)}})}`
      + `new MutationObserver(function(r){r.forEach(function(m){if(m.type==='attributes')el1(m.target);else for(var k=0;k<m.addedNodes.length;k++)el(m.addedNodes[k])})}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href']});`
      + `})(${cfg})</script>`;
    return /<head[^>]*>/i.test(out) ? out.replace(/<head([^>]*)>/i, (mm) => mm + script) : script + out;
  }

  // ---------- 登录限频（按来源 IP：每分钟 10 次；连续失败指数退避） ----------
  const attempts = new Map<string, { hits: number[]; fails: number; until: number }>();
  function rateCheck(ip: string): { ok: true } | { ok: false; retryS: number } {
    const now = Date.now();
    const a = attempts.get(ip) ?? { hits: [], fails: 0, until: 0 };
    a.hits = a.hits.filter((t) => now - t < 60_000);
    if (attempts.size > 5000) attempts.clear();
    attempts.set(ip, a);
    if (a.until > now) return { ok: false, retryS: Math.ceil((a.until - now) / 1000) };
    if (a.hits.length >= 10) return { ok: false, retryS: Math.ceil((60_000 - (now - a.hits[0])) / 1000) };
    a.hits.push(now);
    return { ok: true };
  }
  function rateResult(ip: string, ok: boolean): void {
    const a = attempts.get(ip);
    if (!a) return;
    if (ok) { a.fails = 0; a.until = 0; return; }
    a.fails += 1;
    if (a.fails >= 3) a.until = Date.now() + Math.min(2 ** (a.fails - 3), 300) * 1000; // 第 3 次起 1s、2s、4s… 封顶 5 分钟
  }

  function secure(req: express.Request): boolean {
    return req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  }
  function setLoginCookie(req: express.Request, res: express.Response, value: string, maxAgeMs: number): void {
    res.cookie(LOGIN_COOKIE, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: maxAgeMs, secure: secure(req) });
  }
  /** 浏览器来的登录/登出必须同源（防跨站登录固定、强制登出） */
  function sameOrigin(req: express.Request): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(String(origin)).host === String(req.headers.host ?? ''); } catch { return false; }
  }

  function mount(app: express.Express): void {
    app.get('/login', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      const canOdooLogout = loginRelay().relayLogin() && loginRelay().sessionEntries(String(req.headers.cookie ?? '')).length > 0;
      res.type('html').send(loginPage(safeNext(req.query.next), deps.odooLoginHref(req), deps.tokensCss(), deps.mode, canOdooLogout, deps.loginFlows?.() ?? []));
    });
    app.post('/api/auth/login', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!sameOrigin(req)) return res.status(403).json({ error: '跨源登录被拒绝' });
      const ip = clientIp(req);
      const rc = rateCheck(ip);
      if (!rc.ok) { res.setHeader('Retry-After', String(rc.retryS)); return res.status(429).json({ error: '尝试过于频繁，请稍后再试', retry_after_s: rc.retryS }); }
      const token = typeof req.body?.token === 'string' ? req.body.token : '';
      const ok = token.length > 0 && token.length <= 256 && deps.adminTokenFingerprint() !== '' && deps.adminTokenCheck(token);
      rateResult(ip, ok);
      log({ source: 'login-gate', event: 'login', ok, ip, at: new Date().toISOString() }); // 只记结果、来源与时间，不记口令
      if (!ok) return res.status(401).json({ error: '口令无效' }); // 口令错与未设置口令同答
      const c = issueCookie();
      setLoginCookie(req, res, c.value, SESSION_MS);
      res.json({ ok: true, expires_at: new Date(c.exp).toISOString() });
    });
    app.post('/api/auth/logout', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!sameOrigin(req)) return res.status(403).json({ error: '跨源登出被拒绝' });
      const cookie = String(req.headers.cookie ?? '');
      const sessions = loginRelay().sessionEntries(cookie);
      const relay = loginRelay().relayLogin();
      const sessionCookie = loginRelay().sessionCookieName();
      if (relay && sessions.length) {
        // A browser must make an explicit same-origin JSON request to terminate Odoo.
        let originOk = false;
        try { originOk = !!req.headers.origin && new URL(String(req.headers.origin)).protocol === (secure(req) ? 'https:' : 'http:'); } catch { /* reject */ }
        if (!originOk || !req.is('application/json') || req.headers['x-wm-odoo-logout'] !== '1') return res.status(403).json({ error: 'Odoo 登出请求不符合安全要求' });
      }
      const v = verifyCookie(cookieValue(req));
      if (v) {
        revoked.set(v.jti, v.exp);
        for (const [j, exp] of revoked) if (exp <= Date.now()) revoked.delete(j);
      }
      res.clearCookie(LOGIN_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: secure(req) });
      // 市场会话：注销即失效（库里记下 revoked_at），浏览器那边也清掉
      const marketSession = identityService().endSession(cookie);
      if (marketSession) res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure: secure(req) });
      if (!relay) return res.json({ ok: true, odoo_session: !!loginRelay().sessionOf(cookie) });
      res.clearCookie(sessionCookie, { httpOnly: true, sameSite: 'lax', path: '/', secure: secure(req) });
      if (!sessions.length) return res.json({ ok: true, odoo_session: false, browser_session_cleared: true });
      if (sessions.length !== 1) return res.status(409).json({ ok: false, error: 'Odoo 会话不唯一，无法确认服务器端已注销', browser_session_cleared: true, odoo_session_revoked: false });
      const sid = sessions[0].slice(sessionCookie.length + 1);
      const done = await loginRelay().revokeSession(sid);
      return res.status(done ? 200 : 502).json({ ok: done, odoo_session: true, browser_session_cleared: true, odoo_session_revoked: done, ...(!done ? { error: '已清除浏览器会话，但无法确认 Odoo 服务器端注销' } : {}) });
    });
    app.get('/api/auth/me', async (req, res, next) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        res.vary('Cookie');
        const id = await identity(req);
        res.json({ gate: deps.mode, authenticated: !!id, via: id?.via ?? null, login: id?.login ?? null });
      } catch (e) { next(e); }
    });
  }

  /** 登录门签给某个台页面的查看凭证（wm_av）对不对：台数据的下载守卫也认它（沙箱页的下载链接带不了头） */
  const viewCapOk = (slug: string, cap: string): boolean => capOk(slug, cap);
  return { mode: deps.mode, enforced, middleware, mount, identity, upgradeAllowed, rewriteAppHtml, viewCapOk };
}

function loginPage(next: string, odooHref: string | null, tokensCss: string, mode: LoginGateMode, canOdooLogout: boolean, flows: { name: string; label: string }[] = []): string {
  const j = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 工作台市场</title><style>
${tokensCss.replace(/<\/style/gi, '')}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:var(--wm-font-sans,system-ui);font-size:var(--wm-font-size-body,14px);line-height:var(--wm-line-height-body,1.6);color:var(--wm-color-text,#1f2329);background:var(--wm-color-page,#f5f6f7)}
.card{width:360px;background:var(--wm-color-surface,#fff);border:1px solid var(--wm-color-border,#dee0e3);border-radius:var(--wm-radius-lg,8px);padding:var(--wm-space-8,32px)}
h1{margin:0 0 var(--wm-space-1,4px);font-size:var(--wm-font-size-title,20px);line-height:var(--wm-line-height-title,1.4);font-weight:var(--wm-font-weight-title,600)}
.sub{margin:0 0 var(--wm-space-6,24px);color:var(--wm-color-text-secondary,#646a73);font-size:var(--wm-font-size-caption,12px)}
button{width:100%;height:36px;border-radius:var(--wm-radius-md,6px);font:inherit;cursor:pointer;border:1px solid var(--wm-color-border-strong,#c9cdd4);background:var(--wm-color-surface,#fff);color:var(--wm-color-text,#1f2329)}
button.primary{background:var(--wm-color-primary,#3370ff);border-color:var(--wm-color-primary,#3370ff);color:var(--wm-color-on-primary,#fff)}
button:disabled{opacity:.6;cursor:default}
input{box-sizing:border-box;width:100%;height:36px;padding:0 var(--wm-space-3,12px);border:1px solid var(--wm-color-border-strong,#c9cdd4);border-radius:var(--wm-radius-md,6px);font:inherit;margin-bottom:var(--wm-space-3,12px)}
.or{display:flex;align-items:center;gap:var(--wm-space-3,12px);margin:var(--wm-space-6,24px) 0;color:var(--wm-color-text-secondary,#646a73);font-size:var(--wm-font-size-caption,12px)}
.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--wm-color-border,#dee0e3)}
.msg{min-height:20px;margin-top:var(--wm-space-2,8px);font-size:var(--wm-font-size-caption,12px);color:var(--wm-color-danger-text,#d83931)}
.msg.info{color:var(--wm-color-text-secondary,#646a73)}
</style></head><body><main class="card">
<h1>工作台市场</h1><p class="sub">${mode === 'enforce' ? '本站需要登录后访问' : '登录门未开启（WM_LOGIN_GATE=off）'}</p>
${canOdooLogout ? '<button id="odoo-logout" type="button">退出当前 Odoo 会话</button><div class="msg" id="odoo-logout-msg" role="alert"></div>' : ''}
${flows.length ? '<style>.flow{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;height:36px;margin-bottom:var(--wm-space-3,12px);border-radius:var(--wm-radius-md,6px);background:var(--wm-color-primary,#3370ff);color:var(--wm-color-on-primary,#fff);text-decoration:none}</style>' : ''}${flows.map((f) => `<a class="flow" href="/login/${encodeURIComponent(f.name)}?next=${encodeURIComponent(next)}">${f.label.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</a>`).join('')}${flows.length ? '<div class="or">或</div>' : ''}${odooHref ? `<button class="primary" id="odoo" type="button">用 Odoo 登录</button><div class="msg info" id="odoo-msg"></div><div class="or">或</div>` : ''}
<form id="f"><input id="t" type="password" autocomplete="current-password" placeholder="管理员口令" aria-label="管理员口令" required>
<button ${odooHref ? '' : 'class="primary" '}type="submit" id="go">输入管理员口令登录</button><div class="msg" id="msg" role="alert"></div></form>
</main><script>(function(){var next=${j(next)},odoo=${j(odooHref)};
function done(){location.replace(next)}
var f=document.getElementById('f'),t=document.getElementById('t'),go=document.getElementById('go'),msg=document.getElementById('msg');
f.addEventListener('submit',function(e){e.preventDefault();go.disabled=true;msg.textContent='';
fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t.value})})
.then(function(r){return r.json().catch(function(){return{}}).then(function(b){t.value='';if(r.ok)return done();msg.textContent=r.status===429?'尝试过于频繁，请 '+(b.retry_after_s||60)+' 秒后再试':(b.error||'登录失败');go.disabled=false;t.focus()})})
.catch(function(){msg.textContent='网络错误';go.disabled=false})});
var ob=document.getElementById('odoo-logout'),oe=document.getElementById('odoo-logout-msg');
if(ob)ob.addEventListener('click',function(){ob.disabled=true;oe.textContent='';
fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-WM-Odoo-Logout':'1'},body:'{}'})
.then(function(r){return r.json().catch(function(){return{}}).then(function(b){if(r.ok&&b.ok){location.reload();return}oe.textContent=b.error||'无法确认 Odoo 会话已退出';ob.disabled=false})})
.catch(function(){oe.textContent='网络错误，无法确认会话已退出';ob.disabled=false})});
if(!odoo)return;var btn=document.getElementById('odoo'),om=document.getElementById('odoo-msg'),pop=null,until=0,timer=0;
function check(){if(!until||Date.now()>until)return;fetch('/api/auth/me',{cache:'no-store',credentials:'same-origin'}).then(function(r){return r.json()}).then(function(b){if(b&&b.authenticated){until=0;try{pop&&pop.close()}catch(e){}done()}}).catch(function(){})}
btn.addEventListener('click',function(){
// 与 #275 弹窗流同法：先开空白页、切断 opener 再跳 Odoo 中继，保住句柄；登录后回本页轮询身份
var w=window.open('about:blank','_blank','popup,width=520,height=680');if(!w){om.textContent='弹窗被浏览器拦截，请允许弹窗后重试';return}
try{w.opener=null}catch(e){}var cut=false;try{cut=w.opener===null}catch(e){}if(!cut){try{w.close()}catch(e){}om.textContent='无法安全打开登录窗口';return}
try{w.location.replace(odoo)}catch(e){w.location.href=odoo}pop=w;until=Date.now()+600000;om.textContent='在弹出的窗口里登录 Odoo，完成后回到本页';btn.disabled=true;
clearInterval(timer);timer=setInterval(function(){if(Date.now()>until){clearInterval(timer);btn.disabled=false;om.textContent='等待超时，可重试'}else check()},1500)});
window.addEventListener('focus',check);document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')check()});
})()</script></body></html>`;
}
