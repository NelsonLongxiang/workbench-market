import express from 'express';
import { createStartupSecurityProbe, isStartupProbeRequest } from './startup-security-self-probe.ts';
import { createLoginGate, loginGateMode, trustedProxies } from './login-gate.ts';
import { identity, loginRelay } from './identity.ts';
import { requestPerson, hasLoginCredential } from './request-person.ts';
import { countSubmission, countSubmitterTicket } from './services/submission-counts.ts';
import { serveAppHtml } from './app-html.ts';
import { initSubmitterTickets, issueSubmitterTicket, selfCheckSubmitterTickets, submitterFromTicket } from './submitter-ticket.ts';
import { initializeTaskCenter, publishTaskIntake, taskCenterSteps, TaskIntakeError, taskView, taskListView, taskCenterPolicy } from './task-center.ts';
import { recordAppDataEvent, cancelTaskCenterDeliveries, kickWorkbenchEvents, startWorkbenchEventWorker, registerWorkbenchEventRoutes } from './workbench-events.ts';
import cors from 'cors';
import { contentConfig, createContentSurface, mountContentSurface, listenContentSurface } from './content-surface.ts';
import { createPortalObservation } from './portal-observation.ts';
import { allSurfaceServers, browserMarked, originIsThisSurface, rawLoopback, registerSurface, surfaceOf, surfacePorts, surfaceUrl } from './surfaces.ts';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { dirname, join, posix, extname, relative, sep as pathSep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import multer from 'multer';
import { svc } from './context.ts';
import type { HttpService } from './http.ts';
import { registerTypeRoutes } from './routes/types.ts';
import { registerCockpitRoutes } from './routes/cockpits.ts';
import { registerCookieRoutes } from './routes/cookies.ts';
import { registerStatsRoutes } from './routes/stats.ts';
import { registerDesignTokenRoutes } from './routes/design-tokens.ts';
import { registerAgentCardRoutes } from './routes/agent-card.ts';
import { registerSsoRoutes } from './routes/sso.ts';
import { registerSummaryRoutes } from './routes/summary.ts';
import { registerContentObservationRoutes } from './routes/content-observation.ts';
import { registerAuthViewerRoutes } from './routes/auth-viewer.ts';
import { registerPrincipalRoutes } from './routes/principals.ts';
import { loadRoleDeclarations, registerGrantRoutes } from './routes/grants.ts';
import { registerAttentionRoutes } from './routes/attention.ts';
import { registerWorkItemRoutes } from './routes/work-items.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerAdminTokenRoutes } from './routes/admin-token.ts';
import { registerBindingRoutes } from './routes/bindings.ts';
import { registerExportImportRoutes } from './routes/export-import.ts';
import { registerLoginFlowRoutes } from './routes/login-flows.ts';
import { registerWorkbenchRoutes } from './routes/workbenches.ts';
import { registerSopPageRoutes } from './routes/sop-page.ts';
import { registerLoginEventRoutes } from './routes/login-events.ts';
import { registerChangeRequestRoutes } from './routes/change-requests.ts';
import { registerSopStateRoutes, registerSopSpaceRoutes } from './routes/sops.ts';
import { registerTaskIntakeRoutes, registerTaskReadRoutes, registerTaskControlRoutes } from './routes/task-center.ts';
import { registerSkillRoutes } from './routes/skills.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { registerRemoteAllowRoutes } from './routes/remote-allow.ts';
import { registerAppRoutes, registerAppLifecycleRoutes } from './routes/apps.ts';
import { registerAppDataRoutes } from './routes/app-data.ts';
import { registerSopRunFileRoutes } from './routes/sop-run-files.ts';
import { registerSopRunLifecycleRoutes } from './routes/sop-run-lifecycle.ts';
import { registerMcpRestRoutes } from './routes/mcp-rest.ts';
import { registerSopRunControlRoutes } from './routes/sop-run-control.ts';
import { registerSopRunAccessRoutes } from './routes/sop-run-access.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { SopService } from './services/sop.ts';
import type { ChangeRequestService } from './services/change-request.ts';
import type { TaskCenterService } from './services/task-center.ts';
import type { RemoteAllowService } from './services/remote-allow.ts';
import { SkillService } from './services/skill.ts';
import type { AppService } from './services/app.ts';
import type { AppDataService } from './services/app-data.ts';
import type { CookieService } from './services/cookie.ts';
import type { CockpitService } from './services/cockpit.ts';
import { ADMIN_TOKEN_KEY, type SettingService } from './services/setting.ts';
import type { BindingService } from './services/binding.ts';
import { recordLayerFsShadowOutcome, recordLayerFsSkillShadowOutcome } from './layerfs-shadow.ts';
import { db, getSettings, dataDir, rowToWorkbench, type WorkbenchRow, type TypeRow, type CockpitRow, type PanelConfig, type AppRow, type AppVersionRow, type SopRunRow } from './db.ts';
(globalThis as any).__wmDb = db; // #94 v3 S1：tasks.ts 直读 change_requests 桥
import { assertHttpUrl, composeProbeUrl, probe } from './health.ts';
import { HttpError } from './errors.ts';
import { designStandard } from './design-standard.ts';
import { mountVault } from './vault-api.ts';
import { createWorkbenchVars, dropWorkbenchVars, mcpVarsGet, mcpVarsSet } from './workbench-vars.ts';
import { AdmissionError, admitUrl, analyzeUrl, auditAllow, auditDeny, checkHealthPath, checkTypeHealthPath, legacyGaps, loadAllowPolicy, markAuditChannelFailed, sameTarget, type AllowPolicy } from './url-admission.ts';
import { parse as parseYaml } from 'yaml';
import { startRedis, redisHealthy, redisConfigured, runStateRestore, runStateRead, runStateRetire, type RunStateRead } from './redis.ts';
import { createRunCheckpoints } from './sop-state-checkpoints.ts';
import { adminTokenOk, buildAgentCard, a2aKeyPath, sopNode8, a2aDirectHandle, a2aSendOutbound, formatA2aReceipt, marketOriginClaim, marketPublicUrl, MARKET_TEAM } from './a2a.ts';
import type { IncomingMessage } from 'node:http';
import { noteA2aError, type A2aErrorKey } from './a2a/errors.ts';
import { a2aHealth } from './a2a/health.ts';
import { createDirectSigVerifier, directSigBodyMode, directSigMode, type DirectSigMode } from './a2a-direct-sig.ts';

const here = dirname(fileURLToPath(import.meta.url));
const http = svc<HttpService>('http'); // HTTP 服务持有 Express 应用；域模块经它注册路由（注册可撤销）
const app = http.expressApp(); // 全局中间件、监听和还没搬走的路由，照旧直接用应用本身
const startupSecurity = createStartupSecurityProbe();
app.use(startupSecurity.middleware); // #326: before parsers, content dispatch and every business route
// 全站登录门（WM_LOGIN_GATE=enforce|off，缺省 off）：紧跟启动自检门，早于内容分发、解析器、静态资源、SPA 回落和各路由。
// 依赖都是函数声明或请求期才取的值（提升/闭包），这里只建不调。值不合法拒绝启动（同 MCP_GATEWAY #284）
const LOGIN_GATE_MODE = loginGateMode();
if (!LOGIN_GATE_MODE) {
  console.error('[login-gate] 拒绝启动：WM_LOGIN_GATE 只接受 enforce / off / 不设（当前值无法识别，不按关处理）');
  process.exit(1);
}
// 市场会话的绝对期限（WM_SESSION_TTL_MIN，分钟，缺省 720 = 12 小时，范围 15～10080）：启动时读一次，不合法拒绝启动。不续期
const SESSION_TTL_MIN = (() => {
  const raw = String(process.env.WM_SESSION_TTL_MIN ?? '').trim();
  const n = raw === '' ? 720 : /^[0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 15 || n > 10080) { console.error('[session] 拒绝启动：WM_SESSION_TTL_MIN 只接受 15～10080 的整数（分钟）'); process.exit(1); }
  return n;
})();
const loginGateViewer = identity().cachedResolver({ ttlMs: 30_000, max: 2000 }); // 提供方的回答最多留 30 秒；主体停没停用每次现查
const loginGate = createLoginGate({
  mode: LOGIN_GATE_MODE,
  dataDir,
  adminTokenCheck: (t) => adminTokenCheck(t),
  adminTokenFingerprint: () => process.env.ADMIN_TOKEN
    ? createHash('sha256').update('env|' + process.env.ADMIN_TOKEN, 'utf8').digest('hex')
    : String((svc<SettingService>('setting').get(ADMIN_TOKEN_KEY) as { value: string } | undefined)?.value ?? ''),
  odooViewer: async (cookie, fresh) => {
    if (!identity().configured() && !identity().hasSession(cookie)) return null; // 没配身份来源时，只有市场会话还可能认得出人
    const who = fresh ? await identity().resolveViewer(cookie) : await loginGateViewer(cookie); // 只认内部员工（门户账号 403）
    if (!who.ok) return who.held ? { held: true as const } : null; // 登录成功、卡在主体那一步：登录门给等待页
    return { login: who.viewer.login, admin: who.viewer.admin, ...(who.via === 'session' ? { via: 'session' as const } : {}) };
  },
  loginFlows: () => identity().flows(),
  appToken: (slug) => wmAppToken(slug),
  varsAppTokenOk: (req) => workbenchVars.appTokenWrite(req),
  runCapOk: async (kind, runId, presented) => {
    if (kind === 'read') return (await authorizeRunRead({ cap: presented }, runId)).authorized;
    const row = db.prepare('SELECT status, upload_token FROM sop_runs WHERE id = ?').get(runId) as { status: string; upload_token: string } | undefined;
    const want = String(row?.upload_token ?? '');
    return row?.status === 'running' && want.length > 0 && want.length === presented.length && timingSafeEqual(Buffer.from(want), Buffer.from(presented));
  },
  goAppSlug: (id) => /^\/apps\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(wbById(id)?.url ?? '')?.[1] ?? null,
  odooLoginHref: (req) => (identity().configured() ? odooLoginUrl(req, '/login') : null),
  tokensCss: () => loadTokensCss()?.css ?? '',
});
if (loginGate.enforced) console.log('[login-gate] enforce：无身份的请求一律拦截（页面 302 /login，API 401）');
// /a2a/direct 入站签名（WM_A2A_DIRECT_SIG=require|accept|off，缺省 accept）：enforce 时强制 require；值不合法拒绝启动
// 可信反代（WM_TRUSTED_PROXIES）：来源 IP（登录门限频与审计、SSO 票据按来源限额）只对这些对端认 X-Real-IP / XFF；非法项拒绝启动
{
  const tp = trustedProxies();
  if (tp.invalid.length) { console.error(`[trusted-proxies] 拒绝启动：WM_TRUSTED_PROXIES 有非法项（只收 IP 或 CIDR）：${tp.invalid.join(', ')}`); process.exit(1); }
  if (tp.entries.length) console.log(`[trusted-proxies] 认这些对端写入的 X-Real-IP/X-Forwarded-For：${tp.entries.join(', ')}（回环恒可信）`);
}
const A2A_DIRECT_SIG_RAW = directSigMode();
const A2A_DIRECT_SIG_BODY = directSigBodyMode();
if (!A2A_DIRECT_SIG_RAW || !A2A_DIRECT_SIG_BODY) {
  console.error('[a2a-direct-sig] 拒绝启动：WM_A2A_DIRECT_SIG 只接受 require / accept / off / 不设，WM_A2A_DIRECT_SIG_BODY 只接受 require / accept / 不设');
  process.exit(1);
}
const A2A_DIRECT_SIG: DirectSigMode = loginGate.enforced ? 'require' : A2A_DIRECT_SIG_RAW;
if (loginGate.enforced && A2A_DIRECT_SIG_RAW !== 'require') console.warn(`[a2a-direct-sig] WM_A2A_DIRECT_SIG=${A2A_DIRECT_SIG_RAW} 被忽略：WM_LOGIN_GATE=enforce 时 /a2a/direct 强制 require`);
const directSig = createDirectSigVerifier({ audiences: () => [marketPublicUrl()], bodyMode: A2A_DIRECT_SIG_BODY });
app.use(loginGate.middleware);
loginRelay().install(app); // narrow same-origin Odoo login, before any body parser
// Explicit opt-in only; no default content listener, no live configuration writes.
const contentCfg = contentConfig(process.env);
const portalObserver = process.env.WM_PORTAL_OBSERVE === '1' ? createPortalObservation(db, id => !!svc<WorkbenchService>('workbench').exists(id)) : null;
app.use((req, _res, next) => { if (surfaceOf(req) === 'market') portalObserver?.observe(req); next(); });
if (contentCfg) {
  const odoo = String(process.env.WM_CONTENT_ODOO_ORIGIN ?? '');
  const parsed = new URL(odoo);
  const ports = surfacePorts();
  if (contentCfg.port === ports.market || contentCfg.port === ports.control) throw Error('Content port must be distinct');
  if (parsed.origin !== odoo || !loginRelay().trustedOrigins().origins.has(odoo)) throw Error('Content viewer source must be an explicitly trusted Odoo origin');
}
const contentRuntime = contentCfg ? createContentSurface(contentCfg, {
  async viewer(cookie) {
    // Reject duplicate SID instead of inheriting the legacy first-cookie ambiguity.
    const values = loginRelay().sessionEntries(cookie);
    if (values.length !== 1) return null;
    const result = await identity().resolveViewer(values[0], process.env.WM_CONTENT_ODOO_ORIGIN);
    return result.ok ? { subject: result.viewer.sub + ':' + result.viewer.uid, internal: true } : null;
  },
  staticTarget(id) {
    // Exact metadata projection: no auth_config, Cookie pool or app token read.
    const w = db.prepare('SELECT url, enabled FROM workbenches WHERE id = ?').get(id) as { url: string; enabled: number } | undefined;
    const match = w?.enabled ? /^[/]apps[/]([a-z0-9][a-z0-9-]{0,63})[/]$/.exec(w.url) : null;
    if (!w || !match) return null;
    const a = db.prepare('SELECT active_version, kind, status FROM apps WHERE slug = ?').get(match[1]) as { active_version: number; kind: string; status: string } | undefined;
    if (!a || a.kind !== 'app' || a.status !== 'active') return null;
    return { url: w.url, root: join(appsRoot, match[1], 'v' + a.active_version), version: a.active_version };
  },
  upstream(id) {
    const w = wbById(id);
    if (!w || !w.enabled || w.cookie_set_id) return null; // cookie containers require a separate adapter, never browser fallback
    return { url: w.url, authorization: w.auth?.type === 'bearer' ? 'Bearer ' + w.auth.value : w.auth?.type === 'basic' ? 'Basic ' + Buffer.from(w.auth.value, 'utf8').toString('base64') : undefined };
  },
}) : null;
if (contentRuntime) {
  mountContentSurface(app, contentRuntime); // TERMINAL content dispatch before every shared parser/route/SPA
  app.use((req, res, next) => {
    if (!req.url.startsWith('/content/open/')) return next();
    if (surfaceOf(req) !== 'market') return res.status(404).end();
    contentRuntime.launch(req, res, next);
  });
  app.use((req, res, next) => {
    if (surfaceOf(req) !== 'market') return next();
    contentRuntime.migrate(req, res, next);
  });
}
// issue #1：CORS 从全开放收紧为白名单——生产形态（web/dist 由本服务同源托管）不需要跨源；
// 仅 web dev（vite 5173，其 /api 代理是同源转发、但直连调试场景保留）放行本机回环源。
// /mcp 为 StreamableHTTP POST（非浏览器 fetch 场景不受 CORS 约束；浏览器 MCP 客户端经同源门户）。
const CORS_ALLOW = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ALLOW.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: false,
}));
// 凭据库专用域名（WM_VAULT_HOST）：服务端持有主密码时凭据库只在这个源（或控制面）开放。按请求 Host 精确比较、不分大小写、不看端口；
// 防的是浏览器里主域名上的同源脚本（/go/ 外站、SOP 正文）——它们改不了 Host、也读不到跨源响应。非浏览器客户端本来就要管理员口令。
const VAULT_HOST = String(process.env.WM_VAULT_HOST ?? '').trim().toLowerCase();
if (VAULT_HOST && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(VAULT_HOST)) {
  console.error('[vault] 拒绝启动：WM_VAULT_HOST 只接受主机名（如 vault.example.com，不带协议、端口、路径）');
  process.exit(1);
}
// 属主取舍（不开 9801、不用专用域名，又要管理员免输主密码）：显式开关 WM_VAULT_SERVER_PASSWORD_ON_MAIN=accept-same-origin-risk
// 才让服务端持有主密码时凭据库也在主域名开放。残余风险：管理员登着时，/go/ 外站页面或带脚本的 SOP 正文可静默读走全部凭据明文。
const VAULT_ON_MAIN_RAW = String(process.env.WM_VAULT_SERVER_PASSWORD_ON_MAIN ?? '').trim();
if (VAULT_ON_MAIN_RAW && VAULT_ON_MAIN_RAW !== 'accept-same-origin-risk') {
  console.error('[vault] 拒绝启动：WM_VAULT_SERVER_PASSWORD_ON_MAIN 只接受 accept-same-origin-risk 或不设');
  process.exit(1);
}
const VAULT_ON_MAIN = VAULT_ON_MAIN_RAW === 'accept-same-origin-risk';
if (VAULT_ON_MAIN) console.warn('[vault] WM_VAULT_SERVER_PASSWORD_ON_MAIN=accept-same-origin-risk：服务端持有主密码时凭据库在主域名开放，同源内容可静默读走全部凭据');
function onVaultHost(req: express.Request): boolean {
  if (!VAULT_HOST) return false;
  return String(req.headers.host ?? '').trim().toLowerCase().replace(/:\d+$/, '') === VAULT_HOST;
}
// #292 M1 控制面围栏：控制面（WM_CONTROL_PORT）不承载任何不可信内容，也不许被嵌、不嵌别人；凭据库专用域名同一道围栏
app.use((req, res, next) => {
  if (surfaceOf(req) !== 'control' && !onVaultHost(req)) return next();
  // 用 Express 路由同一个 pathname（req.path：已剥查询串、已处理绝对形式 http://x/mcp），再按小写判——路由不区分大小写（/MCP、/A2A/direct 曾漏过；#299 绝对形式）
  const p = req.path.toLowerCase();
  if (/^\/(go|sop|apps)(\/|$)/.test(p) || p === '/mcp' || p === '/openapi.json' || p.startsWith('/api/mcp-rest/') || p.startsWith('/a2a/')) return res.status(404).type('text').send(surfaceOf(req) === 'control' ? '控制面不提供此路径（请用业务面）\n' : '凭据库域名不提供此路径（请用主域名）\n');
  res.setHeader('content-security-policy', "frame-ancestors 'none'; frame-src 'none'");
  res.setHeader('x-frame-options', 'DENY');
  next();
});
// #336 工作台变量：鉴权依赖（函数声明有提升，请求期已定义）；沙箱页面按台令牌 CORS
const workbenchVars = createWorkbenchVars({ appToken: wmAppToken, markOdooAdmin, adminRead: vaultGuard, adminWrite: adminGuard, adminActor });
app.use(workbenchVars.cors);
// #198（裁 A）：自产台数据/文件面的按台令牌 CORS——sandbox 页面（Origin: null）凭 X-App-Token 匹配 slug 才放行
app.use((req, res, next) => {
  // #198 复修②：路径匹配前剥查询串（GET …/data?limit= 形态此前漏放 ACAO）
  const _pathOnly = String(req.url ?? '').split('?')[0];
  const m = /^\/api\/apps\/([a-z0-9][a-z0-9-]*)\/(data|files)(?:\/|$)/.exec(_pathOnly);
  if (!m) return next();
  const origin = String(req.headers.origin ?? '');
  if (origin !== 'null') return next(); // 常规同源/白名单走 cors 中间件
  const slug = m[1];
  const _setAcao = () => {
    res.setHeader('access-control-allow-origin', 'null');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,x-app-token');
    res.setHeader('access-control-max-age', '600');
  };
  // #198 复修①：预检（OPTIONS）按 CORS 规范**不带自定义头值**——只回 ACAO/允许头，不校验令牌；实际请求才校验
  if (req.method === 'OPTIONS') { _setAcao(); return res.status(204).end(); }
  const presented = String(req.headers['x-app-token'] ?? '').trim();
  const expected = wmAppToken(slug);
  const okTok = presented.length > 0 && presented.length === expected.length && timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
  if (!okTok) return next(); // 无/错令牌：不发 ACAO（浏览器侧拒绝读）
  _setAcao();
  return next();
});
// body 解析：/go/ 路径跳过（品味席 direct-2999b07d 实测——express.json 在 HPM 之前
// 消费了 body 流，上游需要读 body 的 POST（如 taste-mcp 的 tools/call）永远等不到
// end 事件挂起；401 路径不读 body 所以「看起来通」）。/go/ 的 body 由 HPM 原样 pipe。
// /mcp 的 app_files_upload 用 base64 传文件：100MB 原始 ≈ 134MB base64，再留 JSON-RPC 包装余量。
// 只给带有效会话令牌的 /mcp 请求放大：本中间件先于 /mcp 路由里的会话判定执行，不先认令牌，匿名请求也能把 72MB 读进内存
// REST 开放的工具调用（/api/mcp-rest/tools/<name>）同口径：请求体就是工具参数，app_files_upload 一样带 base64
const MCP_BODY_LIMIT = '140mb';
function bodyLimitFor(req: express.Request): string {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/mcp' && !path.startsWith('/api/mcp-rest/tools/')) return '4mb';
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(String(req.headers.authorization ?? ''));
  return m && mcpSessionByToken(m[1]) ? MCP_BODY_LIMIT : '4mb';
}
// MCP REST 原始字节上传（PUT /api/mcp-rest/apps/<slug>/files/<name>）：请求体就是文件（data.json 也带 application/json），由路由流式落盘，不经 JSON 解析。
// 用 req.path（与路由同一个 pathname，已处理绝对形式请求目标 #299）+ 不区分大小写（路由同样不区分）
const MCP_REST_RAW_UPLOAD = /^\/api\/mcp-rest\/apps\/[^/]+\/files\/[^/]+$/i;
app.use((req, res, next) => {
  if ((req.url ?? '').startsWith('/go/')) return next();
  if (req.method === 'PUT' && MCP_REST_RAW_UPLOAD.test(req.path)) return next();
  // /a2a/direct 的 body 签名要原始字节（a2a-direct-sig.ts 的 X-WM-Body-Sha256）
  // 登录方式的失效通知（/login/<方式>/events）同样要原始字节：飞书的签名算在原始请求体上
  const keepRaw = req.method === 'POST' && (req.path.toLowerCase() === '/a2a/direct' || /^\/login\/[a-z0-9][a-z0-9-]{0,31}\/events$/i.test(req.path));
  return express.json({ limit: bodyLimitFor(req), ...(keepRaw ? { verify: (r: IncomingMessage, _res: unknown, buf: Buffer) => { (r as IncomingMessage & { rawBody?: Buffer }).rawBody = buf; } } : {}) })(req, res, next);
});

// GH #20 P1 ④远程面收口：非本机请求只放 /mcp、/.well-known/agent-card.json、/a2a/direct——
// 其余 /api/* 写操作要 X-Admin-Token（本机 REST 面维持内网信任模型不变；此中间件只拦远程写）。
// 主人裁定 A（2026-10-23）：自产台数据/文件面对远程浏览器开放——应用层写，与发布面同口径；
// 控制面（/api/mcp/*、/api/sops/*/bindings 等）照旧收口。没有这条，远程节点浏览器提交表单会 403。
const REMOTE_ALLOW_EXACT = new Set(['/mcp', '/.well-known/agent-card.json', '/a2a/direct', '/api/auth/login', '/api/auth/logout']); // 登录/登出自带同源门与限频
// ---------- 端点命中计数（总工程师 B 类单：采纳监测 instrumentation）----------
// 必须挂在所有业务路由之前（Express 按注册序匹配，路由先响应则后续 use 不再执行）
app.use(endpointStatsMiddleware());

// #T1（评审裁定 direct-7d8eaa75，与裁定 A 同语义）：SOP Runner 业务写面——建单/存步/完成/附件
// 对远程浏览器开放（.157 业务同事裸开 Runner 页提交 403 即本缺口）；精确到业务子路径：
// assign（派单指派）是控制面不豁免；/api/sops/* 控制面照旧收口（smoke 判据④⑤护栏钉死）。
const REMOTE_ALLOW_PREFIX = [
  /^\/api\/apps\/[a-z0-9-]{1,64}\/(data|files)(\/|$)/,
  /^\/api\/sop\/runs(\/\d+(\/(finish|files|files\/refs))?)?$/, // files/refs：引用已有文件，路由内与上传同一道写门，另逐条核源 run 读授权
  // 工作台事件 v1：接单节点回写决定（凭投递里的 reply token 鉴权，不认口令；只此一条子路径）
  /^\/api\/workbench-events\/wbe-[0-9a-f]{16}\/decision$/,
  // 阶段八 8e：建立人本人验收、退回自己的事项（路由内经身份服务认人、事项服务判是不是建立人；只此一条子路径）
  /^\/api\/work-items\/wi_[A-Za-z0-9_-]{1,96}\/decision$/,
  // MCP 工具 REST 开放：与 /mcp 同口径，凭会话令牌在路由内鉴权，不认管理口令
  /^\/api\/mcp-rest\/(tools\/[^/]+|apps\/[a-z0-9-]{1,64}\/files(\/[^/]+)?)$/,
];

// S3 豁免面可观测（评审席裁下批·PR#72 真事故锚）：启动时快照+diff——安全清单变更不再无声
const remoteAllowSnapshot = () => [
  ...[...REMOTE_ALLOW_EXACT],
  ...REMOTE_ALLOW_PREFIX.map((re) => String(re)),
];
function computeAllowDiff() {
  const cur = remoteAllowSnapshot();
  let prev: string[] | null = null;
  try {
    const row = db.prepare('SELECT snapshot FROM remote_allow_state ORDER BY id DESC LIMIT 1').get() as { snapshot: string } | undefined;
    if (row) prev = JSON.parse(row.snapshot);
  } catch { prev = null; }
  const added = prev === null ? [] : cur.filter((p) => !prev!.includes(p));
  const removed = prev === null ? [] : prev!.filter((p) => !cur.includes(p));
  if (prev === null || added.length > 0 || removed.length > 0) {
    db.prepare('INSERT INTO remote_allow_state (snapshot) VALUES (?)').run(JSON.stringify(cur));
  }
  return { added, removed, current: cur };
}
// 快照在扩展加载之后才取（扩展可经 ctx.remoteWrite.allowExact 加业务写面），见下方扩展段
let lastAllowDiff: ReturnType<typeof computeAllowDiff> = { added: [], removed: [], current: remoteAllowSnapshot() };
function announceAllowDiff(): void {
  lastAllowDiff = computeAllowDiff();
  if (lastAllowDiff.added.length === 0 && lastAllowDiff.removed.length === 0) return;
  console.warn(`[S3 豁免面变更] added=${JSON.stringify(lastAllowDiff.added)} removed=${JSON.stringify(lastAllowDiff.removed)}`);
  // S3 联动（direct-6a39fc57 ③）：变更通知绑定台面——延迟投（等所有 svc 就绪·尽力而为）
  setTimeout(() => {
    try {
      const nts = db.prepare("SELECT target_slug, agent_node, notify_url FROM bindings WHERE direction IN ('notify','both') AND revoked_at = '' AND notify_url != ''").all() as { target_slug: string; agent_node: string; notify_url: string }[];
      for (const nt of nts) {
        a2aSendOutbound(a2aKeyPath(), { baseUrl: nt.notify_url, team: nt.agent_node }, JSON.stringify({
          type: 'remote-allow-changed', added: lastAllowDiff.added, removed: lastAllowDiff.removed,
          hint: '安全豁免清单已变更——如你的台面行为突变（403/201 变化），此处即根因',
        })).catch(e2 => console.error(`[S3-notify] ${nt.target_slug}→${nt.agent_node}: ${String(e2).slice(0, 80)}`));
      }
    } catch { /* 不阻启动 */ }
  }, 3000);
}
/** 扩展的业务写面：远程浏览器 POST 该路径不经管理写门（不要口令、不查 Odoo 管理员），由扩展路由自己判身份与同源。
 *  只收 /api/<命名空间>/… 精确路径，命名空间不得是宿主的；进 S3 豁免面快照，变更照常告警与通知 */
const HOST_API_NAMESPACES = new Set(['a2a', 'admin', 'admin-token', 'apps', 'auth', 'bindings', 'change-requests', 'check-all', 'cockpits', 'content', 'cookies', 'design', 'export', 'health', 'import', 'mcp', 'mcp-rest', 'remote-allow', 'settings', 'skills', 'sop', 'sops', 'stats', 'summary', 'task-center', 'tasks', 'types', 'vault', 'workbench-events', 'workbenches']);
function allowExtensionRemoteWrite(path: string): void {
  const m = /^\/api\/([a-z0-9][a-z0-9-]{0,63})(\/[a-z0-9][a-z0-9-]{0,63}){1,3}$/.exec(path);
  if (!m) throw new Error(`业务写面路径非法（须 /api/<命名空间>/<段>，小写）：${path}`);
  if (HOST_API_NAMESPACES.has(m[1])) throw new Error(`业务写面不能落在宿主命名空间 /api/${m[1]}/：${path}`);
  REMOTE_ALLOW_EXACT.add(path);
}
// 管理身份（属主 2026-11-02 裁定：撤销 #292 M1「管理写只认控制面」，有管理员口令就够；Odoo 管理员登录也算管理员）：
//   带 Odoo 会话 cookie、却没带有效口令的 /api 请求，现查 Odoo get_session_info；内部员工且 is_admin=true 即记为管理员。
//   提供方的回答按会话哈希缓存 30 秒（Odoo 侧撤管理员权限最迟 30 秒生效），缓存在身份服务里，不缓存会话本身；
//   主体停没停用不进缓存，每次现查：停用一个主体，管理员认定立即不成立。
const ODOO_ADMIN_TTL_MS = 30_000;
const odooAdminViewer = identity().cachedResolver({ ttlMs: ODOO_ADMIN_TTL_MS, max: 1000 });
const odooAdminReqs = new WeakMap<express.Request, string>(); // 本次请求经 Odoo 管理员认定 → 登录名
async function odooAdminOf(cookieHeader: string): Promise<string | null> {
  if (!identity().credentialOf(cookieHeader)) return null;
  try {
    // Explicit relay logout revokes Odoo sessions; never reuse a stale admin verdict.
    const who = loginRelay().relayLogin() ? await identity().resolveViewer(cookieHeader) : await odooAdminViewer(cookieHeader);
    return who.ok && who.viewer.admin ? who.viewer.login : null;
  } catch { return null; }
}
/** 按需认定：只在确实要判管理员的请求上现查（写门调 adminGuard 前、管理读面、口令设置、whoami），其余请求不碰 Odoo */
async function markOdooAdmin(req: express.Request): Promise<void> {
  if (odooAdminReqs.has(req) || surfaceOf(req) === 'content' || adminTokenCheck(req.headers['x-admin-token'])) return;
  const cookie = String(req.headers.cookie ?? '');
  if (!identity().credentialOf(cookie)) return;
  const login = await odooAdminOf(cookie);
  if (login) odooAdminReqs.set(req, login);
}
// 管理读面（GET 也走 adminGuard/vaultGuard 的）与口令/身份端点：进路由前先认定
const ADMIN_IDENTITY_PATHS = /^\/api\/(admin\/whoami|admin-token(\/|$)|mcp\/(sessions|upstreams|tools|calls|access-requests)(\/|$)|change-requests(\/|$)|bindings(\/|$)|remote-allow\/diff|vault\/|tasks(\/|$)|workbench-events(\/|$))/; // tasks：统一待办读面同样认 Odoo 管理员（与口令管理员同为全量）；workbench-events：工作台事件的列表、详情也认（「关注」的席位提问同口径）
app.use(async (req, _res, next) => {
  if (ADMIN_IDENTITY_PATHS.test(req.path.toLowerCase())) await markOdooAdmin(req);
  next();
});
// 写请求总门。
//   本机 CLI（回环直连、不带浏览器标记、没有反代转发头）照旧免口令——属主口径；
//   其余 /api 管理写走 adminGuard：有效口令或 Odoo 管理员，浏览器来的还要同源；同机反代转进来的按远程处理。
//   业务写白名单（REMOTE_ALLOW_*）不变，照旧免口令。
app.use(async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next(); // 读面不拦（掩码已有）
  // 与路由同口径分类：req.path 是 Express 路由用的 pathname（绝对形式 POST http://x/api/… 的原始 req.url 不以 /api/ 开头，曾绕过本门：#299）；
  // 再统一转小写：路由默认不区分大小写，/API/workbenches 也会命中 /api/workbenches（评审席 #294 复验；main 热修 #295）
  const p = req.path.toLowerCase();
  if (REMOTE_ALLOW_EXACT.has(p)) return next();
  if (REMOTE_ALLOW_PREFIX.some((re) => re.test(p))) return next(); // 自产台数据/文件面（主人裁定 A）
  if (!browserMarked(req) && rawLoopback(req)) return next(); // 本机 CLI
  if (workbenchVars.appTokenWrite(req)) return next(); // #336：自产台/SOP 台凭本台令牌写本台变量（路由内再判）
  if (p === '/api/admin-token') return next(); // 设/清口令由路由自己判（首次设置时还没有口令可验）
  if (p.startsWith('/api/')) {
    // 其余 /api/* 写：走 adminGuard（函数声明有提升，请求期已定义）；先按需认定 Odoo 管理员
    await markOdooAdmin(req);
    if (adminGuard(req, res)) return next();
    return; // adminGuard 已回 403
  }
  return next(); // 其余非 /api 面（如 /go/ 门户读型代理）不在本判据范围
});

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch(next);
  };

const bad = (msg: string): never => { throw new HttpError(400, msg); };

// ---------- 工作台 CRUD ----------
function listWorkbenches(): ReturnType<typeof rowToWorkbench>[] {
  const rows = svc<WorkbenchService>('workbench').listSorted() as unknown as WorkbenchRow[];
  return rows.map(rowToWorkbench);
}

// 凭据面防浏览泄露（监督席派单 direct-30b57179/320ed1a5/74a7d418 安全批）：无认证 API 出口
// （REST 列表/详情 + MCP 工具）对 url query 敏感参数与 auth.value 统一掩码；代理侧 DB 直读不受影响。
const SENSITIVE_QUERY_KEYS = /^(token|password|passwd|secret|api[-_]?key|access[-_]?token|auth)$/i;
function maskSensitiveQuery(url: string): string {
  const qi = url.indexOf('?');
  if (qi < 0) return url;
  const head = url.slice(0, qi + 1);
  const search = url.slice(qi + 1);
  const hashIdx = search.indexOf('#');
  const hash = hashIdx >= 0 ? search.slice(hashIdx) : '';
  const qs = hashIdx >= 0 ? search.slice(0, hashIdx) : search;
  if (!qs) return url;
  const masked = qs.split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq < 0) return kv;
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    return SENSITIVE_QUERY_KEYS.test(k) ? `${k}=****` : kv;
  }).join('&');
  return head + masked + hash;
}

/** API 出口统一脱敏（issue #2 auth.value + #3 MCP 通道）：REST 与 MCP 共用 */
function maskForApi<T extends { url: string; auth: { type: string; value: string } | null }>(w: T): T {
  return { ...w, url: maskSensitiveQuery(w.url), auth: w.auth ? { ...w.auth, value: '****' } : w.auth };
}

function validateWorkbenchBody(b: any, partial = false) {
  const out: any = {};
  if (!partial || b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) bad('name 不能为空');
    out.name = b.name.trim();
  }
  if (!partial || b.url !== undefined) {
    if (typeof b.url !== 'string' || !b.url.trim()) bad('url 不能为空');
    const u = b.url.trim();
    // 掩码指纹不得入新建（复制工作台从列表带回掩码 url 时在这里拦下，防 **** 落库成坏台）
    if (u.includes('=****')) bad('url 含掩码占位（****）——请填写真实地址（列表展示的 token 已脱敏）');
    // #258：格式/分类/许可统一在 cores 里经 admitUrl 判（需要知道 update 前的原 url 与操作类型）
    out.url = u;
  }
  if (b.type !== undefined) out.type = String(b.type || 'web');
  for (const k of ['icon', 'description', 'category', 'health_path'] as const) {
    if (b[k] !== undefined) out[k] = String(b[k] ?? '');
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) bad('tags 必须是数组');
    out.tags = JSON.stringify(b.tags.map(String));
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.sort !== undefined) out.sort = Number(b.sort) || 0;
  // 凭据注入（可选）：{type:'bearer'|'basic', value} 经统一门户 /go/ 代理时注入 Authorization 头；
  // null / 空对象 / 空串 = 清除。明文入库是已知信任假设（内网全员模型，README「信任模型」）。
  if (b.auth !== undefined) {
    if (b.auth === null || b.auth === '' || (typeof b.auth === 'object' && b.auth !== null && !('type' in b.auth) && !('value' in b.auth))) {
      out.auth_config = '';
    } else if (typeof b.auth === 'object' && (b.auth.type === 'bearer' || b.auth.type === 'basic')) {
      if (typeof b.auth.value !== 'string' || !b.auth.value) bad('auth.value 不能为空');
      if (b.auth.value.length > 4096) bad('auth.value 过长（>4096）');
      // issue #2 掩码指纹：PUT（partial）视为「未变更」不写 out（保留 DB 原值）；POST 拒绝
      if (b.auth.value === '****') {
        if (!partial) bad('auth.value 含掩码占位（****）——请填写真实凭据（接口展示已脱敏）');
      } else {
        out.auth_config = JSON.stringify({ type: b.auth.type, value: b.auth.value });
      }
    } else {
      bad('auth 形态：{type:"bearer"|"basic", value:string} 或 null');
    }
  }
  return out;
}

// #258 R3 准入：WM_REGISTER_URL_ALLOWLIST 是进程启动快照；坏配置拒绝启动（不回落成更宽或更窄的默认）
const URL_POLICY: AllowPolicy = (() => {
  try { return loadAllowPolicy(process.env.WM_REGISTER_URL_ALLOWLIST); }
  catch (e: any) { console.error(`[R3] 拒绝启动：${e?.message ?? e}`); process.exit(1); }
})();
if (!process.stderr.writable) { console.log('[R3] 拒绝启动：stderr 不可写（准入审计日志渠道）'); process.exit(1); }
process.stderr.on('error', () => { markAuditChannelFailed(); }); // 审计渠道断：锁存故障，后续 allow 都报降级；不让 error 事件打死进程

/** 内部路径的台必须存在：/sop/<slug>/ 对 kind=sop，/apps/<slug>/ 对其余 */
function internalTargetExists(area: 'apps' | 'sop', slug: string): boolean {
  const row = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
  return !!row && (area === 'sop' ? row.kind === 'sop' : row.kind !== 'sop');
}

/** 单核准入 + deny 审计（限量）；返回值供 commit 后写 allow 日志 */
function admitOrDeny(op: 'register' | 'update' | 'import', url: string) {
  try { return admitUrl(url, URL_POLICY, internalTargetExists); }
  catch (e) {
    if (e instanceof AdmissionError) {
      let key: string | null = null;
      try { key = analyzeUrl(url).key; } catch { /* 格式坏到无 key */ }
      auditDeny(op, e.code, key);
    }
    throw e;
  }
}

/** cores 的调用上下文：subject 只放已核认证标识；auditOk=false 时调用方回 X-WM-Audit-State: degraded */
interface WriteCtx { subject: string; auditOk?: boolean }

// CRUD 共用核心（REST 与 MCP workbench_register/update/unregister 同链）：
// MCP 面不接受 auth 字段（凭据只经人工 REST/表单——安全边界内置）
function workbenchCreateCore(body: any, ctx: WriteCtx = { subject: 'anonymous' }): ReturnType<typeof rowToWorkbench> {
  const f = validateWorkbenchBody(body);
  const adm = admitOrDeny('register', f.url);
  checkHealthPath(f.url, f.health_path ?? '');
  const r = svc<WorkbenchService>('workbench').createByNamed({ type: 'web', icon: '', description: '', category: '', tags: '[]', enabled: 1, health_path: '', sort: 0, auth_config: '', ...f }) as unknown as { lastInsertRowid: number | bigint };
  const row = svc<WorkbenchService>('workbench').byId(Number(r.lastInsertRowid)) as unknown as WorkbenchRow;
  if (adm.allowlisted) ctx.auditOk = auditAllow('register', URL_POLICY, adm.key!, row.id, ctx.subject);
  return rowToWorkbench(row);
}

function workbenchUpdateCore(id: number, body: any, ctx: WriteCtx = { subject: 'anonymous' }): ReturnType<typeof rowToWorkbench> {
  const cur = svc<WorkbenchService>('workbench').byId(id) as unknown as WorkbenchRow | undefined;
  if (!cur) throw new HttpError(404, `workbench not found: ${id}`);
  const f = validateWorkbenchBody(body, true);
  // 掩码回传保护（url 面）：编辑表单从 API 取到的是掩码值，原样回传视为「未变更」
  if (f.url !== undefined && f.url.includes('=****') && f.url !== cur.url) delete f.url;
  // #258：url 未变（原样或同一规范化 key、同 fragment）= 纯元数据更新，沿旧行原 url（存量公网行不因改名被拒/删）；
  // scheme/host/port/path/query 任一变化都是新 url，必须重新准入
  if (f.url !== undefined && (f.url === cur.url || sameTarget(cur.url, f.url))) delete f.url;
  const adm = f.url !== undefined ? admitOrDeny('update', f.url) : null;
  if (f.url !== undefined || f.health_path !== undefined) checkHealthPath(f.url ?? cur.url, f.health_path ?? cur.health_path ?? '');
  // cookie_set_id 挂接（派单 direct-5fbb2176：nullable=0 取消挂接，正数须为池条目）
  if (body.cookie_set_id !== undefined) {
    const cid = Number(body.cookie_set_id) || 0;
    if (cid > 0) {
      const hit = svc<CookieService>('cookie').byId(cid);
      if (!hit) bad(`cookie_set_id 不存在: ${cid}`);
    }
    (f as any).cookie_set_id = cid;
  }
  const merged = { ...cur, ...f };
  svc<WorkbenchService>('workbench').updateAll({
    name: merged.name, url: merged.url, type: merged.type, icon: merged.icon,
    description: merged.description, category: merged.category, tags: merged.tags,
    enabled: merged.enabled, health_path: merged.health_path, sort: merged.sort,
    auth_config: merged.auth_config ?? '', cookie_set_id: (merged as any).cookie_set_id ?? 0, id,
  });
  const row = svc<WorkbenchService>('workbench').byId(id) as unknown as WorkbenchRow;
  if (adm?.allowlisted) ctx.auditOk = auditAllow('update', URL_POLICY, adm.key!, id, ctx.subject);
  return rowToWorkbench(row);
}

function workbenchDeleteCore(id: number): { ok: boolean; deleted: number } {
  const r = svc<WorkbenchService>('workbench').delete(id);
  if (!r.changes) throw new HttpError(404, `workbench not found: ${id}`);
  dropWorkbenchVars(id); // #336 变量随台删除
  // issue #9：删除工作台同步清掉各驾驶舱对它的面板引用——否则悬空面板会让之后每次保存布局 400
  const cocks = svc<CockpitService>('cockpit').all() as unknown as CockpitRow[];
  for (const c of cocks) {
    let panels: PanelConfig[];
    try { panels = JSON.parse(c.layout_config || '[]'); } catch { continue; }
    const kept = panels.filter((p) => p.workbenchId !== id);
    if (kept.length !== panels.length) {
      svc<CockpitService>('cockpit').setLayout(c.id, JSON.stringify(kept));
    }
  }
  return { ok: true, deleted: id };
}

/** 审计主体：只认已核的管理口令；X-Market-Client 等自报头不算身份 */
const restSubject = (req: express.Request) => (adminHeaderOk(req) ? 'admin' : 'anonymous');

// ---------- 健康检查 ----------
function typeOf(key: string): TypeRow | undefined {
  return svc<WorkbenchService>('workbench').typeByKey(key) as unknown as TypeRow | undefined;
}

async function checkOne(w: WorkbenchRow): Promise<ReturnType<typeof rowToWorkbench>> {
  // 自产台（url 以 / 开头）由本服务静态托管：不发 HTTP 探测，但要核实台本身还在——
  // /apps/<slug>/ 要求台存在，/sop/<slug>/ 要求 SOP 存在且已上架；否则记 down（台被删或下架后卡片不再显示在线）
  if (w.url.startsWith('/')) {
    const self = /^\/(apps|sop)\/([a-z0-9][a-z0-9-]*)(\/|$)/.exec(w.url);
    if (self) {
      const a = (self[1] === 'sop' ? svc<AppService>('app').sopBySlug(self[2]) : svc<AppService>('app').bySlug(self[2])) as unknown as AppRow | undefined;
      const why = !a ? `${self[1] === 'sop' ? 'SOP' : '自产台'}不存在：${self[2]}` : self[1] === 'sop' && a.status !== 'published' ? `SOP 状态为 ${a.status}，未上架` : '';
      if (why) {
        svc<WorkbenchService>('workbench').markDownWithError(w.id, why);
        return rowToWorkbench(svc<WorkbenchService>('workbench').byId(w.id) as unknown as WorkbenchRow);
      }
    }
    svc<WorkbenchService>('workbench').markSelfUp(w.id);
    const selfRow = svc<WorkbenchService>('workbench').byId(w.id) as unknown as WorkbenchRow;
    return rowToWorkbench(selfRow);
  }
  const t = typeOf(w.type);
  const settings = getSettings();
  // issue #8：坏 health_path / 非法组合不得让单测整体 500——探测目标构造失败时该台记 down
  let target: string;
  try {
    // #258 U15：实际生效的 health_path（台自己的或类型继承的）在探测处统一按台 origin 核——存量/类型/导入/MCP 同一处兜住
    const effective = w.health_path || t?.health_path || '';
    try { checkHealthPath(w.url, effective); } catch (e: any) { throw new Error(`health_path 被拒：${e?.extra?.message ?? e?.message}`); }
    target = composeProbeUrl(w.url, effective);
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    svc<WorkbenchService>('workbench').markDownWithError(w.id, reason);
    const row = svc<WorkbenchService>('workbench').byId(w.id) as unknown as WorkbenchRow;
    return rowToWorkbench(row);
  }
  // probe 内部 assertHttpUrl 在 try 外（残缺 URL 如 http:// 会在断言处抛）——再兜一层，
  // 目标不可探测一律记 down 不炸单测/全测
  let result: Awaited<ReturnType<typeof probe>>;
  try {
    result = await probe(target, {
      method: t?.health_method || 'GET',
      timeoutMs: Number(settings.health_timeout_ms) || 5000,
      expectStatus: t?.expect_status ?? null,
    });
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    svc<WorkbenchService>('workbench').markDownWithError(w.id, `探测失败：${reason}`);
    const row = svc<WorkbenchService>('workbench').byId(w.id) as unknown as WorkbenchRow;
    return rowToWorkbench(row);
  }
  svc<WorkbenchService>('workbench').applyProbeResult({ status: result.status, latency: result.latency_ms, code: result.http_code, error: result.error, id: w.id });
  const row = svc<WorkbenchService>('workbench').byId(w.id) as unknown as WorkbenchRow;
  return rowToWorkbench(row);
}

// 台驱逐冷却（与 a2a-net peer 驱逐冷却同名不同物·命名区分，direct-53caaed3）：
// 连续 down 的台进入 24h 冷却窗，窗内每窗只探一次（防 flapping）。up 即清零；内存态（重启清零，保守）。
const EVICT_COOLDOWN_MS = Number(process.env.A2A_EVICT_COOLDOWN_MS) > 0 ? Number(process.env.A2A_EVICT_COOLDOWN_MS) : 24 * 3_600_000; // 测试可加速
const downSince = new Map<number, number>();
const lastProbeAt = new Map<number, number>();
registerWorkbenchRoutes(http, { wrap, listWorkbenches, maskForApi, restSubject, workbenchCreateCore, workbenchUpdateCore, workbenchDeleteCore, checkOne, downSince, lastProbeAt, EVICT_COOLDOWN_MS });

// ---------- 驾驶舱 CRUD（任务驾驶舱：多工作台分屏组合视图） ----------
registerCockpitRoutes(http);

// ---------- 自产台（台生成器：AI 发布 API + 全版本快照，发布即入册） ----------
const appsRoot = join(dataDir, 'apps');
initializeTaskCenter(appsRoot);
startWorkbenchEventWorker(); // 工作台事件 v1（人提交 → 事件 → 团队接单）；表随 initializeTaskCenter 建
// #198（监督席裁 A·P11 回归修复）：自产台按台令牌——CSP sandbox 下页面源为 null，
// 交付空间模式（页面调本台 data/files）靠「Origin: null + X-App-Token 匹配 slug」放行 CORS。
const APP_TOKEN_KEY_FILE = join(dataDir, '.wm-app-token.key');
initSubmitterTickets(dataDir); // 8f-2：提交人票据的密钥（单独一把，不和台令牌共用）
selfCheckSubmitterTickets(); // 8f-2 启动自检：验不对就关掉票据（不出、不认）
let _appTokenKey = '';
// 登录门首次 enforce：按台令牌永久有效，开门之前它在公网页面上谁都拿得到；登录门又对带令牌的 data/files 直接放行，
// 所以首次 enforce 启动时换一把新密钥（旧令牌全部作废），写记号 .wm-app-token.gate 后不再重复。原子替换、权限 600、日志不记密钥。
// 写不进去（只读卷）：本进程用随机密钥（旧令牌同样作废，重启再换），不写记号
const APP_TOKEN_GATE_MARK = join(dataDir, '.wm-app-token.gate');
if (loginGate.enforced && !existsSync(APP_TOKEN_GATE_MARK)) {
  const fresh = randomBytes(32).toString('hex');
  try {
    const tmp = `${APP_TOKEN_KEY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, fresh, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, APP_TOKEN_KEY_FILE);
    writeFileSync(APP_TOKEN_GATE_MARK, JSON.stringify({ rotated_at: new Date().toISOString(), reason: 'login-gate-enforce' }) + '\n', { mode: 0o600 });
    console.warn('[login-gate] 首次 enforce：已轮换按台令牌密钥，开门前发出的台令牌全部作废（已打开的自产台页面刷新即可）');
  } catch {
    console.warn('[login-gate] 首次 enforce：按台令牌密钥写不进 DATA_DIR，本进程改用随机密钥（旧令牌作废，重启后会再换一次）');
  }
  _appTokenKey = fresh;
}
function appTokenKey(): string {
  if (_appTokenKey) return _appTokenKey;
  try {
    _appTokenKey = String(readFileSync(APP_TOKEN_KEY_FILE, 'utf8')).trim();
  } catch { /* 首次 */ }
  if (!_appTokenKey) {
    _appTokenKey = randomBytes(32).toString('hex');
    try { writeFileSync(APP_TOKEN_KEY_FILE, _appTokenKey, { mode: 0o600 }); } catch { /* 只读卷降级：进程内随机（重启失效·可接受） */ }
  }
  return _appTokenKey;
}
/** 本台在市场里的卡片编号（注入页面供读写 /api/workbenches/:id/vars 用；没登记卡片时为 null）。台重新登记换了编号也跟着变，页面不必写死 */
function wmWorkbenchIdFor(url: string): number | null {
  try { const w = svc<WorkbenchService>('workbench').marketAppIdByUrl(url) as { id: number } | undefined; return w && Number.isInteger(w.id) ? w.id : null; } catch { return null; }
}
/** 台令牌（HMAC-SHA256(slug, key)·不可跨台复用） */
function wmAppToken(slug: string): string {
  return createHmac('sha256', appTokenKey()).update(String(slug)).digest('hex');
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 系统占用的 LayerFS 项目名（技能库等）：台 slug 不得与之相同——否则台的发布、迁移、删台会写到或删掉系统项目。新增系统项目在这里登记。 */
const LAYERFS_SKILLS_PROJECT = 'wm-skills';
const LAYERFS_SYSTEM_PROJECTS: ReadonlySet<string> = new Set([LAYERFS_SKILLS_PROJECT]);
const MAX_APP_FILES = 64;
const MAX_APP_TOTAL_BYTES = 100 * 1024 * 1024;

function getApp(slug: string): AppRow {
  const row = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
  if (!row) throw new HttpError(404, `app not found: ${slug}`);
  return row;
}

function appDetail(a: AppRow) {
  const versions = (svc<AppService>('app').versions(a.id) as unknown as AppVersionRow[]).map(v => ({ ...v, shadow_status: (v as any).shadow_status ?? (v.commit_id ? 'succeeded' : 'pending'), shadow_error: String((v as any).shadow_error ?? '') }));
  const url = a.kind === 'sop' ? `/sop/${a.slug}/` : `/apps/${a.slug}/`;
  const wb = svc<WorkbenchService>('workbench').marketAppIdByUrl(url) as { id: number } | undefined;
  return { ...a, versions, workbench_id: wb?.id ?? null };
}

function validateAppFiles(raw: unknown, kind: 'app' | 'sop' = 'app'): { path: string; content: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) bad('files 必须是非空数组 [{path, content}]');
  if (raw.length > MAX_APP_FILES) bad(`文件数超过上限 ${MAX_APP_FILES}`);
  let total = 0;
  const seen = new Set<string>();
  const files = raw.map((f: any) => {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string') bad('每个文件必须是 {path: string, content: string}（v1 仅支持 UTF-8 文本）');
    const p = posix.normalize(f.path.replace(/\\/g, '/'));
    if (p.length > 200 || p === '.' || p.startsWith('/') || p.startsWith('..') || p.includes('../')) bad(`文件路径非法: ${f.path}`);
    if (seen.has(p)) bad(`文件重复: ${p}`);
    seen.add(p);
    total += Buffer.byteLength(f.content, 'utf8');
    if (total > MAX_APP_TOTAL_BYTES) bad(`文件总量超过 ${MAX_APP_TOTAL_BYTES} 字节上限`);
    return { path: p, content: f.content };
  });
  // 入口检查按 kind 分流：app 类要 index.html（静态台入口）；sop 类要 sop.yaml（混合源，稍后校验）
  if (kind === 'sop') {
    if (!seen.has('sop.yaml')) bad('SOP 发布必须包含 sop.yaml（混合源）');
  } else if (!seen.has('index.html')) {
    bad('files 必须包含根目录 index.html（入口）');
  }
  // 数据契约写错在同步时就拦下，不留到业务提交时才 500
  const contract = files.find((f) => f.path === 'data-contract.json');
  if (contract) { try { parseContract(contract.content); } catch (e) { bad((e as Error).message); } }
  return files;
}

/** #94 S4 根修：快照路径统一解析——dataDir 相对形（'skill-snapshots/…'）为准；legacy 'server/data/…' 剥前缀；绝对路径直用（隔离实例自此真隔离——绝不因相对形落产库） */
/** #183（P0·单一事实源）：技能快照磁盘相对路径——写与读同用此函数。
 *  唯一形=encodeURIComponent(全 slug)（agents:brand 与 jf:brand 互不覆盖）；导出包内顶层仍用 name。 */
function skillSnapRel(slug: string, version: number): string {
  return 'skill-snapshots/' + encodeURIComponent(String(slug)) + '/v' + version;
}

function resolveSnap(p: string): string {
  // #601 P0：绝对路径若落在 dataDir/skill-snapshots 内＝合法（历史导入器存过绝对）→ 归一相对；域外仍封禁（K14）
  const _snapRoot = join(dataDir, "skill-snapshots");
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/")) {
    const abs = p.replace(/[\\/]+/g, "/");
    const root = _snapRoot.replace(/[\\/]+/g, "/");
    if (abs.startsWith(root + "/")) return join(_snapRoot, abs.slice(root.length + 1));
    return join(dataDir, "skill-snapshots", "_blocked_");
  }
  if (p.includes("..")) return join(dataDir, "skill-snapshots", "_blocked_");
  const rel = p.replace(/^server[\\/]data[\\/]/, "");
  return join(dataDir, rel);
}

/** #94 P2（L5）：物化目录保留策略——最新 3 版 ∪ 活跃版（回滚后活跃版不丢）；其余删除（Commit 在服务端=真源） */
function pruneAppDirs(slug: string): void {
  try {
    const a = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
    if (!a) return;
    const vs = (svc<AppService>('app').versions(a.id) as { version: number }[]).map((v) => v.version).sort((x, y) => y - x);
    // #94 P2（L5）：活跃版优先 + 其余最新补足至 3——恒 ≤3 且含活跃（回滚后弃次新而非溢出）
    const keep = new Set<number>([a.active_version]);
    for (const v of vs) { if (keep.size >= 3) break; keep.add(v); }
    const root = join(appsRoot, slug);
    if (!existsSync(root)) return;
    // L15（加急）：只删**已落 Commit** 的版本目录——无 commit_id 一律保留（默认部署无服务=永不 prune·数据丢失灭类）
    const commitMap = new Map<number, string>();
    for (const v of svc<AppService>('app').versions(a.id) as any[]) commitMap.set(v.version, String(v.commit_id ?? ''));
    for (const d of readdirSync(root)) {
      const m = /^v(\d+)$/.exec(d);
      if (m && !keep.has(Number(m[1])) && commitMap.get(Number(m[1])) !== '') { try { rmSync(join(root, d), { recursive: true, force: true }); } catch { /* 下轮再试 */ } }
    }
  } catch { /* prune 失败不阻发布 */ }
}

function writeAppFiles(slug: string, version: number, files: { path: string; content: string }[]) {
  const dir = join(appsRoot, slug, `v${version}`);
  rmSync(dir, { recursive: true, force: true });
  let total = 0;
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    total += Buffer.byteLength(f.content, 'utf8');
  }
  return { file_count: files.length, total_bytes: total };
}

/** 发布即入册：自产台自动注册进 workbenches（type=market-app），门户/驾驶舱/市场全链立即可用 */
function syncWorkbenchRegistration(a: AppRow): number {
  const url = a.kind === 'sop' ? `/sop/${a.slug}/` : `/apps/${a.slug}/`;
  const icon = a.kind === 'sop' ? '📋' : '🧩';
  const category = a.kind === 'sop' ? 'SOP 台' : '自产台';
  admitOrDeny('register', url); // #258 同核：自动登记也只收托管白名单形态
  const cur = svc<WorkbenchService>('workbench').idByUrl(url) as { id: number } | undefined;
  if (cur) {
    svc<WorkbenchService>('workbench').renameDescByUrl(a.title, a.description, cur.id);
    return cur.id;
  }
  const r = svc<WorkbenchService>('workbench').registerMarketApp(a.title, url, icon, a.description, category) as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

// ---------- SOP 台：混合源（sop.yaml）解析与校验 ----------
interface SopStep { key: string; title: string; body?: string }
interface SopManifest { title: string; code?: string; description?: string; steps: SopStep[] }

/** 校验并解析 sop.yaml（混合源：结构化字段 + 步骤内嵌 HTML 块）；抛 HttpError 说明缺什么 */
function parseSopManifest(yamlText: string): SopManifest {
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(yamlText) as Record<string, unknown>;
  } catch (e) {
    throw new HttpError(400, `sop.yaml 解析失败: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') throw new HttpError(400, 'sop.yaml 必须是对象');
  const title = typeof doc.title === 'string' ? doc.title.trim() : '';
  if (!title) throw new HttpError(400, 'sop.yaml 缺少 title');
  const rawSteps = Array.isArray(doc.steps) ? doc.steps : [];
  if (rawSteps.length === 0) throw new HttpError(400, 'sop.yaml 缺少 steps（至少一步）');
  const steps: SopStep[] = [];
  const seen = new Set<string>();
  for (const s of rawSteps) {
    const o = s as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key.trim() : '';
    const st = typeof o.title === 'string' ? o.title.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(key)) throw new HttpError(400, `步骤 key 非法（字母数字开头，允许 _ -）: ${JSON.stringify(o.key)}`);
    if (!st) throw new HttpError(400, `步骤 ${key} 缺少 title`);
    if (seen.has(key)) throw new HttpError(400, `步骤 key 重复: ${key}`);
    seen.add(key);
    steps.push({ key, title: st, body: typeof o.body === 'string' ? o.body : undefined });
  }
  return {
    title, steps,
    code: typeof doc.code === 'string' ? doc.code.trim() : undefined,
    description: typeof doc.description === 'string' ? doc.description.trim() : undefined,
  };
}

function readActiveManifest(slug: string): { manifest: SopManifest; app: AppRow } | null {
  const a = svc<AppService>('app').sopBySlug(slug) as unknown as AppRow | undefined;
  if (!a) return null;
  const yamlPath = join(appsRoot, slug, `v${a.active_version}`, 'sop.yaml');
  if (!existsSync(yamlPath)) return null;
  return { manifest: parseSopManifest(readFileSync(yamlPath, 'utf8')), app: a };
}

/** #164 P1①（批派令尾件）：patch 合并——活跃版本文件树 + {set,delete} 片段 → 合并后全文件集 + diff 摘要 */
function mergePatchFiles(slug: string, activeVersion: number, patch: any): { files: { path: string; content: string }[]; diff: { added: string[]; modified: string[]; removed: string[] } } {
  const setList = Array.isArray(patch?.set) ? patch.set : [];
  const delList = Array.isArray(patch?.delete) ? patch.delete.map((x: unknown) => String(x)) : [];
  if (!setList.length && !delList.length) bad('patch 必须含 set 或 delete 非空数组');
  const baseDir = join(appsRoot, slug, `v${activeVersion}`);
  const base = new Map<string, string>();
  if (existsSync(baseDir)) {
    (function walk(d: string, rel: string) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const abs = join(d, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, r);
        else base.set(r, readFileSync(abs, 'utf8'));
      }
    })(baseDir, '');
  }
  const added: string[] = [], modified: string[] = [], removed: string[] = [];
  for (const f of setList) {
    const path = String(f?.path ?? '').replace(/^\/+/, '');
    const content = String(f?.content ?? '');
    if (!path) bad('patch.set 项缺 path');
    if (base.has(path)) { if (base.get(path) !== content) modified.push(path); }
    else added.push(path);
    base.set(path, content);
  }
  for (const path of delList) {
    if (base.has(path)) { base.delete(path); removed.push(path); }
  }
  return { files: [...base.entries()].map(([path, content]) => ({ path, content })), diff: { added, modified, removed } };
}

/** 发布/重发逻辑：返回响应体与状态码。
 *  属主 2026-11-02 来源收敛后只有两类调用方：GitHub main 同步（syncAppFromGithub，带 source）与 task-center 内置元台的人工面。 */
function publishAppBody(b: any, source?: { repo: string; path: string; commit: string }): { status: number; body: object } {
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) bad('slug 必须是小写字母/数字/连字符（≤64 字符，字母或数字开头）');
  if (layerfsReservedSlug(slug)) bad('slug 是系统保留名（LayerFS 系统项目），换一个');
  const kind = b.kind === 'sop' ? 'sop' : 'app';
  // #164 P1①：三种发布形态——全量 files / patch{set,delete}+base_version（合并活跃版）/ 两者皆无＝错
  let files: { path: string; content: string }[];
  let patchDiff: { added: string[]; modified: string[]; removed: string[] } | null = null;
  const hasFull = Array.isArray(b.files);
  const hasPatch = b.patch && (Array.isArray(b.patch.set) || Array.isArray(b.patch.delete));
  if (hasPatch && !hasFull) {
    const baseVersion = Number(b.base_version ?? svc<AppService>('app').bySlug(String(b.slug ?? '').trim().toLowerCase())?.active_version ?? 0);
    if (!Number.isInteger(baseVersion) || baseVersion <= 0) bad('patch 发布需 base_version（或缺省取当前活跃版本）且该台已存在版本');
    const merged = mergePatchFiles(String(b.slug ?? '').trim().toLowerCase(), baseVersion, b.patch);
    files = validateAppFiles(merged.files, kind);
    patchDiff = merged.diff;
  } else {
    files = validateAppFiles(b.files, kind);
  }
  const existing = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
  if (existing && existing.kind !== kind) bad(`slug 已被 ${existing.kind} 类台占用，kind 不可切换`);

  // SOP 类发布面：sop.yaml 必在且可解析、changelog 必填（版本化治理）
  let changelog = '';
  if (kind === 'sop') {
    const yf = files.find((f) => f.path === 'sop.yaml');
    if (!yf) throw new HttpError(400, 'SOP 发布必须包含 sop.yaml（混合源：结构化字段 + 步骤内嵌 HTML）');
    const parsedManifest = parseSopManifest(yf.content);
    const meta = (parseYaml(yf.content) as any).meta;
    if (slug !== 'task-center' && meta !== undefined) bad('meta 仅允许 task-center 内置元台');
    if (slug === 'task-center' && (meta !== 'task-center' || taskCenterSteps.some(s => !parsedManifest.steps.some(v => v.key === s.key)))) bad('task-center 必须保留 meta 与六个固定步骤');
    changelog = typeof b.changelog === 'string' ? b.changelog.trim() : '';
    if (!changelog) throw new HttpError(400, 'SOP 发布必须携带 changelog（本版改了什么）');
  } else if (typeof b.changelog === 'string' && b.changelog.trim()) {
    changelog = b.changelog.trim();
  }

  // ── 发布内容门禁（S1·采购席反馈 P1/v16 事故锚·判据先红 publish-gate-smoke）──
  // 三闸全放发布入口服务端：①空 content 拒（v16 实证：空串照发上线 0 字节 2 分钟）
  // ②对前版体积骤降>50% 拒（显式 force:true 可越——合法瘦身通道）③HTML div 开闭配对失衡拒。
  const force = b.force === true;
  for (const f of files) {
    if (f.content.trim() === '') throw new HttpError(400, `发布门禁：${f.path} 内容为空（v16 事故锚——空文件照发曾致生产页 0 字节）`);
    if (/\.html?$/i.test(f.path)) {
      const opens = (f.content.match(/<div\b/gi) ?? []).length;
      const closes = (f.content.match(/<\/div\s*>/gi) ?? []).length;
      if (opens !== closes) throw new HttpError(400, `发布门禁：${f.path} div 开闭不配对（开 ${opens} / 闭 ${closes}）`);
    }
  }
  if (existing && !force) {
    const prev = svc<AppService>('app').versionsMax(existing.id) as { v: number | null };
    if (prev.v !== null && prev.v > 0) {
      const prevRow = db.prepare('SELECT total_bytes FROM app_versions WHERE app_id = ? AND version = ?').get(existing.id, prev.v) as { total_bytes?: number } | undefined;
      const prevBytes = prevRow?.total_bytes ?? 0;
      const newBytes = files.reduce((s, f) => s + Buffer.byteLength(f.content, 'utf8'), 0);
      if (prevBytes > 0 && newBytes < prevBytes * 0.5) {
        throw new HttpError(400, `发布门禁：体积骤降（前版 ${prevBytes}B → 本版 ${newBytes}B，降幅>${Math.round((1 - newBytes / prevBytes) * 100)}%）——若为有意精简请携带 force:true`);
      }
    }
  }

  let appRow: AppRow;
  let version: number;
  if (existing) {
    // 重新发布 = 新版本快照（title/description/created_by/code 缺省保留原值）
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : existing.title;
    const description = b.description !== undefined ? String(b.description) : existing.description;
    const created_by = typeof b.created_by === 'string' && b.created_by.trim() ? b.created_by.trim() : existing.created_by;
    const code = typeof b.code === 'string' && b.code.trim() ? b.code.trim() : existing.code;
    const maxV = svc<AppService>('app').versionsMax(existing.id) as { v: number | null };
    version = (maxV.v ?? 0) + 1;
    const st = writeAppFiles(slug, version, files);
    svc<AppService>('app').updatePublish(existing.id, title, description, created_by, code, version);
    svc<AppService>('app').versionInsert(existing.id, version, st.file_count, st.total_bytes, created_by, changelog);
    appRow = getApp(slug);
  } else {
    if (typeof b.title !== 'string' || !b.title.trim()) bad('首次发布必须提供 title');
    const created_by = String(b.created_by ?? '');
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const st = writeAppFiles(slug, 1, files);
    const r = svc<AppService>('app').createFirst({ slug, title: b.title.trim(), description: String(b.description ?? ''), createdBy: created_by, kind, code, status: kind === 'sop' ? 'draft' : 'active' }) as unknown as { lastInsertRowid: number | bigint };
    svc<AppService>('app').versionInsertFirst(Number(r.lastInsertRowid), st.file_count, st.total_bytes, created_by, changelog);
    version = 1;
    appRow = getApp(slug);
  }
  if (source) {
    svc<AppService>('app').setSource(appRow.id, source.repo, source.path);
    svc<AppService>('app').setVersionCommit(appRow.id, version, source.commit);
    appRow = getApp(slug);
  }
  // Shadow remains non-blocking; persist each outcome so failures are visible and retryable.
  if (!layerfsReservedSlug(slug)) void layerfsPublish(layerfsProjectName(slug), files, String(changelog ?? `[publish] v${version}`)).then((out) => {
    try { recordLayerFsShadowOutcome(db, slug, version, layerfsProjectName(slug), out); }
    catch (e) { console.warn(`[P1-shadow] outcome persistence failed: ${slug} v${version}: ${String((e as Error).message).slice(0,100)}`); }
  }).catch((e) => {
    console.warn(`[P1-shadow] publish promise failed: ${slug} v${version}: ${String((e as Error).message).slice(0,100)}`);
    try { recordLayerFsShadowOutcome(db, slug, version, layerfsProjectName(slug), null); }
    catch (persistErr) { console.warn(`[P1-shadow] failure status persistence failed: ${String((persistErr as Error).message).slice(0,100)}`); }
  }); // fire-and-forget: keep local publication responsive
  pruneAppDirs(slug); // #94 P2（L5）：发布后留 3 版 ∪ 活跃

  // app 类发布即入册；sop 类走状态机——draft 不入册，publish 时入册
  const workbench_id = appRow.kind === 'app' ? syncWorkbenchRegistration(appRow) : 0;
  // #132 R1 软防护（监督席直裁）：发布响应带 served_version 基线（发布者可见供 diff 自查·不做跨域强制校验）
  return { status: existing ? 200 : 201, body: { ok: true, slug: appRow.slug, version, served_version: existing ? (version - 1) : 0, diff: patchDiff, patch_base_version: patchDiff ? Number(b.base_version ?? 0) : undefined, workbench_id, kind: appRow.kind, status: appRow.status, app: appDetail(appRow) } };
}

// #164 P1③（监督席 direct-848bcf34）：60s 同 slug 发布锁——异会话窗口内重发 409（双发互踩第二例防线）；同会话续发放行；force:true 显式越锁
const PUBLISH_LOCK_MS = Number(process.env.PUBLISH_LOCK_MS) > 0 ? Number(process.env.PUBLISH_LOCK_MS) : 60_000; // 测试可加速
const lastPublishBySlug = new Map<string, { at: number; who: string }>();
function publishLockGuard(slug: string, who: string, force: boolean): { ok: true } | { ok: false; hint: string } {
  const prev = lastPublishBySlug.get(slug);
  const now = Date.now();
  if (prev && !force && prev.who !== who && now - prev.at < PUBLISH_LOCK_MS) {
    return { ok: false, hint: `同 slug 60s 内已被另一会话发布（${prev.who}·${Math.ceil((PUBLISH_LOCK_MS - (now - prev.at)) / 1000)}s 后解锁）——发布前请先 GET served 基线做 diff；确需覆盖带 force:true` };
  }
  lastPublishBySlug.set(slug, { at: now, who });
  return { ok: true };
}

/** 属主 2026-11-02 来源收敛：自产台与 SOP 台只接受 GitHub 仓库 main 分支，直接传文件/patch 的发布一律拒（task-center 内置元台除外，仍只认管理员人工面） */
const DIRECT_PUBLISH_CLOSED = '自产台与 SOP 台只接受 GitHub 仓库 main 分支：把文件合进仓库 main，再调 POST /api/apps/<slug>/sync（首次须带 source_repo，可选 source_path；本机 CLI 或管理员）或 MCP app_sync';

/** 从 GitHub main 头同步一版。给了 source_repo 即（重新）绑定来源——只走 REST（本机 CLI 或管理员）；不给则按已绑定来源重拉（MCP app_sync 只能这样）。
 *  main 头与活跃版同一 commit 且来源未变 → 不出新版本（unchanged:true）。 */
async function syncAppFromGithub(slug: string, b: any, who: string): Promise<{ status: number; body: object }> {
  slug = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) bad('slug 必须是小写字母/数字/连字符（≤64 字符，字母或数字开头）');
  if (slug === 'task-center') throw new HttpError(403, 'task-center 内置元台不从仓库同步');
  if (layerfsReservedSlug(slug)) bad('slug 是系统保留名（LayerFS 系统项目），换一个');
  const existing = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
  const rebind = b?.source_repo !== undefined;
  if (!existing && !rebind) bad('该台尚未登记来源：首次同步须带 source_repo（owner/repo），可选 source_path');
  let src: { repo: string; path: string };
  try { src = rebind ? normalizeSource(b.source_repo, b.source_path) : { repo: existing!.source_repo, path: existing!.source_path }; }
  catch (e) { if (e instanceof SourceError) throw new HttpError(e.status, e.message); throw e; }
  if (!src.repo) bad('该台还没有 GitHub 来源（来源收敛前直接发布的旧台）：请管理员带 source_repo 绑定一次');
  const kind = existing ? existing.kind : (b?.kind === 'sop' ? 'sop' : 'app');
  let pulled: { commit: string; files: { path: string; content: string }[] };
  try { pulled = await fetchMainFiles(src.repo, src.path); }
  catch (e) { if (e instanceof SourceError) throw new HttpError(e.status, e.message); throw e; }
  if (existing) {
    const active = (svc<AppService>('app').versions(existing.id) as unknown as AppVersionRow[]).find((v) => v.version === existing.active_version);
    if (active?.source_commit === pulled.commit && existing.source_repo === src.repo && existing.source_path === src.path) {
      return { status: 200, body: { ok: true, unchanged: true, slug, version: existing.active_version, source: { ...src, branch: SOURCE_BRANCH, commit: pulled.commit }, app: appDetail(existing) } };
    }
  }
  const short = pulled.commit.slice(0, 7);
  const changelog = (typeof b?.changelog === 'string' && b.changelog.trim()) ? b.changelog.trim() : `[github] ${src.repo}${src.path ? '/' + src.path : ''}@${SOURCE_BRANCH} ${short}`;
  const out = publishAppBody({ slug, kind, title: b?.title, description: b?.description, code: b?.code, created_by: (typeof b?.created_by === 'string' && b.created_by.trim()) || who, changelog, force: b?.force === true, files: pulled.files }, { ...src, commit: pulled.commit });
  return { status: out.status, body: { ...out.body, source: { ...src, branch: SOURCE_BRANCH, commit: pulled.commit } } };
}

registerAppRoutes(http, { appDetail, getApp, DIRECT_PUBLISH_CLOSED, sameOriginGuard, adminGuard, adminTokenCheck, publishLockGuard, publishAppBody, wrap, isAdmin, syncAppFromGithub, appsRoot, layerfsReservedSlug, layerfsPublish, layerfsProjectName, layerfsServiceBase });

// 版本回滚：activate 指定历史版本为当前生效快照（文件不动，只切换指针）；REST 与 MCP 共用
async function activateAppVersion(slug: string, vRaw: unknown): Promise<object> {
  const a = getApp(slug);
  const v = Number(vRaw);
  if (!Number.isInteger(v) || v < 1) bad('version 必须是正整数');
  const hit = svc<AppService>('app').versionExists(a.id, v) as { version: number } | undefined;
  if (!hit) throw new HttpError(404, `版本不存在: ${v}`);
  // L15c（加急）：冷重建**先验成再切指针**——失败/无 Commit 锚=拒回滚（线上版本不动）
  const dir2 = join(appsRoot, slug, `v${v}`);
  if (!existsSync(dir2)) {
    const vrow = (svc<AppService>('app').versions(a.id) as any[]).find((x) => x.version === v);
    if (!vrow?.commit_id) throw new HttpError(409, `v${v} 物化已清且无 Commit 锚——不可回滚（L15：未落 Commit 的版本不删·此态不应存在）`);
    const { base, token } = layerfsServiceBase();
    if (!base) throw new HttpError(502, `v${v} 为冷版本且 layerfs 服务未配置——拒回滚（不切指针）`);
    let rebuilt = false;
    try {
      const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(slug)) + '/branches/release/commits/' + encodeURIComponent(vrow.commit_id) + '/files', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
      if (fr.ok) {
        const fj = await fr.json() as { files: { path: string; content: string }[] };
        for (const f of fj.files) { const abs = join(dir2, f.path); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, f.content, 'utf8'); }
        rebuilt = existsSync(dir2);
      }
    } catch { rebuilt = false; }
    if (!rebuilt) throw new HttpError(502, `v${v} 冷重建失败——拒回滚（不切指针·线上版本不动）`);
  }
  svc<AppService>('app').setActiveVersion(a.id, v); // 指针最后切（重建验成后）
  pruneAppDirs(a.slug); // 回滚后 ≤3 ∪ 活跃
  return appDetail(getApp(a.slug));
  return appDetail(getApp(a.slug));
}

// ---------- #94 v3 S1 统一人审门：请求-批准两段（agent 提请求·人批准执行）----------
/** #94 v3 S1：技能回滚执行体（与批准执行体同源）。回滚=把「当前版本」指针移到已有版本，不复制出新版本：
 *  版本是不可变内容锚、同技能同指纹唯一（K9），复制出的 N+1 与目标同指纹必撞唯一索引；指针与台的 active_version 同构，
 *  可回可进（再指回新版即恢复），快照不碰所以二进制逐字节不变。取装/导出/安装计划/搜索缺省都取当前版本；发布新版恢复跟随最新。 */
async function executeSkillRollback(slug: string, targetVersion: number, reviewedBy: string): Promise<Record<string, unknown>> {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(slug);
  if (!row) throw new HttpError(404, `skill not found: ${slug}`);
  const vs = S.versionsBySkill(row.id) as any[];
  const src = vs.find((v) => v.version === targetVersion);
  if (!src) throw new HttpError(404, `version not found: ${targetVersion}`);
  if (!src.snapshot_path || !existsSync(resolveSnap(src.snapshot_path))) throw new HttpError(409, `v${targetVersion} 快照缺失——拒回滚（当前版本不动）`);
  const prev = SkillService.currentOf(row, vs)?.version ?? null;
  S.setActive(row.id, targetVersion, reviewedBy);
  return { ok: true, slug, active_version: targetVersion, previous_version: prev, latest_version: vs[0].version, tree_digest: src.tree_digest, reviewed_by: reviewedBy };
}
/** #94 v3 S1：技能删除执行体（版本快照+台账+技能行级联） */
function executeSkillDelete(slug: string): void {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(slug);
  if (!row) throw new HttpError(404, `skill not found: ${slug}`);
  for (const v of S.versionsBySkill(row.id) as any[]) { try { rmSync(resolveSnap(v.snapshot_path), { recursive: true, force: true }); } catch { /* 已不在 */ } }
  db.prepare('DELETE FROM install_ledger WHERE skill_id = ?').run(row.id);
  db.prepare('DELETE FROM skill_versions WHERE skill_id = ?').run(row.id);
  db.prepare('DELETE FROM skills WHERE id = ?').run(row.id);
}
registerChangeRequestRoutes(http, { adminGuard, wrap, bad, activateAppVersion, deleteAppCascade, executeSkillRollback, executeSkillDelete });

registerAppLifecycleRoutes(http, { sameOriginGuard, adminGuard, wrap, bad, activateAppVersion, deleteAppCascade });

/** #94 v3 S1：台删除级联体（一步式 REST 与人审批准共用一个执行体——单一事实源） */
/** #94 P1 影子双写：经 layerfs 服务发布 Commit（契约 v0 §2.1·Bearer）——失败不阻（warn·commit_id 留空） */
/** #94 ②（R9）：LayerFS 项目名——[a-z0-9_.-]{1,63}·超限 slug 折叠 wm-<前52>-<sha8> */
function layerfsReservedSlug(slug: string): boolean { return LAYERFS_SYSTEM_PROJECTS.has(layerfsProjectName(slug)); }
function layerfsProjectName(slug: string): string {
  if (/^[a-z0-9][a-z0-9._-]{0,62}$/.test(slug)) return slug;
  const h = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return ('wm-' + slug.slice(0, 52).replace(/[^a-z0-9._-]/g, '-') + '-' + h).slice(0, 63);
}

function layerfsServiceBase(): { base: string; token: string } {
  const s = getSettings() as Record<string, unknown>;
  const tokenFile = String(process.env.LAYERFS_SERVICE_TOKEN_FILE ?? '').trim();
  let token: string;
  if (tokenFile) {
    // In managed Docker mode this file is authoritative; never fall back to a stale DB/env token.
    token = String(readFileSync(tokenFile, 'utf8')).trim();
    if (Buffer.byteLength(token, 'utf8') < 32) throw new Error('LayerFS secret file must contain at least 32 bytes');
  } else {
    token = String(s['layerfs_service_token'] ?? process.env.LAYERFS_SERVICE_TOKEN ?? '').trim();
  }
  const base = tokenFile ? String(process.env.LAYERFS_SERVICE_URL ?? '').trim() : String(s['layerfs_service_url'] ?? process.env.LAYERFS_SERVICE_URL ?? '').trim();
  return { base, token };
}
async function layerfsPublish(project: string, files: { path: string; content: string }[], message: string, branch = 'release'): Promise<{ commit_id: string; changed: boolean } | null> {
  try {
    const { base, token } = layerfsServiceBase();
    if (!base) return null; // 未配置=不启用（契约 §1）
    // #94 契约 v1（监督席 direct-440fb53c）：项目+分支两级路由
    const res = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(project) + '/branches/' + encodeURIComponent(branch) + '/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ files, message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`layerfs service HTTP ${res.status}`);
    const j = await res.json() as { commit_id?: string; changed?: boolean };
    if (!j.commit_id) throw new Error('layerfs service 无 commit_id');
    return { commit_id: j.commit_id, changed: j.changed === true };
  } catch (e) {
    console.warn(`[P1-shadow] 影子写失败（不阻发布·commit_id 留空）: ${project}: ${String((e as Error).message).slice(0, 100)}`);
    return null;
  }
}

async function deleteAppCascade(slug: string): Promise<void> {
  const a = getApp(slug);
  // Remove remote state first and retain local state on failure; without LayerFS config, apps never written there stay deletable.
  const versions = svc<AppService>('app').versions(a.id) as any[];
  const hasLayerfsState = Boolean((a as any).layerfs_project) || versions.some(v => String(v.commit_id ?? '') !== '');
  // 配了 LayerFS 就一律按项目名删远端（404 视为没有）：影子发布可能远端已建 Commit 而响应丢了，本地没留记号
  const { base, token } = layerfsServiceBase();
  // 保留名（历史遗留的同名台）：远端项目属于系统，绝不随删台删除，只删本地
  const reserved = layerfsReservedSlug(slug);
  if (reserved) console.warn(`[layerfs] 删台 ${slug}：slug 是系统保留项目名，跳过远端删除`);
  if (hasLayerfsState && !base && !reserved) throw new HttpError(503, 'LayerFS service is required to delete an app with LayerFS data');
  if (base && !reserved) {
    let remote: Response;
    try {
      remote = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(slug)), {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw new HttpError(502, `LayerFS project deletion unavailable; app retained for retry: ${String((e as Error).message).slice(0, 80)}`);
    }
    if (!remote.ok && remote.status !== 404) throw new HttpError(502, `LayerFS project deletion failed (HTTP ${remote.status}); app retained for retry`);
  }
  rmSync(join(appsRoot, slug), { recursive: true, force: true });
  svc<AppService>('app').versionsDelete(a.id);
  svc<AppService>('app').delete(a.id);
  svc<AppDataService>('appData').dataDelete(slug);
  const files = svc<AppDataService>('appData').filePaths(slug) as { storage_path: string }[];
  for (const f of files) { try { rmSync(join(dataDir, f.storage_path), { force: true }); } catch { /* 已删 */ } }
  svc<AppDataService>('appData').filesDelete(slug);
  // issue #6：清理应用与 SOP 对应的工作台注册。
  svc<WorkbenchService>('workbench').deleteByAppUrls(`/apps/${slug}/`, `/sop/${a.slug}/`);
}

// ---------- 自产台数据提交面（监督席派单 direct-22838fab：台不仅是看板，有交互提交数据） ----------
// 通用通道：POST 写入 / GET 游标分页（倒序 before_id）。JSON blob 哑存储——含义在台自身。
// 安全面：内网信任模型（同发布面口径）；台页 iframe 同源 fetch 直通。
// 无 DELETE——提交数据留审计，误提交由应用层覆盖语义处理。

/** 分页参数校验（评审 #22：limit=1.5 曾 500、limit=-1 绕过上限——输入错误一律 400） */
function pageLimit(v: unknown, def = 50, max = 200): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) bad(`limit 必须是 1-${max} 的正整数`);
  return Math.min(n, max);
}
function pageBeforeId(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) bad('before_id 必须是整数');
  return Math.max(0, n);
}
// 台的数据契约（可选，见 app-data-contract.ts）：取活跃版本目录里的 data-contract.json，按 slug@版本缓存
const _contractCache = new Map<string, DataContract | null>();
function appDataContract(a: AppRow): DataContract | null {
  const k = `${a.slug}@${a.active_version}`;
  if (_contractCache.has(k)) return _contractCache.get(k)!;
  const f = join(appsRoot, a.slug, `v${a.active_version}`, 'data-contract.json');
  const c = existsSync(f) ? parseContract(readFileSync(f, 'utf8')) : null;
  _contractCache.set(k, c);
  return c;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** 台数据写入核心：REST POST /api/apps/:slug/data 与 MCP app_data_submit 共用——1MB 上限、数据契约、幂等键、写入后推事件。
 *  违约不抛错，回 status 400 + violations，由两个入口各自原样交出去。 */
function submitAppData(a: AppRow, input: { data: unknown; createdBy?: unknown; idempotencyKey?: unknown; submitterTicket?: unknown; channel: { name: 'app-data.rest' | 'app-data.tool'; hasCredential: boolean } }): { status: number; body: Record<string, unknown> } {
  const data = input.data;
  const json = JSON.stringify(data);
  if (json === undefined) bad('data 必填');
  if (Buffer.byteLength(json, 'utf8') > 1024 * 1024) bad('data 超 1MB 上限');
  const key = input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === '' ? '' : String(input.idempotencyKey);
  if (key && !IDEMPOTENCY_KEY_RE.test(key)) bad('idempotency_key 只能是 1–128 个字母/数字/_ . : -');
  if (key) {
    const prev = svc<AppDataService>('appData').dataByIdempotencyKey(a.slug, key) as { id: number; data: string; created_at: string } | undefined;
    if (prev) {
      if (prev.data !== json) throw new HttpError(409, 'idempotency_key 已用于另一份内容', { id: prev.id });
      return { status: 200, body: { ok: true, id: prev.id, slug: a.slug, created_at: prev.created_at, duplicate: true } };
    }
  }
  const contract = appDataContract(a);
  if (contract) {
    const violations = checkRecord(contract, data, (id) => !!svc<AppDataService>('appData').fileById(id, a.slug));
    if (violations.length) return { status: 400, body: { error: '提交不符合本台数据契约', violations } };
  }
  const created_by = typeof input.createdBy === 'string' ? input.createdBy.trim().slice(0, 128) : '';
  // 8f-2：台页面在信封里带回的提交人票据。验得过、主体仍启用才记下这个人；验不过当没带（照样收、留空），不把原因回给调用方
  const submitter = input.channel.name === 'app-data.rest' ? submitterFromTicket(input.submitterTicket, a.slug) : null;
  const r = svc<AppDataService>('appData').dataInsertStmt()
    .run(a.slug, json, created_by, key, submitter) as unknown as { lastInsertRowid: number | bigint };
  const itemId = Number(r.lastInsertRowid);
  const createdAt = new Date().toISOString();
  // 属主裁 C（2026-10-26）：提交即推送——绑定 agent 异步收通知（不阻塞 201）。
  // 工作台事件 v1：推送改走事件投递队列（退避重试、终态 sent/dead 可查），信封带 event_id 与 submitter_kind。
  // 提交面匿名、created_by 自填 → submitter_kind 恒 unverified、dispatch:false（只通知不派发）。
  // 联合评审① C：统一绑定表——notify 方向行（授 admits 不触发推送·方向独立性铁律）
  // 8f：不带内容的提交计数。台的提交只凭票据认人（8f-2）
  countSubmission(input.channel.name, input.channel.hasCredential, submitter !== null);
  try {
    if (recordAppDataEvent({ slug: a.slug, id: itemId, data, json, createdBy: created_by, createdAt, submitterPrincipal: submitter })) kickWorkbenchEvents();
  } catch (err) { console.error(`[app-notify] event record failed ${a.slug}: ${String(err).slice(0, 120)}`); }
  return { status: 201, body: { ok: true, id: itemId, slug: a.slug, created_at: createdAt } };
}

// ---------- 自产台文件提交面（所有资源类型文件，单文件 100MB 上限） ----------
// multipart/form-data：字段 file（单文件）+ 可选 note/created_by。
// 落盘 DATA_DIR/uploads/<slug>/<YYYYMM>/<id>-<safeName>；元数据入 app_files；GET 列表 + 下载。
const UPLOAD_MAX = 100 * 1024 * 1024; // 属主 2026-11-03：单文件放宽到 100MB
// 每台文件数上限：浏览器上传与 MCP 上传共用；部署可用 WM_APP_FILES_MAX 调整（存量迁移台已有数百个文件）
const APP_FILES_MAX = Math.max(1, Number(process.env.WM_APP_FILES_MAX) || 2000);
/** 台的文件容量（上传前可查）：已用/上限文件数、单文件上限、MCP base64 上限 */
function appFilesQuota(slug: string) {
  const used = Number(svc<AppDataService>('appData').fileCount(slug)) || 0;
  return { files_used: used, files_max: APP_FILES_MAX, files_left: Math.max(0, APP_FILES_MAX - used), max_file_bytes: UPLOAD_MAX, mcp_max_base64_chars: Math.ceil(UPLOAD_MAX / 3) * 4 };
}
const uploadRoot = join(dataDir, 'uploads');
// multipart 文件名编码修复：busboy 默认把 UTF-8 字节按 latin1 解码（中文名变 mojibake）
const fixFileName = (s: string): string => {
  try {
    const buf = Buffer.from(s, 'latin1');
    const utf8 = buf.toString('utf8');
    // 若 latin1→utf8 往返合法且含多字节字符，采用修复值
    return /�/.test(utf8) ? s : utf8;
  } catch {
    return s;
  }
};
/** 按内容核对上传文件类型：扩展名与内容不符、或是可执行文件 → 删掉落盘文件并回 415（不按文件名自动改 MIME）；
 *  相符时返回应存的规范 MIME。返回 null 表示已回 415。 */
function checkUploadKind(res: express.Response, file: Express.Multer.File, name: string): Sniff | null {
  try { return uploadKindOrThrow(file.path, file.size, name, file.mimetype || ''); } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    res.status(e.status).json({ error: e.message, ...e.extra });
    return null;
  }
}
function uploadKindOrThrow(path: string, size: number, name: string, reported: string): Sniff {
  const headLen = Math.min(size, 1024 * 1024);
  const head = Buffer.alloc(headLen);
  const fd = openSync(path, 'r');
  try { readSync(fd, head, 0, headLen, 0); } finally { closeSync(fd); }
  const kind = sniff(name, head, headLen === size, reported);
  if (kind.verdict === 'mismatch' || kind.verdict === 'executable') {
    rmSync(path, { force: true });
    throw new HttpError(415, `文件类型不符：${kind.reason}`, { name, detected: kind.detected || null });
  }
  return kind;
}
/** 自产台文件入库核心：浏览器 multipart 与 MCP REST（原始字节 PUT / multipart）共用——已落盘的文件按内容核类型（不符删盘 415）后写 app_files */
function appFileStoreCore(slug: string, f: { path: string; size: number; name: string; reportedMime: string; createdBy: string; note: string; sha256?: string }) {
  const kind = uploadKindOrThrow(f.path, f.size, f.name, f.reportedMime);
  // 存储相对路径（dataDir 内，随数据目录迁移）
  const rel = f.path.replace(dataDir, '').replace(/\\/g, '/').replace(/^\/+/, '');
  const r = svc<AppDataService>('appData').fileInsert(slug, f.name, kind.mime, f.size, rel, f.createdBy, f.note, f.sha256 ?? '') as unknown as { lastInsertRowid: number | bigint }; // #132 P0①：note 落库；sha256 有就存（下载 ETag 不再重算）
  const id = Number(r.lastInsertRowid);
  return { ok: true, id, slug, name: f.name, mime: kind.mime, size: f.size, note: f.note, url: `/api/apps/${slug}/files/${id}` };
}
/** 上传落盘位置（multer 与原始字节上传同规则）：uploads/<YYYYMM>/<时间戳>-<随机><原扩展名> */
function uploadMonthDir(): string {
  const now = new Date();
  const dir = join(uploadRoot, `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function uploadFileName(originalName: string): string {
  // 保留原扩展名、抹掉路径与控制字符
  const ext = extname(originalName).slice(0, 16).replace(/[^.\w-]/g, '');
  return `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
}
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, uploadMonthDir());
    },
    filename(_req, file, cb) {
      cb(null, uploadFileName(fixFileName(file.originalname)));
    },
  }),
  limits: { fileSize: UPLOAD_MAX, files: 1 },
});


registerAppDataRoutes(http, { getApp, submitAppData, pageLimit, pageBeforeId, appFilesQuota, APP_FILES_MAX, upload, fixFileName, appFileStoreCore, adminGuard, bad });

// ---------- SOP 台：状态机（draft → published → deprecated）+ 执行 Runner + 分层持久化 ----------
function sopTransition(slug: string, from: string[], to: string, label: string): AppRow {
  const a = getApp(slug);
  if (a.kind !== 'sop') throw new HttpError(400, `${slug} 不是 SOP 台`);
  if (!from.includes(a.status)) throw new HttpError(409, `状态机拒绝：当前 ${a.status}，${label} 仅允许 ${from.join('/')}`);
  svc<AppService>('app').setStatus(a.id, to);
  const updated = getApp(slug);
  if (to === 'published') {
    syncWorkbenchRegistration(updated); // 发布即入册（门户/市场/驾驶舱全链可见）
    // issue #10：废弃→重新上架时市场行仍是停用态（enabled=0），上架必须恢复启用
    svc<WorkbenchService>('workbench').setEnabledByUrl(1, `/sop/${updated.slug}/`);
  }
  return updated;
}

registerSopStateRoutes(http, { appDetail, getApp, sameOriginGuard, adminGuard, sopTransition });

// ---------- SOP Runner：GET /sop/:slug/ → 内置执行页（读活跃版本 sop.yaml 服务端渲染）----------
/** #321：执行页内联 DESIGN.md 生成的 --wm-* 变量，与市场前端同色同字号 */
const renderSopRunner = (manifest: Parameters<typeof renderSopRunnerRaw>[0], app: Parameters<typeof renderSopRunnerRaw>[1]) => renderSopRunnerRaw(manifest, app, loadTokensCss()?.css ?? '');


registerSopPageRoutes(http, { readActiveManifest, renderSopRunner, appsRoot, wmAppToken, wmWorkbenchIdFor });

// ---------- SOP run API：分层治理（Redis 热态 + SQLite 真源）----------
// core 函数为唯一持久化链：REST 与 MCP（sop_run_* 工具）共用——agent 更新持久化执行数据
// 与人在 Runner 页填数据走同一条链（GH #17 P4 的执行数据面提前交付，不经版本发布）。
const runCheckpoints = createRunCheckpoints({
  write(id, data) { svc<SopService>('sop').runCheckpointData(id, data); },
});
function runCacheCheckpoint(row: SopRunRow): string {
  // Namespace + durable revision prevent cache collisions, partial writes and same-value ABA resurrection.
  return createHash('sha256').update(JSON.stringify([dataDir, row.id, row.sop_slug, row.sop_version, row.started_at, row.cache_revision, row.status, row.data])).digest('hex');
}
function storedRunData(row: SopRunRow): Record<string, unknown> {
  try { const data = JSON.parse(row.data || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
/**
 * #442 进行中 run 的最新数据：本进程缓冲 > 当前一代热态 > SQLite。
 * 没有缓冲又读不到热态时，Redis 里可能还有已确认、尚未落盘的写入，不能当成「没有热态」：
 *   error（连着但这次读出错）一律 503，稍后重试；
 *   down（配了但没连上）在 strict（完成、升级）时 503，等 Redis 恢复；日常保存仍按降级设计直写 SQLite，
 *   除非 SQLite 记着「热态有未落盘写入」（hot_pending，#448）——那时保存（writing）直写会让 Redis 里那份更新的写入再也对不上校验点，同样 503；只读照常降级。
 */
async function runLiveData(row: SopRunRow, strict: boolean, writing = false): Promise<{ data: Record<string, unknown>; buffered: boolean; hot: RunStateRead }> {
  const pending = runCheckpoints.peek(row.id);
  if (pending) return { data: pending, buffered: true, hot: { kind: 'miss' } };
  const hot = await runStateRead(row.id, runCacheCheckpoint(row));
  // #448: after a restart the buffer is gone; if SQLite says Redis may hold a newer acknowledged write, a degraded save would orphan it (reads stay degraded)
  if (hot.kind === 'error' || (hot.kind === 'down' && (strict || (writing && !!row.hot_pending)))) {
    throw new HttpError(503, `run ${row.id} 的热态暂时读不到（Redis ${hot.kind === 'down' ? '未连上' : '读出错'}），为免丢掉已确认的填写，稍后重试`, { redis: hot.kind, retryable: true });
  }
  return { data: { ...storedRunData(row), ...(hot.kind === 'hit' && hot.meta.status === 'running' ? hot.data : {}) }, buffered: false, hot };
}

function sopRunRow(id: number): SopRunRow {
  const r = svc<SopService>('sop').runById(id) as unknown as SopRunRow | undefined;
  if (!r) throw new HttpError(404, `run not found: ${id}`);
  return r;
}

function mergeRunData(row: SopRunRow, stepKey: string, value: unknown): string {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  data[stepKey] = value;
  return JSON.stringify(data);
}

/** 开 run（钉当前版本；仅 published） */
function sopRunStartCore(slugRaw: string, startedByRaw: string, requester: string | null = null): { id: number; slug: string; version: number; status: string; data: Record<string, unknown>; read_capability: string } {
  const slug = slugRaw.trim().toLowerCase();
  if (!slug) bad('slug 必填');
  const hit = readActiveManifest(slug);
  if (!hit) throw new HttpError(404, `SOP not found: ${slug}`);
  if (hit.app.status !== 'published') throw new HttpError(409, `SOP 状态为 ${hit.app.status}，仅 published 可执行`);
  const started_by = startedByRaw.trim();
  const r = svc<SopService>('sop').runCreate(slug, hit.app.active_version, started_by, slug === 'task-center' ? requester : null) as unknown as { lastInsertRowid: number | bigint };
  const id = Number(r.lastInsertRowid);
  // P0：run-scoped 上传令牌（启动签发·Runner 页内嵌·files POST 必带）
  const uploadToken = randomBytes(32).toString('hex');
  try { db.prepare('UPDATE sop_runs SET upload_token = ? WHERE id = ?').run(uploadToken, id); } catch { /* 列缺=降级 */ }
  // Lazy Redis initialization under the per-run queue avoids racing a new save or finish.
  // #309 phase2：创建即得 run 级读能力（明文仅此一次；库内只存摘要）
  const readCapability = issueRunReadCap(id);
  return { id, slug, version: hit.app.active_version, status: 'running', started_by, data: {}, upload_token: uploadToken, read_capability: readCapability }; // 创建者即得上传令牌与读能力
}

/** 更新持久化数据（任意步骤键值；Redis 热写 + 30s checkpoint / 降级直写 SQLite） */
async function sopRunStepSaveCore(id: number, stepKeyRaw: string, value: unknown): Promise<{ ok: boolean; id: number; stepKey: string; persisted: string }> {
  const stepKey = stepKeyRaw.trim();
  if (!stepKey) bad('stepKey 必填');
  if (!/^[\w-]+$/.test(stepKey)) bad('stepKey 仅允许字母/数字/_/-');
  return runCheckpoints.serial(id, async () => {
    const row = sopRunRow(id);
    if (row.status !== 'running') throw new HttpError(409, 'run ' + id + ' 已 ' + row.status + '，不可再写');
    if (row.sop_slug === 'task-center') {
      svc<SopService>('sop').runUpdateData(id, mergeRunData(row, stepKey, value ?? null));
      return { ok: true, id, stepKey, persisted: 'sqlite' };
    }
    const { data } = await runLiveData(row, false, true);
    data[stepKey] = value ?? null;
    // Repopulate all known fields after a Redis loss; a partial HSET must not erase the durable baseline.
    const hotOk = await runCheckpoints.save(id, data, () =>
      runStateRestore(id, { slug: row.sop_slug, version: row.sop_version, status: 'running', started_by: row.started_by, updated_at: Date.now() }, data, runCacheCheckpoint(sopRunRow(id))),
      () => { if (redisConfigured()) svc<SopService>('sop').runMarkHotPending(id); }); // #466 N2：发布失败时强制落盘会清掉标记
    // A successful fallback bumps SQLite generation; any surviving OLD Redis payload now misses.
    return { ok: true, id, stepKey, persisted: hotOk ? 'redis+checkpoint' : 'sqlite' };
  });
}

/** 读 run（热读优先，miss 回 SQLite 真源并回填热态） */
/** P3 回执可见性：none / pending / sent / dead / rejected:<原因>（评审席判据 E1-E6 观测面） */
function receiptStatusOf(runId: number): string {
  const src = svc<SopService>('sop').ctxSourceByRun(runId) as { receipt_status?: string } | undefined;
  if (src && typeof src.receipt_status === 'string' && src.receipt_status.startsWith('rejected:')) return src.receipt_status;
  const ob = svc<SopService>('sop').outboxByRun(runId) as { status?: string } | undefined;
  if (ob?.status === 'sent') return 'sent';
  if (ob?.status === 'dead') return 'dead';
  if (ob?.status === 'pending') return 'pending';
  return 'none';
}

async function sopRunGetCore(id: number): Promise<{ id: number; sop_slug: string; sop_version: number; status: string; started_by: string; started_at: string; updated_at: string; finished_at: string | null; data: Record<string, unknown>; receipt: string }> {
  return runCheckpoints.serial(id, async () => {
    const row = sopRunRow(id);
    let data = storedRunData(row);
    if (row.status === 'running' && row.sop_slug !== 'task-center') {
      const live = await runLiveData(row, false);
      data = live.data;
      if (live.hot.kind === 'hit' && live.hot.meta.status === 'running') runCheckpoints.remember(id, data); // recovered acknowledged hot state must not stay uncheckpointed after restart
      if (redisHealthy() && live.hot.kind !== 'hit') await runStateRestore(id, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data, runCacheCheckpoint(row));
    }
    // 时间字段与无读凭证的元数据视图（sopRunGetMeta）、sop_run_list 一致
    return { id: row.id, sop_slug: row.sop_slug, sop_version: row.sop_version, status: row.status, started_by: row.started_by, started_at: row.started_at, updated_at: row.updated_at, finished_at: row.finished_at ?? null, data, receipt: receiptStatusOf(id) };
  });
}

/** #309 phase2：未授权单 run 响应——显式元数据白名单，不含私有 data（缺归属即拒私有值）。 */
function sopRunGetMeta(id: number) {
  const row = sopRunRow(id);
  let steps = 0;
  try { steps = Object.keys(JSON.parse(row.data || '{}')).length; } catch { steps = 0; }
  return { id: row.id, sop_slug: row.sop_slug, sop_version: row.sop_version, status: row.status, started_by: row.started_by, started_at: row.started_at, updated_at: row.updated_at, finished_at: row.finished_at, steps, receipt: receiptStatusOf(id), private_read: 'authorization-required' };
}
function runReadCapHeader(req: express.Request): string | undefined {
  const v = String(req.headers['x-run-read-capability'] ?? '').trim();
  return v || undefined;
}

/** 归档（热态全量沉淀 SQLite；Redis 条目 1h 平滑淘汰） */
/** 流式算文件 sha256（不把整个文件读进内存、不卡事件循环） */
function sha256File(abs: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(abs).on('data', (c) => h.update(c)).on('error', fail).on('end', () => done(h.digest('hex')));
  });
}
/** #437① 旧文件没记 sha256 的现算一次，按存储路径给源行与引用行一起补记；返回补齐后的 sha（文件不在存储里返回 ''） */
async function ensureRunFileSha(f: { storage_path: string; sha256?: string }): Promise<string> {
  if (f.sha256) return f.sha256;
  if (!f.storage_path) return '';
  const abs = join(dataDir, f.storage_path);
  if (!existsSync(abs)) return '';
  const sha = await sha256File(abs);
  try { svc<SopService>('sop').runFileSetShaByPath(f.storage_path, sha); } catch { /* 补记失败不影响本次 */ }
  return sha;
}

/** #437① 文件清单逐行对文件面核：file_id 必须是本 run 的文件（上传或引用），登记的 sha256 必须等于文件实际 hash，
 *  文件名必须一致——同名不同内容、换了文件却沿用旧登记，都在完成时拦下。旧文件没记 sha 的现算一次并补记。 */
async function checkFileListsAgainstStore(rules: FieldRule[], data: Record<string, unknown>, runId: number): Promise<string[]> {
  const errs: string[] = [];
  for (const r of rules.filter((x) => x.type === 'file-list')) {
    const sv = data?.[r.step];
    const rows = fileListRows(sv && typeof sv === 'object' ? (sv as Record<string, unknown>)[r.field] : undefined) ?? [];
    for (const [i, row] of rows.entries()) {
      const o = row && typeof row === 'object' ? row as Record<string, unknown> : null;
      const fid = Number(o?.file_id);
      if (!o || !Number.isInteger(fid) || fid <= 0) continue; // 结构问题 checkRunData 已报
      const at = `${r.step}.${r.label} 第 ${i + 1} 行`;
      const f = svc<SopService>('sop').runFileById(runId, fid) as { id: number; original_name: string; storage_path: string; sha256?: string } | undefined;
      if (!f) { errs.push(`${at}：文件 ${fid} 不在本记录里（先上传或引用）`); continue; }
      const actual = await ensureRunFileSha(f);
      if (!actual) { errs.push(`${at}：文件 ${fid} 已不在存储里`); continue; }
      if (String(o.sha256 ?? '') !== actual) errs.push(`${at}：登记的 sha256 与文件 ${fid} 的实际内容不一致（文件可能已更换，请重新选择）`);
      if (o.name !== undefined && String(o.name) !== f.original_name) errs.push(`${at}：文件名与文件 ${fid} 不一致`);
    }
  }
  return errs;
}

async function sopRunFinishCore(id: number): Promise<{ ok: boolean; id: number; status: string; steps: number }> {
  return runCheckpoints.serial(id, () => sopRunFinishLockedCore(id));
}
async function sopRunFinishLockedCore(id: number): Promise<{ ok: boolean; id: number; status: string; steps: number }> {
  const row = sopRunRow(id);
  if (row.status !== 'running') throw new HttpError(409, `run ${id} 已 ${row.status}`);
  const data = JSON.stringify(row.sop_slug === 'task-center' ? storedRunData(row) : (await runLiveData(row, true)).data);
  // 完成前按该 run 所用 SOP 版本里的字段规则（required/pattern/长度/类型）校验；不符则不完成、run 保持进行中
  if (row.sop_slug !== 'task-center') {
    const yamlPath = join(appsRoot, row.sop_slug, `v${row.sop_version}`, 'sop.yaml');
    const manifest = existsSync(yamlPath) ? parseSopManifest(readFileSync(yamlPath, 'utf8')) : readActiveManifest(row.sop_slug)?.manifest;
    if (manifest) {
      let parsedData: Record<string, unknown> = {};
      try { parsedData = JSON.parse(data); } catch { parsedData = {}; }
      const rules = extractFieldRules(manifest);
      const violations = [...checkRunData(rules, parsedData), ...(await checkFileListsAgainstStore(rules, parsedData, id))];
      if (violations.length) throw new HttpError(400, `有 ${violations.length} 个字段未通过校验，未完成：${violations.slice(0, 5).join('；')}${violations.length > 5 ? ' 等' : ''}`, { violations });
    }
  }
  svc<SopService>('sop').runFinish(id, data);
  runCheckpoints.forget(id); // only clear after the durable finish succeeds
  await runStateRetire(id); // best-effort cache retirement; SQLite status remains authoritative
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(data); } catch { parsed = {}; }
  // P3 回执（network/a2a-receipt）：派单来源 + 有效 callback_url → 入 outbox（run_id 唯一幂等）
  try {
    const src = svc<SopService>('sop').ctxSourceByRun(id) as { task_id?: string; context_id?: string; callback_url?: string; receipt_status?: string } | undefined;
    if (src && src.receipt_status !== 'rejected:callback-mismatch' && (src.callback_url ?? '') !== '') {
      const payload = formatA2aReceipt(String(src.task_id ?? ''), '业务专家已完成验收', {
        outcome: 'completed',
        idempotencyKey: `run-${id}-finished`,
      });
      svc<SopService>('sop').outboxInsert({ runId: id, taskId: String(src.task_id ?? ''), contextId: String(src.context_id ?? ''), targetUrl: String(src.callback_url ?? ''), payload });
      void deliverOutboxOnce(id);
    }
  } catch (e: any) { console.error('[receipt] enqueue failed:', e?.message ?? e); /* 回执失败不影响完成主流程 */ }
  return { ok: true, id, status: 'finished', steps: Object.keys(parsed).length };
}

// ---------- P3 回执 outbox worker（退避 1m/5m/15m/1h，5 次后 dead；行永不删） ----------
const OUTBOX_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
/** #50：next_at 必须用与 datetime('now') 同构的 'YYYY-MM-DD HH:MM:SS.sss'（UTC 空格式）——
 *  ISO 串的 'T' > 空格，字符串比较同天内永不到期（E8/E9 红） */
function sqliteUtcIn(ms: number): string {
  return new Date(Date.now() + ms + 1_000).toISOString().slice(0, 19).replace('T', ' '); // 秒精度+1s 防同秒边界
}
function outboxBackoffScale(): number {
  const v = Number(process.env.A2A_OUTBOX_BACKOFF_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
}
async function postReceipt(targetUrl: string, row: { run_id: number; task_id: string; context_id: string; payload: string }): Promise<void> {
  const body = {
    team: MARKET_TEAM,
    caller_session: MARKET_TEAM,
    task_id: `receipt-${row.run_id}`,
    context_id: row.context_id,
    message: row.payload,
  };
  const url = `${targetUrl.replace(/\/+$/, '')}/a2a/direct`;
  // OriginClaim：回执同样带绑定形式信封（#64 关窗后未签名的回执会被对端拒收）
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...marketOriginClaim(a2aKeyPath(), { url, method: 'POST' }) }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000), redirect: 'manual',
  });
  if (r.status >= 300 && r.status < 400) {
    await r.body?.cancel();
    throw new Error('A2A receipt redirect rejected: HTTP ' + r.status);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
/** 立即试投一次（finish 触发）；失败留给 worker */
async function deliverOutboxOnce(runId: number): Promise<void> {
  try {
    const row = svc<SopService>('sop').outboxByRun(runId) as { id: number; run_id: number; task_id: string; context_id: string; target_url: string; payload: string; attempts: number; status: string } | undefined;
    if (!row || row.status !== 'pending') return;
    await postReceipt(row.target_url, row);
    svc<SopService>('sop').outboxMarkSent(row.id);
  } catch (e: any) {
    try {
      const row = svc<SopService>('sop').outboxByRun(runId) as { id: number; attempts: number } | undefined;
      if (row) svc<SopService>('sop').outboxMarkRetry(row.id, row.attempts + 1, sqliteUtcIn(30_000 * outboxBackoffScale()), String(e?.message ?? e));
    } catch { /* 忽略 */ }
  }
}
async function outboxWorkerTick(): Promise<void> {
  try {
    const due = svc<SopService>('sop').outboxDue(20) as { id: number; run_id: number; task_id: string; context_id: string; target_url: string; payload: string; attempts: number }[];
    for (const row of due) {
      try {
        await postReceipt(row.target_url, row);
        svc<SopService>('sop').outboxMarkSent(row.id);
      } catch (e: any) {
        const attempts = row.attempts + 1;
        if (attempts >= 5) {
          svc<SopService>('sop').outboxMarkDead(row.id, String(e?.message ?? e));
        } else {
          const delay = (OUTBOX_BACKOFF_MS[Math.min(attempts - 1, OUTBOX_BACKOFF_MS.length - 1)] ?? 3_600_000) * outboxBackoffScale();
          svc<SopService>('sop').outboxMarkRetry(row.id, attempts, sqliteUtcIn(delay), String(e?.message ?? e));
        }
      }
    }
  } catch { /* worker 单轮失败不致命 */ }
}
const outboxTimer = setInterval(() => { void outboxWorkerTick(); }, 5_000);
outboxTimer.unref?.();

// ---------- P4 run 交付物（product/run-delivery F1-F4） ----------
// 上传：先校验 run 存在且 running（404/409 先于落盘——与 #25 同口径），再交给 multer 写盘。
const runFilesRoot = join(dataDir, 'run-files');
const runUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const dir = join(runFilesRoot, String((req.params as any).id ?? '0'));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = extname(fixFileName(file.originalname)).slice(0, 16).replace(/[^.\w-]/g, '');
      cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: UPLOAD_MAX, files: 1 },
});
// ---------- #437② run 文件配额与引用已有文件 ----------
const RUN_UPLOAD_MAX_COUNT = 20;
const RUN_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
const RUN_REF_MAX_COUNT = 2000;   // 引用不占新存储，只限条数
const RUN_REF_BATCH_MAX = 200;    // 单次请求最多关联多少条，历史大包分批
function runFileQuota(runId: number) {
  const files = svc<SopService>('sop').runFiles(runId) as { size: number; ref_of: number }[];
  const own = files.filter((f) => !f.ref_of), refs = files.length - own.length;
  const bytes = own.reduce((n, f) => n + Number(f.size || 0), 0);
  return {
    upload_count: own.length, upload_bytes: bytes, upload_max_count: RUN_UPLOAD_MAX_COUNT, upload_max_bytes: RUN_UPLOAD_MAX_BYTES,
    upload_left_count: Math.max(0, RUN_UPLOAD_MAX_COUNT - own.length), upload_left_bytes: Math.max(0, RUN_UPLOAD_MAX_BYTES - bytes),
    ref_count: refs, ref_max_count: RUN_REF_MAX_COUNT, ref_left_count: Math.max(0, RUN_REF_MAX_COUNT - refs),
  };
}
/** 写入本 run 的门：与上传同一口径（run 进行中；严格模式要上传令牌或管理员） */
function runFileWriteGate(req: express.Request, runId: number): void {
  const row = sopRunRow(runId);
  if (row.status !== 'running') throw new HttpError(409, `run ${runId} 已 ${row.status}，不可再关联文件`);
  const strict = (() => { try { const r = db.prepare("SELECT value FROM settings WHERE key = 'run_upload_require_token'").get() as { value?: string } | undefined; return String(r?.value ?? '') === '1'; } catch { return false; } })();
  if (strict && !adminHeaderOk(req)) {
    const presented = String(req.headers['x-run-upload-token'] ?? '').trim();
    const expected = String((row as any).upload_token ?? '');
    if (!expected) throw new HttpError(403, '该 run 无上传令牌（旧 run 上传面已关闭）');
    if (!presented) throw new HttpError(401, '缺少 X-Run-Upload-Token');
    if (presented !== expected) throw new HttpError(403, '上传令牌不符（run 不匹配或已过期）');
  }
}
registerSopRunFileRoutes(http, { wrap, markOdooAdmin, runFileWriteGate, sopRunRow, adminHeaderOk, runReadCapHeader, bad, RUN_REF_BATCH_MAX, RUN_REF_MAX_COUNT, RUN_UPLOAD_MAX_COUNT, RUN_UPLOAD_MAX_BYTES, runFileQuota, runUpload, fixFileName, checkUploadKind, sha256Hex, ensureRunFileSha });

// ---------- Cookie 池（监督席派单 direct-5fbb2176：web 型外部台 cookie 认证） ----------
registerCookieRoutes(http);

// PUT /api/workbenches/:id 已扩展支持 cookie_set_id（在 validateWorkbenchBody 后 merged）

// ---------- 19a 任务发布面（监督席 direct-58d60ed6，主人已批）----------
// 零新概念：给已有 run 写派单来源（复用 a2a_run_ctx），使其入待验收列表（dispatched=1）
registerSopRunControlRoutes(http, { wrap, sopRunRow, bad, sopRunStartCore });

registerStatsRoutes(http);
registerContentObservationRoutes(http, { adminGuard, portalObserver });

/** #275 过渡登录入口（#221 落地前）：挑一个可信 Odoo 台，走 /go/<id>/ 的 SSO v1 舞步并带 return 落回市场原页面。
 *  先选 origin = WM_ODOO_URL 的台（工作台只认这个 Odoo 的会话；session_id 按主机名跨端口共享，登别的 Odoo 会把它覆盖掉），
 *  再选与请求同主机名的台；都没有返回 null，不盲选（别的主机名登完市场也拿不到 session_id） */
function odooLoginUrl(req: express.Request, returnPath: string): string | null {
  // 同域登录中继开着：登录入口就是本机 /web/login（中继只放行登录面、上游固定为 WM_ODOO_URL、redirect 只认白名单回跳页），
  // 不再依赖库里登记了 Odoo 台——否则部署方只能手工插一条假工作台才有登录入口
  if (loginRelay().relayLogin() && loginRelay().sourceUrl()) return `/web/login?redirect=${encodeURIComponent(returnPath)}`;
  let host = '';
  try { host = new URL(`http://${String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()}`).hostname.toLowerCase(); } catch { host = ''; }
  const odoo = listWorkbenches().filter((w) => w.enabled && /^https?:\/\//i.test(w.url) && loginRelay().isSessionTarget(w.url));
  let idOrigin = '';
  try { idOrigin = new URL(loginRelay().sourceUrl()).origin; } catch { idOrigin = ''; }
  const at = (w: { url: string }) => { try { return new URL(w.url); } catch { return null; } };
  const pick = odoo.find((w) => idOrigin && at(w)?.origin === idOrigin) ?? odoo.find((w) => at(w)?.hostname.toLowerCase() === host);
  return pick ? `/go/${pick.id}/?return=${encodeURIComponent(returnPath)}` : null;
}

// ---------- 统一待办（omni-inbox · 总工程师设计 9c5557c1c0）：只读聚合 ----------
app.get('/api/tasks', wrap(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie'); res.vary('X-Admin-Token');
  if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req))) return res.status(403).json({ error: 'tasks_cross_origin_denied' });
  const access = await tasksReadAccess(adminHeaderOk(req), String(req.headers.cookie ?? ''));
  if (!access.ok) return res.status(access.http).json({ error: access.error, ...(access.http === 401 ? { login_url: odooLoginUrl(req, '/tasks') } : {}) });
  const payload = await collectTasks(svc<SopService>('sop') as never, access.scope);
  if (!extensionTaskSourceKeys().length) return res.json(payload);
  // 扩展来源自己按查看人判权（ctx.odoo.resolveViewer）；宿主不拿管理员身份替查看人取数
  const ext = await collectExtensionTasks(req);
  for (const [k, m] of Object.entries(ext.sources)) {
    ext.sources[k] = { ...m, ...(m.ok === false && m.error ? { error: `${k}_source_unavailable` } : {}), ...(m.auth_required ? { login_url: odooLoginUrl(req, '/tasks') } : {}) };
  }
  res.json({ ...payload, tasks: [...payload.tasks, ...ext.tasks], sources: { ...payload.sources, ...ext.sources } });
}));
app.put('/api/tasks/read-grants', (req, res) => {
  if (!adminGuard(req, res)) return;
  if (!createTaskSourceGrant(req.body)) return res.status(400).json({ error: 'invalid_task_source_grant' });
  res.status(201).json({ ok: true });
});
app.post('/api/tasks/read-grants/revoke', (req, res) => {
  if (!adminGuard(req, res)) return;
  const n = revokeTaskSourceGrant(req.body);
  if (n === null) return res.status(400).json({ error: 'invalid_task_source_grant' });
  res.json({ ok: true, revoked: n });
});

// #275 登录探测：弹窗送 Odoo 登录后，前端轮询这里拿 200 即回原页面（Odoo 19 无法跨源回跳，回程在市场源完成）；顶栏用户 chip 同源
registerAuthViewerRoutes(http, { wrap, odooLoginUrl });

// ---------- 主体管理（列出、停用、恢复）：路由在域模块里 ----------
registerPrincipalRoutes(http, { markOdooAdmin, adminGuard, adminActor });
registerGrantRoutes(http, { markOdooAdmin, adminGuard, adminActor }); // 阶段六 6b：角色声明与授予（只建结构，不接判定）
registerAttentionRoutes(http, { markOdooAdmin, adminGuard, adminHeaderOk, varsAuthorizeRead: workbenchVars.authorizeRead, crossOriginDenied: (req) => req.headers['sec-fetch-site'] === 'cross-site' || (!!req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req)) }); // 阶段八 8c：「关注」的读
registerWorkItemRoutes(http, { markOdooAdmin, adminGuard, crossOriginDenied: (req) => req.headers['sec-fetch-site'] === 'cross-site' || (!!req.headers.origin && !originIsThisSurface(req) && !devOriginOk(req)) }); // 阶段八 8d：事项页的时间线

// ---------- 扩展（WM_EXTENSIONS_DIR）：挂在身份/写门之后、SPA 回落之前；加载失败拒绝启动 ----------
try {
  const loaded = await loadExtensions(process.env.WM_EXTENSIONS_DIR, {
    app, wrap,
    adminGuard: async (req, res) => { await markOdooAdmin(req); return adminGuard(req, res); },
    odoo: { url: () => loginRelay().sourceUrl(), sessionOf: (cookie) => loginRelay().sessionOf(cookie), resolveViewer: (cookie) => identity().resolveViewer(cookie), loginUrl: odooLoginUrl, addReturnPath: (path) => loginRelay().addReturnPath(path) },
    remoteWrite: { allowExact: allowExtensionRemoteWrite },
  });
  if (loaded.length) console.log(`[extensions] 已加载：${loaded.join('、')}（${process.env.WM_EXTENSIONS_DIR}）`);
} catch (e) {
  console.error(`[extensions] 拒绝启动：${String((e as Error)?.message ?? e)}`);
  process.exit(1);
}
announceAllowDiff();

// ---------- 技能文件暂存（MCP 一次只传一个文件：skill_file_put 先暂存，skill_publish 按 sha256 引用成版）----------
const SKILL_STAGE_DIR = join(dataDir, 'skill-staging');
const SKILL_STAGE_TTL_MS = 24 * 3600_000;
const SKILL_FILE_MAX = 10 * 1024 * 1024; // 单文件上限（MCP 传输面；更大的走 REST 导出/发布）
/** 暂存一个文件，内容寻址：同内容幂等；顺手清掉超过 24h 的暂存 */
function skillStagePut(content: unknown, encoding: unknown): { sha256: string; size: number; expires_in_hours: number } {
  if (typeof content !== 'string') bad('content 必须是字符串');
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') bad('encoding 只收 utf8 或 base64');
  if (encoding === 'base64' && !isStrictBase64(content as string)) bad('content 不是合法 base64');
  const buf = Buffer.from(content as string, encoding === 'base64' ? 'base64' : 'utf8');
  if (buf.length > SKILL_FILE_MAX) bad(`单文件超过 ${SKILL_FILE_MAX} 字节上限`);
  const sha = createHash('sha256').update(buf).digest('hex');
  mkdirSync(SKILL_STAGE_DIR, { recursive: true });
  const now = Date.now();
  for (const e of readdirSync(SKILL_STAGE_DIR)) {
    try { const fp = join(SKILL_STAGE_DIR, e); if (now - statSync(fp).mtimeMs > SKILL_STAGE_TTL_MS) rmSync(fp, { force: true }); } catch { /* 并发删除 */ }
  }
  const fp = join(SKILL_STAGE_DIR, sha);
  if (existsSync(fp)) utimesSync(fp, new Date(), new Date()); // 重传续期
  else { const tmp = `${fp}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; writeFileSync(tmp, buf); renameSync(tmp, fp); } // 先写临时再改名：发布不会读到半个文件
  return { sha256: sha, size: buf.length, expires_in_hours: 24 };
}
/** 某技能某版本的快照目录（缺省当前版本：回滚指针，未回滚即最新）+ 版本行 */
function skillVersionDir(slugIn: unknown, versionIn: unknown): { row: any; target: any; dir: string } {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(slugIn ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${slugIn}`);
  const vs = S.versionsBySkill(row.id) as any[];
  const target = typeof versionIn === 'number' ? vs.find((v) => v.version === versionIn) : SkillService.currentOf(row, vs);
  if (!target) throw new HttpError(404, versionIn === undefined ? `无版本：${slugIn}` : `version not found: ${versionIn}`);
  const dir = resolveSnap(target.snapshot_path);
  if (!dir || !existsSync(dir)) throw new HttpError(404, `snapshot missing: v${target.version}`);
  return { row, target, dir };
}
function skillSnapFiles(dir: string): { path: string; abs: string }[] {
  const out: { path: string; abs: string }[] = [];
  (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else out.push({ path: rel + e.name, abs: fp }); } })(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------- 技能包下载（MCP skill_download 签发 10 分钟票据 → GET /api/skills/dl/<票号> 取 .tar.gz）----------
const SKILL_PKG_META = '.wm-skill.json';
const SKILL_PKG_VERIFY = '.wm-skill-verify.mjs';
const SKILL_PKG_RESERVED: ReadonlySet<string> = new Set([SKILL_PKG_META, SKILL_PKG_VERIFY]);
const SKILL_DL_TTL_MS = 10 * 60_000;
const SKILL_DL_MAX = 5; // 单票下载次数上限（留给网络重试），超过与过期同一 404，拒绝次数记在 denied
/** 票据表只存票号的 sha256：库被读走也拿不到能用的票（票号是 32 字节随机数，无需加盐） */
const skillTicketKey = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
const SKILL_INSTALL_ROOT = '~/.workbench-market/skills';
/** 包内目录名：slug 里的 : 换成 .（slug 不允许 .，所以不会撞名；Windows 也不收 :） */
const skillPkgDir = (slug: string) => slug.replace(/:/g, '.');
let _skillVerifyScript: Buffer | null = null;
function skillVerifyScript(): Buffer {
  return (_skillVerifyScript ??= readFileSync(new URL('./skill-verify.mjs', import.meta.url)));
}
/** 技能包 = <目录名>/ 下的快照文件 + 市场生成的 .wm-skill.json（清单）与 .wm-skill-verify.mjs（固定模板）。tree_digest 不含这两个文件 */
function skillPackage(row: any, target: any, dir: string): Buffer {
  const files = skillSnapFiles(dir).map((f) => ({ path: f.path, content: readFileSync(f.abs) }));
  if (files.some((f) => SKILL_PKG_RESERVED.has(f.path))) throw new HttpError(409, `v${target.version} 快照里有保留名文件，不能打包`);
  const name = skillPkgDir(row.slug);
  const meta = {
    schema: 1, slug: row.slug, name: row.name, dir: name, version: target.version, tree_digest: target.tree_digest,
    published_at: target.created_at ?? '', changelog: target.changelog ?? '',
    files: files.map((f) => ({ path: f.path, sha256: createHash('sha256').update(f.content).digest('hex'), size: f.content.length })),
    verify: `node ${SKILL_PKG_VERIFY}`, install: `node ${SKILL_PKG_VERIFY} --install`,
  };
  files.push({ path: SKILL_PKG_META, content: Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8') }, { path: SKILL_PKG_VERIFY, content: skillVerifyScript() });
  const mtime = Date.parse(String(target.created_at ?? '').replace(' ', 'T') + 'Z');
  return gzipSync(ustarTar(files, { prefix: name + '/', mtime: Number.isFinite(mtime) ? mtime / 1000 : 0 })); // gzip 头 mtime 恒 0
}
/** 安装命令里会拼进对外地址：只收规范的 http(s)://主机[:端口]，带引号等字符的 Host 头直接拒（没设 MARKET_PUBLIC_URL 时取自请求） */
function skillDownloadOrigin(origin: string): string {
  let u: URL | null = null;
  try { u = new URL(origin); } catch { /* 下面统一报 */ }
  if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash || !/^[A-Za-z0-9.\-\[\]:]+$/.test(u.host)) {
    throw new HttpError(400, '无法确定市场对外地址，不签发下载链接；请部署方设置 MARKET_PUBLIC_URL');
  }
  return u.origin;
}
function skillDownloadIssue(slugIn: unknown, versionIn: unknown, issuedTo: string, origin: string): Record<string, unknown> {
  const base = skillDownloadOrigin(origin);
  const { row, target } = skillVersionDir(slugIn, versionIn);
  const id = randomBytes(32).toString('hex');
  const exp = Date.now() + SKILL_DL_TTL_MS;
  db.prepare('DELETE FROM skill_download_tickets WHERE expires_at < ?').run(Date.now() - 86400_000); // 过期一天的票顺手清掉
  db.prepare('INSERT INTO skill_download_tickets (id, slug, version, issued_to, expires_at) VALUES (?, ?, ?, ?, ?)').run(skillTicketKey(id), row.slug, target.version, issuedTo, exp);
  const name = skillPkgDir(row.slug);
  const url = `${base}/api/skills/dl/${id}`;
  const pkgSha = createHash('sha256').update(skillPackage(row, target, skillVersionDir(row.slug, target.version).dir)).digest('hex');
  // 安装链只信 MCP 应答（会话通道）里服务端给的摘要，并把它们写进命令本身：
  // 下载后先用命令内联的固定逻辑核对整个包的 sha256，再解压，再核对校验脚本 = 市场模板，最后才运行包里的脚本（它再核对清单指纹 = tree_digest）。
  // 明文 http 下包被换也能发现；仍建议设 MARKET_PUBLIC_URL 走 https。
  const scriptSha = createHash('sha256').update(skillVerifyScript()).digest('hex');
  const script = `"$d/${name}/${SKILL_PKG_VERIFY}"`;
  const pin = (file: string, sha: string) => `node -e 'const h=require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex");if(h!==process.argv[2]){console.error("sha256 不符，已停止，未执行包内任何代码: "+process.argv[1]);process.exit(2)}' ${file} ${sha}`;
  return {
    slug: row.slug, version: target.version, tree_digest: target.tree_digest, file_count: target.file_count, total_bytes: target.total_bytes,
    download_url: url, expires_at: new Date(exp).toISOString(), package_dir: name, install_dir: `${SKILL_INSTALL_ROOT}/${name}`,
    package_sha256: pkgSha, verify_script_sha256: scriptSha,
    install_command: `d=$(mktemp -d) && curl -fsSL '${url}' -o "$d/pkg.tgz" && ${pin('"$d/pkg.tgz"', pkgSha)} && tar -xzf "$d/pkg.tgz" -C "$d" && ${pin(script, scriptSha)} && node ${script} --install --expect ${target.tree_digest}; rc=$?; rm -rf "$d"; (exit $rc)`, // 清理临时目录但保留安装结果的返回码
    verify_command: `node ${SKILL_INSTALL_ROOT}/${name}/${SKILL_PKG_VERIFY} --expect ${target.tree_digest}`,
  };
}
/** 技能发布核心（REST 口令面与 MCP skill_publish 共用）：首版建技能，此后每次 N+1；同技能同内容 409。
 *  refsOnly（MCP）：files 只收 {path, sha256}，内容取自 skill_file_put 的暂存，缺哪个点名 400 */
async function skillPublishCore(slugIn: unknown, files: any, changelogIn: unknown, reviewedByIn: unknown, opts: { refsOnly?: boolean } = {}): Promise<Record<string, unknown>> {
  const slug = String(slugIn ?? '').trim();
  // #94 S0③：slug 校验（小写字母数字开头·[a-z0-9:_-]·≤64）
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(slug)) bad('slug 非法（小写字母数字开头·仅 [a-z0-9:_-]·≤64 字符）');
  if (!Array.isArray(files) || files.length === 0) bad(opts.refsOnly ? 'files 必须为非空 [{path, sha256}]' : 'files 必须为非空 [{path, content}]');
  for (const f of files) {
    if (opts.refsOnly) {
      if (typeof f?.path !== 'string' || !f.path || typeof f?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || f.content !== undefined) bad('files 项须 {path, sha256}（内容先逐个经 skill_file_put 上传）');
    } else if (typeof f?.path !== 'string' || !f.path || typeof f?.content !== 'string') bad('files 项须 {path, content}');
    // 二进制文件（图片/字体/模板）用 encoding:'base64'；缺省 utf8 = 旧语义
    if (f.encoding !== undefined && f.encoding !== 'utf8' && f.encoding !== 'base64') bad(`encoding 只收 utf8 或 base64: ${f.path}`);
    if (f.encoding === 'base64' && !isStrictBase64(f.content)) bad(`content 不是合法 base64: ${f.path}`);
    // #94 S0③：path 严校验（反斜杠/绝对路径/空·.·..段全拒）
    if (f.path.length > 200) bad('path 过长（>200）');
    if (f.path.includes('\\')) bad(`path 非法（禁反斜杠）: ${f.path}`);
    if (f.path.startsWith('/') || /^[A-Za-z]:/.test(f.path)) bad(`path 非法（禁绝对路径）: ${f.path}`);
    for (const seg of f.path.split('/')) if (seg === '' || seg === '.' || seg === '..') bad(`path 非法（空/. / .. 段）: ${f.path}`);
    if (SKILL_PKG_RESERVED.has(f.path)) bad(`path ${f.path} 是技能包保留名（市场打包时生成）`);
  }
  // #94 S0③（K6）：同名重复路径拒收（同 path 两义——内容静默覆盖防）
  {
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f.path)) bad(`path 重复: ${f.path}（同名两义拒收）`);
      seen.add(f.path);
    }
  }
  const changelog = String(changelogIn ?? '').slice(0, 2000);
  const reviewedBy = String(reviewedByIn ?? '').trim();
  const S = svc<SkillService>('skill');
  // 指纹与落盘都按字节：utf8 文本与等价 base64 得同一 digest
  let blobs: { path: string; content: Buffer }[];
  if (opts.refsOnly) {
    const missing = (files as any[]).filter((f) => !existsSync(join(SKILL_STAGE_DIR, f.sha256))).map((f) => f.path);
    if (missing.length) bad(`这些文件还没经 skill_file_put 上传（或暂存已过 24h）：${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` 等 ${missing.length} 个` : ''}`);
    blobs = (files as any[]).map((f) => ({ path: String(f.path), content: readFileSync(join(SKILL_STAGE_DIR, f.sha256)) }));
  } else blobs = (files as any[]).map((f) => ({ path: String(f.path), content: Buffer.from(String(f.content), f.encoding === 'base64' ? 'base64' : 'utf8') }));
  const t = SkillService.filesDigest(blobs);
  let row = S.skillBySlug(slug);
  // #94 S0⑥（K9）：digest 按 skill 域查重（不同技能同内容各自可发布——全局唯一是误拒）
  const existed = row ? S.versionByDigest(t.digest, row.id) : undefined; // #94 S0⑥：仅同技能域查重（新技能无域可撞）
  if (existed) throw new HttpError(409, `内容 digest 已存在（skill_version #${existed.id}）——不可变锚拒重复发布`);
  const nextVer = row ? (S.versionsMax(row.id)?.v ?? 0) + 1 : 1;
  // #178 S14：发布吸收 SKILL.md frontmatter（name/description/argument-hint）——导入器同构
  let fmName = '';
  let fmDesc = '';
  let fmHint = '';
  {
    const sk = blobs.find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
    if (sk) {
      const txt = sk.content.toString('utf8').replace(/\r\n?/g, '\n');
      if (txt.startsWith('---')) {
        const end = txt.indexOf('\n---', 3);
        if (end > 0) {
          for (const ln of txt.slice(4, end).split('\n')) {
            const m = /^([\w-]+):\s*(.*)$/.exec(ln);
            if (!m) continue;
            const k = m[1].toLowerCase();
            const v = m[2].replace(/^["']|["']$/g, '').trim();
            if (k === 'name') fmName = v;
            else if (k === 'description') fmDesc = v;
            else if (k === 'argument-hint') fmHint = v;
          }
        }
      }
    }
  }

  if (!row) {
    // #94 S0②（K4）：首版不再强制 reviewed_by（人审门取消——发布/导入同权）
    S.upsertSkill({ slug, name: fmName || (slug.split(':').pop() ?? slug), layer: 5, layerName: 'AI 原生运营', description: fmDesc, argumentHint: fmHint, source: 'publish' }); // #178 S14
    row = S.skillBySlug(slug);
  } else if (fmDesc || fmHint || fmName) {
    S.upsertSkill({ slug, name: fmName || row.name, layer: row.layer, layerName: row.layer_name, description: fmDesc || row.description, argumentHint: fmHint || row.argument_hint, source: 'publish' }); // #178 S14：已存技能同步吸收
  }
  // 快照落盘：先写同级临时目录，写完整体改名成 v{N}——写到一半崩溃不留半个版本；
  // v{N} 已在而库里没有这一版（旧回滚失败、崩溃留下的孤儿）就先挪进 .orphans/，绝不和旧内容混写（混进去的文件不在 tree_digest 里，安装会因指纹不符被拒）
  const snapDir = join(dataDir, skillSnapRel(slug, nextVer)); // #183：磁盘与 DB 同一函数（slug 唯一形）
  const tmpDir = `${snapDir}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    for (const f of blobs) {
      const abs = join(tmpDir, f.path);
      mkdirSync(dirname(abs), { recursive: true }); // #94 S0②：子目录路径建父目录（docs/a.md 不再 500）
      writeFileSync(abs, f.content);
    }
    mkdirSync(tmpDir, { recursive: true }); // 空文件树也有目录（上面已校验非空，这里只兜底）
    if (existsSync(snapDir)) {
      const orphan = join(dirname(snapDir), '.orphans', `v${nextVer}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(dirname(orphan), { recursive: true });
      renameSync(snapDir, orphan);
      console.warn(`[skill-publish] ${slug} v${nextVer}: 快照目录已存在但库里无此版本（孤儿），已挪到 ${relative(dataDir, orphan).split('\\').join('/')}`);
    }
    renameSync(tmpDir, snapDir);
  } catch (e) { rmSync(tmpDir, { recursive: true, force: true }); throw e; }
  try {
    S.versionInsert({ skillId: row.id, version: nextVer, changelog, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: `skill-snapshots/${encodeURIComponent(slug)}/v${nextVer}`, reviewedBy }); // S4：存 dataDir 相对形
  } catch (e) { rmSync(snapDir, { recursive: true, force: true }); throw e; } // 版本行没落下就不留目录（否则又是孤儿）
  S.setActive(row.id, null); // 发布新版即恢复跟随最新（回滚指针清掉）
  // Skill shadow remains non-blocking; its per-version outcome is durable/retryable like app publishing.
  // LayerFS 契约 v1 只收文本：含二进制的版本不推影子，记 skipped（与 migrate-layerfs 的留档不迁同义）
  const binary = blobs.find((f) => !isUtf8Bytes(f.content));
  if (binary) db.prepare("UPDATE skill_versions SET shadow_status='skipped', shadow_error=? WHERE skill_id=? AND version=? AND commit_id=''").run(`含非 UTF-8（二进制）文件 ${binary.path}：LayerFS 契约只收文本，不推影子`, row.id, nextVer);
  else void layerfsPublish(LAYERFS_SKILLS_PROJECT, blobs.map((f) => ({ path: f.path, content: f.content.toString('utf8') })), `[skill-publish] ${slug} v${nextVer}`, `skill/${slug}`).then((out) => {
    try { recordLayerFsSkillShadowOutcome(db, Number(row.id), nextVer, out); }
    catch (e) { console.warn(`[S2-shadow] outcome persistence failed: ${slug} v${nextVer}: ${String((e as Error).message).slice(0,100)}`); }
  }).catch((e) => {
    console.warn(`[S2-shadow] publish promise failed: ${slug} v${nextVer}: ${String((e as Error).message).slice(0,100)}`);
    try { recordLayerFsSkillShadowOutcome(db, Number(row.id), nextVer, null); }
    catch (persistErr) { console.warn(`[S2-shadow] failure status persistence failed: ${String((persistErr as Error).message).slice(0,100)}`); }
  });
  return { ok: true, slug, version: nextVer, tree_digest: t.digest, file_count: t.fileCount, total_bytes: t.totalBytes, snapshot_path: `skill-snapshots/${encodeURIComponent(slug)}/v${nextVer}` }; // #94 S0⑤：不暴露 DATA_DIR 绝对路径
}

// ---------- #94 S4 D4：技能内容月度整库重建（layerfs#411 不能退役分支——定期重建清除已删技能残留） ----------
async function rebuildWmSkills(trigger: string): Promise<{ ok: boolean; deleted_project: boolean; republished: number; cleared_stale: number }> {
  const { base, token } = layerfsServiceBase();
  if (!base) throw new HttpError(502, 'layerfs 服务未配置——重建不可用');
  // ① 整库删（服务删项目·卷·备份——已删技能分支随之灭）
  let deleted = false;
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + LAYERFS_SKILLS_PROJECT, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
    deleted = r.ok;
  } catch { deleted = false; }
  // ② 活技能当前版本重发布（旧 commit_id 清——重建后历史 commit 失效；回滚过的技能分支头即回滚到的版本）
  let republished = 0; let cleared = 0;
  const S = svc<SkillService>('skill');
  for (const sk of S.skillsAll() as any[]) {
    const vs = S.versionsBySkill(sk.id) as any[];
    const latest = SkillService.currentOf(sk, vs);
    if (!latest?.snapshot_path || !existsSync(resolveSnap(latest.snapshot_path))) continue;
    db.prepare("UPDATE skill_versions SET commit_id = '' WHERE skill_id = ?").run(sk.id); cleared++;
    const raw: { path: string; bytes: Buffer }[] = [];
    try { (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else raw.push({ path: rel + e.name, bytes: readFileSync(fp) }); } })(resolveSnap(latest.snapshot_path)); } catch { continue; }
    if (raw.some((f) => !isUtf8Bytes(f.bytes))) continue; // 含二进制：LayerFS 只收文本，不迁
    const files = raw.map((f) => ({ path: f.path, content: f.bytes.toString('utf8') }));
    if (files.length === 0 || files.some((f) => f.content === '')) continue; // 异常快照不迁
    const out = await layerfsPublish(LAYERFS_SKILLS_PROJECT, files, `[rebuild] ${sk.slug} v${latest.version}`, `skill/${sk.slug}`);
    if (out) { db.prepare('UPDATE skill_versions SET commit_id = ? WHERE id = ?').run(out.commit_id, latest.id); republished++; }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_wm_skills_rebuild', datetime('now'))").run();
  console.log(`[S4-rebuild] ${trigger}: deleted=${deleted} republished=${republished} cleared=${cleared}`);
  return { ok: true, deleted_project: deleted, republished, cleared_stale: cleared };
}
// 月度调度：启动+每 24h 查——距上次重建 ≥30 天即自动触发
void (async function scheduleMonthlyRebuild() {
  const check = async () => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'last_wm_skills_rebuild'").get() as { value?: string } | undefined;
      const last = row?.value ? Date.parse(row.value.replace(' ', 'T') + 'Z') : 0;
      if (Date.now() - last >= 30 * 24 * 3600 * 1000) await rebuildWmSkills('monthly-auto');
    } catch { /* 调度失败不阻运行 */ }
  };
  setTimeout(check, 60_000).unref?.();
  setInterval(check, 24 * 3600 * 1000).unref?.();
})();


/** 严格 base64（标准字母表、长度 4 的倍数、末尾至多两个 =）；Buffer.from 会静默跳过非法字符，不能拿它当校验 */
function isStrictBase64(s: string): boolean {
  return s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}
/** 字节能无损按 UTF-8 往返 = 文本文件 */
function isUtf8Bytes(b: Buffer): boolean {
  return Buffer.from(b.toString('utf8'), 'utf8').equals(b);
}
/** #94 S3：最小 ustar 打包（薄分发导出——D5·无外部依赖） */
function ustarTar(files: { path: string; content: string | Buffer }[], opts: { prefix?: string; mtime?: number } = {}): Buffer {
  const chunks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512, 0);
    // 名字超过 100 字节时拆进 ustar 的 prefix 字段（≤155 字节，在 / 处断开），不再静默截断
    let nm = name, pre = '';
    if (Buffer.byteLength(nm) > 100) {
      const cut = [...nm.matchAll(/\//g)].map((m) => m.index!).reverse().find((i) => Buffer.byteLength(nm.slice(0, i)) <= 155 && Buffer.byteLength(nm.slice(i + 1)) <= 100);
      if (cut === undefined) throw new HttpError(422, `路径过长，tar 装不下: ${name}`);
      pre = nm.slice(0, cut); nm = nm.slice(cut + 1);
    }
    h.write(nm, 0, 'utf8');
    if (pre) h.write(pre, 345, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(opts.mtime ?? Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136); // 技能包传版本发布时刻：同一版本每次打出逐字节相同的包
    h.write(' '.repeat(8), 148);
    h.write(type, 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  for (const f of files) {
    const body = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    chunks.push(header((opts.prefix ?? '') + f.path, body.length, '0')); // #132 P1④：包内 <slug>/ 顶层
    chunks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}


registerSkillRoutes(http, { adminGuard, wrap, bad, resolveSnap, skillPublishCore, skillTicketKey, skillVersionDir, skillPackage, skillPkgDir, SKILL_DL_MAX, executeSkillRollback, executeSkillDelete, layerfsPublish, LAYERFS_SKILLS_PROJECT, layerfsServiceBase, rebuildWmSkills, ustarTar });

// ---------- #437③ 进行中的 run 升级到当前 SOP 版本（预检 + 人确认 + 审计） ----------
/** 每步的 data-field 名（含没有规则的字段），用来列出升级后新增、失效的字段 */
function sopStepFields(manifest: SopManifest): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of manifest.steps) {
    const set = new Set<string>();
    for (const m of String(s.body ?? '').matchAll(/data-field\s*=\s*["']([^"']+)["']/g)) set.add(m[1]);
    out.set(s.key, set);
  }
  return out;
}
function sopVersionManifest(slug: string, version: number): SopManifest | null {
  const p = join(appsRoot, slug, `v${version}`, 'sop.yaml');
  return existsSync(p) ? parseSopManifest(readFileSync(p, 'utf8')) : null;
}
/** 预检：run 现有数据分别按旧版、当前版规则核一遍，并列出字段增减与升级后无处安放的数据（数据保留，不删） */
async function sopRunUpgradePlan(id: number) {
  const row = sopRunRow(id);
  if (row.sop_slug === 'task-center') throw new HttpError(400, '任务中心记录不走 SOP 版本');
  if (row.status !== 'running') throw new HttpError(409, `run ${id} 已 ${row.status}，只能升级进行中的记录`);
  const active = readActiveManifest(row.sop_slug);
  if (!active) throw new HttpError(404, `SOP ${row.sop_slug} 当前版本不可读`);
  const { data } = await runLiveData(row, true); // 升级会换版本号，旧热态之后对不上校验点，读不到时必须等
  const oldM = sopVersionManifest(row.sop_slug, row.sop_version);
  const newM = active.manifest;
  const oldF = oldM ? sopStepFields(oldM) : new Map<string, Set<string>>();
  const newF = sopStepFields(newM);
  const list = (a: Map<string, Set<string>>, b: Map<string, Set<string>>) => [...a].flatMap(([step, fs]) => [...fs].filter((f) => !b.get(step)?.has(f)).map((f) => `${step}.${f}`));
  const orphan = Object.entries(data).flatMap(([step, v]) => !newF.has(step) ? [step] : v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).filter((f) => !newF.get(step)!.has(f)).map((f) => `${step}.${f}`) : []);
  return {
    row, data, target: active.app.active_version,
    preflight: {
      run_id: id, sop_slug: row.sop_slug, from_version: row.sop_version, to_version: active.app.active_version,
      up_to_date: row.sop_version === active.app.active_version,
      old_rules_readable: !!oldM,
      violations_now: oldM ? checkRunData(extractFieldRules(oldM), data) : null,
      violations_after: checkRunData(extractFieldRules(newM), data),
      fields_added: list(newF, oldF), fields_removed: list(oldF, newF), data_without_field: orphan,
      history: svc<SopService>('sop').runUpgradeAuditList(id),
    },
  };
}
registerSopRunLifecycleRoutes(http, { wrap, adminHeaderOk, runReadCapHeader, sopRunGetCore, sopRunGetMeta, sopRunStepSaveCore, sopRunFinishCore, markOdooAdmin, sopRunUpgradePlan, bad, runCheckpoints, adminActor });

// ---------- 自产台静态托管：GET /apps/:slug/* → DATA_DIR/apps/<slug>/v<active>/* ----------
function serveApp(req: express.Request, res: express.Response) {
  // #170 P11 sandbox：自产台与市场同源——CSP sandbox（不助 allow-same-origin）=不透明源，摸不到市场 API/存储
  try { res.setHeader('content-security-policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'); } catch { /* 已发头 */ }
  const m = /^\/apps\/([a-z0-9][a-z0-9-]*)\/?(.*)$/.exec(req.path ?? '');
  if (!m) return res.status(404).json({ error: 'not found' });
  let rest = '';
  try {
    rest = decodeURIComponent(m[2] || '');
  } catch {
    return res.status(400).json({ error: '路径编码非法' });
  }
  const a = svc<AppService>('app').bySlug(m[1]) as unknown as AppRow | undefined;
  if (!a) return res.status(404).json({ error: `app not found: ${m[1]}` });
  // S2 预览槽（采购席反馈 P2）：?version=N 服务历史版本（版本链已有，预览成本极低）——
  // 发布前对照/回滚核查用；非数字或不存在的版本回落活跃版。
  let ver = a.active_version;
  const qv = String(req.query.version ?? '');
  if (qv !== '' && /^\d+$/.test(qv)) {
    const hit = svc<AppService>('app').versionExists(a.id, Number(qv)) as { version: number } | undefined;
    if (hit) ver = hit.version;
  }
  const root = join(appsRoot, m[1], `v${ver}`);
  let rel = posix.normalize(rest || 'index.html');
  if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = join(root, rel);
  if (!abs.startsWith(root)) return res.status(400).json({ error: '路径非法' });
  res.setHeader('X-App-Version', `v${ver}`);
  if (!existsSync(abs)) {
    // #94 P2（L6）：冷版本回读——物化已 prune·版本链在——经 layerfs 服务取该版 Commit 文件集
    void (async () => {
      try {
        const a2 = svc<AppService>('app').bySlug(m[1]) as unknown as AppRow | undefined;
        const vrow = a2 ? (svc<AppService>('app').versions(a2.id) as any[]).find((x) => x.version === ver) : undefined;
        if (!vrow?.commit_id) {
          if (!posix.extname(rel) && existsSync(join(root, 'index.html'))) return res.sendFile(join(root, 'index.html'));
          return res.status(404).json({ error: `file not found (cold, no commit): ${rel}` });
        }
        const { base, token } = layerfsServiceBase();
        if (!base) return res.status(502).json({ error: '冷版本需 layerfs 服务（未配置）' });
        const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(m[1])) + '/branches/release/commits/' + encodeURIComponent(vrow.commit_id) + '/files', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
        if (!fr.ok) return res.status(502).json({ error: `冷回读服务 HTTP ${fr.status}` });
        const fj = await fr.json() as { files: { path: string; content: string }[] };
        const hitFile = fj.files.find((f) => f.path === rel) ?? (!posix.extname(rel) ? fj.files.find((f) => f.path === 'index.html') : undefined);
        if (!hitFile) return res.status(404).json({ error: `file not found in commit: ${rel}` });
        res.setHeader('Content-Length', String(Buffer.byteLength(hitFile.content, 'utf8')));
        return res.end(hitFile.content);
      } catch (e) {
        return res.status(502).json({ error: `冷回读失败: ${String((e as Error).message).slice(0, 80)}` });
      }
    })();
    return; // 异步冷回读接管
  }
  // #198（裁 A）：自产台 HTML 注入按台令牌——sandbox 页面凭它调本台 data/files（P11 回归修复）
  if (/\.html?$/i.test(rel)) {
    let raw: string;
    try { raw = readFileSync(abs, 'utf8'); } catch { return res.sendFile(abs); /* 读取失败回落原样 */ }
    // 8f-2：认得出看页面的是启用的人，就给一张只能在这个台的提交上记下他的票据（只有当前上架的版本出票）。
    // 出票抛错页面照常、不带票据；别的出错回到原样页面并计数（app-html.ts）
    void serveAppHtml(req, res, { raw, abs, slug: m[1], current: ver === a.active_version }, {
      person: async (r) => (await requestPerson(r)).principal,
      appToken: wmAppToken,
      workbenchId: (slug) => String(wmWorkbenchIdFor(`/apps/${slug}/`)),
      issueTicket: issueSubmitterTicket,
      rewrite: (r, html) => loginGate.rewriteAppHtml(r, html),
      countFallback: () => countSubmitterTicket('page_fallback'),
    });
    return;
  }
  res.sendFile(abs);
}
// 必须在 web/dist SPA fallback 之前注册
app.get(/^\/apps\/[a-z0-9][a-z0-9-]*(\/.*)?$/, serveApp);
// #321 设计 token 的固定路径（自产台 <link> 引入）：/design/tokens@<主版本>.css 推荐（主版本内名字稳定、值可变，按需重新验证），
// /design/tokens@<完整版本>.css 精确钉版本（内容不变，可长缓存）；其他版本 404，不猜
registerDesignTokenRoutes(http);

function summaryPayload() {
  const rows = listWorkbenches();
  const up = rows.filter((w) => w.enabled && w.last_status === 'up');
  const latencies = up.map((w) => w.last_latency_ms ?? 0).filter((n) => n > 0);
  const byCategory = new Map<string, { total: number; up: number }>();
  for (const w of rows) {
    const c = w.category || '未分类';
    const e = byCategory.get(c) ?? { total: 0, up: 0 };
    e.total += 1;
    if (w.enabled && w.last_status === 'up') e.up += 1;
    byCategory.set(c, e);
  }
  return {
    total: rows.length,
    enabled: rows.filter((w) => w.enabled).length,
    up: up.length,
    down: rows.filter((w) => w.enabled && w.last_status === 'down').length,
    unknown: rows.filter((w) => w.enabled && w.last_status === 'unknown').length,
    avg_latency_ms: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    categories: Object.fromEntries([...byCategory].map(([k, v]) => [k, v])),
  };
}

registerSummaryRoutes(http, { summaryPayload });

// ---------- 类型管理 ----------
registerTypeRoutes(http);

// ---------- 设置 / 导入导出 ----------
// ---------- 管理员口令手动设置（本机引导：首次无口令时允许从 loopback 设置） ----------
/** 首次设口令（库里还没有口令）：本机直连（CLI 或本机同源页面），或 Odoo 管理员；改/清口令：带当前口令或 Odoo 管理员 */
registerAdminTokenRoutes(http, { adminTokenCheck, odooAdminReqs, dbAdminTokenSet, dbAdminTokenOk, hashAdminToken, browserSameSite, devOriginOk });

// 评审 #24：settings 出口把 mcp_upstreams.headers 的值掩成 ****（键名保留）——
// 内部读取走 mcpUpstreams() 直读 DB，不受影响；导出同样脱敏（与 auth.value 口径一致）。
// 评审 #27：管理员口令哈希（admin_token_sha256）同表存放，出口一律剔除——远程 GET 无口令可读，
// 无盐 sha256 + 短口令可离线爆破；口令只经 /api/admin-token 设置与校验，不随设置/导出外流。
function maskUpstreamsSetting(settings: Record<string, string>): Record<string, string> {
  const { [ADMIN_TOKEN_KEY]: _adminHash, ...all } = settings;
  const raw = all.mcp_upstreams;
  if (!raw) return all;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { ...all, mcp_upstreams: '' };
    const masked = arr.map((u: any) => ({
      ...u,
      headers: u?.headers && typeof u.headers === 'object'
        ? Object.fromEntries(Object.keys(u.headers).map((k) => [k, '****']))
        : {},
    }));
    return { ...all, mcp_upstreams: JSON.stringify(masked) };
  } catch {
    return { ...all, mcp_upstreams: '' };
  }
}

registerSettingsRoutes(http, { maskUpstreamsSetting, armPatrol });

registerExportImportRoutes(http, { listWorkbenches, maskForApi, maskUpstreamsSetting, URL_POLICY, admitOrDeny, restSubject, markAdmin: markOdooAdmin, adminGuard });

// ---------- 凭据库（融合 dsh-vault）：读写全部过 vaultGuard ----------
// 与 adminGuard 同口径，只多认一种浏览器形态：同源 GET 不带 Origin（只有 Sec-Fetch-Site: same-origin），
// adminGuard 按「无 Origin 即非本面」会拒掉控制面页面自己的读请求；凭据读必须和写一样严，所以读也要口令。
function vaultGuard(req: express.Request, res: express.Response): boolean {
  if (browserMarked(req) && !req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin' && surfaceOf(req) !== 'content') {
    if (isAdmin(req)) return true;
    res.status(403).json({ error: '需要有效的 X-Admin-Token 或 Odoo 管理员登录（凭据库读写都要管理员）' });
    return false;
  }
  return adminGuard(req, res);
}
mountVault(app, vaultGuard, (req) => VAULT_ON_MAIN || surfaceOf(req) === 'control' || onVaultHost(req)); // 服务端持有主密码时只在控制面或凭据库专用域名开放（两者都不承载 /go/、/sop/、/apps/）；属主显式接受同源风险时主域名也开放
workbenchVars.mount(app); // #336 /api/workbenches/:id/vars

// 存活 / 就绪分开：/api/health 是存活（只看本进程，不发外部请求）；/api/health/ready 是就绪（含 LayerFS）。
// 两者都是公开端点，LayerFS 探测结果缓存 10 秒、同一时刻只发一次，匿名请求打不穿到 LayerFS。
const LAYERFS_PROBE_TTL_MS = 10_000;
let layerfsProbe: { at: number; status: 'healthy' | 'unhealthy' | 'unreachable' } | null = null;
let layerfsProbing: Promise<'healthy' | 'unhealthy' | 'unreachable'> | null = null;
function layerfsReadiness(): Promise<'healthy' | 'unhealthy' | 'unreachable'> {
  if (layerfsProbe && Date.now() - layerfsProbe.at < LAYERFS_PROBE_TTL_MS) return Promise.resolve(layerfsProbe.status);
  layerfsProbing ??= (async () => {
    let status: 'healthy' | 'unhealthy' | 'unreachable';
    try {
      const { base } = layerfsServiceBase();
      const r = await fetch(base.replace(/\/+$/, '') + '/healthz', { signal: AbortSignal.timeout(2500) });
      status = r.ok ? 'healthy' : 'unhealthy';
    } catch { status = 'unreachable'; }
    layerfsProbe = { at: Date.now(), status };
    return status;
  })().finally(() => { layerfsProbing = null; });
  return layerfsProbing;
}
function healthBase(): Record<string, unknown> {
  return { ok: true, service: 'workbench-market-server', version: '0.1.0', uptime_s: Math.round(process.uptime()), login_gate: loginGate.mode, self_probe: startupSecurity.snapshot() };
}
app.get('/api/health', (_req, res) => {
  const result = healthBase();
  if (process.env.LAYERFS_SERVICE_URL && layerfsProbe) result.layerfs = layerfsProbe.status; // 只回缓存的上次结果，不触发探测
  result.a2a = a2aHealth({ directSig: A2A_DIRECT_SIG, directSigBody: A2A_DIRECT_SIG_BODY! }); // 阶段七第 5 步：只出开关、计数和时长
  res.json(result);
});
app.get('/api/health/ready', async (_req, res) => {
  const result = healthBase();
  if (process.env.LAYERFS_SERVICE_URL) {
    result.layerfs = await layerfsReadiness();
    if (result.layerfs !== 'healthy') { result.ok = false; return res.status(503).json(result); }
  }
  res.json(result);
});
loginGate.mount(app); // /login、/api/auth/login|logout|me（解析器之后、SPA 回落之前）
registerLoginFlowRoutes(http, { publicUrl: marketPublicUrl, sessionTtlMs: SESSION_TTL_MIN * 60_000 });
registerLoginEventRoutes(http); // /login/<方式>/events：离职、停用的失效通知；每天一次对账 // /login/<方式>、/login/<方式>/callback：飞书等发市场会话的登录

// ---------- A2A 网络接入（GH #17 P1：签名卡片 + 人工绑定，只读暴露） ----------
// 卡片：canonical/签名与上游 card.ts（裁判钉 75a3ebd）逐字节一致；sessionTeams 只列
// published 且 ≥1 有效绑定的 SOP；不发布 teamMemberships（修订 3：绑定图不出门）。
registerAgentCardRoutes(http);

// 人工绑定 API（读写都要 ADMIN_TOKEN + Origin 空或同源——服务端校验跨源，CORS 白名单管不住执行）
// 管理员口令存储（主人要求「页面手动设置」）：settings.admin_token_sha256（不可逆），
// 优先级 env ADMIN_TOKEN > 库内值 > 无（未设一律 403）。DB 仅存 sha256，明文不落库。
function dbAdminTokenSet(): boolean {
  return !!svc<SettingService>('setting').has(ADMIN_TOKEN_KEY);
}
// 口令哈希（评审 #27）：新值一律**加盐**——`<salt32hex>$<sha256(salt+token)64hex>`。
// 旧值（无 `$`，单轮无盐 sha256）保持可验证，下次设置口令时自动升级为加盐格式。
function hashAdminToken(token: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('hex');
  return `${s}$${createHash('sha256').update(s + token, 'utf8').digest('hex')}`;
}
function dbAdminTokenOk(provided: string | undefined): boolean {
  const row = svc<SettingService>('setting').get(ADMIN_TOKEN_KEY) as { value: string } | undefined;
  if (!row) return false;
  const stored = String(row.value);
  const got = stored.includes('$')
    ? hashAdminToken(String(provided ?? ''), stored.split('$')[0])
    : createHash('sha256').update(String(provided ?? ''), 'utf8').digest('hex'); // 兼容旧无盐格式
  const a = Buffer.from(got.split('$').pop() ?? '', 'hex');
  const b = Buffer.from(stored.split('$').pop() ?? '', 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
/** 口令校验：env 优先（启动环境注入），否则库内 sha256 */
function adminTokenCheck(provided: string | undefined): boolean {
  return process.env.ADMIN_TOKEN ? adminTokenOk(provided) : dbAdminTokenOk(provided);
}

/** 管理员：有效口令，或本次请求已认定为 Odoo 管理员（见上方预判中间件） */
function isAdmin(req: express.Request): boolean {
  return adminTokenCheck(req.headers['x-admin-token']) || odooAdminReqs.has(req);
}

/** 浏览器来源门：带 Sec-Fetch-Site 的必须是同源（Odoo 会话 cookie 是环境凭据，防跨站借用） */
function browserSameSite(req: express.Request): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none' || devOriginOk(req);
}

/** P0：静默管理员判定（不写响应——供上传面与 token 二选一逻辑用） */
function adminHeaderOk(req: express.Request): boolean {
  if (!isAdmin(req) || !browserSameSite(req)) return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(String(origin)).host !== String(req.headers.host ?? '')) return false; } catch { return false; } }
  return true;
}

function adminGuard(req: express.Request, res: express.Response): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({ error: '需要有效的 X-Admin-Token 或 Odoo 管理员登录（口令缺失或无效一律拒绝；顶栏钥匙图标可输入口令）' }); // 属主报障文案修正：不再把「未带/无效」说成「未设置」
    return false;
  }
  if (!browserSameSite(req)) {
    res.status(403).json({ error: '跨源写操作被拒绝' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin && !devOriginOk(req)) {
    try {
      const oh = new URL(String(origin)).host;
      if (oh !== String(req.headers.host ?? '')) {
        res.status(403).json({ error: '跨源写操作被拒绝' });
        return false;
      }
    } catch {
      res.status(403).json({ error: 'Origin 非法' });
      return false;
    }
  }
  return true;
}

/** web dev（vite 5173 经代理转 /api）：Origin 是白名单里的本机 dev 源、且本机直连时，视同控制面。
 *  **默认关闭**，只在显式开启时生效：启动参数 `--dev-origin`（`pnpm dev` 已带）或环境变量 `WM_DEV_ORIGIN=1`；
 *  生产 `pnpm start` / 容器不带，5173 来源的管理写一律 403（评审席 #294 ee13ad9：曾在 production 下 201）。 */
const DEV_ORIGIN_ENABLED = process.argv.includes('--dev-origin') || process.env.WM_DEV_ORIGIN === '1';
if (DEV_ORIGIN_ENABLED) console.warn('[surfaces] 已开启 web dev 来源例外（--dev-origin / WM_DEV_ORIGIN=1）：本机 vite 5173 页面可凭口令做管理写；生产不要开');
function devOriginOk(req: express.Request): boolean {
  return DEV_ORIGIN_ENABLED && CORS_ALLOW.has(String(req.headers.origin ?? '')) && rawLoopback(req);
}

// #159 M3 B2（决策 #010）：任务中心——同源门（C1/C9/C10 三态）+ 状态迁移（恰一条事件）+ 8 端点
/** 同源门：Origin 存在时必须与 Host 同源（跨站 → 403）；无 Origin（curl/同源）放行给 adminGuard 判口令 */
function sameOriginGuard(req: express.Request, res: express.Response): boolean {
  const origin = String(req.headers.origin ?? '');
  if (!origin) return true;
  const host = String(req.headers.host ?? '');
  try { return new URL(origin).host === host; } catch { return false; }
}

// ---- 任务中心 8 端点（读开放·写删人审·C13 元台只能人工面） ----
registerTaskIntakeRoutes(http, { sameOriginGuard, adminGuard });
registerWorkbenchEventRoutes(app, { admin: adminGuard, sameOrigin: (req) => sameOriginGuard(req, undefined as never) });
registerTaskReadRoutes(http, { wrap, adminHeaderOk, runReadCapHeader });
registerSopRunAccessRoutes(http, { adminGuard, sopRunRow, bad });
registerTaskControlRoutes(http, { readActiveManifest, sameOriginGuard, adminGuard });




// ---------- 统一绑定面（联合评审①裁定 C · 2026-10-26）：表层统一+语义分离 ----------
// 一张 bindings 表：direction(admits=入站准入|notify=出站推送|both=显式双授永非默认)。
// 授权独立铁律：admits 消费点只认 admits|both；notify 消费点只认 notify|both——授一边不隐含另一边。
// 跨型 CHECK（DDL）：app 行 remote_api_key 恒空、mode 恒 read（sop 专属语义不漂移）。
// S3 豁免面可观测（评审席裁下批）：GET /api/remote-allow/diff——安全清单变更管理面可查
// SSO 回调路由（属主令「都需要」·A 面）：Odoo 登录完 302 回市场统一入口——
// /sso/callback?redirect=/go/N/&state=xxx → 内域校验 → 302 目标台（会话 cookie 由浏览器自持 Odoo 域·此处只管回跳安全）
registerSsoRoutes(http);

registerRemoteAllowRoutes(http, { adminGuard, lastAllowDiff });

registerSopSpaceRoutes(http, { getApp, adminHeaderOk, bad, appsRoot, parseSopManifest });

registerBindingRoutes(http, { adminGuard, getApp });

// （旧双面绑定 CRUD 已删——统一面 /api/bindings 承接，410 过渡件在上）

// /a2a/direct（P2）：准入开放——有效绑定 + 同 context 续 run + 上游幂等族 + 512KiB + DELIVERED 形状。
// 查无 SOP 仍 404 不泄露；无绑定/draft/mode 不足 → 200 TASK_STATE_FAILED -32000（对齐上游 admission 形状）。
// ADMIN_TOKEN 未设置时绑定面休眠（主人裁定：内网信任模型）——direct 对无绑定的 SOP 自然全拒。
app.post('/a2a/direct', express.json({ limit: '600kb' }), async (req, res) => {
  const rawBytes = Number(req.headers['content-length'] ?? 0) || JSON.stringify(req.body ?? {}).length;
  // 入站签名（WM_A2A_DIRECT_SIG）：签名身份对上 caller_session 才进下面的绑定准入
  if (A2A_DIRECT_SIG !== 'off') {
    const caller = typeof req.body?.caller_session === 'string' ? req.body.caller_session : '';
    const presence = directSig.presence(req);
    let reason = '';
    if (presence === 'signed') {
      const v = await directSig.verify(req, (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0), caller);
      // accept：调用方没登记取卡地址时验不了，按未签名的老路走（不比无签名更宽）
      if (!v.ok && !(A2A_DIRECT_SIG === 'accept' && v.reason === 'unregistered')) reason = v.reason;
    } else if (A2A_DIRECT_SIG === 'require') reason = presence === 'unbound' ? 'unbound-only' : 'absent';
    if (reason !== '') {
      console.warn(JSON.stringify({ source: 'a2a-direct-sig', refused: reason }));
      noteA2aError(`sig:${reason}` as A2aErrorKey);
      // 对外把「没登记」与「取不到卡」并成一种，不泄露绑定是否存在
      const shown = reason === 'unregistered' ? 'no-card' : reason;
      res.status(401).json({ error: `untrusted-origin: signature verification failed (${shown}) — sign with OriginClaim Sig2 (X-A2A-Caller/-Url/-Ts/-Aud/-Sig2) using the card key published at the address registered on your binding`, code: -32000, task_status: 'TASK_STATE_FAILED' });
      return;
    }
  }
  // run 操作桥（P2 note 写入走 sop_runs 的哑数据面：step_key=note-<ts> 追加不覆盖）
  const runOps = {
    start: (slug: string, startedBy: string): { id: number; read_capability: string } => { const r = sopRunStartCore(slug, startedBy); return { id: r.id, read_capability: r.read_capability }; },
    uploadToken: (id: number): string => String((db.prepare('SELECT upload_token FROM sop_runs WHERE id = ?').get(id) as { upload_token?: string } | undefined)?.upload_token ?? ''), // P0：派单回执带令牌（创建者即得）
    saveNote: (runId: number, text: string): Promise<void> => runCheckpoints.serial(runId, async () => {
      const row = sopRunRow(runId);
      if (row.status !== 'running') throw new HttpError(409, 'run ' + runId + ' 已 ' + row.status + '，不可再写');
      const data = row.sop_slug === 'task-center' ? storedRunData(row) : (await runLiveData(row, false, true)).data; // #448: a note is a write too
      const notes = Array.isArray(data['a2a-notes']) ? data['a2a-notes'] as unknown[] : [];
      notes.push({ at: new Date().toISOString(), text });
      data['a2a-notes'] = notes;
      if (row.sop_slug === 'task-center') {
        svc<SopService>('sop').runUpdateData(runId, JSON.stringify(data));
        runCheckpoints.forget(runId); // pure SQLite path must never retain a stale note snapshot
      } else {
        runCheckpoints.remember(runId, data, true); // delivered note requires SQLite success before cache publication
        await runStateRestore(runId, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data, runCacheCheckpoint(sopRunRow(runId)));
      }
    }),
    statusOf: (runId: number): { status: string; steps: number } | null => {
      const row = svc<SopService>('sop').runStatusData(runId) as { status: string; data: string } | undefined;
      if (!row) return null;
      let n = 0;
      try { n = Object.keys(JSON.parse(row.data || '{}')).length; } catch { n = 0; }
      return { status: row.status, steps: n };
    },
    ctxBind: (contextId: string): number | null => {
      const hit = svc<SopService>('sop').ctxRunId(contextId) as { run_id: number } | undefined;
      return hit ? hit.run_id : null;
    },
    ctxRegister: (contextId: string, runId: number): void => {
      svc<SopService>('sop').ctxRegister(contextId, runId);
    },
    ctxRegisterSource: (r: { contextId: string; runId: number; taskId: string; caller: string; team: string; receiptStatus: string }): void => {
      svc<SopService>('sop').ctxRegisterSource(r);
    },
    bindingCallback: (slug: string, caller: string): string => {
      const b = svc<SopService>('sop').bindingByNodeFull(slug, caller) as { callback_url?: string } | undefined;
      return b?.callback_url ?? '';
    },
    ctxAttachCallback: (runId: number, callbackUrl: string): void => {
      svc<SopService>('sop').ctxSetCallback(runId, callbackUrl);
    },
  };
  try {
    const out = await a2aDirectHandle(req.body, rawBytes, runOps);
    res.status(out.httpStatus).json(out.body);
  } catch (e: any) {
    res.status(200).json({ error: `direct handler failed: ${String(e?.message ?? e)}`, code: -32000, task_status: 'TASK_STATE_FAILED' });
  }
});
app.get('/a2a/direct', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ---------- 统一门户：/go/:id/* 反向代理到对应工作台 ----------
// 所有注册工作台挂到 9800 同域路径下：一个端口号 + 同源（CORS 消失）+
// 代理剥掉 X-Frame-Options / CSP（禁嵌防线失效）→ 使用页/驾驶舱全量可嵌。
const wbById = (id: number): ReturnType<typeof rowToWorkbench> | null => {
  const row = svc<WorkbenchService>('workbench').byId(id) as unknown as WorkbenchRow | undefined;
  return row ? rowToWorkbench(row) : null;
};

import { MCP_TOOLS, type McpToolDef, type McpToolCategory } from './mcp-tools.ts';
import { evalCandidates } from './eval.ts'; // #178 评估模型客户端

import { renderSopRunner as renderSopRunnerRaw } from './sop-runner.ts';
import { loadTokensCss } from './design-tokens-css.ts';
import { sqliteSsoTicketStore } from './sso-ticket-store.ts';
import { collectTasks } from './tasks.ts';
import { closeYglUpstreams, yglHomeProblem, yglUpstreamRpc } from './mcp-stdio-upstream.ts';
import { tasksReadAccess, createTaskSourceGrant, revokeTaskSourceGrant } from './tasks-read-access.ts';
import { collectExtensionTasks, extensionTaskSourceKeys, loadExtensions } from './extensions.ts';
import { authorizeRunRead, issueRunReadCap, runReadGrantCreate, runReadGrantRevoke, runReadCapRevokeAll } from './sop-read-auth.ts';
import { endpointStatsMiddleware } from './endpoint-stats.ts';
import { fetchMainFiles, normalizeSource, SourceError, SOURCE_BRANCH } from './github-source.ts';
import { checkRecord, parseContract, type DataContract } from './app-data-contract.ts';
import { sniff, type Sniff } from './file-sniff.ts';
import { checkRunData, extractFieldRules, fileListRows, type FieldRule } from './sop-field-rules.ts';

// ---------- MCP 生产通道（StreamableHTTP · stateless：AI 会话直连市场，零依赖手写 JSON-RPC） ----------
const MCP_PROTOCOL = '2025-03-26';
const MCP_KNOWN_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

async function callTool(name: string, args: any, subject = 'anonymous', origin = ''): Promise<unknown> {
  const metaSlug = String(args?.slug ?? '').trim().toLowerCase();
  if (metaSlug === 'task-center' && ['app_sync','app_activate','sop_publish','sop_deprecate'].includes(name)) throw new HttpError(403, 'task-center 元台仅人工面可修改');
  switch (name) {
    case 'design_standard':
      return designStandard(args ?? {});
    case 'skills_list': {
      const S = svc<SkillService>('skill');
      let rows = S.skillsAll() as any[];
      if (typeof args?.layer === 'number' && args.layer >= 1 && args.layer <= 5) rows = rows.filter((r) => r.layer === args.layer);
      if (typeof args?.q === 'string' && args.q) { const k = args.q.toLowerCase(); rows = rows.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(k)); }
      return rows.slice(0, 200).map((r) => {
      const led = (S.ledgerActive() as any[]).find((l: any) => l.skill_id === r.id && l.status === 'installed');
      return { slug: r.slug, name: r.name, layer: r.layer, layer_name: r.layer_name, family_parent: r.family_parent, legacy: r.legacy === 1, versions: (S.versionsBySkill(r.id) as any[]).length, active_version: SkillService.currentOf(r, S.versionsBySkill(r.id) as any[])?.version ?? null, is_installed: !!led, current_version: led ? (S.versionsBySkill(r.id) as any[]).find((v) => v.id === led.version_id)?.version ?? null : null }; // #132 P1⑤ MCP
    });
    }
    case 'skill_versions': {
      const S = svc<SkillService>('skill');
      const row = S.skillBySlug(String(args?.slug ?? ''));
      if (!row) return { error: `skill not found: ${args?.slug}` };
      // #94 S0⑤（K8）：MCP 面同规则——snapshot_path 相对化
      const vs = S.versionsBySkill(row.id) as any[];
      const activeV = SkillService.currentOf(row, vs)?.version ?? null;
      return vs.map((v) => ({ ...v, active: v.version === activeV, snapshot_path: v.snapshot_path ? `skill-snapshots/${encodeURIComponent(row.slug)}/v${v.version}` : v.snapshot_path }));
    }
    // 技能传输面：一次只传一个文件，不收也不发压缩包
    case 'skill_file_put':
      return skillStagePut(args?.content, args?.encoding);
    case 'skill_publish':
      // 审计人恒为调用会话（不收 agent 自报的 reviewed_by）
      return skillPublishCore(args?.slug, args?.files, args?.changelog, subject, { refsOnly: true });
    case 'skill_download':
      return skillDownloadIssue(args?.slug, args?.version, subject, origin);
    case 'skill_install_plan': {
      const S = svc<SkillService>('skill');
      const row = S.skillBySlug(String(args?.slug ?? ''));
      if (!row) return { error: `skill not found: ${args?.slug}` };
      const vs = S.versionsBySkill(row.id) as any[];
      if (vs.length === 0) return { error: `无版本：${args?.slug}` };
      const target = typeof args?.version === 'number' ? vs.find((v) => v.version === args.version) : SkillService.currentOf(row, vs); // 缺省当前版本
      if (!target) return { error: `版本不存在：v${args?.version}` };
      return {
        slug: row.slug, version: target.version, tree_digest: target.tree_digest, snapshot_path: `skill-snapshots/${encodeURIComponent(row.slug)}/v${target.version}`, // K8 相对化
        expected_sha256: target.tree_digest,
        install_hint: `薄分发（手工落盘）：复制 skill-snapshots/${encodeURIComponent(row.slug)}/v${target.version} → 目标技能目录；以 expected_sha256 钉装校验`,
        export_url: `/api/skills/${encodeURIComponent(row.slug)}/export?version=${target.version}`, // #94 S3②：导出包面（薄分发）
      };
    }
    case 'skill_search': {
      // #178（评审席 design v2·S1-S14）：语义搜——预筛 30 → jev 打分（批≤15）→ P>0.7 严格·≤3·降序；不可用报错不降级
      const need = String(args?.need ?? '').trim();
      if (!need || need.length > 2000) throw new HttpError(400, 'need 必填且 ≤2000 字');
      const layerFilter = Number(args?.layer);
      const SS = svc<SkillService>('skill');
      const all = (layerFilter >= 1 && layerFilter <= 5 ? SS.skillsByLayer(layerFilter) : SS.skillsAll()) as any[];
      const alive = all.filter((s) => !(s.legacy === 1 && (SS.versionsBySkill(s.id) as any[]).length === 0));
      const tokens = need.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
      const scored = alive.map((s) => {
        const hay = (String(s.name ?? '') + ' ' + String(s.description ?? '') + ' ' + String(s.argument_hint ?? '')).toLowerCase();
        let sc = 0;
        for (const t of tokens) { if (!t) continue; if (hay.includes(t)) sc += 1; if (String(s.name ?? '').toLowerCase().includes(t)) sc += 2; }
        return { s, sc };
      });
      scored.sort((a, b) => b.sc - a.sc);
      // #178 Q2 + S10 回归裁（监督席 direct-25d8fdcd）：**守属主 30 上限** 同时保留「不臆截」精神——
      // ≤30 全量不截断；>30 且可排序取前 30；词法全 0/全并列=无从排序 → 不砍（全量分批交模型）
      // 总工决策 #007（C 案·30/45 冲突裁）：无硬上限 + top-N 参数（缺省 30·沿现值）+ 候选总量披露
      const topN = Math.max(1, Math.floor(Number((args as any)?.top_n ?? 30)) || 30);
      const maxScore = scored.length ? scored[0].sc : 0;
      const allTied = scored.every((x) => x.sc === maxScore);
      const candidatesTotal = scored.length; // 总量披露
      const prescreen = (allTied ? scored : scored.slice(0, topN)).map((x) => x.s); // 全并列=无从排序不砍；可排序取 top-N
      const qidOf = new Map<string, any>();
      const cands = prescreen.map((s) => { const qid = 'q' + s.id; qidOf.set(qid, s); return { qid, slug: s.slug, name: s.name, description: String(s.description ?? ''), argumentHint: String(s.argument_hint ?? '') }; });
      const probs = await evalCandidates(need, cands);
      const need_digest = createHash('sha256').update(need, 'utf8').digest('hex').slice(0, 12);
      const entries = Object.entries(probs).filter(([, pv]) => pv > 0.7).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const items = entries.map(([qid, pv]) => {
        const s = qidOf.get(qid);
        const vs = SS.versionsBySkill(s.id) as any[];
        const cur = SkillService.currentOf(s, vs)?.version ?? null;
        return { slug: s.slug, name: s.name, layer: s.layer, description: String(s.description ?? ''), confidence: pv, version: cur, install_plan: { slug: s.slug, version: cur } };
      });
      try { db.prepare("INSERT INTO mcp_calls (at, session_name, method, tool, ok, error, duration_ms, args_sha256) VALUES (datetime('now'), ?, 'tools/call', 'skill_search', 1, '', 0, ?)").run('skill_search', need_digest); } catch { /* 审计失败不阻 */ }
      const _total = { candidates_total: candidatesTotal, top_n: topN }; // #007 总量披露（恒报·含未截断）
      return items.length ? { need_digest, ..._total, items } : { need_digest, ..._total, items: [], note: '无置信度大于 0.7 的技能' };
    }

    case 'workbench_list': {
      let list = listWorkbenches();
      if (args?.q) { const s = String(args.q).toLowerCase(); list = list.filter((w) => w.name.toLowerCase().includes(s) || w.url.toLowerCase().includes(s) || (w.description || '').toLowerCase().includes(s)); }
      if (args?.type) list = list.filter((w) => w.type === args.type);
      if (args?.status) list = list.filter((w) => w.last_status === args.status);
      // issue #3：MCP 通道同样掩码（agent 可编程面不得绕过 REST 脱敏）
      return list.map((w) => ({ id: w.id, name: w.name, type: w.type, status: w.last_status, latency_ms: w.last_latency_ms, url: maskSensitiveQuery(w.url), category: w.category, enabled: w.enabled }));
    }
    case 'workbench_summary':
      return summaryPayload();
    case 'workbench_check': {
      if (args?.all) {
        const settings = getSettings();
        const limit = Math.max(1, Number(settings.health_concurrency) || 8);
        const rows = svc<WorkbenchService>('workbench').enabled() as unknown as WorkbenchRow[];
        const results: ReturnType<typeof rowToWorkbench>[] = [];
        const queue = [...rows];
        const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
          for (let w = queue.shift(); w; w = queue.shift()) results.push(await checkOne(w));
        });
        await Promise.all(workers);
        return { checked: results.length, up: results.filter((w) => w.last_status === 'up').length, down: results.filter((w) => w.last_status === 'down').length };
      }
      const row = svc<WorkbenchService>('workbench').byId(Number(args?.id)) as unknown as WorkbenchRow | undefined;
      if (!row) throw new HttpError(404, `工作台不存在: ${args?.id}`);
      const w = await checkOne(row);
      return { id: w.id, name: w.name, status: w.last_status, latency_ms: w.last_latency_ms, error: w.last_error };
    }
    case 'use_url': {
      const w = wbById(Number(args?.id));
      if (!w) throw new HttpError(404, `工作台不存在: ${args?.id}`);
      // issue #3：direct 也掩码——带 token 的直连地址不再下发；浏览器访问请走 portal（代理自动带票）
      return { id: w.id, name: w.name, portal: `/go/${w.id}/`, use_page: `/use/${w.id}`, direct: maskSensitiveQuery(w.url), note: 'portal 经统一门户同源代理（自动注入凭据/剥禁嵌头），推荐浏览器访问；direct 已脱敏' };
    }
    case 'app_sync': {
      // 属主 2026-11-02 来源收敛：MCP 只重拉已登记来源；绑定/改来源是管理员 REST 面
      const _slug = String(args?.slug ?? '').trim().toLowerCase();
      if (_slug === 'task-center') throw new HttpError(403, 'task-center 元台只能经人工面修改（#159 C13）');
      if (args?.source_repo !== undefined || args?.source_path !== undefined) throw new HttpError(403, 'MCP 不能绑定或改来源：须本机 CLI 或管理员走 POST /api/apps/<slug>/sync');
      const _app = svc<AppService>('app').bySlug(_slug) as unknown as AppRow | undefined;
      if (!_app) throw new HttpError(404, `台不存在: ${_slug}（首次登记来源须管理员走 POST /api/apps/<slug>/sync）`);
      const _who = 'mcp';
      // #193 F11：MCP 同步与 REST 同过发布锁（60s 同 slug 异会话 409）
      const _gate = publishLockGuard(_slug, _who, args?.force === true);
      if (!_gate.ok) throw new HttpError(409, _gate.hint);
      return (await syncAppFromGithub(_slug, { changelog: args?.changelog, force: args?.force === true }, _who)).body;
    }
    // #94 v3 S1（K12）：app_activate 直回滚工具**移除**（破坏性操作 MCP 不可直执）——改经 change_request_create 提请求
    // #94 v3 S1（契约形状·#94 评论 6424247402）：{kind: 'app'|'skill', slug, op: 'rollback'|'delete', target_version?, reason}
    // 属主 2026-11-02 来源收敛：app_publish 与 #94 P3 草稿三工具（app_draft_open/edit/submit）移除——内容只从 GitHub main 来
    case 'change_request_create': {
      const kind = String(args?.kind ?? '');
      if (!['app', 'skill'].includes(kind)) throw new HttpError(400, `kind 须 app|skill（得: ${kind}）`);
      const op = String(args?.op ?? '');
      if (!['rollback', 'delete'].includes(op)) throw new HttpError(400, `op 须 rollback|delete（得: ${op}）`);
      const slug = String(args?.slug ?? '').trim();
      if (!slug) bad('slug 必填');
      if (op === 'rollback' && typeof args?.target_version !== 'number') bad('rollback 需 target_version（数字）');
      if (kind === 'app') getApp(slug);
      else if (!svc<SkillService>('skill').skillBySlug(slug)) throw new HttpError(404, `skill not found: ${slug}`);
      const info = db.prepare("INSERT INTO change_requests (kind, slug, op, target_version, reason, source, requested_by) VALUES (?, ?, ?, ?, ?, 'mcp', ?)")
        .run(kind, slug, op, op === 'rollback' ? Number(args?.target_version) : null, String(args?.reason ?? '').slice(0, 500), String(args?.requested_by ?? 'mcp-agent'));
      return { id: Number(info.lastInsertRowid), kind, slug, op, target_version: args?.target_version ?? null, status: 'pending', note: '请求已建——批准前状态不变（人经 /api/change-requests/:id/approve 口令+reviewed_by 批准执行）' };
    }
    case 'change_requests': {
      const status = typeof args?.status === 'string' ? args.status : 'pending';
      return db.prepare('SELECT id, kind, slug, op, target_version, reason, status, requested_by, created_at FROM change_requests WHERE status = ? ORDER BY id DESC LIMIT 50').all(status);
    }
    case 'sop_publish': {
      const a = sopTransition(String(args?.slug), ['draft', 'deprecated'], 'published', '发布');
      if (typeof args?.note === 'string' && args.note.trim()) {
        svc<AppService>('app').appendChangelog(a.id, a.active_version, `\n[publish] ${args.note.trim()}`);
      }
      const d = appDetail(getApp(a.slug)) as { slug: string; status: string; workbench_id: number | null };
      return { ok: true, slug: d.slug, status: d.status, runner_url: `/sop/${a.slug}/`, workbench_id: d.workbench_id };
    }
    // SOP 执行数据面（agent 直接更新持久化数据——与 REST/Runner 同链，不经版本发布）
    case 'sop_run_start':
      return sopRunStartCore(String(args?.slug ?? ''), String(args?.started_by ?? ''));
    case 'sop_run_step_save':
      return sopRunStepSaveCore(Number(args?.run_id), String(args?.step_key ?? ''), args?.value);
    case 'sop_run_get': {
      // #309 phase2：MCP 会话工具 grant ≠ run grant；机器迁移可带 args.read_capability（审计只存哈希）
      const runId = Number(args?.run_id);
      const capArg = typeof args?.read_capability === 'string' ? args.read_capability : undefined;
      const auth = await authorizeRunRead({ cap: capArg, mcpSubject: subject.startsWith('mcp:') ? subject : undefined }, runId);
      return auth.authorized ? sopRunGetCore(runId) : sopRunGetMeta(runId);
    }
    case 'sop_run_list': {
      const slug = typeof args?.slug === 'string' ? args.slug : '';
      const status = typeof args?.status === 'string' ? args.status : '';
      const where: string[] = [];
      const sqlArgs: unknown[] = [];
      if (slug) { where.push('sop_slug = ?'); sqlArgs.push(slug); }
      if (status) { where.push('status = ?'); sqlArgs.push(status); }
      // 翻页：limit 1–200（缺省 50）+ offset；同时间戳按 id 排定，翻页不漏不重
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(args?.limit ?? 50)) || 50));
      const offset = Math.max(0, Math.trunc(Number(args?.offset ?? 0)) || 0);
      const sql = `SELECT * FROM sop_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`;
      return svc<SopService>('sop').runsQuery(sql, [...sqlArgs, limit, offset]);
    }
    case 'sop_run_finish':
      return sopRunFinishCore(Number(args?.run_id));
    // #94 P0 阻断①（总工 direct-d822d457）：沙箱真调用——工具声明此后必须有分发分支（真 tools/call 闸）
    case 'sop_run_sandbox':
      return svc<SandboxService>('sandbox').dispatch({
        runId: Number(args?.run_id),
        script: String(args?.script ?? ''),
        imageTag: typeof args?.image_tag === 'string' ? args.image_tag : undefined,
        timeoutMs: typeof args?.timeout_ms === 'number' ? args.timeout_ms : undefined,
      });
    // 工作台注册 CRUD（agent 登记外部台——与 REST 同链；凭据字段不接受：传入即拒）
    case 'workbench_register': {
      if (args?.auth !== undefined) throw new HttpError(400, '凭据不接受 MCP 写入——请人工经市场页配置');
      const w = workbenchCreateCore(args, { subject });
      return maskForApi(w);
    }
    case 'workbench_update': {
      if (args?.auth !== undefined) throw new HttpError(400, '凭据不接受 MCP 写入——请人工经市场页配置');
      const { id: _ignored, ...rest } = args ?? {};
      const w = workbenchUpdateCore(Number(args?.id), rest, { subject });
      return maskForApi(w);
    }
    case 'workbench_unregister':
      return workbenchDeleteCore(Number(args?.id));
    case 'workbench_vars_get':
      return mcpVarsGet(args);
    case 'workbench_vars_set':
      return mcpVarsSet(args, subject);
    case 'app_data_list': {
      const a = getApp(String(args?.slug ?? ''));
      const limit = pageLimit(args?.limit);
      const beforeId = pageBeforeId(args?.before_id);
      const rows = beforeId > 0
        ? svc<AppDataService>('appData').dataPage(a.slug, beforeId, limit)
        : svc<AppDataService>('appData').dataPage(a.slug, 0, limit);
      const items = (rows as any[]).map((r) => ({ id: r.id, data: JSON.parse(r.data || '{}'), created_by: r.created_by, created_at: r.created_at }));
      return { slug: a.slug, items, count: items.length, has_more: rows.length === limit, next_before_id: rows.length === limit ? items[items.length - 1].id : null };
    }
    case 'app_data_submit': {
      // 与 REST POST /api/apps/:slug/data 同一核心（契约校验、幂等、事件推送）；违约 → 400 + violations 原样
      const a = getApp(String(args?.slug ?? ''));
      if (args?.data === undefined || args?.data === null) bad('data 必填');
      // 工具调用凭的是会话令牌（席位、agent），不看 cookie
      const out = submitAppData(a, { data: args.data, createdBy: args?.created_by ?? subject, idempotencyKey: args?.idempotency_key, channel: { name: 'app-data.tool', hasCredential: false } });
      if (out.status >= 400) throw new HttpError(out.status, String(out.body.error), { violations: out.body.violations });
      return { ...out.body, status: out.status };
    }
    case 'app_files_list': {
      const a = getApp(String(args?.slug ?? ''));
      const limit = pageLimit(args?.limit);
      const beforeId = pageBeforeId(args?.before_id);
      const rows = beforeId > 0
        ? svc<AppDataService>('appData').filePage(a.slug, beforeId, limit)
        : svc<AppDataService>('appData').filePage(a.slug, 0, limit);
      const items = (rows as any[]).map((r) => ({ ...r, url: `/api/apps/${a.slug}/files/${r.id}` }));
      return { slug: a.slug, items, count: items.length, has_more: rows.length === limit, next_before_id: rows.length === limit ? items[items.length - 1].id : null, quota: appFilesQuota(a.slug) };
    }
    case 'app_files_upload': {
      // #164 P1②（批派令）：MCP 侧上传——base64 入 app_files（与 REST multipart 同表同链）
      const slug = String(args?.slug ?? '').trim();
      const name = fixFileName(String(args?.name ?? '').trim());
      const b64 = String(args?.content_base64 ?? '');
      if (!slug || !name || !b64) throw new HttpError(400, 'slug/name/content_base64 必填');
      const a = getApp(slug);
      // 完整性：有的 MCP 客户端会把过长的参数截短（常见截在 64KB）。截在 4 的倍数上的 base64 照样能解码，
      // 不核就会把残缺文件当正常文件存下。所以：base64 严格校验；调用方带了 size / sha256 就逐项对；
      // 恰好 65536 字符又没带 size / sha256 的，按疑似截断拒收（要么带上 size / sha256，要么改用 REST 原始字节上传）。
      const compact = b64.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new HttpError(400, `content_base64 不是完整的 base64（长 ${compact.length} 字符）：可能在传输中被截断，请改用 REST 原始字节上传，或带上 size / sha256 重传`);
      const wantSize = args?.size === undefined || args?.size === null || args?.size === '' ? null : Number(args.size);
      const wantSha = args?.sha256 === undefined || args?.sha256 === null || args?.sha256 === '' ? null : String(args.sha256).toLowerCase();
      if (wantSize !== null && (!Number.isSafeInteger(wantSize) || wantSize <= 0)) throw new HttpError(400, 'size 须为正整数（原始字节数）');
      if (wantSha !== null && !/^[0-9a-f]{64}$/.test(wantSha)) throw new HttpError(400, 'sha256 须为 64 位十六进制');
      if (compact.length === 65536 && wantSize === null && wantSha === null) throw new HttpError(400, 'content_base64 恰好 65536 字符，疑似被客户端截在 64KB：请带上 size（原始字节数）或 sha256 重传，大文件改用 REST 原始字节上传');
      const buf = Buffer.from(compact, 'base64');
      if (!buf.length) throw new HttpError(400, 'content_base64 解码为空');
      if (buf.length > UPLOAD_MAX) throw new HttpError(413, `文件超 100MB 上限（${buf.length}B）`);
      if (wantSize !== null && buf.length !== wantSize) throw new HttpError(400, `收到 ${buf.length} 字节，声明 ${wantSize} 字节：内容可能在传输中被截断，未保存`);
      if (wantSha !== null && createHash('sha256').update(buf).digest('hex') !== wantSha) throw new HttpError(400, `收到内容的 sha256 与声明不符（收到 ${buf.length} 字节）：内容可能在传输中被截断或改动，未保存`);
      if (appFilesQuota(a.slug).files_left <= 0) throw new HttpError(413, `该台文件数已达上限（${APP_FILES_MAX}）`); // #193 F8：全量计数；上限与浏览器上传共用
      // 与浏览器上传同一套内容类型检查：扩展名与内容不符、或是可执行文件 → 拒收；相符则存规范 MIME
      const kind = sniff(name, buf.subarray(0, 1024 * 1024), buf.length <= 1024 * 1024, String(args?.mime ?? ''));
      if (kind.verdict === 'mismatch' || kind.verdict === 'executable') throw new HttpError(415, `文件类型不符：${kind.reason}`);
      const dir = join(dataDir, 'uploads');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const safe = name.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 80);
      const fname = `${Date.now().toString(36)}-${safe}`;
      const abs = join(dir, fname);
      writeFileSync(abs, buf);
      const rel = abs.replace(dataDir, '').replace(/\\/g, '/').replace(/^\/+/, '');
      const createdBy = String(args?.created_by ?? '').trim().slice(0, 128);
      const note = String(args?.note ?? '').trim().slice(0, 500);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const r = svc<AppDataService>('appData').fileInsert(a.slug, name, kind.mime, buf.length, rel, createdBy, note, sha256) as unknown as { lastInsertRowid: number | bigint };
      const id = Number(r.lastInsertRowid);
      return { ok: true, id, slug: a.slug, name, mime: kind.mime, size: buf.length, sha256, note, url: `/api/apps/${a.slug}/files/${id}` };
    }
    default:
      throw new HttpError(400, `未知工具: ${name}`);
  }
}

// ---------- MCP 上游聚合（GH #20 P2：外部 MCP 服务以 <prefix>__<tool> 并入市场 /mcp） ----------
// 配置：settings.mcp_upstreams = JSON 数组 [{prefix,url,headers?,enabled?,toolCallTimeoutMs?}]
// prefix 规范 [a-z][a-z0-9]{0,15}（与本地工具名不冲突——本地工具无 __ 分隔）。
// 工具列表 30s 缓存（每请求不直打上游）；上游不可达时跳过其工具、不影响本地工具面。
// #474 kind='ygl-trees'：不走 HTTP，由服务端启动 `ygl-trees mcp`（stdio），工作区为 ygl_home（见 mcp-stdio-upstream.ts）
interface McpUpstream { prefix: string; url: string; headers?: Record<string, string>; enabled?: boolean; toolCallTimeoutMs?: number; kind?: 'ygl-trees'; ygl_home?: string }
const MCP_UPSTREAM_PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const upstreamToolCache = new Map<string, { at: number; tools: McpToolDef[] }>();
const UPSTREAM_CACHE_MS = 30_000;
/** 上游健康（#379）：tools/list 成败都记下来，授权面缩水时管理端看得到原因 */
const upstreamHealth = new Map<string, { reachable: boolean; tools: number; last_error: string; last_ok_at: string; last_checked_at: string }>();

function mcpUpstreams(): McpUpstream[] {
  try {
    const raw = getSettings()['mcp_upstreams'] ?? '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((u: any) => u && typeof u.prefix === 'string' && MCP_UPSTREAM_PREFIX_RE.test(u.prefix) && u.enabled !== false
      && (u.kind === 'ygl-trees' ? typeof u.ygl_home === 'string' : (u.kind === undefined && typeof u.url === 'string' && /^https?:\/\//.test(u.url))));
  } catch {
    return [];
  }
}

async function upstreamRpc(u: McpUpstream, method: string, params: unknown, id = 1, clientIdent?: string): Promise<any> {
  const timeout = u.toolCallTimeoutMs && u.toolCallTimeoutMs > 0 ? u.toolCallTimeoutMs : 15_000;
  if (u.kind === 'ygl-trees') return yglUpstreamRpc({ prefix: u.prefix, yglHome: String(u.ygl_home) }, method, params, timeout);
  // 身份透传（#20 P2）：网关会话存在时以 mcp/<会话名> 覆盖静态头——
  // 上游（如 taste-mcp）以此判 judge 身份：agent:<X-Market-Client>@<model>。
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(u.headers ?? {}) };
  if (clientIdent) headers['X-Market-Client'] = clientIdent;
  const r = await fetch(u.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error(`upstream ${u.prefix} HTTP ${r.status}`);
  const text = await r.text();
  // 兼容 SSE 形态（data: {...}）与纯 JSON
  const payload = text.trim().startsWith('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') : text;
  const j = JSON.parse(payload);
  if (j.error) throw new Error(`upstream ${u.prefix}: ${j.error.message ?? 'error'}`);
  return j.result;
}

/** 聚合工具面：本地 + 各上游（<prefix>__<name>）；上游失败时跳过其工具，并记入 upstreamHealth。
 *  上游工具的类别按其 annotations.readOnlyHint：明说只读才算 read，其余一律按 write（保守）。 */
async function mcpAggregatedTools(): Promise<McpToolDef[]> {
  const out: McpToolDef[] = [...MCP_TOOLS];
  const ups = mcpUpstreams();
  for (const u of ups) {
    const cached = upstreamToolCache.get(u.prefix);
    if (cached && Date.now() - cached.at < UPSTREAM_CACHE_MS) {
      out.push(...cached.tools.map((t) => ({ ...t, name: `${u.prefix}__${t.name}`, description: `[${u.prefix}] ${t.description}` })));
      continue;
    }
    try {
      const res = await upstreamRpc(u, 'tools/list', {}, 1);
      const tools = (res?.tools ?? []) as { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: unknown } }[];
      upstreamHealth.set(u.prefix, { reachable: true, tools: tools.length, last_error: '', last_ok_at: new Date().toISOString(), last_checked_at: new Date().toISOString() });
      const clean = tools.filter((t) => typeof t.name === 'string').map((t) => ({
        // ygl-trees 的工具没有 readOnlyHint；它的 read 工具只读（只路由到 CLI 的读动作），按 read 归类，其余仍按 write
        name: t.name, description: t.description ?? '', category: (t.annotations?.readOnlyHint === true || (u.kind === 'ygl-trees' && t.name === 'read') ? 'read' : 'write') as McpToolCategory,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }));
      upstreamToolCache.set(u.prefix, { at: Date.now(), tools: clean });
      out.push(...clean.map((t) => ({ ...t, name: `${u.prefix}__${t.name}`, description: `[${u.prefix}] ${t.description}` })));
    } catch (e) {
      /* 上游不可达：跳过其工具，不影响本地工具面；原因记下来给管理端看 */
      const prev = upstreamHealth.get(u.prefix);
      upstreamHealth.set(u.prefix, { reachable: false, tools: 0, last_error: String((e as Error)?.message ?? e).slice(0, 200), last_ok_at: prev?.last_ok_at ?? '', last_checked_at: new Date().toISOString() });
    }
  }
  return out;
}

/** 上游工具路由：taste__rules → (upstream taste, tool rules) */
function routeUpstream(toolName: string): { upstream: McpUpstream; remoteTool: string } | null {
  const i = toolName.indexOf('__');
  if (i <= 0) return null;
  const prefix = toolName.slice(0, i);
  const remoteTool = toolName.slice(i + 2);
  if (!remoteTool) return null;
  const u = mcpUpstreams().find((x) => x.prefix === prefix);
  return u ? { upstream: u, remoteTool } : null;
}

/** 当前注册表（本地 + 上游可用工具名；grants 校验用） */
async function mcpRegisteredNames(): Promise<Set<string>> {
  return new Set((await mcpAggregatedTools()).map((t) => t.name));
}


// #284 缺省开（fail closed）：未设/空/on 均开网关，只有显式 MCP_GATEWAY=off 才关并在启动时告警；
// 其它值拒绝启动（防拼写错误静默放开）。重启漏带环境变量不再把 /mcp 退回匿名可调。
// 网关开而无 ADMIN_TOKEN 时控制面全 403，无法建会话 → /mcp 全 401（拒绝而非放开）。
const MCP_GATEWAY_RAW = process.env.MCP_GATEWAY ?? '';
if (!['', 'on', 'off'].includes(MCP_GATEWAY_RAW)) {
  console.error(`[#284] 拒绝启动：MCP_GATEWAY 只接受 on / off / 不设（当前值无法识别，不按关处理）`);
  process.exit(1);
}
// 登录门 enforce 时网关强制开：/mcp 不走登录 cookie，只认网关会话令牌，匿名一律 401
const MCP_GATEWAY_ON = MCP_GATEWAY_RAW !== 'off' || loginGate.enforced;
if (MCP_GATEWAY_RAW === 'off' && loginGate.enforced) console.warn('[#284] MCP_GATEWAY=off 被忽略：WM_LOGIN_GATE=enforce 时网关强制开');
if (!MCP_GATEWAY_ON) console.warn('[#284] 警告：MCP_GATEWAY=off，/mcp 不校验会话令牌、匿名可调全部工具——只用于本地开发/测试，生产勿设');
const MCP_SESSION_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
let mcp401Count = 0;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function mcpSessionByToken(token: string): { id: number; name: string; grants: string[] } | null {
  const row = svc<McpService>('mcp').sessionByToken(sha256Hex(token)) as { id: number; name: string; grants: string } | undefined;
  if (!row) return null;
  let grants: string[] = [];
  try { grants = JSON.parse(row.grants || '[]'); } catch { grants = []; }
  return { id: row.id, name: row.name, grants };
}

/** grants 校验口径（#379，整体替换与批准申请共用）：注册表里有的保留；不在注册表的，只有 held 里已有的才不报错——
 *  所属上游已配置但暂不可达 → 保留（kept_unavailable）；其余（工具已下线/改名）→ 剔除（dropped）。held 之外的未知名 400。 */
function resolveGrants(raw: unknown[], held: string[], registered: Set<string>): { saved: string[]; dropped: string[]; keptUnavailable: string[] } {
  const upPrefixes = new Set(mcpUpstreams().map((u) => u.prefix));
  const saved: string[] = [], dropped: string[] = [], keptUnavailable: string[] = [];
  for (const g of raw) {
    if (typeof g !== 'string') bad(`工具名必须是字符串: ${JSON.stringify(g)}`);
    const name = g as string;
    const scoped = parseGrant(name);
    if (scoped.wid !== null) { // #452 工具@台：工具须支持按台授权、台须存在；已持有但台已删除的剔除
      if (!registered.has(scoped.tool)) bad(`未知工具名: ${JSON.stringify(scoped.tool)}（合法面见 GET /api/mcp/tools）`);
      if (!MCP_SCOPED_TOOLS.has(scoped.tool)) bad(`${scoped.tool} 暂不支持按台授权（目前只有 ${[...MCP_SCOPED_TOOLS].join(' / ')}）`);
      if (svc<WorkbenchService>('workbench').exists(scoped.wid)) { if (!saved.includes(name)) saved.push(name); }
      else if (held.includes(name)) dropped.push(name);
      else bad(`台不存在: ${scoped.wid}（${name}）`);
      continue;
    }
    if (registered.has(name)) { if (!saved.includes(name)) saved.push(name); continue; }
    if (!held.includes(name)) bad(`未知工具名: ${JSON.stringify(name)}（合法面见 GET /api/mcp/tools）`);
    const prefix = name.includes('__') ? name.slice(0, name.indexOf('__')) : '';
    if (prefix && upPrefixes.has(prefix) && upstreamHealth.get(prefix)?.reachable === false) { if (!saved.includes(name)) { saved.push(name); keptUnavailable.push(name); } }
    else dropped.push(name);
  }
  return { saved, dropped, keptUnavailable };
}

// ---------- MCP 权限自助：access_info / access_request（免 grants）+ 管理员审批面 ----------
// 会话只能看和申请；批准、驳回只走下面的管理员 REST（adminGuard：口令或 Odoo 管理员），会话令牌不是管理身份，自己批不了。
const MCP_EXEMPT_TOOLS = new Set(MCP_TOOLS.filter((t) => t.exempt).map((t) => t.name));
/** #452 可按台授权（工具@台）的工具：按 id 参数取工作台的。以后可扩到 app_data_* / app_files_* / app_sync（按 slug）。
 *  依赖 workbenches.id 为 AUTOINCREMENT、不复用：台删除后旧的 工具@台 要到下次保存才剔除，期间新台拿不到旧 id。
 *  例外：从备份恢复库或 sqlite_sequence 被重置时，要先清理各会话 grants 里的 工具@台。 */
const MCP_SCOPED_TOOLS: ReadonlySet<string> = new Set(['workbench_vars_get', 'workbench_vars_set']);
/** 授权串 'tool' 或 'tool@<台 id>'；@ 后不是正整数的整串当工具名（随后按未知工具名 400） */
function parseGrant(g: string): { tool: string; wid: number | null } {
  const m = /^(.+)@([1-9]\d{0,9})$/.exec(g);
  return m ? { tool: m[1], wid: Number(m[2]) } : { tool: g, wid: null };
}
const ACCESS_REQUEST_HOURLY_MAX = 10;
const ACCESS_REASON_MAX = 500;
const ACCESS_STATUSES = ['pending', 'approved', 'rejected'];
type McpSess = { id: number; name: string; grants: string[] };
type AccessRequestRow = { id: number; session_id: number; tools: string; reason: string; status: string; decided_by: string; decided_at: string; note: string; created_at: string };
function parseToolList(raw: string): string[] {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
/** 会话看到的申请：不带 decided_by（管理员身份不外露给会话） */
function accessRequestForSession(r: Pick<AccessRequestRow, 'id' | 'tools' | 'reason' | 'status' | 'note' | 'decided_at' | 'created_at'>) {
  return { id: r.id, tools: parseToolList(r.tools), reason: r.reason, status: r.status, note: r.note, decided_at: r.decided_at || null, created_at: r.created_at };
}

/** 对外基址：设了 MARKET_PUBLIC_URL 用它（反代/TLS 终止后 req.protocol 不可信），否则按本次请求的主机 */
function mcpPublicOrigin(req: express.Request): string {
  const pub = (process.env.MARKET_PUBLIC_URL ?? '').replace(/\/+$/, '');
  return pub || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}
/** MCP 内嵌 REST 的入口（initialize 与 access_info 告诉 agent：大文件与资源走 REST） */
function mcpRestInfo(origin: string) {
  return {
    openapi_url: `${origin}/openapi.json`,
    rest_base: `${origin}/api/mcp-rest`,
    rest_hint: '同一个会话令牌（Authorization: Bearer）可按 REST 调用：大文件上传 PUT {rest_base}/apps/<slug>/files/<文件名>（请求体为原始字节），下载 GET {rest_base}/apps/<slug>/files/<id>（支持 Range）；完整接口见 openapi_url',
  };
}

async function mcpAccessTool(name: string, args: any, sess: McpSess | null, origin: string): Promise<unknown> {
  const catalog = await mcpAggregatedTools();
  if (name === 'access_info') {
    const granted = (t: McpToolDef) => mcpToolGranted(sess, t.name); // 网关关时全部可调
    const scopeOf = (t: McpToolDef) => { const sc = mcpToolScope(sess, t.name); return sc && sc !== 'all' ? [...sc].sort((a, b) => a - b) : null; };
    return {
      gateway: MCP_GATEWAY_ON ? 'on' : 'off',
      session: sess?.name ?? null,
      granted_tools: catalog.filter(granted).map((t) => t.name),
      catalog: catalog.map((t) => ({ name: t.name, description: t.description, category: t.category, granted: granted(t), ...(scopeOf(t) ? { granted_workbenches: scopeOf(t) } : {}), ...(MCP_SCOPED_TOOLS.has(t.name) ? { scopable: true } : {}), ...(t.exempt ? { always_allowed: true } : {}) })),
      requests: sess ? (svc<McpService>('mcp').accessRequestsBySession(sess.id) as AccessRequestRow[]).map(accessRequestForSession) : [],
      how_to_request: `access_request {tools: [工具名], reason: 用途}；只要一张台时写 工具@台id（目前 ${[...MCP_SCOPED_TOOLS].join(' / ')} 支持）；管理员在「MCP 网关」页「权限申请」批准后立即生效（并入现有授权）`,
      ...mcpRestInfo(origin),
    };
  }
  // access_request
  if (!sess) bad('网关关闭时不校验授权，无需申请');
  const s = sess as McpSess;
  const raw = args?.tools;
  if (!Array.isArray(raw) || raw.length === 0) bad('tools 必须是非空的工具名数组');
  if (raw.length > 100) bad('tools 一次最多 100 个');
  const known = new Set(catalog.map((t) => t.name));
  for (const t of raw) {
    const p = typeof t === 'string' ? parseGrant(t) : null;
    if (!p || !known.has(p.tool)) bad(`不在工具目录里: ${JSON.stringify(t)}（先调 access_info 查目录）`);
    if (p!.wid !== null) {
      if (!MCP_SCOPED_TOOLS.has(p!.tool)) bad(`${p!.tool} 暂不支持按台申请（目前只有 ${[...MCP_SCOPED_TOOLS].join(' / ')}）`);
      if (!svc<WorkbenchService>('workbench').exists(p!.wid)) bad(`台不存在: ${p!.wid}`);
    }
  }
  // 已有全局授权的工具，再申请它的 工具@台 也算已可用
  const wanted = [...new Set(raw as string[])].filter((t) => !MCP_EXEMPT_TOOLS.has(t) && !s.grants.includes(t) && !s.grants.includes(parseGrant(t).tool)).sort();
  if (!wanted.length) bad('申请的工具本会话都已可用，无需申请');
  const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
  if (!reason) bad('reason 必填：写清要用这些工具做什么');
  if ([...reason].length > ACCESS_REASON_MAX) bad(`reason 超过 ${ACCESS_REASON_MAX} 字`);
  const toolsJson = JSON.stringify(wanted);
  const mcp = svc<McpService>('mcp');
  db.exec('BEGIN IMMEDIATE');
  try {
    const dup = mcp.accessRequestPendingSame(s.id, toolsJson) as AccessRequestRow | undefined;
    let out;
    if (dup) out = { ok: true, duplicate: true, request: accessRequestForSession(dup) };
    else {
      if (mcp.accessRequestCountLastHour(s.id) >= ACCESS_REQUEST_HOURLY_MAX) throw new HttpError(429, `每个会话每小时最多提 ${ACCESS_REQUEST_HOURLY_MAX} 条权限申请，请稍后再试`);
      const r = mcp.accessRequestInsert(s.id, toolsJson, reason) as unknown as { lastInsertRowid: number | bigint };
      out = { ok: true, duplicate: false, request: accessRequestForSession(mcp.accessRequestById(Number(r.lastInsertRowid)) as AccessRequestRow) };
    }
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 审批人：Odoo 管理员记登录名，口令记 admin-token（口令本身不落库） */
function adminActor(req: express.Request): string {
  const odoo = odooAdminReqs.get(req);
  return odoo ? `odoo:${odoo}` : 'admin-token';
}
function accessRequestId(req: express.Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, `access request not found: ${req.params.id}`);
  return id;
}

registerMcpRoutes(http, { adminGuard, bad, sha256Hex, MCP_UPSTREAM_PREFIX_RE, MCP_SESSION_NAME_RE, MCP_SCOPED_TOOLS, ACCESS_STATUSES, ACCESS_REASON_MAX, upstreamHealth, upstreamToolCache, mcpUpstreams, mcpAggregatedTools, mcpRegisteredNames, resolveGrants, pageLimit, parseToolList, adminActor, accessRequestId });

// ---------- /mcp 与 REST（/api/mcp-rest/*）共用：会话认定、审计、tools/call ----------
type McpChannel = 'mcp' | 'rest';
/** 网关会话认定：只认 Authorization: Bearer <会话令牌>。网关开且令牌无效/缺失/吊销 → 已回 401，返回 undefined；
 *  网关关 → null（匿名可调全部工具，只用于本地开发）。 */
function mcpGatewaySession(req: express.Request, res: express.Response): McpSess | null | undefined {
  if (!MCP_GATEWAY_ON) return null;
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(String(req.headers.authorization ?? ''));
  const sess = m ? mcpSessionByToken(m[1]) : null;
  if (!sess) {
    if (!isStartupProbeRequest(req)) mcp401Count += 1; // self-probe is not adoption traffic
    res.setHeader('WWW-Authenticate', 'Bearer realm="workbench-market mcp"');
    res.status(401).json({ error: 'unauthorized: valid session token required', hint: '会话与令牌由管理员经 /api/mcp/sessions 创建分发' });
    return undefined;
  }
  svc<McpService>('mcp').sessionTouched(sess.id);
  return sess;
}
function mcpAudit(sess: McpSess | null, channel: McpChannel, method: string, tool: string, ok: boolean, error: string, durationMs: number, args: unknown): void {
  if (!MCP_GATEWAY_ON || !sess) return;
  svc<McpService>('mcp').callInsertStmt()
    .run(sess.name, method, tool, ok ? 1 : 0, error, durationMs, sha256Hex(JSON.stringify(args ?? {})), channel); // 不存参数原文
}
/** 会话对某工具的授权范围（#452）：'all'＝免授权/全局授权/网关关；台 id 集合＝只授权了 工具@台；null＝无权 */
function mcpToolScope(sess: McpSess | null, toolName: string): 'all' | Set<number> | null {
  if (!sess || MCP_EXEMPT_TOOLS.has(toolName) || (!toolName.includes('@') && sess.grants.includes(toolName))) return 'all'; // 全局授权只认不带 @ 的工具名
  if (!MCP_SCOPED_TOOLS.has(toolName)) return null;
  const ids = new Set<number>();
  for (const g of sess.grants) { const p = parseGrant(g); if (p.wid !== null && p.tool === toolName) ids.add(p.wid); }
  return ids.size ? ids : null;
}
/** 会话可调用（列目录用）：免授权工具 + grants（含只限定到某些台的）；网关关时全部可调 */
function mcpToolGranted(sess: McpSess | null, toolName: string): boolean {
  return mcpToolScope(sess, toolName) !== null;
}
type McpInvokeResult =
  | { kind: 'not_granted' }
  | { kind: 'ok'; out: unknown; upstream: boolean }
  | { kind: 'error'; error: any; upstream: boolean };
/** tools/call 唯一执行链：授权检查 → 免授权工具 / 上游转发 / 本地工具 → 审计。两个渠道各自把结果映射成自己的应答形状。 */
async function mcpInvokeTool(sess: McpSess | null, toolName: string, args: any, channel: McpChannel, origin: string, t0 = Date.now()): Promise<McpInvokeResult> {
  const scope = mcpToolScope(sess, toolName);
  // 限定到台的授权在分发前按 id 参数核对（与工具自身同样 Number(args.id) 解析），台外按未授权处理并记审计
  if (scope === null || (scope !== 'all' && !scope.has(Number(args?.id)))) {
    mcpAudit(sess, channel, 'tools/call', toolName, false, scope === null ? 'not granted' : 'not granted: workbench scope', Date.now() - t0, args);
    return { kind: 'not_granted' };
  }
  // 上游路由（P2）：<prefix>__<tool> → 转发到对应上游 MCP
  const up = MCP_EXEMPT_TOOLS.has(toolName) ? null : routeUpstream(toolName);
  try {
    const out = MCP_EXEMPT_TOOLS.has(toolName)
      ? await mcpAccessTool(toolName, args ?? {}, sess, origin)
      : up
      ? await upstreamRpc(up.upstream, 'tools/call', { name: up.remoteTool, arguments: args ?? {} }, 2, sess ? `mcp/${sess.name}` : undefined)
      : await callTool(toolName, args ?? {}, sess ? `mcp:${sess.name}` : 'anonymous', origin);
    mcpAudit(sess, channel, 'tools/call', toolName, true, '', Date.now() - t0, args);
    return { kind: 'ok', out, upstream: !!up };
  } catch (e: any) {
    mcpAudit(sess, channel, 'tools/call', toolName, false, String(e?.message ?? e).slice(0, 200), Date.now() - t0, args);
    return { kind: 'error', error: e, upstream: !!up };
  }
}

// /mcp 网关化（MCP_GATEWAY=on）：Bearer 有效→会话；无效/缺失/吊销→401+WWW-Authenticate（含 initialize，无兼容期）
app.post('/mcp', async (req, res) => {
  const msg = req.body ?? {};
  const fail = (code: number, message: string) => res.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });

  // 网关会话判定 + 审计
  const sess = mcpGatewaySession(req, res);
  if (sess === undefined) return;
  const audit = (method: string, tool: string, ok: boolean, error: string, durationMs: number, args: unknown) =>
    mcpAudit(sess, 'mcp', method, tool, ok, error, durationMs, args);
  const t0 = Date.now();

  if (typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    audit('invalid', '', false, 'Invalid Request', 0, msg);
    return fail(-32600, 'Invalid Request');
  }
  if (msg.id === undefined || msg.id === null) return res.status(202).end(); // notification（含 notifications/initialized）——stateless 无会话态需要跟踪
  try {
    if (msg.method === 'initialize') {
      const want = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      audit('initialize', '', true, '', Date.now() - t0, msg.params);
      const rest = mcpRestInfo(mcpPublicOrigin(req));
      return res.json({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: MCP_KNOWN_PROTOCOLS.includes(want) ? want : MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'workbench-market', version: '0.1.0', title: '工作台市场' },
          instructions: `缺工具先调 access_info。大文件上传下载与资源读取可用同一会话令牌走 REST：${rest.rest_base}（OpenAPI：${rest.openapi_url}）`,
          ...rest,
        },
      });
    }
    if (msg.method === 'ping') {
      audit('ping', '', true, '', Date.now() - t0, null);
      return res.json({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
    if (msg.method === 'tools/list') {
      const all = await mcpAggregatedTools(); // 本地 + 上游（P2 聚合）
      // 按授权过滤；access_info / access_request 始终列出（缺权限时靠它们看目录、提申请）
      const tools = all.filter((t) => mcpToolGranted(sess, t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      audit('tools/list', '', true, '', Date.now() - t0, null);
      return res.json({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    }
    if (msg.method === 'tools/call') {
      if (typeof msg.params?.name !== 'string') {
        audit('tools/call', '', false, 'params.name 必填', Date.now() - t0, msg.params);
        return fail(-32602, 'params.name 必填');
      }
      // 未授权与不存在同应答——不泄露存在性
      const toolName = msg.params.name;
      const r = await mcpInvokeTool(sess, toolName, msg.params?.arguments, 'mcp', mcpPublicOrigin(req), t0);
      if (r.kind === 'not_granted') return fail(-32601, `Method not found: ${msg.method}`); // 与未知工具同文案族
      if (r.kind === 'ok') {
        // 上游结果已是 MCP 形状（{content,isError?}）→ 原样透传（下游客户端语义无损）；
        // 本地工具结果是业务对象 → 序列化为 text content。
        const out = r.out;
        if (r.upstream && out && typeof out === 'object' && Array.isArray((out as any).content)) {
          return res.json({ jsonrpc: '2.0', id: msg.id, result: out });
        }
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      }
      // 工具执行失败按 MCP 规范走 isError（协议层错误才用 JSON-RPC error）
      // 带具名字段的错误（如数据契约 violations）把状态码与字段原样附在后面，agent 能逐条改
      const e = r.error;
      const detail = e instanceof HttpError && e.extra ? `\n${JSON.stringify({ status: e.status, ...e.extra })}` : '';
      return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `执行失败：${e?.message || e}${detail}` }], isError: true } });
    }
    audit(msg.method, '', false, 'Method not found', Date.now() - t0, msg.params);
    return fail(-32601, `Method not found: ${msg.method}`);
  } catch (e: any) {
    audit(msg.method, '', false, 'Internal error', Date.now() - t0, msg.params);
    return fail(-32603, `Internal error: ${e?.message || e}`);
  }
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'stateless StreamableHTTP：仅支持 POST（无服务端会话流）' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: '无会话可终止（stateless）' }));

// ---------- MCP 工具的 OpenAPI REST 开放：不说 MCP 协议的客户端用同一个会话令牌按 REST 调同一批工具 ----------
// 认证、授权、审计、上游转发全走上面的共用链（mcpGatewaySession / mcpInvokeTool），只换应答形状。
// 与 /mcp 不同：未授权回 403 并提示申请（REST 客户端要能区分「没权限」和「没这个工具」）；目录本就能经 access_info 看到，不另泄露。
const MCP_REST_TOOLS_PATH = '/api/mcp-rest/tools/';
const MCP_REST_DENIED_HINT = '调 access_info 查看可用工具与授权状态，用 access_request 申请（管理员批准后立即生效）';
async function mcpOpenApiDoc(req: express.Request, sess: McpSess | null): Promise<Record<string, unknown>> {
  const tools = (await mcpAggregatedTools()).filter((t) => mcpToolGranted(sess, t.name));
  const errRef = (name: string) => ({ $ref: `#/components/responses/${name}` });
  const paths: Record<string, any> = {};
  // 文件与资源接口（MCP 内嵌）：按所映射工具的授权过滤，与工具映射同口径
  for (const op of mcpRestResourceOps()) {
    if (!mcpToolGranted(sess, op.tool)) continue;
    const { path, method, tool, errors, ...rest } = op;
    (paths[path] ??= {})[method] = {
      ...rest, tags: [path.includes('/sop/') ? 'sop' : path.includes('/files') ? 'files' : 'resources'], 'x-requires-tool': tool, 'x-granted': true,
      responses: { ...op.responses, ...Object.fromEntries(errors.map((c) => [c, errRef(MCP_REST_ERR_NAMES[c])])) },
    };
  }
  for (const t of tools) {
    paths[MCP_REST_TOOLS_PATH + encodeURIComponent(t.name)] = {
      post: {
        tags: ['tools'],
        operationId: t.name,
        summary: t.description.split('\n')[0].slice(0, 120),
        description: t.description,
        'x-category': t.category,
        'x-granted': true,
        ...(t.exempt ? { 'x-exempt': true } : {}),
        requestBody: { required: false, content: { 'application/json': { schema: t.inputSchema } } },
        responses: {
          '200': { description: '工具结果（本地工具为业务对象 JSON；上游工具为其 MCP 结果 {content}）', content: { 'application/json': { schema: {} } } },
          '400': errRef('BadRequest'), '401': errRef('Unauthorized'), '403': errRef('Forbidden'), '404': errRef('NotFound'),
        },
      },
    };
  }
  const errSchema = { type: 'object', properties: { error: { type: 'string' }, hint: { type: 'string' }, violations: { type: 'array', items: { type: 'object' } } }, required: ['error'] };
  const errResp = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'workbench-market MCP tools (REST)',
      version: '0.1.0',
      description: `与 /mcp 同一批工具、同一个会话令牌（Authorization: Bearer <会话令牌>）。含两部分：文件与资源接口（大文件原始字节上传、二进制下载支持 Range/ETag、列文件/读台数据/读 SOP run，授权映射到对应工具）与工具映射（每个工具一个 POST /api/mcp-rest/tools/{name}）。只列当前会话可调用的${sess ? `（会话 ${sess.name}）` : ''}；缺权限时调 access_info 查看目录、用 access_request 申请。`,
    },
    servers: [{ url: mcpPublicOrigin(req) }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'MCP 会话令牌（管理员经 /api/mcp/sessions 创建，只显示一次）' } },
      schemas: { Error: errSchema },
      responses: {
        BadRequest: errResp('参数错误；违反台数据契约时带 violations'),
        Unauthorized: errResp('缺少或无效的会话令牌'),
        Forbidden: errResp('会话未获授权（响应 hint 提示用 access_request 申请）'),
        NotFound: errResp('工具或资源不存在'),
        PayloadTooLarge: errResp('文件超 100MB 或台文件数已达上限'),
        UnsupportedMediaType: errResp('文件内容与扩展名不符，或是可执行文件'),
        RangeNotSatisfiable: errResp('Range 超出文件范围'),
      },
    },
  };
}
const MCP_REST_ERR_NAMES: Record<string, string> = { '400': 'BadRequest', '401': 'Unauthorized', '403': 'Forbidden', '404': 'NotFound', '413': 'PayloadTooLarge', '415': 'UnsupportedMediaType', '416': 'RangeNotSatisfiable' };
/** 文件与资源接口的 OpenAPI 描述（路由在下方「MCP 内嵌的文件与资源 REST」） */
function mcpRestResourceOps(): { path: string; method: 'get' | 'put' | 'post'; tool: string; operationId: string; summary: string; description: string; parameters?: unknown[]; requestBody?: unknown; responses: Record<string, unknown>; errors: string[] }[] {
  const P = (name: string, description: string, schema: Record<string, unknown> = { type: 'string' }) => ({ name, in: 'path', required: true, description, schema });
  const Q = (name: string, description: string, schema: Record<string, unknown>) => ({ name, in: 'query', required: false, description, schema });
  const H = (name: string, description: string) => ({ name, in: 'header', required: false, description, schema: { type: 'string' } });
  const slug = P('slug', '自产台 slug', { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' });
  const page = [Q('limit', '每页条数（默认 50，最多 200）', { type: 'integer', minimum: 1, maximum: 200 }), Q('before_id', '游标：上一页的 next_before_id', { type: 'integer', minimum: 1 })];
  const json = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
  const uploaded = { description: '已入库', content: { 'application/json': { schema: { type: 'object', required: ['id', 'sha256', 'mime', 'size', 'url'], properties: {
    id: { type: 'integer' }, slug: { type: 'string' }, name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    note: { type: 'string' }, url: { type: 'string', description: 'REST 下载地址' }, download_url: { type: 'string', description: '台页面用的下载地址' } } } } } };
  const binary = (description: string) => ({
    description,
    headers: { ETag: { description: '强 ETag = 文件 sha256', schema: { type: 'string' } }, 'X-Content-SHA256': { schema: { type: 'string' } }, 'Accept-Ranges': { schema: { type: 'string' } }, 'Content-Range': { schema: { type: 'string' } } },
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  });
  const download = { parameters: [H('Range', '单段字节范围，如 bytes=0-1023'), H('If-None-Match', '上次的 ETag；未变回 304'), H('If-Range', 'ETag 不符时忽略 Range 回整份')],
    responses: { '200': binary('文件内容（Content-Type 为入库时识别的类型，Content-Disposition: attachment）'), '206': binary('Range 片段'), '304': { description: '未变化' } } };
  const base = MCP_REST_BASE;
  return [
    { path: `${base}/apps/{slug}/files/{name}`, method: 'put', tool: 'app_files_upload', operationId: 'rest_file_upload', summary: '上传文件（原始字节，流式落盘）',
      description: '请求体即文件内容（≤100MB），边收边落盘，不经 base64。与浏览器上传同一套核心：按内容识别类型（扩展名与内容不符 415）、台文件数配额。返回 id / sha256 / mime / url。',
      parameters: [slug, P('name', '文件名（含扩展名，URL 编码）'), Q('note', '备注（≤500 字）', { type: 'string' }), Q('created_by', '提交人（缺省 mcp:<会话名>）', { type: 'string' })],
      requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } }, '*/*': { schema: { type: 'string', format: 'binary' } } } },
      responses: { '201': uploaded }, errors: ['400', '401', '403', '404', '413', '415'] },
    { path: `${base}/apps/{slug}/files`, method: 'post', tool: 'app_files_upload', operationId: 'rest_file_upload_multipart', summary: '上传文件（multipart）',
      description: 'multipart/form-data：字段 file（单文件 ≤100MB）+ 可选 note / created_by。其余同原始字节上传。',
      parameters: [slug],
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' }, created_by: { type: 'string' } } } } } },
      responses: { '201': uploaded }, errors: ['400', '401', '403', '404', '413', '415'] },
    { path: `${base}/apps/{slug}/files`, method: 'get', tool: 'app_files_list', operationId: 'rest_files_list', summary: '列文件（倒序分页 + 配额）',
      description: '与 app_files_list 同一结果；items[].url 为 REST 下载地址，quota 为剩余文件数与单文件上限。', parameters: [slug, ...page],
      responses: { '200': json('{ items, count, has_more, next_before_id, quota }') }, errors: ['401', '403', '404'] },
    { path: `${base}/apps/{slug}/files/{id}`, method: 'get', tool: 'app_files_list', operationId: 'rest_file_download', summary: '下载文件（二进制，支持 Range / ETag）',
      description: '返回文件原始字节；ETag 与 X-Content-SHA256 为 sha256，可续传。', parameters: [slug, P('id', '文件 id', { type: 'integer' }), ...download.parameters],
      responses: download.responses, errors: ['401', '403', '404', '416'] },
    { path: `${base}/apps/{slug}/data`, method: 'get', tool: 'app_data_list', operationId: 'rest_data_list', summary: '读台数据（倒序分页）',
      description: '与 app_data_list 同一结果。', parameters: [slug, ...page], responses: { '200': json('{ items, count, has_more, next_before_id }') }, errors: ['401', '403', '404'] },
    { path: `${base}/sop/runs/{id}`, method: 'get', tool: 'sop_run_get', operationId: 'rest_sop_run_get', summary: '读 SOP run',
      description: '与 sop_run_get 同一结果：有该 run 的读授权时含执行数据，否则只有元数据。', parameters: [P('id', 'run id', { type: 'integer' }), H('X-Run-Read-Capability', 'run 读凭证（可选）')],
      responses: { '200': json('run') }, errors: ['401', '403', '404'] },
    { path: `${base}/sop/runs/{id}/files`, method: 'get', tool: 'sop_run_get', operationId: 'rest_sop_run_files', summary: '列 SOP run 附件',
      description: '需该 run 的读授权（与 sop_run_get 同一判定）。', parameters: [P('id', 'run id', { type: 'integer' }), H('X-Run-Read-Capability', 'run 读凭证（可选）')],
      responses: { '200': json('{ run_id, items, count }') }, errors: ['401', '403', '404'] },
    { path: `${base}/sop/runs/{id}/files/{fileId}`, method: 'get', tool: 'sop_run_get', operationId: 'rest_sop_run_file_download', summary: '下载 SOP run 附件（二进制，支持 Range / ETag）',
      description: '需该 run 的读授权。', parameters: [P('id', 'run id', { type: 'integer' }), P('fileId', '附件 id', { type: 'integer' }), H('X-Run-Read-Capability', 'run 读凭证（可选）'), ...download.parameters],
      responses: download.responses, errors: ['401', '403', '404', '416'] },
  ];
}
const serveMcpOpenApi = wrap(async (req, res) => {
  const sess = mcpGatewaySession(req, res);
  if (sess === undefined) return;
  res.setHeader('Cache-Control', 'no-store'); // 内容随会话授权变化
  res.json(await mcpOpenApiDoc(req, sess));
});
// ---------- MCP 内嵌的文件与资源 REST：传文件不走 JSON-RPC 的 base64，下载直接拿二进制 ----------
// 认证同上（会话 Bearer）；授权映射到现有工具 grants，不另设权限：上传 = app_files_upload，列文件/下载 = app_files_list，
// 读台数据 = app_data_list，SOP run 元数据与附件 = sop_run_get（附件另过 run 读授权，与 sop_run_get 同一判定）。
const MCP_REST_BASE = '/api/mcp-rest';
/** 会话认定 + 工具授权。未授权已回 403（提示申请）并记审计，返回 undefined。 */
function mcpRestSession(req: express.Request, res: express.Response, tool: string, op: string): McpSess | null | undefined {
  const sess = mcpGatewaySession(req, res);
  if (sess === undefined) return undefined;
  if (!mcpToolGranted(sess, tool)) {
    mcpAudit(sess, 'rest', `rest/${op}`, tool, false, 'not granted', 0, req.params);
    res.status(403).json({ error: `会话未获授权：${op} 需要工具 ${tool} 的授权`, required_tool: tool, hint: MCP_REST_DENIED_HINT });
    return undefined;
  }
  return sess;
}
/** 资源接口的执行与审计：成功/失败都按 rest/<op> 记一行，错误交统一出口映射状态码 */
async function mcpRestRun(sess: McpSess | null, tool: string, op: string, auditArgs: unknown, fn: () => Promise<void> | void): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    mcpAudit(sess, 'rest', `rest/${op}`, tool, true, '', Date.now() - t0, auditArgs);
  } catch (e: any) {
    mcpAudit(sess, 'rest', `rest/${op}`, tool, false, String(e?.message ?? e).slice(0, 200), Date.now() - t0, auditArgs);
    throw e;
  }
}
/** 文件 sha256（ETag 用，入库没存的才算）：按 路径+大小+mtime 缓存，同一文件每进程只算一次 */
const fileShaCache = new Map<string, string>();
async function fileSha256(abs: string): Promise<string> {
  const st = statSync(abs);
  const key = `${abs}|${st.size}|${st.mtimeMs}`;
  const hit = fileShaCache.get(key);
  if (hit) return hit;
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  const hex = h.digest('hex');
  if (fileShaCache.size > 2000) fileShaCache.clear();
  fileShaCache.set(key, hex);
  return hex;
}
/** 二进制下载：强 ETag = sha256、If-None-Match → 304、单段 Range（bytes=a-b / a- / -n）→ 206、越界 416；安全头同现有下载（attachment + nosniff） */
async function sendStoredFile(req: express.Request, res: express.Response, f: { abs: string; size: number; mime: string; name: string; sha256?: string; onSha?: (sha: string) => void }): Promise<void> {
  if (!existsSync(f.abs)) throw new HttpError(404, 'stored file missing on disk');
  const size = statSync(f.abs).size;
  // 入库时存了 sha256 就直接用；存量行（浏览器上传等未存的）算一次后经 onSha 回写
  let sha = f.sha256 && size === f.size ? f.sha256 : '';
  if (!sha) { sha = await fileSha256(f.abs); f.onSha?.(sha); }
  const etag = `"${sha}"`;
  res.setHeader('content-type', f.mime || 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('etag', etag);
  res.setHeader('x-content-sha256', sha);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'private, no-cache');
  const inm = String(req.headers['if-none-match'] ?? '');
  if (inm && inm.split(',').map((x) => x.trim()).some((x) => x === etag || x === '*')) { res.status(304).end(); return; }
  let start = 0, end = size - 1;
  const range = String(req.headers.range ?? '');
  const ifRange = String(req.headers['if-range'] ?? '');
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) { // 多段或坏格式忽略，回整份（RFC 9110 允许）
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
      else { start = Math.max(0, size - Number(m[2])); }
      if (start >= size || start > end || (!m[1] && Number(m[2]) === 0)) {
        res.setHeader('content-range', `bytes */${size}`);
        res.status(416).json({ error: 'Range 超出文件范围', size });
        return;
      }
      res.status(206);
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    }
  }
  res.setHeader('content-length', String(end - start + 1));
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  await pipeline(createReadStream(f.abs, { start, end }), res);
}
const restFileItem = (slug: string, r: any) => ({ ...r, url: `${MCP_REST_BASE}/apps/${slug}/files/${r.id}` });

/** SOP run 读授权：与 sop_run_get 同一判定（会话主体 mcp:<会话名> 的 run grant，或 X-Run-Read-Capability） */
async function mcpRestRunReadable(req: express.Request, sess: McpSess | null, runId: number): Promise<boolean> {
  return (await authorizeRunRead({ cap: runReadCapHeader(req), mcpSubject: sess ? `mcp:${sess.name}` : undefined }, runId)).authorized;
}
const runIdParam = (v: unknown): number => { if (!/^\d+$/.test(String(v))) throw new HttpError(404, `run not found: ${v}`); return Number(v); };
registerMcpRestRoutes(http, { wrap, serveMcpOpenApi, mcpGatewaySession, mcpAudit, mcpRegisteredNames, MCP_REST_DENIED_HINT, mcpInvokeTool, mcpPublicOrigin, mcpRestSession, mcpRestRun, bad, getApp, appFilesQuota, APP_FILES_MAX, UPLOAD_MAX, uploadMonthDir, uploadFileName, appFileStoreCore, MCP_REST_BASE, upload, fixFileName, fileSha256, sendStoredFile, restFileItem, mcpRestRunReadable, runIdParam, sopRunRow, runReadCapHeader });
import { installPortal, goPrefix, moduleProxy } from './portal.ts';

loginRelay().useTicketStore(sqliteSsoTicketStore()); // SSO 回调票据落库：重启不丢、同一 DATA_DIR 的实例共享
installPortal(app, wbById, { serveApp, readActiveManifest, renderSopRunner, appsRoot });

// ---------- 静态托管前端（生产形态：单端口） ----------
const webDist = join(here, '..', '..', 'web', 'dist');
// #292 M1：index.html 按面注入 <meta name="wm-surface">（market/control）与另一面的地址，前端据此分流管理入口
let indexHtmlCache: { mtimeMs: number; html: string } | null = null;
function sendSurfaceIndex(req: express.Request, res: express.Response): void {
  const file = join(webDist, 'index.html');
  const mtimeMs = statSync(file).mtimeMs;
  if (!indexHtmlCache || indexHtmlCache.mtimeMs !== mtimeMs) indexHtmlCache = { mtimeMs, html: readFileSync(file, 'utf8') };
  const attr = (v: string | null) => (v ?? '').replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]!));
  const meta = `<meta name="wm-surface" content="${surfaceOf(req) === 'control' ? 'control' : 'market'}">`
    + `<meta name="wm-control-url" content="${attr(surfaceUrl(req, 'control'))}"><meta name="wm-market-url" content="${attr(surfaceUrl(req, 'market'))}">`;
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(indexHtmlCache.html.replace(/<head([^>]*)>/i, (m) => m + meta));
}
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: false })); // index.html 由 sendSurfaceIndex 注入后下发
  // SPA fallback 只兜「路由路径」：静态资源（/assets/*、带扩展名文件）不存在的直接 404——
  // 否则旧缓存 index.html 引用的已删 hash 会被回成 200 text/html，前端炸 MIME 错且难定位（实盘踩坑）
  app.get(/^(?!\/api\/|\/assets\/|\/health).*/, (_req, res, next) => { // P1-4：/health* 不被 SPA 兜底（探活可区分）
    if (/\.[A-Za-z0-9]+$/.test(_req.path) && _req.path !== '/index.html') return next(); // 带扩展名的文件请求不兜底
    sendSurfaceIndex(_req, res);
  });
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
}

// ---------- 统一错误出口 ----------
// issue #8：校验类普通 Error（assertHttpUrl 的「非法 URL/仅支持 http」）统一映射 400——
// 输入校验错误不得 500 泄内部细节。
const VALIDATION_ERR_PREFIX = ['非法 URL', '仅支持 http'];
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // body-parser 的坏 JSON / 超限：回 4xx 固定文案，不记日志也不回显——err.body 是原始请求体（凭据库解锁时就是主密码）
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(err.status ?? 400).json({ error: err.type === 'entity.too.large' ? '请求体过大' : '请求体不是合法 JSON' });
  }
  const msg = String(err?.message ?? err);
  let status = err instanceof HttpError || err instanceof TaskIntakeError ? err.status : 500;
  if (status === 500 && VALIDATION_ERR_PREFIX.some((p) => msg.startsWith(p))) status = 400;
  if (isStartupProbeRequest(_req)) {
    if (status === 500) console.error(JSON.stringify({ source: 'self-probe', event: 'handler-error', status }));
    return res.status(status).json({ error: 'self_probe_request_failed' }); // never echo or log raw probe exceptions
  }
  if (status === 500) console.error('[server] unhandled:', err);
  if (status === 503 && err instanceof HttpError && err.extra?.retryable) res.set('Retry-After', '5'); // #442 热态读不到：稍后重试
  res.status(status).json({ error: msg, ...(err instanceof HttpError && err.extra ? err.extra : {}) });
});

// 进程兜底日志（监督席顺查件 direct-db6fc70c③）：不吞异常只记栈——multer 等中间件内部 throw 不经 Express 链时留证
process.on('uncaughtException', (e) => { console.error('[fatal] uncaughtException:', e); });
process.on('unhandledRejection', (r) => { console.error('[fatal] unhandledRejection:', r); });

// ---------- 定期巡检 ----------
let timer: ReturnType<typeof setTimeout> | null = null;
let checking = false;
async function patrol(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const rows = svc<WorkbenchService>('workbench').enabled() as unknown as WorkbenchRow[];
    for (const w of rows) {
      try {
        // down 即入冷却窗：窗内（距上次探测不足一个窗）跳过，每窗只探一次
        if (downSince.has(w.id) && Date.now() - (lastProbeAt.get(w.id) ?? 0) < EVICT_COOLDOWN_MS) continue;
        if (downSince.has(w.id)) lastProbeAt.set(w.id, Date.now());
        await checkOne(w);
        const after = svc<WorkbenchService>('workbench').byId(w.id) as unknown as WorkbenchRow | undefined;
        if (after?.last_status === 'down') { if (!downSince.has(w.id)) { downSince.set(w.id, Date.now()); lastProbeAt.set(w.id, Date.now()); } }
        else { downSince.delete(w.id); lastProbeAt.delete(w.id); }
      } catch { /* 单个失败不阻断巡检 */ }
    }
  } finally {
    checking = false;
  }
}
function armPatrol(): void {
  if (timer) clearTimeout(timer);
  const s = Number(getSettings().health_interval_seconds) || 0;
  if (s < 10) return; // 0 或过小视为关闭
  timer = setTimeout(() => { patrol().finally(armPatrol); }, s * 1000);
  timer.unref?.();
}
// #326: background patrol is armed only after the startup safety gate passes.

const PORT = Number(process.env.PORT) || 9800;
// ---------- A2A 出站（#17 P4 最小面）：市场作为客户端向对端派单/发消息 ----------
// 官方 A2aClient（fetchCardDetail 带 OriginClaim 信封 + routeDirect 投递），单进程单端口（9800）。
// 三件自实现按官方示例：身份密钥（DATA_DIR/a2a-key.pem）、OriginClaim 签名、fetch/schedule 适配。
app.get('/api/a2a/state', (_req, res) => {
  const card = buildAgentCard(a2aKeyPath());
  res.json({
    team: MARKET_TEAM,
    key: existsSync(a2aKeyPath()) ? 'present' : 'missing',
    card: { name: card.name, session: card.session, team: card.team, expiresAt: card.expiresAt, sessionTeams: (card as any).sessionTeams ?? [] },
    binding: svc<SopService>('sop').activeBindingCount(),
  });
});

app.post('/api/a2a/send', wrap(async (req, res) => {
  const target = String(req.body?.target_url ?? '').trim();
  const team = String(req.body?.team ?? '').trim();
  const message = String(req.body?.message ?? '');
  if (!/^https?:\/\/[^\s]+$/.test(target)) bad('target_url 必须是 http(s):// 对端节点地址');
  if (!/^[a-z][a-z0-9-]*\/[0-9a-f]{8}$/i.test(team)) bad('team 形如 market/<8hex>（对端卡片里的 sessionTeams）');
  if (!message) bad('message 必填');
  try {
    const out = await a2aSendOutbound(a2aKeyPath(), { baseUrl: target.replace(/\/+$/, ''), team }, message, typeof req.body?.context_id === 'string' ? req.body.context_id : undefined);
    res.json({ ok: true, target, team, result: out });
  } catch (e: any) {
    throw new HttpError(502, `出站失败：${String(e?.message ?? e)}`);
  }
}));

if (getApp('task-center').status === 'published') syncWorkbenchRegistration(getApp('task-center'));
const SURFACE_PORTS = surfacePorts();
// 阶段六 6b：所有路由都注册完之后、开始监听之前读角色声明并校验（动作清单要齐）；不合格抛错，拒绝启动
try { loadRoleDeclarations(http); } catch (e) {
  // 这里已经在全局 uncaughtException 兜底之后：不显式退出的话进程会以 0 结束，看上去像正常退出
  console.error(`[grants] 拒绝启动：${String((e as Error)?.message ?? e)}`);
  process.exit(1);
}
const goServer = registerSurface(app, 'market', PORT, () => {
  // #258 breaking：旧开关不再放行任何公网登记，只做兼容检测告警
  if (process.env.ALLOW_PUBLIC_NET === '1') console.warn('[R3] ALLOW_PUBLIC_NET=1: legacy flag no longer grants public registration; use WM_REGISTER_URL_ALLOWLIST exact entries.');
  console.log(`[R3] URL 准入 policy ${URL_POLICY.digest.slice(0, 12)}：精确许可 ${URL_POLICY.size} 条${URL_POLICY.duplicates ? `（去重 ${URL_POLICY.duplicates} 条）` : ''}`);
  {
    const gaps = legacyGaps(listWorkbenches().map((w) => ({ id: w.id, url: w.url })), URL_POLICY);
    // 迁移材料：存量行不删不停，只列按新规会被拒的 id + URL 摘要 + 原因（不出原 URL/query）
    if (gaps.length) console.warn(JSON.stringify({ event: 'workbench_url_legacy_gap', policy_digest: URL_POLICY.digest, count: gaps.length, rows: gaps }));
  }
  const odooTrust = loginRelay().trustedOrigins();
  const oldOdoo = loginRelay().legacyConfig();
  if (oldOdoo === 'only-old') console.warn('[odoo] LC_ODOO_URL 已弃用，请改名为 WM_ODOO_URL（当前按旧名读取）');
  else if (oldOdoo === 'both') console.warn('[odoo] WM_ODOO_URL 与已弃用的 LC_ODOO_URL 都设了：以 WM_ODOO_URL 为准，LC_ODOO_URL 可删');
  if (odooTrust.invalid.length) console.warn(`[SSO v1] WM_ODOO_ORIGINS/WM_ODOO_URL 有非法项（已忽略）：${odooTrust.invalid.join(', ')}`);
  if (odooTrust.origins.size === 0 && listWorkbenches().some((w) => loginRelay().looksLikeTarget(w.type, w.url))) console.warn('[SSO v1] 未设 WM_ODOO_ORIGINS / WM_ODOO_URL：门户不转发 Odoo 会话，Odoo 台免登不生效（台内会显示 Odoo 自己的登录页）——要免登请把 Odoo 台的源写进 WM_ODOO_ORIGINS');
  const counts = svc<WorkbenchService>('workbench').count() as { n: number };
  console.log(`[workbench-market] server  http://127.0.0.1:${PORT}  (workbenches: ${counts.n}, web-dist: ${existsSync(webDist) ? 'served' : 'none'}, portal: /go/<id>/)`);
  if (SURFACE_PORTS.control) console.log(`[workbench-market] control http://127.0.0.1:${SURFACE_PORTS.control}  （可选的独立管理端口；管理写在业务面凭口令或 Odoo 管理员同样可做）`);
  // The listener exists but HTTP/market WS remain gated until anonymous safety checks pass.
});

const controlServer = SURFACE_PORTS.control ? registerSurface(app, 'control', SURFACE_PORTS.control) : undefined;
if (contentCfg && contentRuntime) listenContentSurface(app, contentCfg, contentRuntime, () => startupSecurity.snapshot().passed);

void startupSecurity.run({ market: goServer, control: controlServer, gatewayOn: MCP_GATEWAY_ON, nodeEnv: process.env.NODE_ENV, loginGate: loginGate.mode }).then((result) => {
  if (!result.passed) return refuseUnsafeStartup();
  startRedis();
  armPatrol();
  svc<SettingService>('setting').put('patrol_armed_at', new Date().toISOString());
  const boot = setTimeout(() => { void patrol(); }, 8_000);
  boot.unref?.();
}).catch(() => refuseUnsafeStartup());

function refuseUnsafeStartup(): void {
  const snap = startupSecurity.snapshot();
  // 失败项的原因与状态码也写 stderr（逐项结果在 stdout，只收 stderr 的冒烟与容器日志里看不到为什么拒绝）
  const why = snap.rows.filter((r) => r.verdict === 'fail').map((r) => ({ id: r.id, status: r.status, reason: r.reason }));
  console.error(JSON.stringify({ source: 'self-probe', event: 'startup-refused', failed: snap.failed, why }));
  // Only this process's listeners are closed; never signal a PID, parent cmd or host.
  for (const server of allSurfaceServers()) { server.closeAllConnections(); server.close(); }
  try { db.close(); } catch { /* initialization may already have closed it */ }
  process.exit(1);
}

// P1-3（#147）：优雅关闭——停巡检→WAL checkpoint(db.close)→server.close（容器 stop 不丢写）
let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown] ' + sig + ' received——停止接受新请求');
  if (timer) clearTimeout(timer);
  const deadline = setTimeout(() => { console.error('[shutdown] checkpoint_or_request_drain_timeout'); process.exit(1); }, 8000);
  deadline.unref?.();
  try {
    await Promise.all(allSurfaceServers().map(srv => new Promise<void>(resolve => { srv.close(() => resolve()); })));
    await runCheckpoints.close();
    db.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error('[shutdown] sqlite_checkpoint_failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// WebSocket 升级（Jupyter kernel / MCP / DSH web 实时通道等长连接走 /go/ 代理）。
// 关键：upgrade 事件不流经 Express 中间件链——前置中间件设置的 goOrigin/goBase/goQuery/goAuth
// 在这里全部不存在，必须对 upgrade 请求重做同样的准备，否则 router 兜底到 http://127.0.0.1（80 端口
// 无服务）→ DSH 台经门户打开后 WS 永远连不上（页面「重新连接中…」，实测踩坑）。
for (const srv of allSurfaceServers()) if (srv !== goServer) srv.on('upgrade', (req, socket) => { if (surfaceOf(req) !== 'content') socket.destroy(); }); // #292 M1：控制面不提供 WS
goServer.on('upgrade', async (req, socket, head) => {
  if (!startupSecurity.snapshot().passed) return socket.destroy();
  if (!(await loginGate.upgradeAllowed(req))) return socket.destroy(); // 登录门：WS 升级同样要身份
  portalObserver?.observe(req);
  const m = goPrefix.exec(req.url ?? '');
  if (!m) return socket.destroy(); // 非 /go/ 的升级请求：本服务自身不提供 WS
  const w = wbById(Number(m[1]));
  if (!w || w.url.startsWith('/')) return socket.destroy(); // 自产台纯静态无 WS
  let u: URL;
  try {
    u = new URL(w.url);
  } catch {
    return socket.destroy();
  }
  const rq = req as typeof req & { goOrigin?: string; goBase?: string; goQuery?: string; goAuth?: string };
  rq.goOrigin = u.origin;
  rq.goBase = u.pathname.replace(/\/+$/, '');
  rq.goQuery = u.search;
  if (w.auth?.type === 'bearer') rq.goAuth = `Bearer ${w.auth.value}`;
  else if (w.auth?.type === 'basic') rq.goAuth = `Basic ${Buffer.from(w.auth.value, 'utf8').toString('base64')}`;
  // WS 握手不走 on.proxyReq 钩子（HPM v4 upgrade 路径不触发），头改写必须直接动 req.headers：
  // ① 浏览器握手必带 Origin（=9800 门户源），上游 Origin fence 要求 Origin==Host authority → 403（实测）
  // ② Host 改成上游 authority，与 changeOrigin 语义一致；cookie 名是 authority 的 sha256，
  //    Host 不符则上游取不到签名 cookie → 401（实测）
  if (!loginRelay().isSessionTarget(w.url)) loginRelay().stripSession(req.headers); // 同 HTTP 门户：Odoo 会话只转给可信 Odoo 源
  const upstreamHost = u.host; // host:port（authority 形态）
  if (req.headers.origin !== undefined) req.headers.origin = u.origin;
  req.headers.host = upstreamHost;
  (moduleProxy as unknown as { upgrade: (rq: typeof req, sk: typeof socket, hd: typeof head) => void }).upgrade(req, socket, head);
});
