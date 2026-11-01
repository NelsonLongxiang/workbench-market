import express from 'express';
import { initializeTaskCenter, publishTaskIntake, taskCenterSteps, TaskIntakeError, taskView, taskListView, taskCenterPolicy } from './task-center.ts';
import cors from 'cors';
import { contentConfig, createContentSurface, mountContentSurface, listenContentSurface } from './content-surface.ts';
import { createPortalObservation } from './portal-observation.ts';
import { allSurfaceServers, browserMarked, originIsThisSurface, rawLoopback, registerSurface, surfaceOf, surfacePorts, surfaceUrl } from './surfaces.ts';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, posix, extname, sep as pathSep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import multer from 'multer';
import { svc } from './context.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { SopService } from './services/sop.ts';
import { SkillService } from './services/skill.ts';
import type { AppService } from './services/app.ts';
import type { AppDataService } from './services/app-data.ts';
import type { CookieService } from './services/cookie.ts';
import type { CockpitService } from './services/cockpit.ts';
import type { SettingService } from './services/setting.ts';
import { db, getSettings, dataDir, rowToWorkbench, rowToCockpit, type WorkbenchRow, type TypeRow, type CockpitRow, type PanelConfig, type AppRow, type AppVersionRow, type SopRunRow } from './db.ts';
(globalThis as any).__wmDb = db; // #94 v3 S1：tasks.ts 直读 change_requests 桥
import { assertHttpUrl, composeProbeUrl, probe } from './health.ts';
import { HttpError } from './errors.ts';
import { designStandard } from './design-standard.ts';
import { AdmissionError, admitUrl, analyzeUrl, auditAllow, auditDeny, checkHealthPath, checkTypeHealthPath, legacyGaps, loadAllowPolicy, markAuditChannelFailed, sameTarget, type AllowPolicy } from './url-admission.ts';
import { parse as parseYaml } from 'yaml';
import { startRedis, redisHealthy, runStateRestore, runStateLoad, runStateRetire } from './redis.ts';
import { createRunCheckpoints } from './sop-state-checkpoints.ts';
import { adminTokenOk, buildAgentCard, a2aKeyPath, sopNode8, a2aDirectHandle, a2aSendOutbound, formatA2aReceipt, MARKET_TEAM } from './a2a.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
// Explicit opt-in only; no default content listener, no live configuration writes.
const contentCfg = contentConfig(process.env);
const portalObserver = process.env.WM_PORTAL_OBSERVE === '1' ? createPortalObservation(db, id => !!svc<WorkbenchService>('workbench').exists(id)) : null;
app.use((req, _res, next) => { if (surfaceOf(req) === 'market') portalObserver?.observe(req); next(); });
if (contentCfg) {
  const odoo = String(process.env.WM_CONTENT_ODOO_ORIGIN ?? '');
  const parsed = new URL(odoo);
  const ports = surfacePorts();
  if (contentCfg.port === ports.market || contentCfg.port === ports.control) throw Error('Content port must be distinct');
  if (parsed.origin !== odoo || !trustedOdooOrigins().origins.has(odoo)) throw Error('Content viewer source must be an explicitly trusted Odoo origin');
}
const contentRuntime = contentCfg ? createContentSurface(contentCfg, {
  async viewer(cookie) {
    // Reject duplicate SID instead of inheriting the legacy first-cookie ambiguity.
    const values = cookie.split(';').map(s => s.trim()).filter(s => s.startsWith('session_id='));
    if (values.length !== 1) return null;
    const result = await resolveOdooViewer(values[0], process.env.WM_CONTENT_ODOO_ORIGIN);
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
// #292 M1 控制面围栏：控制面（WM_CONTROL_PORT）不承载任何不可信内容，也不许被嵌、不嵌别人
app.use((req, res, next) => {
  if (surfaceOf(req) !== 'control') return next();
  // 用 Express 路由同一个 pathname（req.path：已剥查询串、已处理绝对形式 http://x/mcp），再按小写判——路由不区分大小写（/MCP、/A2A/direct 曾漏过；#299 绝对形式）
  const p = req.path.toLowerCase();
  if (/^\/(go|sop|apps)(\/|$)/.test(p) || p === '/mcp' || p.startsWith('/a2a/')) return res.status(404).type('text').send('控制面不提供此路径（请用业务面）\n');
  res.setHeader('content-security-policy', "frame-ancestors 'none'; frame-src 'none'");
  res.setHeader('x-frame-options', 'DENY');
  next();
});
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
app.use((req, res, next) => {
  if ((req.url ?? '').startsWith('/go/')) return next();
  return express.json({ limit: '4mb' })(req, res, next);
});

// GH #20 P1 ④远程面收口：非本机请求只放 /mcp、/.well-known/agent-card.json、/a2a/direct——
// 其余 /api/* 写操作要 X-Admin-Token（本机 REST 面维持内网信任模型不变；此中间件只拦远程写）。
// 主人裁定 A（2026-10-23）：自产台数据/文件面对远程浏览器开放——应用层写，与发布面同口径；
// 控制面（/api/mcp/*、/api/sops/*/bindings 等）照旧收口。没有这条，远程节点浏览器提交表单会 403。
// 生命周期审批：业务审批人从各自浏览器调用，身份靠 Odoo 会话（lifecycle.ts 现查）+ 同源 JSON 门，不靠 X-Admin-Token
const REMOTE_ALLOW_EXACT = new Set(['/mcp', '/.well-known/agent-card.json', '/a2a/direct', '/api/lifecycle/approve']);
// ---------- 端点命中计数（总工程师 B 类单：采纳监测 instrumentation）----------
// 必须挂在所有业务路由之前（Express 按注册序匹配，路由先响应则后续 use 不再执行）
app.use(endpointStatsMiddleware());

// #T1（评审裁定 direct-7d8eaa75，与裁定 A 同语义）：SOP Runner 业务写面——建单/存步/完成/附件
// 对远程浏览器开放（.157 业务同事裸开 Runner 页提交 403 即本缺口）；精确到业务子路径：
// assign（派单指派）是控制面不豁免；/api/sops/* 控制面照旧收口（smoke 判据④⑤护栏钉死）。
const REMOTE_ALLOW_PREFIX = [
  /^\/api\/apps\/[a-z0-9-]{1,64}\/(data|files)(\/|$)/,
  /^\/api\/sop\/runs(\/\d+(\/(finish|files))?)?$/,
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
let lastAllowDiff = computeAllowDiff();
if (lastAllowDiff.added.length > 0 || lastAllowDiff.removed.length > 0) {
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
// #292 M1：写请求总门。
//   本机 CLI（回环直连、不带浏览器标记、没有反代转发头）照旧免口令——属主口径；
//   浏览器发来的管理写（带 Origin / Sec-Fetch-*）一律要控制面 + 控制面 Origin + 口令（adminGuard），
//   **从 127.0.0.1:9800 页面发的也拒**；同机反代转进来的（带 X-Forwarded-For 等）按远程处理。
//   业务写白名单（REMOTE_ALLOW_*）不变，照旧在业务面免口令。
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next(); // 读面不拦（掩码已有）
  // 与路由同口径分类：req.path 是 Express 路由用的 pathname（绝对形式 POST http://x/api/… 的原始 req.url 不以 /api/ 开头，曾绕过本门：#299）；
  // 再统一转小写：路由默认不区分大小写，/API/workbenches 也会命中 /api/workbenches（评审席 #294 复验；main 热修 #295）
  const p = req.path.toLowerCase();
  if (REMOTE_ALLOW_EXACT.has(p)) return next();
  if (REMOTE_ALLOW_PREFIX.some((re) => re.test(p))) return next(); // 自产台数据/文件面（主人裁定 A）
  if (!browserMarked(req) && rawLoopback(req)) return next(); // 本机 CLI
  if (p === '/api/admin-token') return next(); // 设/清口令由路由自己判（首次设置时还没有口令可验）
  if (p.startsWith('/api/')) {
    // 其余 /api/* 写：走 adminGuard（函数声明有提升，请求期已定义）
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

app.get('/api/workbenches', (req, res) => {
  const { q, category, type, status } = req.query;
  let list = listWorkbenches();
  if (q) { const s = String(q).toLowerCase(); list = list.filter((w) => w.name.toLowerCase().includes(s) || w.url.toLowerCase().includes(s) || (w.description || '').toLowerCase().includes(s)); }
  if (category) list = list.filter((w) => w.category === category);
  if (type) list = list.filter((w) => w.type === type);
  if (status) list = list.filter((w) => w.last_status === status);
  // 列表出队即掩码（q 过滤仍用原值——搜索语义不变，明文不落响应）
  res.json(list.map(maskForApi));
});

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

app.post('/api/workbenches', (req, res) => {
  const ctx: WriteCtx = { subject: restSubject(req) };
  const w = workbenchCreateCore(req.body, ctx);
  if (ctx.auditOk === false) res.setHeader('X-WM-Audit-State', 'degraded');
  res.status(201).json(w);
});

app.get('/api/workbenches/:id', (req, res) => {
  const row = svc<WorkbenchService>('workbench').byId(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
  if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
  // 与列表同策略掩码（issue #2/#3：auth.value 同为无认证出口的明文凭据向量）；
  // 编辑流由 PUT 掩码回传保护兜底（掩码回传=不变更，DB 原值不毁）
  res.json(maskForApi(rowToWorkbench(row)));
});

app.put('/api/workbenches/:id', (req, res) => {
  const ctx: WriteCtx = { subject: restSubject(req) };
  const w = workbenchUpdateCore(Number(req.params.id), req.body, ctx);
  if (ctx.auditOk === false) res.setHeader('X-WM-Audit-State', 'degraded');
  res.json(w);
});

app.delete('/api/workbenches/:id', (req, res) => {
  res.json(workbenchDeleteCore(Number(req.params.id)));
});

// ---------- 健康检查 ----------
function typeOf(key: string): TypeRow | undefined {
  return svc<WorkbenchService>('workbench').typeByKey(key) as unknown as TypeRow | undefined;
}

async function checkOne(w: WorkbenchRow): Promise<ReturnType<typeof rowToWorkbench>> {
  // 自产台（url 以 / 开头）由本服务静态托管：服务活着即在线，探测短路
  if (w.url.startsWith('/')) {
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

app.post('/api/workbenches/:id/check', wrap(async (req, res) => {
  const row = svc<WorkbenchService>('workbench').byId(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
  if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
  res.json(await checkOne(row));
}));

app.post('/api/check-all', wrap(async (_req, res) => {
  const settings = getSettings();
  const limit = Math.max(1, Number(settings.health_concurrency) || 8);
  const rows = svc<WorkbenchService>('workbench').enabled() as unknown as WorkbenchRow[];
  const results: ReturnType<typeof rowToWorkbench>[] = [];
  // 台驱逐冷却两入口一致（patrol/check-all 共享）：down 台窗内跳过，每窗一探
  const queue = [...rows].filter((w) => {
    if (!downSince.has(w.id)) return true;
    if (Date.now() - (lastProbeAt.get(w.id) ?? 0) >= EVICT_COOLDOWN_MS) { lastProbeAt.set(w.id, Date.now()); return true; }
    return false;
  });
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let w = queue.shift(); w; w = queue.shift()) results.push(await checkOne(w));
  });
  await Promise.all(workers);
  for (const r of results) {
    if (r.last_status === 'down') { if (!downSince.has(r.id)) { downSince.set(r.id, Date.now()); lastProbeAt.set(r.id, Date.now()); } }
    else { downSince.delete(r.id); lastProbeAt.delete(r.id); }
  }
  res.json({ checked: results.length, up: results.filter((r) => r.last_status === 'up').length, down: results.filter((r) => r.last_status === 'down').length });
}));

// ---------- 驾驶舱 CRUD（任务驾驶舱：多工作台分屏组合视图） ----------
function getCockpit(id: number): CockpitRow {
  const row = svc<CockpitService>('cockpit').byId(id) as unknown as CockpitRow | undefined;
  if (!row) throw new HttpError(404, `cockpit not found: ${id}`);
  return row;
}

function validatePanels(raw: unknown): PanelConfig[] {
  if (!Array.isArray(raw)) bad('layout_config 必须是面板数组');
  const seen = new Set<number>();
  return raw.map((p: any) => {
    // 统一待办卡（omni-inbox）：kind='tasks'，workbenchId=0 占位，不引用工作台
    if (p?.kind === 'tasks' && String(p?.i ?? '') === 'tasks') {
      const tw = Math.min(12, Math.max(3, Number(p?.w) || 6));
      const th = Math.min(40, Math.max(6, Number(p?.h) || 12));
      return { i: 'tasks', workbenchId: 0, kind: 'tasks' as const, x: Math.min(12 - tw, Math.max(0, Number(p?.x) || 0)), y: Math.max(0, Number(p?.y) || 0), w: tw, h: th };
    }
    const workbenchId = Number(p?.workbenchId ?? Number(String(p?.i ?? '').replace('wb-', '')));
    if (!Number.isInteger(workbenchId) || workbenchId < 1) bad(`面板 workbenchId 非法: ${JSON.stringify(p)}`);
    if (seen.has(workbenchId)) bad(`面板重复引用工作台 ${workbenchId}`);
    seen.add(workbenchId);
    if (!svc<WorkbenchService>('workbench').idById(workbenchId)) bad(`面板引用的工作台不存在: ${workbenchId}`);
    const w = Math.min(12, Math.max(1, Number(p?.w) || 6));
    const h = Math.min(40, Math.max(4, Number(p?.h) || 10));
    return {
      i: `wb-${workbenchId}`,
      workbenchId,
      x: Math.min(12 - w, Math.max(0, Number(p?.x) || 0)),
      y: Math.max(0, Number(p?.y) || 0),
      w, h,
    };
  });
}

app.get('/api/cockpits', (_req, res) => {
  const rows = svc<CockpitService>('cockpit').list() as unknown as CockpitRow[];
  res.json(rows.map(rowToCockpit));
});

app.post('/api/cockpits', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) bad('name 不能为空');
  const description = String(req.body?.description ?? '');
  const panels = validatePanels(req.body?.panels ?? []);
  const r = svc<CockpitService>('cockpit').create(name, description, JSON.stringify(panels)) as unknown as { lastInsertRowid: number | bigint };
  res.status(201).json(rowToCockpit(getCockpit(Number(r.lastInsertRowid))));
});

app.get('/api/cockpits/:id', (req, res) => {
  res.json(rowToCockpit(getCockpit(Number(req.params.id))));
});

app.put('/api/cockpits/:id', (req, res) => {
  const cur = getCockpit(Number(req.params.id));
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : cur.name;
  if (!name) bad('name 不能为空');
  const description = req.body?.description !== undefined ? String(req.body.description) : cur.description;
  const panels = req.body?.panels !== undefined ? validatePanels(req.body.panels) : JSON.parse(cur.layout_config || '[]');
  svc<CockpitService>('cockpit').update(cur.id, name, description, JSON.stringify(panels));
  res.json(rowToCockpit(getCockpit(cur.id)));
});

app.delete('/api/cockpits/:id', (req, res) => {
  const cur = getCockpit(Number(req.params.id));
  svc<CockpitService>('cockpit').delete(cur.id);
  res.json({ ok: true });
});

// ---------- 自产台（台生成器：AI 发布 API + 全版本快照，发布即入册） ----------
const appsRoot = join(dataDir, 'apps');
initializeTaskCenter(appsRoot);
// #198（监督席裁 A·P11 回归修复）：自产台按台令牌——CSP sandbox 下页面源为 null，
// 交付空间模式（页面调本台 data/files）靠「Origin: null + X-App-Token 匹配 slug」放行 CORS。
const APP_TOKEN_KEY_FILE = join(dataDir, '.wm-app-token.key');
let _appTokenKey = '';
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
/** 台令牌（HMAC-SHA256(slug, key)·不可跨台复用） */
function wmAppToken(slug: string): string {
  return createHmac('sha256', appTokenKey()).update(String(slug)).digest('hex');
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_APP_FILES = 64;
const MAX_APP_TOTAL_BYTES = 2 * 1024 * 1024;

function getApp(slug: string): AppRow {
  const row = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
  if (!row) throw new HttpError(404, `app not found: ${slug}`);
  return row;
}

function appDetail(a: AppRow) {
  const versions = svc<AppService>('app').versions(a.id) as unknown as AppVersionRow[];
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

app.get('/api/apps', (_req, res) => {
  // /api/apps = 全部台（app+sop）；/api/sops 才是 kind='sop' 过滤——S2 批量替换期间两口径装反过一次
  const rows = svc<AppService>('app').all() as unknown as AppRow[];
  res.json(rows.map(appDetail));
});

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

/** 发布/重发逻辑（REST 与 MCP 工具共用）：返回响应体与状态码 */
function publishAppBody(b: any): { status: number; body: object } {
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) bad('slug 必须是小写字母/数字/连字符（≤64 字符，字母或数字开头）');
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
  // #94 P1 影子双写：发布同时写 Commit（读路径不变·失败不阻·commit_id 留空可后补迁移）
  void layerfsPublish(layerfsProjectName(slug), files, String(changelog ?? `[publish] v${version}`)).then((out) => {
    if (out) {
      try {
        db.prepare("UPDATE app_versions SET commit_id = ? WHERE app_id = (SELECT id FROM apps WHERE slug = ?) AND version = ?").run(out.commit_id, slug, version);
        db.prepare("UPDATE apps SET layerfs_project = ? WHERE slug = ?").run(layerfsProjectName(slug), slug);
      } catch { /* 影子失败不阻 */ }
    }
  }); // 异步影子——响应不等（fire-and-forget·不阻发布路径）
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

app.post('/api/apps', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (String(b.slug ?? '').trim().toLowerCase() === 'task-center') {
    if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
    if (!adminGuard(req,res)) return;
  }
  // #165 回归修（E2E 红）：锁身份=客户端会话（X-Market-Client/admin 摘要），**不用 created_by**（元数据·同操作者带/不带误判两会话→合法发布 409）
  const who = String(req.headers['x-market-client'] ?? '').trim() || (adminTokenCheck(req.headers['x-admin-token']) ? 'admin-session' : 'loopback-anon');
  const gate = publishLockGuard(String(b.slug ?? '').trim().toLowerCase(), who, b.force === true || b.force === 'true');
  if (!gate.ok) return res.status(409).json({ error: gate.hint });
  const r = publishAppBody(b);
  res.status(r.status).json(r.body);
});

// #94 P1 迁移端点：现有版本依次导成该台项目的 Commit（三门禁复验·异常留档·幂等·sha256 对账）
app.post('/api/apps/:slug/migrate-layerfs', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const a = getApp(req.params.slug);
  const vs = svc<AppService>('app').versions(a.id) as any[];
  const results: any[] = [];
  let prevBytes = 0;
  for (const v of vs.sort((x: any, y: any) => x.version - y.version)) {
    const dir = join(appsRoot, a.slug, `v${v.version}`);
    if (!existsSync(dir)) { results.push({ version: v.version, result: 'anomaly', reason: '物化目录缺失' }); continue; }
    // 读物化文件
    const files: { path: string; content: string }[] = [];
    (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp, 'utf8') }); } })(dir);
    // 三门禁复验（评审席复查裁定）
    if (files.some((f) => f.content === '')) { results.push({ version: v.version, result: 'anomaly', reason: '空 content（门禁复验拒迁·留档）' }); prevBytes = v.total_bytes; continue; }
    if (prevBytes > 0 && v.total_bytes < prevBytes * 0.5) { results.push({ version: v.version, result: 'anomaly', reason: `体积骤降（${prevBytes}→${v.total_bytes}·>50%·门禁拒迁）` }); prevBytes = v.total_bytes; continue; }
    const html = files.filter((f) => /\.html?$/.test(f.path));
    for (const h of html) {
      const open = (h.content.match(/<div/g) ?? []).length; const close = (h.content.match(/<\/div>/g) ?? []).length;
      if (open !== close) { results.push({ version: v.version, result: 'anomaly', reason: `div 配对失败（${open}开/${close}闭）` }); break; }
    }
    if (results.at(-1)?.version === v.version && results.at(-1)?.result === 'anomaly') { prevBytes = v.total_bytes; continue; }
    // 幂等：已有 commit_id 跳过
    if (v.commit_id) { results.push({ version: v.version, result: 'skip', commit_id: v.commit_id }); prevBytes = v.total_bytes; continue; }
    const out = await layerfsPublish(layerfsProjectName(a.slug), files, `[migrate] v${v.version}`);
    if (!out) { results.push({ version: v.version, result: 'error', reason: 'layerfs 服务不可达（影子失败语义·可重跑）' }); prevBytes = v.total_bytes; continue; }
    db.prepare('UPDATE app_versions SET commit_id = ? WHERE id = ?').run(out.commit_id, v.id);
    db.prepare("UPDATE apps SET layerfs_project = ? WHERE slug = ?").run(a.slug, a.slug);
    // sha256 对账（物化 vs 服务 commit——经服务回读）
    const { base, token } = layerfsServiceBase();
    let shaMatch = false;
    try {
      const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(a.slug)) + '/branches/release/commits/' + encodeURIComponent(out.commit_id) + '/files', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const fj = await fr.json() as { files: { path: string; content: string }[] };
      const { createHash: ch } = await import('node:crypto');
      const h1 = ch('sha256').update(JSON.stringify(files.map((f) => [f.path, ch('sha256').update(f.content, 'utf8').digest('hex')]))).digest('hex');
      const h2 = ch('sha256').update(JSON.stringify(fj.files.map((f) => [f.path, ch('sha256').update(f.content, 'utf8').digest('hex')]))).digest('hex');
      shaMatch = h1 === h2;
    } catch { shaMatch = false; }
    results.push({ version: v.version, result: 'migrated', commit_id: out.commit_id, changed: out.changed, sha256_match: shaMatch });
    prevBytes = v.total_bytes;
  }
  res.json({ slug: a.slug, layerfs_project: a.slug, results });
}));

app.get('/api/apps/:slug', (req, res) => {
  res.json(appDetail(getApp(req.params.slug)));
});

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
/** #94 v3 S1：技能回滚执行体（以旧版内容产新版·与批准执行体同源） */
async function executeSkillRollback(slug: string, targetVersion: number, reviewedBy: string): Promise<Record<string, unknown>> {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(slug);
  if (!row) throw new HttpError(404, `skill not found: ${slug}`);
  const vs = S.versionsBySkill(row.id) as any[];
  const src = vs.find((v) => v.version === targetVersion);
  if (!src) throw new HttpError(404, `version not found: ${targetVersion}`);
  const nextVer = (S.versionsMax(row.id)?.v ?? 0) + 1;
  const { readdirSync, readFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const files: { path: string; content: string }[] = [];
  (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = j(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp, 'utf8') }); } })(resolveSnap(src.snapshot_path));
  const dg = SkillService.filesDigest(files);
  const snapDir = j(dataDir, skillSnapRel(slug, nextVer));
  mkdirSync(snapDir, { recursive: true });
  for (const f of files) { const abs = j(snapDir, f.path); mkdirSync(j(abs, '..'), { recursive: true }); writeFileSync(abs, f.content, 'utf8'); }
  S.versionInsert({ skillId: row.id, version: nextVer, changelog: `[rollback] 回滚自 v${targetVersion}`, treeDigest: dg.digest, fileCount: dg.fileCount, totalBytes: dg.totalBytes, snapshotPath: skillSnapRel(slug, nextVer), reviewedBy }); // S4/#183
  return { ok: true, slug, new_version: nextVer, rolled_back_from: targetVersion, reviewed_by: reviewedBy };
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
app.get('/api/change-requests', (req, res) => {
  if (!adminGuard(req, res)) return;
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const rows = status
    ? db.prepare('SELECT * FROM change_requests WHERE status = ? ORDER BY id DESC LIMIT 100').all(status)
    : db.prepare('SELECT * FROM change_requests ORDER BY id DESC LIMIT 100').all();
  res.json(rows.map((r: any) => ({ ...r, payload: JSON.parse(r.payload || '{}') })));
});
app.post('/api/change-requests/:id/approve', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return; // K11：口令无效→401（adminGuard 已回）
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  if (!reviewedBy) bad('批准必填 reviewed_by（K11——人审语义）'); // K11
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM change_requests WHERE id = ?').get(id) as any;
  if (!r) throw new HttpError(404, `change_request not found: ${id}`);
  if (r.status !== 'pending') bad(`请求已处理（status=${r.status}）——不可重复批准`); // 幂等
  // 执行体（v3 契约形状：kind×op 四象限·与一步式 REST 同构）
  if (r.kind === 'app' && r.op === 'rollback') {
    await activateAppVersion(r.slug, r.target_version);
  } else if (r.kind === 'app' && r.op === 'delete') {
    deleteAppCascade(r.slug);
  } else if (r.kind === 'skill' && r.op === 'rollback') {
    await executeSkillRollback(r.slug, Number(r.target_version), reviewedBy);
  } else if (r.kind === 'skill' && r.op === 'delete') {
    executeSkillDelete(r.slug);
  } else { bad(`未知 kind×op: ${r.kind}/${r.op}`); }
  db.prepare("UPDATE change_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(reviewedBy, id);
  res.json({ ok: true, id, status: 'approved', executed: `${r.kind}/${r.op}`, reviewed_by: reviewedBy });
}));
app.post('/api/change-requests/:id/reject', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  if (!reviewedBy) bad('拒绝必填 reviewed_by（K11）');
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM change_requests WHERE id = ?').get(id) as any;
  if (!r) throw new HttpError(404, `change_request not found: ${id}`);
  if (r.status !== 'pending') bad(`请求已处理（status=${r.status}）`);
  db.prepare("UPDATE change_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(reviewedBy, id);
  res.json({ ok: true, id, status: 'rejected', reviewed_by: reviewedBy });
}));

app.post('/api/apps/:slug/activate', wrap(async (req, res) => {
  if (req.params.slug === 'task-center') {
    if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
    if (!adminGuard(req,res)) return;
  }
  // #94 v3 S1（L14）：回滚经人审——一步式=口令+reviewed_by（缺 reviewed_by 不执行）
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  if (!reviewedBy) bad('回滚需 reviewed_by（人审门——一步式直调必填；或经 MCP change_request_create 提请求）');
  const out = await activateAppVersion(req.params.slug, req.body?.version);
  res.json({ ...out, reviewed_by: reviewedBy });
}));

app.delete('/api/apps/:slug', (req, res) => {
  if (req.params.slug === 'task-center') {
    if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
    if (!adminGuard(req,res)) return;
  }
  // #94 v3 S1（L14）：删除经人审——一步式=口令+reviewed_by
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  if (!reviewedBy) bad('删除需 reviewed_by（人审门——一步式直调必填；或经 MCP change_request_create 提请求）');
  deleteAppCascade(req.params.slug);
  res.json({ ok: true, deleted: req.params.slug, reviewed_by: reviewedBy });
});

/** #94 v3 S1：台删除级联体（一步式 REST 与人审批准共用一个执行体——单一事实源） */
/** #94 P1 影子双写：经 layerfs 服务发布 Commit（契约 v0 §2.1·Bearer）——失败不阻（warn·commit_id 留空） */
/** #94 ②（R9）：LayerFS 项目名——[a-z0-9_.-]{1,63}·超限 slug 折叠 wm-<前52>-<sha8> */
function layerfsProjectName(slug: string): string {
  if (/^[a-z0-9][a-z0-9._-]{0,62}$/.test(slug)) return slug;
  const h = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return ('wm-' + slug.slice(0, 52).replace(/[^a-z0-9._-]/g, '-') + '-' + h).slice(0, 63);
}

function layerfsServiceBase(): { base: string; token: string } {
  const s = getSettings() as Record<string, unknown>;
  const base = String(s['layerfs_service_url'] ?? process.env.LAYERFS_SERVICE_URL ?? '').trim();
  const token = String(s['layerfs_service_token'] ?? process.env.LAYERFS_SERVICE_TOKEN ?? '').trim();
  return { base, token };
}
async function layerfsPublish(project: string, files: { path: string; content: string }[], message: string, branch = 'release'): Promise<{ commit_id: string; changed: boolean } | null> {
  const { base, token } = layerfsServiceBase();
  if (!base) return null; // 未配置=不启用（契约 §1）
  try {
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

function deleteAppCascade(slug: string): void {
  const a = getApp(slug);
  rmSync(join(appsRoot, slug), { recursive: true, force: true });
  svc<AppService>('app').versionsDelete(a.id);
  svc<AppService>('app').delete(a.id);
  // 数据面/文件面一并清理（派单 direct-22838fab 与文件提交面）
  svc<AppDataService>('appData').dataDelete(slug);
  const files = svc<AppDataService>('appData').filePaths(slug) as { storage_path: string }[];
  for (const f of files) { try { rmSync(join(dataDir, f.storage_path), { force: true }); } catch { /* 已删 */ } }
  svc<AppDataService>('appData').filesDelete(slug);
  // issue #6：SOP 台的注册 url 是 /sop/<slug>/（非 /apps/），删除时必须一并清理，否则留孤儿工作台（门户 404）
  // #94 S4（§4.5 五步②③）：服务 project.remove+volume.remove（契约 §2.4——服务删项目·Store 卷·备份）
  // 任一步失败即停·记录残留·不重试（§4.5 铁则）
  void (async () => {
    try {
      const { base, token } = layerfsServiceBase();
      if (!base) return; // 服务未配=跳过（市场面已清·残留记）
      const r = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(slug)), { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
      if (!r.ok) console.warn(`[S4-residue] 服务删除失败 HTTP ${r.status}（项目 ${slug} 残留·不重试·月度重建兜底）`);
    } catch (e) { console.warn(`[S4-residue] 服务删除异常: ${String((e as Error).message).slice(0, 80)}（不重试）`); }
  })();
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
app.post('/api/apps/:slug/data', (req, res) => {
  const a = getApp(req.params.slug);
  const b = req.body ?? {};
  const data = b.data ?? b; // 兼容 {data: {...}} 或直接 {...} 两种形态
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, 'utf8') > 1024 * 1024) bad('data 超 1MB 上限');
  const created_by = typeof b.created_by === 'string' ? b.created_by.trim().slice(0, 128) : '';
  const r = svc<AppDataService>('appData').dataInsertStmt()
    .run(a.slug, json, created_by) as unknown as { lastInsertRowid: number | bigint };
  const itemId = Number(r.lastInsertRowid);
  const createdAt = new Date().toISOString();
  res.status(201).json({ ok: true, id: itemId, slug: a.slug, created_at: createdAt });
  // 属主裁 C（2026-10-26）：提交即推送——绑定 agent 异步收通知（尽力而为不阻塞 201；
  // 失败仅日志，下次提交再推——数据真源始终在 app_data，拉模式兜底）。
  // 联合评审① C：统一绑定表——notify 方向行（授 admits 不触发推送·方向独立性铁律）
  const targets = db.prepare("SELECT agent_node, notify_url FROM bindings WHERE target_type = 'app' AND target_slug = ? AND direction IN ('notify','both') AND revoked_at = ''").all(a.slug) as { agent_node: string; notify_url: string }[];
  for (const t of targets) {
    if (t.notify_url === '') continue;
    a2aSendOutbound(a2aKeyPath(), { baseUrl: t.notify_url, team: t.agent_node }, JSON.stringify({
      type: 'app-data-submitted', slug: a.slug, id: itemId, data, created_at: createdAt,
      hint: '经 MCP app_data_list（slug + before_id 增量）读取；本通知尽力而为，真源在 app_data',
    }), undefined, `market/${sopNode8(a.slug)}`).catch(err => console.error(`[app-notify] push failed ${a.slug}→${t.node}: ${String(err).slice(0, 120)}`));
  }
});

app.get('/api/apps/:slug/data', (req, res) => {
  const a = getApp(req.params.slug);
  const limit = pageLimit(req.query.limit);
  const beforeId = pageBeforeId(req.query.before_id);
  const rows = beforeId > 0
    ? svc<AppDataService>('appData').dataPage(a.slug, beforeId, limit)
    : svc<AppDataService>('appData').dataPage(a.slug, 0, limit);
  const items = (rows as { id: number; data: string; created_by: string; created_at: string }[]).map((r) => ({
    id: r.id, data: JSON.parse(r.data || '{}'), created_by: r.created_by, created_at: r.created_at,
  }));
  const has_more = rows.length === limit;
  res.json({ slug: a.slug, items, count: items.length, has_more, next_before_id: has_more ? items[items.length - 1].id : null });
});

// ---------- 自产台文件提交面（所有资源类型文件，50MB 上限） ----------
// multipart/form-data：字段 file（单文件）+ 可选 note/created_by。
// 落盘 DATA_DIR/uploads/<slug>/<YYYYMM>/<id>-<safeName>；元数据入 app_files；GET 列表 + 下载。
const UPLOAD_MAX = 50 * 1024 * 1024;
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
const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      const now = new Date();
      const sub = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dir = join(uploadRoot, sub);
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      // 保留原扩展名、抹掉路径与控制字符
      const ext = extname(fixFileName(file.originalname)).slice(0, 16).replace(/[^.\w-]/g, '');
      cb(null, `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: UPLOAD_MAX, files: 1 },
});


app.post('/api/apps/:slug/files', (req, res, next) => {
  try { getApp(req.params.slug); } catch (e) { return next(e); }
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超 50MB 上限' });
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    try {
      const a = getApp(req.params.slug);
      if (!req.file) bad('缺少 file 字段（multipart/form-data）');
      const created_by = typeof req.body?.created_by === 'string' ? req.body.created_by.trim().slice(0, 128) : '';
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
      // 存储相对路径（dataDir 内，随数据目录迁移）
      const rel = req.file.path.replace(dataDir, '').replace(/\\/g, '/').replace(/^\/+/, '');
      const originalName = fixFileName(req.file.originalname);
      const r = svc<AppDataService>('appData').fileInsert(a.slug, originalName, req.file.mimetype || 'application/octet-stream', req.file.size, rel, created_by, note) as unknown as { lastInsertRowid: number | bigint }; // #132 P0①：note 落库
      const id = Number(r.lastInsertRowid);
      res.status(201).json({ ok: true, id, slug: a.slug, name: originalName, mime: req.file.mimetype, size: req.file.size, note, url: `/api/apps/${a.slug}/files/${id}` });
    } catch (e) {
      next(e);
    }
  });
});

app.get('/api/apps/:slug/files', (req, res) => {
  const a = getApp(req.params.slug);
  const limit = pageLimit(req.query.limit);
  const beforeId = pageBeforeId(req.query.before_id);
  const rows = beforeId > 0
    ? svc<AppDataService>('appData').filePage(a.slug, beforeId, limit)
    : svc<AppDataService>('appData').filePage(a.slug, 0, limit);
  const items = (rows as any[]).map((r) => ({ ...r, url: `/api/apps/${a.slug}/files/${r.id}` }));
  res.json({ slug: a.slug, items, count: items.length, has_more: rows.length === limit, next_before_id: rows.length === limit ? items[items.length - 1].id : null });
});

// #132 P0①：note 更新面（PATCH）
app.patch('/api/apps/:slug/files/:id', (req, res) => {
  if (!adminGuard(req, res)) return; // #193 F3：写面人审（读开放·写删人审）
  if (!adminGuard(req, res)) return; // #193 F3：写面人审（读开放·写删人审）
  const a = getApp(req.params.slug);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;
  if (note === undefined) bad('note 必填（字符串）');
  const hit = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
  if (!hit) throw new HttpError(404, `file not found: ${req.params.id}`);
  svc<AppDataService>('appData').fileUpdateNote(Number(req.params.id), a.slug, note);
  res.json({ ok: true, id: Number(req.params.id), note });
});

// #132 P0③：软删面（deleted_at 置位·原行保审计·列表过滤）
app.delete('/api/apps/:slug/files/:id', (req, res) => {
  if (!adminGuard(req, res)) return; // #193 F3
  if (!adminGuard(req, res)) return; // #193 F3
  const a = getApp(req.params.slug);
  const hit = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
  if (!hit) throw new HttpError(404, `file not found: ${req.params.id}`);
  const _fd = svc<AppDataService>('appData').fileSoftDelete(Number(req.params.id), a.slug) as { changes?: number };
  if (Number(_fd?.changes ?? 0) === 0) throw new HttpError(404, `file not found: ${req.params.id}`); // #193 F5：幂等假绿修（不存在→404）
  res.json({ ok: true, id: Number(req.params.id), deleted: 'soft' });
});
app.delete('/api/apps/:slug/data/:id', (req, res) => {
  if (!adminGuard(req, res)) return; // #193 F3
  if (!adminGuard(req, res)) return; // #193 F3
  const a = getApp(req.params.slug);
  const _dd = svc<AppDataService>('appData').dataSoftDelete(Number(req.params.id), a.slug) as { changes?: number };
  if (Number(_dd?.changes ?? 0) === 0) throw new HttpError(404, `data not found: ${req.params.id}`); // #193 F5
  res.json({ ok: true, id: Number(req.params.id), deleted: 'soft' });
});

app.get('/api/apps/:slug/files/:id', (req, res) => {
  const a = getApp(req.params.slug);
  const row = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
  if (!row) throw new HttpError(404, `file not found: ${req.params.id}`);
  const abs = join(dataDir, row.storage_path);
  if (!existsSync(abs)) throw new HttpError(404, 'stored file missing on disk');
  res.setHeader('content-type', row.mime || 'application/octet-stream');
  res.setHeader('content-length', String(row.size));
  // 附件下载语义（原始文件名）——inline 由 mime 决定，避免 XSS：非白名单 mime 强制 attachment
  const inlineOk = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/(plain|csv|markdown))$/.test(row.mime); // hotfix：effMime 未定义（#134 stash 舞连带残留）
  // #215 族修（属主实测「点下载变新标签页访问二进制」）：存储 mime 存错（xlsx 存 text/plain）时 inline 白名单误放——按扩展名强制 attachment
  // 仅二进制容器/归档扩展名强制 attachment（xlsx 存伪 mime 的 #215 防 XSS 线）；png/jpeg/webp/gif/pdf/csv 是 README 契约白名单 inline 面，不在此列
  const BIN_EXT = /\.(xlsx|xls|docx|doc|zip|rar|7z|gz|tar|7z|bz2|xz)$/i.test(row.original_name || '');
  const disp = (inlineOk && !BIN_EXT) ? 'inline' : 'attachment';
  res.setHeader('content-disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(row.original_name || 'file')}`);
  res.setHeader('x-content-type-options', 'nosniff');
  createReadStream(abs).pipe(res);
});

// ---------- SOP 台：状态机（draft → published → deprecated）+ 执行 Runner + 分层持久化 ----------
app.get('/api/sops', (_req, res) => {
  const rows = svc<AppService>('app').sops() as unknown as AppRow[];
  res.json(rows.map(appDetail));
});

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

app.post('/api/sops/:slug/publish', (req, res) => {
  if (req.params.slug === 'task-center') {
    if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
    if (!adminGuard(req,res)) return;
  }
  const a = sopTransition(req.params.slug, ['draft', 'deprecated'], 'published', '发布');
  // publish 附带发布说明（可选）记入当前版本 changelog 末尾
  if (typeof req.body?.note === 'string' && req.body.note.trim()) {
    svc<AppService>('app').appendChangelog(a.id, a.active_version, `\n[publish] ${req.body.note.trim()}`);
  }
  res.json(appDetail(getApp(a.slug)));
});

app.post('/api/sops/:slug/deprecate', (req, res) => {
  if (req.params.slug === 'task-center') {
    if (!sameOriginGuard(req,res)) return res.status(403).json({error:'跨源拒绝'});
    if (!adminGuard(req,res)) return;
  }
  const a = sopTransition(req.params.slug, ['published'], 'deprecated', '废弃');
  // 废弃不入册删除：历史 run 仍可回放；市场行禁用（enabled=0）
  svc<WorkbenchService>('workbench').setEnabledByUrl(0, `/sop/${a.slug}/`);
  res.json(appDetail(getApp(a.slug)));
});

// ---------- SOP Runner：GET /sop/:slug/ → 内置执行页（读活跃版本 sop.yaml 服务端渲染）----------


// /sop/:slug/ 根 → Runner；/sop/:slug/<path> → 版本目录静态文件（附件）
app.get(/^\/sop\/[a-z0-9][a-z0-9-]*(\/.*)?$/, (req, res) => {
  const m = /^\/sop\/([a-z0-9][a-z0-9-]*)\/?(.*)$/.exec(req.path ?? '');
  if (!m) return res.status(404).json({ error: 'not found' });
  const rest = m[2] || '';
  const hit = readActiveManifest(m[1]);
  if (!hit) return res.status(404).json({ error: `SOP not found: ${m[1]}` });
  res.setHeader('X-App-Version', `v${hit.app.active_version}`);
  const runParamRaw = typeof req.query?.run === 'string' && /^\d+$/.test(req.query.run) ? Number(req.query.run) : null;
  if (rest === '' || rest === '/' || rest === 'index.html') {
    // issue #11：非 published 不再渲染下发完整 Runner 页面（信息泄漏面）——403 瘦身为一行
    if (hit.app.status !== 'published') {
      return res.status(403).type('text').send(`SOP ${m[1]} 状态为 ${hit.app.status}，未上架不可执行\n`);
    }
    // #263 页面整链：?run=<id> 精确定位既有执行记录（不新开 run）；归属不匹配时 404，不静默换记录
    if (runParamRaw !== null) {
      const runRow = svc<SopService>('sop').runById(runParamRaw) as unknown as { sop_slug?: string } | undefined;
      if (!runRow || runRow.sop_slug !== m[1]) return res.status(404).json({ error: `run ${runParamRaw} 不属于 SOP ${m[1]}` });
      (globalThis as any).__wmSopPinRun = runParamRaw;
      try { return res.status(200).type('html').send(renderSopRunner(hit.manifest, hit.app)); } finally { delete (globalThis as any).__wmSopPinRun; }
    }
    return res.status(200).type('html').send(renderSopRunner(hit.manifest, hit.app));
  }
  // 附件：从活跃版本目录读（与 serveApp 同款防穿越）
  const root = join(appsRoot, m[1], `v${hit.app.active_version}`);
  let rel = posix.normalize(rest);
  if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });
  const abs = join(root, rel);
  if (!abs.startsWith(root)) return res.status(400).json({ error: '路径非法' });
  if (!existsSync(abs)) return res.status(404).json({ error: `file not found: ${rel}` });
  // #198（裁 A）：自产台入口/子页面注入按台令牌——sandbox 页面凭它调本台 data/files
  if (/\.html?$/i.test(rel)) {
    try {
      const tok = wmAppToken(m[1]);
      const raw = readFileSync(abs, 'utf8');
      const inject = `<meta name="wm-app-token" content="${tok}"><script>window.WM_APP_TOKEN="${tok}";window.WM_APP_SLUG="${m[1]}";</script>`;
      const out = /<head[^>]*>/i.test(raw) ? raw.replace(/<head([^>]*)>/i, (mm) => mm + inject) : inject + raw;
      return res.type('html').send(out);
    } catch { /* 读取失败回落原样 */ }
  }
  return res.sendFile(abs);
});

// ---------- SOP run API：分层治理（Redis 热态 + SQLite 真源）----------
// core 函数为唯一持久化链：REST 与 MCP（sop_run_* 工具）共用——agent 更新持久化执行数据
// 与人在 Runner 页填数据走同一条链（GH #17 P4 的执行数据面提前交付，不经版本发布）。
const runCheckpoints = createRunCheckpoints({
  write(id, data) { svc<SopService>('sop').runCheckpointData(id, data); },
});
function storedRunData(row: SopRunRow): Record<string, unknown> {
  try { const data = JSON.parse(row.data || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; }
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
function sopRunStartCore(slugRaw: string, startedByRaw: string): { id: number; slug: string; version: number; status: string; data: Record<string, unknown>; read_capability: string } {
  const slug = slugRaw.trim().toLowerCase();
  if (!slug) bad('slug 必填');
  const hit = readActiveManifest(slug);
  if (!hit) throw new HttpError(404, `SOP not found: ${slug}`);
  if (hit.app.status !== 'published') throw new HttpError(409, `SOP 状态为 ${hit.app.status}，仅 published 可执行`);
  const started_by = startedByRaw.trim();
  const r = svc<SopService>('sop').runCreate(slug, hit.app.active_version, started_by) as unknown as { lastInsertRowid: number | bigint };
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
    const prior = runCheckpoints.peek(id);
    const hot = prior ? null : await runStateLoad(id);
    const data = prior ?? { ...storedRunData(row), ...(hot?.meta.status === 'running' ? hot.data : {}) };
    data[stepKey] = value ?? null;
    // Repopulate all known fields after a Redis loss; a partial HSET must not erase the durable baseline.
    const hotOk = await runStateRestore(id, { slug: row.sop_slug, version: row.sop_version, status: 'running', started_by: row.started_by, updated_at: Date.now() }, data);
    runCheckpoints.remember(id, data, !hotOk);
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

async function sopRunGetCore(id: number): Promise<{ id: number; sop_slug: string; sop_version: number; status: string; started_by: string; data: Record<string, unknown>; receipt: string }> {
  return runCheckpoints.serial(id, async () => {
    const row = sopRunRow(id);
    let data = storedRunData(row);
    if (row.status === 'running' && row.sop_slug !== 'task-center') {
      const pending = runCheckpoints.peek(id);
      const hot = pending ? null : await runStateLoad(id);
      data = pending ?? { ...data, ...(hot?.meta.status === 'running' ? hot.data : {}) };
      if (redisHealthy() && !hot) await runStateRestore(id, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data);
    }
    return { id: row.id, sop_slug: row.sop_slug, sop_version: row.sop_version, status: row.status, started_by: row.started_by, data, receipt: receiptStatusOf(id) };
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
async function sopRunFinishCore(id: number): Promise<{ ok: boolean; id: number; status: string; steps: number }> {
  return runCheckpoints.serial(id, () => sopRunFinishLockedCore(id));
}
async function sopRunFinishLockedCore(id: number): Promise<{ ok: boolean; id: number; status: string; steps: number }> {
  const row = sopRunRow(id);
  if (row.status !== 'running') throw new HttpError(409, `run ${id} 已 ${row.status}`);
  const pending = runCheckpoints.peek(id);
  const hot = row.sop_slug === 'task-center' || pending ? null : await runStateLoad(id);
  const data = JSON.stringify(pending ?? { ...storedRunData(row), ...(hot?.meta.status === 'running' ? hot.data : {}) });
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
  const r = await fetch(`${targetUrl.replace(/\/+$/, '')}/a2a/direct`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
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
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});
app.post('/api/sop/runs/:id/files', (req, res, next) => {
  // ── P0 安全（总工 direct-c2b55f91）：上传面鉴权三件 ──
  // ①run-scoped upload token（header X-Run-Upload-Token；admin 口令=人工作业一步式）
  // ②配额（数≤20·单≤50MB[multer]·总量≤200MB→413）③写审计（sop_run_file_audit 同链）
  try {
    if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
    const row = sopRunRow(Number(req.params.id));
    if (row.status !== 'running') throw new HttpError(409, `run ${req.params.id} 已 ${row.status}，不可再上传`);
    // #150 开关（属主反馈·业务直传恢复）：settings run_upload_require_token='1' 才要令牌；缺省关闭=旧 T1 直传语义
    const strict = (() => { try { const r = db.prepare("SELECT value FROM settings WHERE key = 'run_upload_require_token'").get() as { value?: string } | undefined; return String(r?.value ?? '') === '1'; } catch { return false; } })();
    const adminOk = adminHeaderOk(req);
    if (strict && !adminOk) { // #150 开关：严格模式才要令牌（缺省=旧 T1 直传）
      const presented = String(req.headers['x-run-upload-token'] ?? '').trim();
      const expected = String((row as any).upload_token ?? '');
      if (!expected) throw new HttpError(403, '该 run 无上传令牌（旧 run 上传面已关闭）');
      if (!presented) throw new HttpError(401, '缺少 X-Run-Upload-Token（Runner 页内嵌令牌·人工作业用 admin 口令）');   // T023 修订签 A1：缺令牌=401（错令牌=403·白名单外=400）
      if (presented !== expected) throw new HttpError(403, '上传令牌不符（run 不匹配或已过期）');
    }
    const existing = (svc<SopService>('sop').runFiles(Number(req.params.id)) as any[]);
    if (existing.length >= 20) throw new HttpError(413, '该 run 文件数已达上限（20）');
    const totalBytes = existing.reduce((n, f) => n + Number(f.size || 0), 0);
    if (totalBytes >= 200 * 1024 * 1024) throw new HttpError(413, '该 run 文件总量已达上限（200MB）');
  } catch (e) { return next(e); }
  runUpload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超 50MB 上限' });
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    try {
      const runId = Number(req.params.id);
      if (!req.file) bad('缺少 file 字段（multipart/form-data）');
      const createdBy = typeof req.body?.created_by === 'string' ? req.body.created_by.trim().slice(0, 128) : '';
      const rel = req.file.path.replace(dataDir, '').split(pathSep).join('/').replace(/^\/+/, '');
      const originalName = fixFileName(req.file.originalname);
      const r = svc<SopService>('sop').runFileInsert({ runId, name: originalName, mime: req.file.mimetype || 'application/octet-stream', size: req.file.size, storagePath: rel, createdBy }) as unknown as { lastInsertRowid: number | bigint };
      try { db.prepare("INSERT INTO sop_run_file_audit (run_id, name, size, sha256, source) VALUES (?, ?, ?, ?, ?)").run(runId, originalName, req.file.size, sha256Hex(readFileSync(req.file.path)), String(req.headers['x-run-upload-token'] ? 'token' : 'admin')); } catch { /* 审计失败不阻 */ }
      res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), run_id: runId, name: originalName, mime: req.file.mimetype, size: req.file.size, url: `/api/sop/runs/${runId}/files/${Number(r.lastInsertRowid)}` });
    } catch (e) { next(e); }
  });
});
app.get('/api/sop/runs/:id/files', wrap(async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
  const runId = Number(req.params.id);
  sopRunRow(runId); // 404 语义与 run 一致
  const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, runId);
  if (!auth.authorized) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'run read authorization required', hint: '创建响应的 read_capability（X-Run-Read-Capability 头）或已授权会话' });
  const items = (svc<SopService>('sop').runFiles(runId) as any[]).map((f) => ({ ...f, url: `/api/sop/runs/${runId}/files/${f.id}` }));
  res.json({ run_id: runId, items, count: items.length });
}));
app.get('/api/sop/runs/:id/files/:fileId', wrap(async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id)) || !/^\d+$/.test(String(req.params.fileId))) throw new HttpError(404, 'file not found');
  const runId = Number(req.params.id);
  const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, runId);
  if (!auth.authorized) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'run read authorization required', hint: '创建响应的 read_capability（X-Run-Read-Capability 头）或已授权会话' });
  const row = svc<SopService>('sop').runFileById(runId, Number(req.params.fileId)) as any;
  if (!row) throw new HttpError(404, `file not found: ${req.params.fileId}`);
  const abs = join(dataDir, row.storage_path);
  if (!existsSync(abs)) throw new HttpError(404, 'stored file missing on disk');
  res.setHeader('content-type', row.mime || 'application/octet-stream');
  res.setHeader('content-length', String(row.size));
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name || 'file')}`);
  res.setHeader('x-content-type-options', 'nosniff');
  createReadStream(abs).pipe(res);
}));

// ---------- Cookie 池（监督席派单 direct-5fbb2176：web 型外部台 cookie 认证） ----------
interface CookieExport { name: string; value: string; domain?: string; path?: string; expirationDate?: number; httpOnly?: boolean; sameSite?: string }
interface CookieRow { id: number; label: string; cookies_json: string; created_at: string }

function cookieExpiryInfo(cookies: CookieExport[]): { total: number; active: number; soonestExpMs: number | null; allExpired: boolean } {
  const now = Date.now();
  let active = 0;
  let soonest: number | null = null;
  for (const c of cookies) {
    if (!c.expirationDate || c.expirationDate * 1000 > now) {
      active++;
      if (c.expirationDate) {
        const ms = c.expirationDate * 1000 - now;
        if (soonest === null || ms < soonest) soonest = ms;
      }
    }
  }
  return { total: cookies.length, active, soonestExpMs: soonest, allExpired: cookies.length > 0 && active === 0 };
}

function maskCookies(cookies: CookieExport[]): CookieExport[] {
  return cookies.map((c) => ({ ...c, value: '****' }));
}

app.post('/api/cookies', (req, res) => {
  const b = req.body ?? {};
  const label = typeof b.label === 'string' ? b.label.trim() : '';
  if (!label) bad('label 必填（如「DSH-3080 生产」）');
  const arr = b.cookies;
  if (!Array.isArray(arr) || arr.length === 0) bad('cookies 必须是非空数组（Cookie-Editor/EditThisCookie 导出格式）');
  // 校验每条 name+value 必填（浏览器扩展标准导出全对象 verbatim 存储）
  const clean: CookieExport[] = [];
  for (const c of arr) {
    if (typeof c?.name !== 'string' || !c.name) bad('每条 cookie 的 name 必填');
    if (typeof c?.value !== 'string') bad(`cookie "${c.name}" 缺 value`);
    clean.push({ name: c.name, value: c.value, domain: String(c.domain ?? ''), path: String(c.path ?? '/'), expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined, httpOnly: !!c.httpOnly, sameSite: String(c.sameSite ?? '') });
  }
  const r = svc<CookieService>('cookie').create(label, JSON.stringify(clean)) as unknown as { lastInsertRowid: number | bigint };
  const info = cookieExpiryInfo(clean);
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), label, cookie_count: clean.length, active: info.active, cookies: maskCookies(clean) });
});

app.get('/api/cookies', (_req, res) => {
  const rows = svc<CookieService>('cookie').all() as unknown as CookieRow[];
  res.json(rows.map((r) => {
    let cookies: CookieExport[] = [];
    try { cookies = JSON.parse(r.cookies_json || '[]'); } catch { cookies = []; }
    const info = cookieExpiryInfo(cookies);
    return {
      id: r.id, label: r.label, cookie_count: info.total, active: info.active,
      all_expired: info.allExpired, soonest_exp_days: info.soonestExpMs !== null ? Math.floor(info.soonestExpMs / 86400000) : null,
      created_at: r.created_at,
      cookies: maskCookies(cookies), // value 全掩码——明文不回任何 API
    };
  }));
});

app.delete('/api/cookies/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = svc<CookieService>('cookie').delete(id);
  if (!r.changes) throw new HttpError(404, `cookie set not found: ${id}`);
  // 挂接了该池的台自动取消引用
  svc<WorkbenchService>('workbench').clearCookieSet(id);
  res.json({ ok: true, deleted: id });
});

// PUT /api/workbenches/:id 已扩展支持 cookie_set_id（在 validateWorkbenchBody 后 merged）

// ---------- 19a 任务发布面（监督席 direct-58d60ed6，主人已批）----------
// 零新概念：给已有 run 写派单来源（复用 a2a_run_ctx），使其入待验收列表（dispatched=1）
app.post('/api/sop/runs/:id/assign', wrap(async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
  const runId = Number(req.params.id);
  const row = sopRunRow(runId);
  if (row.status !== 'running') throw new HttpError(409, `run ${runId} 已 ${row.status}，不可指派`);
  const node = String(req.body?.node ?? '').trim();
  if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9_-]{0,63}$/i.test(node)) bad('node 形态：<zone>/<id8>，如 dsh/1a2b3c4d');
  const existed = svc<SopService>('sop').ctxSourceByRun(runId);
  if (existed) throw new HttpError(409, `run ${runId} 已有派单来源，不可重复指派`);
  svc<SopService>('sop').ctxRegisterFull({ contextId: `task-${runId}`, runId, taskId: `task-${runId}`, caller: node, team: '', receiptStatus: '' });
  res.status(201).json({ ok: true, run_id: runId, node, task_id: `task-${runId}` });
}));

app.post('/api/sop/runs', (req, res) => {
  const out = sopRunStartCore(String(req.body?.slug ?? ''), String(req.body?.started_by ?? ''));
  res.status(201).json(out);
});

app.get('/api/sop/runs/active', wrap(async (_req, res) => {
  // #338: a nonempty Redis set is not proof that it contains every running row.
  // SQLite creates/status-transitions every run, including unsaved and task-center runs.
  const rows = svc<SopService>('sop').runsRunning() as unknown as SopRunRow[];
  res.json(rows);
}));

app.get('/api/stats', (_req, res) => { res.json(statsPayload()); });
app.get('/api/content/observation', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json(portalObserver ? { ...portalObserver.status(), counts: portalObserver.counts() } : { enabled: false, coverageVerified: false });
});

/** #275 过渡登录入口（#221 落地前）：挑一个可信 Odoo 台，走 /go/<id>/ 的 SSO v1 舞步并带 return 落回市场原页面。
 *  先选 origin = LC_ODOO_URL 的台（生命周期只认这个 Odoo 的会话；session_id 按主机名跨端口共享，登别的 Odoo 会把它覆盖掉），
 *  再选与请求同主机名的台；都没有返回 null，不盲选（别的主机名登完市场也拿不到 session_id） */
function odooLoginUrl(req: express.Request, returnPath: string): string | null {
  let host = '';
  try { host = new URL(`http://${String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()}`).hostname.toLowerCase(); } catch { host = ''; }
  const odoo = listWorkbenches().filter((w) => w.enabled && /^https?:\/\//i.test(w.url) && isOdooSessionTarget(w.url));
  let lcOrigin = '';
  try { lcOrigin = new URL(String(process.env.LC_ODOO_URL ?? '')).origin; } catch { lcOrigin = ''; }
  const at = (w: { url: string }) => { try { return new URL(w.url); } catch { return null; } };
  const pick = odoo.find((w) => lcOrigin && at(w)?.origin === lcOrigin) ?? odoo.find((w) => at(w)?.hostname.toLowerCase() === host);
  return pick ? `/go/${pick.id}/?return=${encodeURIComponent(returnPath)}` : null;
}

// ---------- 统一待办（omni-inbox · 总工程师设计 9c5557c1c0）：只读聚合 ----------
app.get('/api/tasks', wrap(async (req, res) => {
  const payload = await collectTasks(svc<SopService>('sop') as never);
  if (!lifecycleConfigured()) return res.json(payload);
  // 生命周期源按查看人（Odoo 会话）现查，不进 30s 共享缓存；响应随 Cookie 变，不许中间缓存
  const lc = await lifecycleSourceFor(String(req.headers.cookie ?? ''));
  res.setHeader('Cache-Control', 'private, no-store');
  const meta = lc.meta.auth_required ? { ...lc.meta, login_url: odooLoginUrl(req, '/tasks') } : lc.meta;
  res.json({ ...payload, tasks: [...payload.tasks, ...lc.tasks], sources: { ...payload.sources, lifecycle: meta } });
}));

// ---------- 生命周期审批（工作台 = lc 断言签发入口 workbench）：Odoo 会话确认登录名 → 为这一条 approve 现签断言 ----------
app.post('/api/lifecycle/approve', wrap(async (req, res) => {
  const r = await lifecycleApprove(req.headers, req.body);
  res.status(r.http).json(r.body);
}));
// 生命周期全景（只读）：登录门同统一待办生命周期源；响应随 Cookie 变，不许中间缓存
app.get('/api/lifecycle/board', wrap(async (req, res) => {
  const r = await lifecycleBoard(String(req.headers.cookie ?? ''), { pd: req.query.pd, as_of: req.query.as_of });
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(r.http).json(r.http === 401 ? { ...r.body, login_url: odooLoginUrl(req, '/lifecycle') } : r.body);
}));
// #275 登录探测：弹窗送 Odoo 登录后，前端轮询这里拿 200 即回原页面（Odoo 19 无法跨源回跳，回程在市场源完成）
app.get('/api/lifecycle/whoami', wrap(async (req, res) => {
  const r = await lifecycleWhoami(String(req.headers.cookie ?? ''));
  res.setHeader('Cache-Control', 'private, no-store');
  // #279：未登录时带登录入口（顶栏 chip 复用 #277 弹窗流；中继页只认白名单 return，这里固定 /lifecycle）
  res.status(r.http).json(r.http === 401 ? { ...r.body, login_url: odooLoginUrl(req, '/lifecycle') } : r.body);
}));
app.get('/api/lifecycle/status', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return; // 配置清单不对远程匿名读开放（评审：只写面有远程门）
  res.json(await lifecycleStatus());
}));

// ---------- 技能市场钉装与审计（P1-b · 方案 §1：市场侧 manifest+校验 API+巡检，不动 DSH catalog）----------
app.post('/api/skills/:slug/install', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  const vs = S.versionsBySkill(row.id) as any[];
  const target = typeof req.body?.version === 'number' ? vs.find((v) => v.version === req.body.version) : vs[0];
  if (!target) throw new HttpError(404, `无版本`);
  S.ledgerInsert({ skillId: row.id, versionId: target.id, expectedDigest: target.tree_digest, installedPath: String(req.body?.installed_path ?? target.snapshot_path), installedBy: String(req.body?.installed_by ?? '') });
  const ledger = S.ledgerActive() as any[];
  const mine = ledger.find((l) => l.skill_id === row.id && l.version_id === target.id && l.status === 'installed');
  // #94 S0⑤（K8）：钉装响应不回绝对路径（相对化——DB 存真值·响应给安装者自己的输入或相对形态）
  res.status(201).json({ ok: true, slug: row.slug, version: target.version, ledger_id: mine?.id, expected_digest: target.tree_digest, installed_path: `skill-snapshots/${encodeURIComponent(row.slug)}/v${target.version}` }); // 恒相对（不回显绝对）
}));

// 装载校验（方案 P1-b 边界：市场侧 API+巡检，不动 DSH catalog）
app.get('/api/skills/:slug/verify', wrap(async (req, res) => {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  const ledger = (S.ledgerActive() as any[]).find((l) => l.skill_id === row.id);
  if (!ledger) return res.json({ ok: null, note: '无钉装记录（未安装）' });
  const [{ readdirSync, readFileSync }, { join }, { createHash }] = await Promise.all([import('node:fs'), import('node:path'), import('node:crypto')]);
  let root = '';
  const files: string[] = [];
  try {
    root = resolveSnap(ledger.installed_path); // #117：S4 起快照路径存 DATA_DIR 相对形
    (function walk(d: string) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(root);
  } catch {
    // #183 P0②：校验失败不回显服务器绝对路径（DATA_DIR 泄露面）
    throw new HttpError(500, '钉装快照不可读（路径已隐藏·请重新安装后再校验）');
  }
  // #94 S0①：与发布面同构 digest（同一 filesDigest——排序/分隔符/utf8 归一消灭「多文件误判篡改」类）
  const actual = SkillService.filesDigest(files.map((p) => ({ path: p.slice(root.length + 1).split('\\').join('/'), content: readFileSync(p) }))).digest; // #105：按原始字节（与导入器 treeDigest 同构，非 UTF-8 文件不误判）
  res.json({ ok: actual === ledger.expected_digest, expected: ledger.expected_digest, actual, checked_files: files.length });
}));

app.post('/api/skills/:slug/install/:ledgerId/revoke', (req, res) => {
  if (!adminGuard(req, res)) return;
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  const id = Number(req.params.ledgerId);
  const led = (S.ledgerActive() as any[]).find((l) => l.id === id);
  if (!led) throw new HttpError(404, `ledger not found: ${id}`); // #94 S0④：撤销校验（不存在→404）
  if (led.skill_id !== row.id) throw new HttpError(404, `ledger not found: ${id}`); // #94 S0④（K7）：跨技能撤销 404（不泄露他技能 ledger 存在性）
  S.ledgerRevoke(id);
  res.json({ ok: true, ledger_id: id, status: 'revoked' });
});

// role-pack 展开清单（bundle→技能清单，上岗即装）
app.get('/api/skills/role-packs', (_req, res) => {
  const S = svc<SkillService>('skill');
  const rows = S.bundlesAll() as any[];
  res.json(rows.map((b) => ({ pack_id: b.pack_id, member_name: b.member_name, bundle_version: b.bundle_version, skill_slugs: JSON.parse(b.skill_slugs || '[]'), roster_digest: b.roster_digest })));
});

// ---------- 技能市场浏览面（P1-a：/api/skills 只读列表，供管理页） ----------
app.get('/api/skills', (_req, res) => {
  const S = svc<SkillService>('skill');
  const rows = S.skillsAll() as any[];
  res.json(rows.map((r) => {
    const led = (S.ledgerActive() as any[]).find((l) => l.skill_id === r.id && l.status === 'installed');
    return { slug: r.slug, name: r.name, layer: r.layer, layer_name: r.layer_name, family_parent: r.family_parent, description: r.description, legacy: r.legacy === 1, versions: (S.versionsBySkill(r.id) as any[]).length, is_installed: !!led, current_version: led ? (S.versionsBySkill(r.id) as any[]).find((v) => v.id === led.version_id)?.version ?? null : null }; // #132 P1⑤
  }));
});

// ---------- 技能市场发布面（P0-b · 方案 PR#57 §1：口令门+首版人审+N+1 快照+digest 锚）----------
app.post('/api/skills/:slug/versions', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return; // 口令门（方案裁定：复用 X-Admin-Token）
  const slug = String(req.params.slug ?? '').trim();
  // #94 S0③：slug 校验（小写字母数字开头·[a-z0-9:_-]·≤64）
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(slug)) bad('slug 非法（小写字母数字开头·仅 [a-z0-9:_-]·≤64 字符）');
  const files = req.body?.files;
  if (!Array.isArray(files) || files.length === 0) bad('files 必须为非空 [{path, content}]');
  for (const f of files) {
    if (typeof f?.path !== 'string' || !f.path || typeof f?.content !== 'string') bad('files 项须 {path, content}');
    // #94 S0③：path 严校验（反斜杠/绝对路径/空·.·..段全拒）
    if (f.path.length > 200) bad('path 过长（>200）');
    if (f.path.includes('\\')) bad(`path 非法（禁反斜杠）: ${f.path}`);
    if (f.path.startsWith('/') || /^[A-Za-z]:/.test(f.path)) bad(`path 非法（禁绝对路径）: ${f.path}`);
    for (const seg of f.path.split('/')) if (seg === '' || seg === '.' || seg === '..') bad(`path 非法（空/. / .. 段）: ${f.path}`);
  }
  // #94 S0③（K6）：同名重复路径拒收（同 path 两义——内容静默覆盖防）
  {
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f.path)) bad(`path 重复: ${f.path}（同名两义拒收）`);
      seen.add(f.path);
    }
  }
  const changelog = String(req.body?.changelog ?? '').slice(0, 2000);
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  const S = svc<SkillService>('skill');
  const t = SkillService.filesDigest(files);
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
    const sk = (files as any[]).find((f) => /(^|\/)SKILL\.md$/i.test(String(f?.path ?? '')));
    if (sk && typeof sk.content === 'string') {
      const txt = String(sk.content).replace(/\r\n?/g, '\n');
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
  // 快照落盘
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const snapDir = join(dataDir, skillSnapRel(slug, nextVer)); // #183：磁盘与 DB 同一函数（slug 唯一形）
  mkdirSync(snapDir, { recursive: true });
  const { dirname } = await import('node:path');
  for (const f of files) {
    const abs = join(snapDir, f.path);
    mkdirSync(dirname(abs), { recursive: true }); // #94 S0②：子目录路径建父目录（docs/a.md 不再 500）
    writeFileSync(abs, f.content, 'utf8');
  }
  S.versionInsert({ skillId: row.id, version: nextVer, changelog, treeDigest: t.digest, fileCount: t.fileCount, totalBytes: t.totalBytes, snapshotPath: `skill-snapshots/${encodeURIComponent(slug)}/v${nextVer}`, reviewedBy }); // S4：存 dataDir 相对形
  // #94 S2 技能影子：wm-skills 项目·skill/<slug> 分支（契约 v1·fire-and-forget 同 P1 语义）
  void layerfsPublish('wm-skills', files, `[skill-publish] ${slug} v${nextVer}`, `skill/${slug}`).then((out) => {
    if (out) { try { db.prepare('UPDATE skill_versions SET commit_id = ? WHERE skill_id = ? AND version = ?').run(out.commit_id, row.id, nextVer); } catch { /* 影子失败不阻 */ } }
  });
  res.status(201).json({ ok: true, slug, version: nextVer, tree_digest: t.digest, file_count: t.fileCount, total_bytes: t.totalBytes, snapshot_path: `skill-snapshots/${encodeURIComponent(slug)}/v${nextVer}` }); // #94 S0⑤：不暴露 DATA_DIR 绝对路径);
}));

// #94 v3 S1/K16：技能一步式回滚/删除（口令+reviewed_by·与 app 同语义）
app.post('/api/skills/:slug/activate', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  if (!reviewedBy) bad('技能回滚需 reviewed_by（人审门——一步式直调必填；或经 MCP change_request_create 提请求）');
  const out = await executeSkillRollback(String(req.params.slug ?? ''), Number(req.body?.version), reviewedBy);
  res.json(out);
}));
app.delete('/api/skills/:slug', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const reviewedBy = String(req.body?.reviewed_by ?? '').trim();
  if (!reviewedBy) bad('技能删除需 reviewed_by（人审门）');
  executeSkillDelete(String(req.params.slug ?? ''));
  res.json({ ok: true, deleted: req.params.slug, reviewed_by: reviewedBy });
}));

// #94 S2 全量重导：技能各版依次入 wm-skills 项目 skill/<slug> 分支（幂等 skip+摘要对账）
app.post('/api/skills/:slug/migrate-layerfs', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  const vs = S.versionsBySkill(row.id) as any[];
  const results: any[] = [];
  for (const v of vs.sort((a, b) => a.version - b.version)) {
    if (v.commit_id) { results.push({ version: v.version, result: 'skip', commit_id: v.commit_id }); continue; } // 幂等
    if (!v.snapshot_path || !existsSync(resolveSnap(v.snapshot_path))) { results.push({ version: v.version, result: 'anomaly', reason: '快照目录缺失' }); continue; }
    const files: { path: string; content: string }[] = [];
    (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp, 'utf8') }); } })(resolveSnap(v.snapshot_path));
    if (files.length === 0 || files.some((f) => f.content === '')) { results.push({ version: v.version, result: 'anomaly', reason: '空快照/空 content（留档不迁）' }); continue; }
    const out = await layerfsPublish('wm-skills', files, `[skill-migrate] ${row.slug} v${v.version}`, `skill/${row.slug}`);
    if (!out) { results.push({ version: v.version, result: 'error', reason: 'layerfs 服务不可达（可重跑）' }); continue; }
    db.prepare('UPDATE skill_versions SET commit_id = ? WHERE id = ?').run(out.commit_id, v.id);
    // K13 摘要对账（发布摘要==重导后文件集重算）
    const re = SkillService.filesDigest(files).digest;
    results.push({ version: v.version, result: 'migrated', commit_id: out.commit_id, digest_match: re === v.tree_digest });
  }
  res.json({ slug: row.slug, project: 'wm-skills', branch: `skill/${row.slug}`, results });
}));

// ---------- #94 S4 D4：技能内容月度整库重建（layerfs#411 不能退役分支——定期重建清除已删技能残留） ----------
async function rebuildWmSkills(trigger: string): Promise<{ ok: boolean; deleted_project: boolean; republished: number; cleared_stale: number }> {
  const { base, token } = layerfsServiceBase();
  if (!base) throw new HttpError(502, 'layerfs 服务未配置——重建不可用');
  // ① 整库删（服务删项目·卷·备份——已删技能分支随之灭）
  let deleted = false;
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/v1/projects/wm-skills', { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
    deleted = r.ok;
  } catch { deleted = false; }
  // ② 活技能最新版重发布（旧 commit_id 清——重建后历史 commit 失效）
  let republished = 0; let cleared = 0;
  const S = svc<SkillService>('skill');
  for (const sk of S.skillsAll() as any[]) {
    const vs = S.versionsBySkill(sk.id) as any[];
    const latest = vs[0];
    if (!latest?.snapshot_path || !existsSync(resolveSnap(latest.snapshot_path))) continue;
    db.prepare("UPDATE skill_versions SET commit_id = '' WHERE skill_id = ?").run(sk.id); cleared++;
    const files: { path: string; content: string }[] = [];
    try { (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp, 'utf8') }); } })(resolveSnap(latest.snapshot_path)); } catch { continue; }
    if (files.length === 0 || files.some((f) => f.content === '')) continue; // 异常快照不迁
    const out = await layerfsPublish('wm-skills', files, `[rebuild] ${sk.slug} v${latest.version}`, `skill/${sk.slug}`);
    if (out) { db.prepare('UPDATE skill_versions SET commit_id = ? WHERE id = ?').run(out.commit_id, latest.id); republished++; }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_wm_skills_rebuild', datetime('now'))").run();
  console.log(`[S4-rebuild] ${trigger}: deleted=${deleted} republished=${republished} cleared=${cleared}`);
  return { ok: true, deleted_project: deleted, republished, cleared_stale: cleared };
}
app.post('/api/admin/rebuild-wm-skills', wrap(async (req, res) => {
  if (!adminGuard(req, res)) return;
  const out = await rebuildWmSkills('manual');
  res.json(out);
}));
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


/** #94 S3：最小 ustar 打包（薄分发导出——D5·无外部依赖） */
function ustarTar(files: { path: string; content: string }[], opts: { prefix?: string } = {}): Buffer {
  const chunks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512, 0);
    h.write(name.slice(0, 99), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write(' '.repeat(8), 148);
    h.write(type, 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  for (const f of files) {
    const body = Buffer.from(f.content, 'utf8');
    chunks.push(header((opts.prefix ?? '') + f.path, body.length, '0')); // #132 P1④：包内 <slug>/ 顶层
    chunks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

// #94 S3①：导出面（薄分发——快照文件集打包 ustar·台与技能共契约面）
app.get('/api/skills/:slug/export', (req, res) => {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  const vs = S.versionsBySkill(row.id) as any[];
  const v = req.query.version !== undefined ? Number(req.query.version) : vs[0]?.version;
  const target = vs.find((x) => x.version === v);
  if (!target) throw new HttpError(404, `version not found: ${v}`);
  const dir = resolveSnap(target.snapshot_path);
  if (!dir || !existsSync(dir)) throw new HttpError(404, `snapshot missing: v${v}`);
  const files: { path: string; content: string }[] = [];
  (function walk(d: string, rel = '') { for (const e of readdirSync(d, { withFileTypes: true })) { const fp = join(d, e.name); if (e.isDirectory()) walk(fp, rel + e.name + '/'); else files.push({ path: rel + e.name, content: readFileSync(fp, 'utf8') }); } })(dir);
  const tar = ustarTar(files, { prefix: String(row.slug).split(':').pop() + '/' }); // #601
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', 'attachment; filename="' + row.slug.replace(/[^a-z0-9._-]/gi, '_') + '-v' + v + '.tar"');
  res.setHeader('X-Expected-Digest', target.tree_digest);
  res.end(tar);
});

// #94 S3③：agent 端摘要上报（K14 漂移记——match/drift 双态入档）
app.post('/api/skills/:slug/report-digest', (req, res) => {
  if (!adminGuard(req, res)) return;
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  const v = Number(req.body?.version);
  const digest = String(req.body?.digest ?? '');
  if (!Number.isInteger(v) || !/^[0-9a-f]{64}$/.test(digest)) bad('version 正整数 + digest 64 位十六进制');
  const target = (S.versionsBySkill(row.id) as any[]).find((x) => x.version === v);
  if (!target) throw new HttpError(404, `version not found: ${v}`);
  const match = digest === target.tree_digest;
  db.prepare('INSERT INTO skill_digest_reports (skill_id, version, digest, expected, match_result, reported_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, v, digest, target.tree_digest, match ? 1 : 0, String(req.body?.reported_by ?? '').slice(0, 100));
  res.json({ ok: true, slug: row.slug, version: v, match, drift: !match, expected: target.tree_digest });
});


app.get('/api/skills/:slug/versions', (req, res) => {
  const S = svc<SkillService>('skill');
  const row = S.skillBySlug(String(req.params.slug ?? ''));
  if (!row) throw new HttpError(404, `skill not found: ${req.params.slug}`);
  // #94 S0⑤（K8）：版本列表 snapshot_path 相对化（不暴露 DATA_DIR）
  res.json({ slug: row.slug, versions: (S.versionsBySkill(row.id) as any[]).map((v) => ({ ...v, snapshot_path: v.snapshot_path ? `skill-snapshots/${encodeURIComponent(row.slug)}/v${v.version}` : v.snapshot_path })) });
});

app.get('/api/sop/runs', (req, res) => {
  // P4（F7）：待验收列表 = running 且有派单来源（a2a_run_ctx 有 callback/task_id），不含人自己开的
  if (req.query.dispatched === '1') {
    // #19 ②a：agent 分拣投递「默认关闭」——settings 开关 dispatch_sorting_enabled（'1'=开·缺省关）
    const ds = getSettings() as Record<string, unknown>;
    if (ds['dispatch_sorting_enabled'] !== '1' && ds['dispatch_sorting_enabled'] !== 1) return res.json([]);
    const rows = svc<SopService>('sop').runsDispatched() as unknown as SopRunRow[];
    return res.json(rows);
  }
  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const where: string[] = [];
  const args: unknown[] = [];
  if (slug) { where.push('sop_slug = ?'); args.push(slug); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM sop_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 200`;
  res.json(svc<SopService>('sop').runsQuery(sql, args) as unknown as SopRunRow[]);
});

// 异步路由一律经 wrap：Express 4 不接 async 抛出的错，404/409 会变成未处理的 Promise 拒绝让进程退出
app.get('/api/sop/runs/:id(\\d+)', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const auth = await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, id);
  if (auth.authorized) return res.json(await sopRunGetCore(id));
  res.set('Cache-Control', 'no-store').json(sopRunGetMeta(id)); // #309 phase2：未授权只回元数据，不回私有 data
}));

app.put('/api/sop/runs/:id(\\d+)', wrap(async (req, res) => {
  res.json(await sopRunStepSaveCore(Number(req.params.id), String(req.body?.stepKey ?? ''), req.body?.value));
}));

app.post('/api/sop/runs/:id(\\d+)/finish', wrap(async (req, res) => {
  res.json(await sopRunFinishCore(Number(req.params.id)));
}));

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
    try {
      const tok = wmAppToken(m[1]);
      const raw = readFileSync(abs, 'utf8');
      const inject = `<meta name="wm-app-token" content="${tok}"><script>window.WM_APP_TOKEN="${tok}";window.WM_APP_SLUG="${m[1]}";</script>`;
      const out = /<head[^>]*>/i.test(raw) ? raw.replace(/<head([^>]*)>/i, (mm) => mm + inject) : inject + raw;
      return res.type('html').send(out);
    } catch { /* 读取失败回落原样 */ }
  }
  res.sendFile(abs);
}
// 必须在 web/dist SPA fallback 之前注册
app.get(/^\/apps\/[a-z0-9][a-z0-9-]*(\/.*)?$/, serveApp);
// #321 设计 token 的固定路径（自产台 <link> 引入）：/design/tokens@<主版本>.css 推荐（主版本内名字稳定、值可变，按需重新验证），
// /design/tokens@<完整版本>.css 精确钉版本（内容不变，可长缓存）；其他版本 404，不猜
app.get(/^\/design\/tokens@[0-9.]+\.css$/, (req, res) => {
  const t = loadTokensCss();
  const kind = t ? resolveTokensPath(req.path, t) : null;
  if (!t || !kind) return res.status(404).type('text').send(t ? `只提供 tokens@${t.major}.css 与 tokens@${t.version}.css\n` : 'design tokens 不可用\n');
  res.setHeader('Cache-Control', kind === 'exact' ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-WM-Tokens-Version', t.version);
  res.type('text/css').send(t.css);
});

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

app.get('/api/summary', (_req, res) => {
  res.json(summaryPayload());
});

// ---------- 类型管理 ----------
app.get('/api/types', (_req, res) => {
  res.json(svc<WorkbenchService>('workbench').types());
});

app.post('/api/types', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.key !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(b.key)) bad('key 必须是小写字母/数字/连字符');
  if (typeof b.name !== 'string' || !b.name.trim()) bad('name 不能为空');
  if (b.key === 'web') bad('内置类型 web 不允许覆盖');
  checkTypeHealthPath(String(b.health_path ?? '/'));
  const exists = svc<WorkbenchService>('workbench').typeIdByKey(b.key);
  if (exists) bad(`类型已存在: ${b.key}`);
  const r = svc<WorkbenchService>('workbench').typeInsertStmt().run(
    b.key, b.name.trim(), String(b.icon ?? ''), b.default_port ?? null,
    b.health_method === 'HEAD' ? 'HEAD' : 'GET',
    String(b.health_path ?? '/'), b.expect_status == null ? null : Number(b.expect_status), String(b.description ?? '')
  );
  res.status(201).json(svc<WorkbenchService>('workbench').typeById(Number(r.lastInsertRowid)));
});

app.put('/api/types/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = svc<WorkbenchService>('workbench').typeById(id) as unknown as TypeRow | undefined;
  if (!cur) throw new HttpError(404, `type not found: ${id}`);
  const b = req.body ?? {};
  const next = {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : cur.name,
    icon: b.icon !== undefined ? String(b.icon) : cur.icon,
    default_port: b.default_port !== undefined ? (b.default_port ?? null) : cur.default_port,
    health_method: b.health_method ? (b.health_method === 'HEAD' ? 'HEAD' : 'GET') : cur.health_method,
    health_path: b.health_path !== undefined ? String(b.health_path) : cur.health_path,
    expect_status: b.expect_status !== undefined ? (b.expect_status == null ? null : Number(b.expect_status)) : cur.expect_status,
    description: b.description !== undefined ? String(b.description) : cur.description,
  };
  if (next.health_path !== cur.health_path) checkTypeHealthPath(next.health_path);
  if (cur.key === 'web' && (next.health_path !== cur.health_path || next.expect_status !== cur.expect_status)) {
    bad('内置类型 web 不允许修改探测语义');
  }
  svc<WorkbenchService>('workbench').typeUpdate({ ...next, id });
  res.json(svc<WorkbenchService>('workbench').typeById(id));
});

app.delete('/api/types/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = svc<WorkbenchService>('workbench').typeById(id) as unknown as TypeRow | undefined;
  if (!cur) throw new HttpError(404, `type not found: ${id}`);
  if (cur.key === 'web' || cur.key === 'market-app') bad(`内置类型 ${cur.key} 不允许删除`);
  const used = svc<WorkbenchService>('workbench').typeUsageCount(cur.key) as { n: number };
  if (used.n > 0) throw new HttpError(409, `类型 ${cur.key} 仍被 ${used.n} 个工作台使用，先改挂其他类型`);
  svc<WorkbenchService>('workbench').typeDelete(id);
  res.json({ ok: true, deleted: id });
});

// ---------- 设置 / 导入导出 ----------
// ---------- 管理员口令手动设置（本机引导：首次无口令时允许从 loopback 设置） ----------
/** #292 M1：可设/清口令——本机直连，且要么是 CLI（无浏览器标记），要么是控制面页面（Origin 就是控制面） */
function isLoopbackReq(req: express.Request): boolean {
  if (!rawLoopback(req)) return false;
  return !browserMarked(req) || (surfaceOf(req) === 'control' && originIsThisSurface(req));
}

app.get('/api/admin-token/state', (req, res) => {
  res.json({
    source: process.env.ADMIN_TOKEN ? 'env' : (dbAdminTokenSet() ? 'db' : 'none'),
    settable: !process.env.ADMIN_TOKEN && isLoopbackReq(req), // env 未设时可由本机页面设置
  });
});

app.put('/api/admin-token', (req, res) => {
  if (!isLoopbackReq(req)) return res.status(403).json({ error: '仅本机命令行或本机控制面页面可设置管理员口令', control_url: surfaceUrl(req, 'control') });
  if (process.env.ADMIN_TOKEN) return res.status(400).json({ error: '口令由启动环境 ADMIN_TOKEN 提供，页面不可改（改环境变量并重启）' });
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (token.length < 4 || token.length > 128) return res.status(400).json({ error: '口令长度 4–128' });
  const hasExisting = dbAdminTokenSet();
  if (hasExisting && !dbAdminTokenOk(req.headers['x-admin-token'])) {
    return res.status(403).json({ error: '修改口令需先在请求头带上当前口令（X-Admin-Token）' });
  }
  svc<SettingService>('setting').put(ADMIN_TOKEN_KEY, hashAdminToken(token));
  res.json({ ok: true, source: 'db', note: '口令已设置并立即生效（库存 sha256，不可取回）' });
});

app.delete('/api/admin-token', (req, res) => {
  if (!isLoopbackReq(req)) return res.status(403).json({ error: '仅本机命令行或本机控制面页面可清除管理员口令', control_url: surfaceUrl(req, 'control') });
  if (process.env.ADMIN_TOKEN) return res.status(400).json({ error: '口令来自启动环境，需清环境变量并重启' });
  if (!dbAdminTokenOk(req.headers['x-admin-token'])) return res.status(403).json({ error: '需当前口令' });
  svc<SettingService>('setting').delete(ADMIN_TOKEN_KEY);
  res.json({ ok: true, source: 'none' });
});

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

app.get('/api/settings', (_req, res) => { res.json(maskUpstreamsSetting(getSettings())); });

app.put('/api/settings', (req, res) => {
  const b = req.body ?? {};
  if (typeof b !== 'object' || b === null) bad('body 必须是 {key: value} 对象');
  const allowed = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'a2a_peers', 'mcp_upstreams', 'dispatch_sorting_enabled', 'run_upload_require_token']; // #19 ②a 分拣开关+#150 上传令牌开关
  const upd = svc<SettingService>('setting').upsertStmt();
  for (const [k, v] of Object.entries(b)) {
    if (!allowed.includes(k)) continue;
    upd.run(k, String(v));
  }
  armPatrol(); // issue #5：改巡检设置即重挂定时器（幂等 clearTimeout 开头），不必重启服务
  res.json(maskUpstreamsSetting(getSettings()));
});

app.get('/api/export', (req, res) => {
  // compliance 二期首项：导出默认脱敏（compliance 范围 kb ab3279b84a 的「导出面」——
  // 无认证导出曾是最大凭据泄漏向量）。?reveal=1 显式取真值（备份/迁移用途），
  // 导入侧对掩码 url/auth 整批400拒绝（见 import 预检）——失败零写，不跳行报成功。
  const reveal = req.query.reveal === '1';
  res.json({
    format: 'workbench-market/export@1',
    exported_at: new Date().toISOString(),
    masked: reveal ? 0 : 1,
    workbenches: listWorkbenches().map((w) => (reveal ? w : maskForApi(w))),
    types: svc<WorkbenchService>('workbench').types(),
    // 评审 #24：上游 MCP 凭据（headers）与 auth.value 同口径——掩码导出不会带真凭据，
    // 导入侧亦不覆盖 mcp_upstreams（掩码值跳过），凭据需在页面重填。
    settings: maskUpstreamsSetting(getSettings()),
  });
});

// #258 D：import 整批预检（结构 + 掩码 + 同核准入）全过才进事务；replace 的清库、类型、插入、布局修复同一事务，
// 任一失败整体回滚零写。不再 skip 坏行/掩码行（掩码导出整批拒 masked_import_value，请用 ?reveal=1 的受控备份）。
const importErr = (status: number, code: string, row_index: number | null, message: string): never => {
  throw new HttpError(status, code, { message, ...(row_index === null ? {} : { row_index }) });
};
app.post('/api/import', (req, res) => {
  const b = req.body ?? {};
  if (!Array.isArray(b.workbenches)) importErr(400, 'invalid_import', null, '导入文件缺少 workbenches 数组');
  if (b.types !== undefined && !Array.isArray(b.types)) importErr(400, 'invalid_import', null, 'types 必须是数组');
  // issue #7：mode 支持 query 优先（README 的 ?mode=replace 写法），body.mode 次之
  const modeRaw = (typeof req.query.mode === 'string' ? req.query.mode : b.mode) ?? 'merge';
  const mode = modeRaw === 'replace' ? 'replace' : 'merge';
  const types: any[] = Array.isArray(b.types) ? b.types : [];
  types.forEach((t) => {
    if (!t || typeof t !== 'object' || typeof t.key !== 'string' || !t.key || typeof t.name !== 'string') importErr(400, 'invalid_import', null, 'types 每项须含字符串 key 与 name');
    try { checkTypeHealthPath(String(t.health_path ?? '/')); } catch (e) { if (e instanceof AdmissionError) importErr(400, e.code, null, `类型 ${t.key}：${e.extra?.message ?? ''}`); throw e; }
  });
  const rows = (b.workbenches as any[]).map((w, i) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) importErr(400, 'invalid_import', i, '行不是对象');
    if (typeof w.url !== 'string' || !w.url.trim()) importErr(400, 'invalid_import', i, 'url 缺失');
    if (w.name !== undefined && typeof w.name !== 'string') importErr(400, 'invalid_import', i, 'name 须为字符串');
    if (w.tags !== undefined && !Array.isArray(w.tags)) importErr(400, 'invalid_import', i, 'tags 须为数组');
    const url = w.url.trim();
    if (url.includes('=****') || w.auth?.value === '****') importErr(400, 'masked_import_value', i, '含掩码占位（****）——掩码导出不能用来恢复，请用 ?reveal=1 的受控备份或重新录入');
    let authCfg = '';
    if (w.auth !== undefined && w.auth !== null) {
      if (typeof w.auth !== 'object' || (w.auth.type !== 'bearer' && w.auth.type !== 'basic') || typeof w.auth.value !== 'string' || !w.auth.value || w.auth.value.length > 4096) {
        importErr(400, 'invalid_import', i, 'auth 形态：{type:"bearer"|"basic", value:string}');
      }
      authCfg = JSON.stringify({ type: w.auth.type, value: w.auth.value });
    }
    let adm;
    try { adm = admitOrDeny('import', url); checkHealthPath(url, String(w.health_path ?? '')); }
    catch (e) { if (e instanceof AdmissionError) importErr(e.status, e.code, i, String(e.extra?.message ?? '')); throw e; }
    return { w, url, authCfg, adm };
  });
  const svcWb = svc<WorkbenchService>('workbench');
  const inserted: { id: number; key: string | null; allowlisted: boolean }[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    if (mode === 'replace') {
      svcWb.deleteAll();
      svcWb.typeDeleteAllExcept('web');
    }
    const insType = svcWb.typeInsertIgnoreStmt();
    for (const t of types) insType.run(t.key, t.name, String(t.icon ?? ''), t.default_port ?? null, t.health_method ?? 'GET', String(t.health_path ?? '/'), t.expect_status ?? null, String(t.description ?? ''));
    const ins = svcWb.importInsertStmt();
    for (const { w, url, authCfg, adm } of rows) {
      const r = ins.run(
        String(w.name ?? '未命名'), url, String(w.type ?? 'web'), String(w.icon ?? ''),
        String(w.description ?? ''), String(w.category ?? ''),
        JSON.stringify(Array.isArray(w.tags) ? w.tags : []), w.enabled === false ? 0 : 1,
        String(w.health_path ?? ''), Number(w.sort) || 0, authCfg
      ) as { lastInsertRowid: number | bigint };
      inserted.push({ id: Number(r.lastInsertRowid), key: adm.key, allowlisted: adm.allowlisted });
    }
    // PR#15 评审吸收的增量思路：replace 重排自增 id 后，驾驶舱面板里指向旧 id 的引用已成悬空
    // （保存布局恒 400）——导入完成后全量剔除不存在引用（比按 id 精确清理更通用，也清历史遗留）
    const wbExists = (id: number) => !!svcWb.exists(id);
    for (const c of svc<CockpitService>('cockpit').all() as unknown as CockpitRow[]) {
      let panels: PanelConfig[];
      try { panels = JSON.parse(c.layout_config || '[]'); } catch { continue; }
      // 待办卡 kind='tasks' 以 workbenchId=0 占位、不引用工作台，不参与悬空剔除
      const kept = panels.filter((p) => p.kind === 'tasks' || wbExists(p.workbenchId));
      if (kept.length !== panels.length) {
        svc<CockpitService>('cockpit').setLayout(c.id, JSON.stringify(kept));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[import] 事务回滚：', (e as Error)?.message ?? e);
    throw new HttpError(500, 'import_failed', { message: '导入写入失败，已整体回滚（原数据未变）' });
  }
  // commit 之后才写 allow：每个命中许可的行恰一条
  let auditOk = true;
  for (const x of inserted) if (x.allowlisted && !auditAllow('import', URL_POLICY, x.key!, x.id, restSubject(req))) auditOk = false;
  if (!auditOk) res.setHeader('X-WM-Audit-State', 'degraded');
  res.json({ ok: true, mode, imported: inserted.length, skipped: 0 });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'workbench-market-server', version: '0.1.0', uptime_s: Math.round(process.uptime()) });
});

// ---------- A2A 网络接入（GH #17 P1：签名卡片 + 人工绑定，只读暴露） ----------
// 卡片：canonical/签名与上游 card.ts（裁判钉 75a3ebd）逐字节一致；sessionTeams 只列
// published 且 ≥1 有效绑定的 SOP；不发布 teamMemberships（修订 3：绑定图不出门）。
app.get('/.well-known/agent-card.json', (_req, res) => {
  res.json(buildAgentCard(a2aKeyPath()));
});

// 人工绑定 API（读写都要 ADMIN_TOKEN + Origin 空或同源——服务端校验跨源，CORS 白名单管不住执行）
// 管理员口令存储（主人要求「页面手动设置」）：settings.admin_token_sha256（不可逆），
// 优先级 env ADMIN_TOKEN > 库内值 > 无（未设一律 403）。DB 仅存 sha256，明文不落库。
const ADMIN_TOKEN_KEY = 'admin_token_sha256';
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

/** P0：静默口令判定（不写响应——供上传面与 token 二选一逻辑用） */
function adminHeaderOk(req: express.Request): boolean {
  if (!adminTokenCheck(req.headers['x-admin-token'])) return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(String(origin)).host !== String(req.headers.host ?? '')) return false; } catch { return false; } }
  return true;
}

function adminGuard(req: express.Request, res: express.Response): boolean {
  // #292 M1：浏览器发来的管理写只认控制面（口令只在控制面存在；业务面上的同源不可信页拿不到也用不了）
  if (browserMarked(req) && !(surfaceOf(req) === 'control' && originIsThisSurface(req)) && !devOriginOk(req)) {
    res.status(403).json({ error: '管理写操作请到控制面（业务面页面发来的一律拒绝）', control_surface_required: true, control_url: surfaceUrl(req, 'control') });
    return false;
  }
  if (!adminTokenCheck(req.headers['x-admin-token'])) {
    res.status(403).json({ error: '需要有效的 X-Admin-Token（口令缺失或无效一律拒绝；设置页/顶栏钥匙图标可设置）' }); // 属主报障文案修正：不再把「未带/无效」说成「未设置」
    return false;
  }
  const origin = req.headers.origin;
  if (origin && !devOriginOk(req)) { // web dev：vite 代理把 Host 改成 9800、Origin 仍是 5173，已在 devOriginOk 里限本机直连
    // 同源判定：Origin 的 host 与请求 Host 一致（http/https 均可）
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

/** 任务状态迁移：每次变化恰一条事件（BEGIN IMMEDIATE 串行段·#159 C23 只增不改） */
function applyTaskTransition(taskId: number, action: 'created' | 'toggled' | 'published' | 'withdrawn', actor: string, patch: Record<string, unknown> = {}): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((k) => k + ' = @' + k).join(', ');
      db.prepare('UPDATE tasks SET ' + sets + ", updated_at = datetime('now') WHERE id = @___id").run({ ...patch, ___id: taskId });
    }
    db.prepare("INSERT INTO task_events (task_id, type, actor, actor_kind, payload_json) VALUES (?, ?, ?, 'human', ?)").run(taskId, action, actor, JSON.stringify(patch));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- 任务中心 8 端点（读开放·写删人审·C13 元台只能人工面） ----
app.post('/api/task-center/tasks', (req, res) => {
  if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' }); // C10
  if (!adminGuard(req, res)) return; // C9 无口令 401/403
  res.status(201).json(publishTaskIntake(req.body ?? {}));
});
app.get('/api/task-center/tasks', (req, res) => { // 读开放
  res.json(db.prepare('SELECT * FROM tasks ORDER BY id DESC').all().map(taskListView)); // #309 phase2：列表同样不带 payload_json 私有副本
});
app.get('/api/task-center/tasks/:id', wrap(async (req, res) => {
  const hit = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!hit) throw new HttpError(404, 'task not found');
  const events = db.prepare('SELECT id, type, actor, actor_kind, at, payload_json FROM task_events WHERE task_id = ? ORDER BY id').all(hit.id).map((e: any) => ({...e, action: e.type, detail: JSON.parse(e.payload_json)}));
  // #309 phase2：详情复制的录入数据与全量投影需 run 级读授权；未授权只回元数据（payload_json 是私有副本）
  const auth = hit.intake_run_id ? await authorizeRunRead({ adminOk: adminHeaderOk(req), cap: runReadCapHeader(req), cookieHeader: req.headers.cookie }, hit.intake_run_id) : { authorized: false };
  if (auth.authorized) return res.json({ ...taskView(hit), events });
  res.set('Cache-Control', 'no-store').json({ ...taskListView(hit), events, private_read: 'authorization-required' });
}));
// #309 phase2：run 私有读授权管理面（播种 grant／重签 cap／撤销；adminGuard——运维持权人经权威映射操作，不猜归属）
app.put('/api/sop/runs/:id(\\d+)/read-grants', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  sopRunRow(id);
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  if (!/^(user|mcp):[A-Za-z0-9_.@-]{1,128}$/.test(subject)) bad('subject 形如 user:<Odoo登录名> 或 mcp:<会话名>');
  const role = typeof req.body?.role === 'string' && req.body.role ? req.body.role.slice(0, 32) : 'reader';
  const expiresAt = typeof req.body?.expires_at === 'string' && req.body.expires_at ? req.body.expires_at.slice(0, 19) : null;
  runReadGrantCreate(id, subject, role, expiresAt, 'admin');
  res.status(201).json({ ok: true, run_id: id, subject, role, expires_at: expiresAt });
});
app.post('/api/sop/runs/:id(\\d+)/read-grants/revoke', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  if (!subject) bad('subject 必填');
  const n = runReadGrantRevoke(id, subject);
  res.json({ ok: true, run_id: id, subject, revoked: n });
});
app.post('/api/sop/runs/:id(\\d+)/read-caps', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  sopRunRow(id);
  const cap = issueRunReadCap(id);
  res.status(201).json({ ok: true, run_id: id, read_capability: cap, note: '明文仅此一次出现——请立即分发保管' });
});
app.post('/api/sop/runs/:id(\\d+)/read-caps/revoke', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  const n = runReadCapRevokeAll(id);
  res.json({ ok: true, run_id: id, revoked_caps: n });
});
app.get('/api/task-center/policy', (req, res) => { // C7 读开放
  res.json(taskCenterPolicy());
});
app.get('/api/task-center/template', (req, res) => { // C17 六固定步骤
  const current = readActiveManifest('task-center');
  res.json({ version: current?.app.active_version, steps: current?.manifest.steps ?? taskCenterSteps });
});
app.put('/api/task-center/policy', (req, res) => {
  if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
  if (!adminGuard(req, res)) return;
  const body = req.body ?? {};
  if (typeof body.agent_dispatch_enabled !== 'boolean') throw new HttpError(400, 'agent_dispatch_enabled 必须是布尔值');
  const enabled = body.agent_dispatch_enabled;
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = taskCenterPolicy().agent_dispatch_enabled !== enabled;
    db.prepare("UPDATE task_center_policy SET value=? WHERE key='center_switch'").run(enabled ? 'on' : 'off');
    if (changed) db.prepare("INSERT INTO task_center_events(actor,action,detail) VALUES('human:admin','policy_changed',?)").run(JSON.stringify({agent_dispatch_enabled:enabled}));
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, ...taskCenterPolicy() });
});
app.patch('/api/task-center/tasks/:id/switch', (req, res) => { // 任务级锁
  if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
  if (!adminGuard(req, res)) return;
  const hit = db.prepare('SELECT id, enabled FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!hit) throw new HttpError(404, 'task not found');
  const nv = hit.enabled ? 0 : 1;
  applyTaskTransition(hit.id, 'toggled', 'human:' + String((req as express.Request & { adminActor?: string }).adminActor ?? 'human'), { enabled: nv });
  res.json({ ok: true, enabled: nv === 1 });
});

// #159 M3 B3（决策 #010）：发布冻结 + 撤回 + agent 派发开关（C2-C6/C8/C11/C18-C22·监督席两对齐）
app.post('/api/task-center/tasks/:id/publish', (req, res) => {
  if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
  if (!adminGuard(req, res)) return;
  const hit = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id)) as any;
  if (!hit) throw new HttpError(404, 'task not found');
  if (hit.status === 'published') throw new HttpError(409, '已发布不可再写（#159 C11）');
  if (hit.status === 'withdrawn') throw new HttpError(409, '已撤回任务不可发布');
  throw new HttpError(409, '旧草稿不得绕过录入 run 发布；请完成 task-center 录入后统一发布');

});
app.post('/api/task-center/tasks/:id/withdraw', (req, res) => {
  if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
  if (!adminGuard(req, res)) return;
  const hit = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id)) as any;
  if (!hit) throw new HttpError(404, 'task not found');
  if (hit.status !== 'published') throw new HttpError(409, '仅已发布可撤回');
  const actor = 'human:' + String((req as express.Request & { adminActor?: string }).adminActor ?? 'admin');
  applyTaskTransition(hit.id, 'withdrawn', actor, { status: 'withdrawn' });
  res.json({ ok: true, id: hit.id, status: 'withdrawn' });
});
app.patch('/api/task-center/tasks/:id/agent-dispatch', (req, res) => { // 监督席对齐②：任务级 agent 派发开关（默认关·与任务锁语义对齐）
  if (!sameOriginGuard(req, res)) return res.status(403).json({ error: '跨源拒绝' });
  if (!adminGuard(req, res)) return;
  const hit = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id)) as any;
  if (!hit) throw new HttpError(404, 'task not found');
  if (hit.status !== 'published') throw new HttpError(409, '仅已发布任务可变更开关');
  if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
  const enabled = req.body?.enabled ?? !Boolean(hit.agent_dispatch_enabled);
  const actor = 'human:' + String((req as express.Request & { adminActor?: string }).adminActor ?? 'admin');
  if (enabled !== Boolean(hit.agent_dispatch_enabled)) applyTaskTransition(hit.id, 'toggled', actor, { agent_dispatch_enabled: enabled ? 1 : 0 });
  res.json({ ok: true, ...taskView(db.prepare('SELECT * FROM tasks WHERE id=?').get(hit.id)) });
});



function maskKey(v: string): string {
  return v ? '****' : '';
}

// ---------- 统一绑定面（联合评审①裁定 C · 2026-10-26）：表层统一+语义分离 ----------
// 一张 bindings 表：direction(admits=入站准入|notify=出站推送|both=显式双授永非默认)。
// 授权独立铁律：admits 消费点只认 admits|both；notify 消费点只认 notify|both——授一边不隐含另一边。
// 跨型 CHECK（DDL）：app 行 remote_api_key 恒空、mode 恒 read（sop 专属语义不漂移）。
// S3 豁免面可观测（评审席裁下批）：GET /api/remote-allow/diff——安全清单变更管理面可查
// SSO 回调路由（属主令「都需要」·A 面）：Odoo 登录完 302 回市场统一入口——
// /sso/callback?redirect=/go/N/&state=xxx → 内域校验 → 302 目标台（会话 cookie 由浏览器自持 Odoo 域·此处只管回跳安全）
app.get('/sso/callback', (req, res) => {
  const redirect = String(req.query.redirect ?? '');
  const state = String(req.query.state ?? '');
  if (!redirect || !state) return res.status(400).json({ error: 'redirect 和 state 必填（Odoo 登录回跳统一入口）' });
  {
    // #170 P9：state 必须与 /go/<id>/ 回跳一一对应（伪造 state 旁路拒）
    const mId = /^\/go\/(\d+)\//.exec(redirect);
    if (!mId) return res.status(400).json({ error: 'redirect 形态非法（须 /go/<id>/…）' });
    const ck = new RegExp('(?:^|;\\s*)wm_sso_' + mId[1] + '=([^;\\s]+)').exec(String(req.headers.cookie ?? ''));
    if (!ck || ck[1] !== state) return res.status(400).json({ error: 'SSO state 校验失败（请从市场门户重新进入）' });
  }
  // open-redirect 护栏：只许内域路径（/ 开头且非 //）；再按浏览器 URL 解析复核——WHATWG 把 \ 当 /，/\evil.com 会被解析成外域（#92）
  if (!redirect.startsWith('/') || redirect.startsWith('//') || new URL(redirect, 'http://sso.internal/').host !== 'sso.internal') {
    return res.status(400).json({ error: 'redirect 只许本站路径（/go/... 形态·外域拒）' });
  }
  return res.redirect(302, redirect);
});

app.get('/api/remote-allow/diff', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ ...lastAllowDiff, snapshot_count: (db.prepare('SELECT COUNT(*) AS n FROM remote_allow_state').get() as { n: number }).n });
});

// #19②b 裁 A（direct-2ff2ed21）：治理时间线——版本链+run 历史+验收链三合一面（轻内嵌）
/** #318 SOP 交付空间「定义」与单次记录的步骤骨架：只回步骤 key / 标题，不回步骤正文 HTML。
 *  可见性同 Runner（issue #11）：published 公开；draft / deprecated 只给管理员。
 *  ?version=N 读该版本（单次记录按 run 的 sop_version 取）；版本目录已冷存时 404，不猜。 */
app.get('/api/sops/:slug/definition', (req, res) => {
  const a = getApp(req.params.slug);
  if (a.kind !== 'sop') throw new HttpError(404, `SOP not found: ${req.params.slug}`);
  if (a.status !== 'published' && !adminHeaderOk(req)) return res.status(403).set('Cache-Control', 'no-store').json({ error: `SOP ${a.slug} 状态为 ${a.status}，定义仅管理员可见` });
  const raw = req.query.version;
  const version = raw === undefined || raw === '' ? a.active_version : Number(raw);
  if (!Number.isInteger(version) || version < 1) bad('version 必须是正整数');
  if (!svc<AppService>('app').versionExists(a.id, version)) throw new HttpError(404, `版本不存在: v${version}`);
  const yamlPath = join(appsRoot, a.slug, `v${version}`, 'sop.yaml');
  if (!existsSync(yamlPath)) return res.status(404).json({ error: `v${version} 未物化（冷版本），无法读取步骤定义`, code: 'version_not_materialized' });
  const m = parseSopManifest(readFileSync(yamlPath, 'utf8'));
  res.json({ slug: a.slug, version, active_version: a.active_version, status: a.status, title: m.title, code: m.code ?? a.code ?? '', description: m.description ?? '', steps: m.steps.map(({ key, title }) => ({ key, title })) });
});

app.get('/api/sops/:slug/timeline', (req, res) => {
  const a = getApp(req.params.slug);
  if (a.kind !== 'sop') throw new HttpError(404, `SOP not found: ${req.params.slug}`);
  const versions = (db.prepare('SELECT version, changelog, created_by, created_at FROM app_versions WHERE app_id = ? ORDER BY version DESC').all(a.id) as Array<{ version: number; changelog: string; created_by: string; created_at: string }>).map(v => ({ ...v, changelog: (v.changelog || '').slice(0, 200) }));
  const runs = (svc<SopService>('sop').runsBySlug(a.slug) as unknown as Array<{ id: number; status: string; started_by: string; started_at: string; finished_at: string }>).slice(0, 50).map(r => ({ id: r.id, status: r.status, started_by: r.started_by, started_at: r.started_at, finished_at: r.finished_at }));
  const receipts = (db.prepare("SELECT r.task_id, r.caller, r.receipt_status, r.run_id FROM a2a_run_ctx r WHERE r.task_id != '' AND r.run_id IN (SELECT id FROM sop_runs WHERE sop_slug = ?)").all(a.slug) as Array<{ task_id: string; caller: string; receipt_status: string; run_id: number }>).map(r => ({ task_id: r.task_id, caller: r.caller, receipt_status: r.receipt_status || 'pending', run_id: r.run_id }));
  res.json({ slug: a.slug, versions, runs, receipts });
});

app.get('/api/bindings', (req, res) => {
  if (!adminGuard(req, res)) return;
  const type = req.query.type === 'app' ? 'app' : 'sop';
  const slug = String(req.query.slug ?? '').trim();
  if (!slug) bad('slug 必填：/api/bindings?type=(sop|app)&slug=x');
  const rows = db.prepare("SELECT id, target_type, target_slug, agent_node, direction, mode, notify_url, remote_api_key, revoked_at, created_by, created_at FROM bindings WHERE target_type = ? AND target_slug = ? ORDER BY id DESC").all(type, slug);
  res.json(rows.map((r: { remote_api_key: string }) => ({ ...r, remote_api_key: maskKey(r.remote_api_key) })));
});

app.post('/api/bindings', (req, res) => {
  if (!adminGuard(req, res)) return;
  const b = req.body ?? {};
  const targetType = b.target_type === 'app' ? 'app' : 'sop';
  const slug = typeof b.target_slug === 'string' ? b.target_slug.trim() : '';
  const node = typeof b.agent_node === 'string' ? b.agent_node.trim() : '';
  // 评审注 A（direction 显式铁律）：缺 direction 一律 400——不许静默默认任何方向
  const direction = b.direction;
  if (direction !== 'admits' && direction !== 'notify' && direction !== 'both') bad('direction 必填且只许 admits|notify|both（显式选择·无默认）');
  if (!slug) bad('target_slug 必填');
  if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9_-]{0,63}$/i.test(node)) bad('agent_node 形态：<zone>/<id8>，如 dsh/1a2b3c4d');
  const a = getApp(slug);
  if (a.kind !== targetType) bad(`target_type=${targetType} 与台型不符（${slug} 是 ${a.kind}）`);
  const mode = targetType === 'sop' && b.mode === 'run' ? 'run' : 'read'; // app 行 mode 恒 read（跨型 CHECK）
  const remoteKey = targetType === 'sop' && typeof b.remote_api_key === 'string' ? b.remote_api_key.trim() : '';
  const notifyRaw = typeof b.notify_url === 'string' ? b.notify_url.trim().replace(/\/+$/, '') : '';
  if (notifyRaw !== '' && !/^https?:\/\/[^\s]+$/.test(notifyRaw)) bad('notify_url 必须是 http(s):// 根地址（达对端：回执投递/推送基址）');
  // 语义对齐旧面：admits+read 不消费 notify_url（P3 口径）；notify 向必须带 notify_url
  const notifyUrl = direction === 'admits' && mode === 'read' ? '' : notifyRaw;
  if ((direction === 'notify' || direction === 'both') && notifyUrl === '') bad('notify 向绑定必须携带 notify_url');
  if (targetType === 'sop') sopNode8(slug); // 确保节点短 id 已生成（上卡用）
  // natural key 命中 → upsert（重绑=刷新字段并复活撤销态·绑定管理语义），首绑/重绑皆 201
  const existing = db.prepare("SELECT id FROM bindings WHERE target_type = ? AND target_slug = ? AND agent_node = ? AND direction = ?").get(targetType, slug, node, direction) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE bindings SET mode = ?, notify_url = ?, remote_api_key = ?, revoked_at = '', created_by = 'admin', created_at = datetime('now') WHERE id = ?").run(mode, notifyUrl, remoteKey, existing.id);
    res.status(201).json({ ok: true, id: existing.id, upserted: true, target_type: targetType, target_slug: slug, agent_node: node, direction, mode, notify_url: notifyUrl, remote_api_key: maskKey(remoteKey) });
    return;
  }
  const r = db.prepare('INSERT INTO bindings (target_type, target_slug, agent_node, direction, mode, notify_url, remote_api_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(targetType, slug, node, direction, mode, notifyUrl, remoteKey, 'admin') as unknown as { lastInsertRowid: number | bigint };
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), target_type: targetType, target_slug: slug, agent_node: node, direction, mode, notify_url: notifyUrl, remote_api_key: maskKey(remoteKey) });
});

app.delete('/api/bindings/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  const hit = db.prepare("SELECT id FROM bindings WHERE id = ? AND revoked_at = ''").get(id) as { id: number } | undefined;
  if (!hit) throw new HttpError(404, `binding not found: ${id}`);
  db.prepare("UPDATE bindings SET revoked_at = datetime('now') WHERE id = ?").run(id);
  res.json({ ok: true, revoked: id });
});

// 旧面 410 过渡（评审注 B：一版 Location 指新面，下一版 404）——UI/脚本切换缓冲
app.all('/api/sops/:slug/bindings', (req, res) => {
  const loc = `/api/bindings?type=sop&slug=${encodeURIComponent(String(req.params.slug ?? ''))}`;
  res.set('Location', loc).status(410).json({ error: '绑定面已统一：GET/POST /api/bindings（direction 显式必填）', location: loc });
});
app.all('/api/sops/:slug/bindings/:id', (req, res) => {
  res.set('Location', '/api/bindings').status(410).json({ error: '绑定面已统一：DELETE /api/bindings/:id', location: '/api/bindings' });
});
app.all('/api/apps/:slug/bindings', (req, res) => {
  const loc = `/api/bindings?type=app&slug=${encodeURIComponent(String(req.params.slug ?? ''))}`;
  res.set('Location', loc).status(410).json({ error: '绑定面已统一：GET/POST /api/bindings（direction 显式必填）', location: loc });
});
app.all('/api/apps/:slug/bindings/:id', (req, res) => {
  res.set('Location', '/api/bindings').status(410).json({ error: '绑定面已统一：DELETE /api/bindings/:id', location: '/api/bindings' });
});

// （旧双面绑定 CRUD 已删——统一面 /api/bindings 承接，410 过渡件在上）

// /a2a/direct（P2）：准入开放——有效绑定 + 同 context 续 run + 上游幂等族 + 512KiB + DELIVERED 形状。
// 查无 SOP 仍 404 不泄露；无绑定/draft/mode 不足 → 200 TASK_STATE_FAILED -32000（对齐上游 admission 形状）。
// ADMIN_TOKEN 未设置时绑定面休眠（主人裁定：内网信任模型）——direct 对无绑定的 SOP 自然全拒。
app.post('/a2a/direct', express.json({ limit: '600kb' }), async (req, res) => {
  const rawBytes = Number(req.headers['content-length'] ?? 0) || JSON.stringify(req.body ?? {}).length;
  // run 操作桥（P2 note 写入走 sop_runs 的哑数据面：step_key=note-<ts> 追加不覆盖）
  const runOps = {
    start: (slug: string, startedBy: string): { id: number; read_capability: string } => { const r = sopRunStartCore(slug, startedBy); return { id: r.id, read_capability: r.read_capability }; },
    uploadToken: (id: number): string => String((db.prepare('SELECT upload_token FROM sop_runs WHERE id = ?').get(id) as { upload_token?: string } | undefined)?.upload_token ?? ''), // P0：派单回执带令牌（创建者即得）
    saveNote: (runId: number, text: string): Promise<void> => runCheckpoints.serial(runId, async () => {
      const row = sopRunRow(runId);
      if (row.status !== 'running') throw new HttpError(409, 'run ' + runId + ' 已 ' + row.status + '，不可再写');
      const prior = runCheckpoints.peek(runId);
      const hot = prior || row.sop_slug === 'task-center' ? null : await runStateLoad(runId);
      const data = prior ?? { ...storedRunData(row), ...(hot?.meta.status === 'running' ? hot.data : {}) };
      const notes = Array.isArray(data['a2a-notes']) ? data['a2a-notes'] as unknown[] : [];
      notes.push({ at: new Date().toISOString(), text });
      data['a2a-notes'] = notes;
      if (row.sop_slug !== 'task-center') await runStateRestore(runId, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data);
      runCheckpoints.remember(runId, data, true); // a delivered note keeps its existing immediate SQLite guarantee
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

import { MCP_TOOLS } from './mcp-tools.ts';
import { evalCandidates } from './eval.ts'; // #178 评估模型客户端

import { renderSopRunner as renderSopRunnerRaw } from './sop-runner.ts';
import { loadTokensCss, resolveTokensPath } from './design-tokens-css.ts';
/** #321：执行页内联 DESIGN.md 生成的 --wm-* 变量，与市场前端同色同字号 */
const renderSopRunner = (manifest: Parameters<typeof renderSopRunnerRaw>[0], app: Parameters<typeof renderSopRunnerRaw>[1]) => renderSopRunnerRaw(manifest, app, loadTokensCss()?.css ?? '');
import { isOdooLikeTarget, isOdooSessionTarget, stripOdooSession, trustedOdooOrigins } from './odoo-session.ts';
import { collectTasks } from './tasks.ts';
import { lifecycleApprove, lifecycleBoard, lifecycleConfigProblem, lifecycleConfigured, lifecycleSourceFor, lifecycleStatus, lifecycleWhoami, resolveOdooViewer } from './lifecycle.ts';
import { authorizeRunRead, issueRunReadCap, runReadGrantCreate, runReadGrantRevoke, runReadCapRevokeAll } from './sop-read-auth.ts';
import { endpointStatsMiddleware, statsPayload } from './endpoint-stats.ts';

// ---------- MCP 生产通道（StreamableHTTP · stateless：AI 会话直连市场，零依赖手写 JSON-RPC） ----------
const MCP_PROTOCOL = '2025-03-26';
const MCP_KNOWN_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

async function callTool(name: string, args: any, subject = 'anonymous'): Promise<unknown> {
  const metaSlug = String(args?.slug ?? '').trim().toLowerCase();
  if (metaSlug === 'task-center' && ['app_publish','app_activate','sop_publish','sop_deprecate','app_draft_open','app_draft_edit','app_draft_submit'].includes(name)) throw new HttpError(403, 'task-center 元台仅人工面可修改');
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
      return { slug: r.slug, name: r.name, layer: r.layer, layer_name: r.layer_name, family_parent: r.family_parent, legacy: r.legacy === 1, versions: (S.versionsBySkill(r.id) as any[]).length, is_installed: !!led, current_version: led ? (S.versionsBySkill(r.id) as any[]).find((v) => v.id === led.version_id)?.version ?? null : null }; // #132 P1⑤ MCP
    });
    }
    case 'skill_versions': {
      const S = svc<SkillService>('skill');
      const row = S.skillBySlug(String(args?.slug ?? ''));
      if (!row) return { error: `skill not found: ${args?.slug}` };
      // #94 S0⑤（K8）：MCP 面同规则——snapshot_path 相对化
      return (S.versionsBySkill(row.id) as any[]).map((v) => ({ ...v, snapshot_path: v.snapshot_path ? `skill-snapshots/${encodeURIComponent(row.slug)}/v${v.version}` : v.snapshot_path }));
    }
    case 'skill_install_plan': {
      const S = svc<SkillService>('skill');
      const row = S.skillBySlug(String(args?.slug ?? ''));
      if (!row) return { error: `skill not found: ${args?.slug}` };
      const vs = S.versionsBySkill(row.id) as any[];
      if (vs.length === 0) return { error: `无版本：${args?.slug}` };
      const target = typeof args?.version === 'number' ? vs.find((v) => v.version === args.version) : vs[0];
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
        return { slug: s.slug, name: s.name, layer: s.layer, description: String(s.description ?? ''), confidence: pv, version: vs[0]?.version ?? null, install_plan: { slug: s.slug, version: vs[0]?.version ?? null } };
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
    case 'app_publish': {
      if (String(args?.slug ?? '') === 'task-center') throw new HttpError(403, 'task-center 元台只能经人工面修改（#159 C13）');
      // #193 F11：MCP 发布与 REST 同过发布锁（60s 同 slug 异会话 409）
      const _slug = String(args?.slug ?? '').trim().toLowerCase();
      const _who = String(args?.created_by ?? '').trim() || 'mcp';
      const _gate = publishLockGuard(_slug, _who, args?.force === true || args?.force === 'true');
      if (!_gate.ok) throw new HttpError(409, _gate.hint);
      return publishAppBody({ ...args, created_by: _who }).body;
    }
    // #94 v3 S1（K12）：app_activate 直回滚工具**移除**（破坏性操作 MCP 不可直执）——改经 change_request_create 提请求
    // #94 v3 S1（契约形状·#94 评论 6424247402）：{kind: 'app'|'skill', slug, op: 'rollback'|'delete', target_version?, reason}
    // #94 P3 agent 工作区（草稿三分支·契约 v1 drafts 面）
    case 'app_draft_open': {
      const a0 = getApp(String(args?.slug ?? ''));
      const v0 = (svc<AppService>('app').versions(a0.id) as any[]).find((x) => x.version === a0.active_version);
      if (!v0?.commit_id) throw new HttpError(409, `激活版无 Commit 锚——不可开草稿（影子未达）`);
      const { base, token } = layerfsServiceBase();
      if (!base) throw new HttpError(502, 'layerfs 服务未配置——草稿不可用');
      const fr = await fetch(base.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(a0.slug)) + '/branches/release/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ from: v0.commit_id }), signal: AbortSignal.timeout(10000) });
      if (!fr.ok) throw new HttpError(502, `draft open HTTP ${fr.status}`);
      return await fr.json();
    }
    case 'app_draft_edit': {
      const aE = getApp(String(args?.slug ?? ''));
      const { base: bE, token: tE } = layerfsServiceBase();
      if (!bE) throw new HttpError(502, 'layerfs 服务未配置');
      const fr = await fetch(bE.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(layerfsProjectName(aE.slug)) + '/branches/release/drafts/' + encodeURIComponent(String(args?.draft ?? '')) + '/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tE ? { Authorization: `Bearer ${tE}` } : {}) }, body: JSON.stringify({ changes: [{ op: 'edit', path: String(args?.path ?? ''), old_text: String(args?.old_text ?? ''), new_text: String(args?.new_text ?? '') }], message: 'draft edit' }), signal: AbortSignal.timeout(10000) });
      if (!fr.ok) throw new HttpError(502, `draft apply HTTP ${fr.status}`);
      return await fr.json();
    }
    case 'app_draft_submit': {
      const aS = getApp(String(args?.slug ?? ''));
      const { base: bS, token: tS } = layerfsServiceBase();
      if (!bS) throw new HttpError(502, 'layerfs 服务未配置');
      const proj = layerfsProjectName(aS.slug);
      const mr = await fetch(bS.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(proj) + '/branches/release/drafts/' + encodeURIComponent(String(args?.draft ?? '')) + '/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tS ? { Authorization: `Bearer ${tS}` } : {}) }, body: JSON.stringify({ into: 'release' }), signal: AbortSignal.timeout(10000) });
      if (mr.status === 409) throw new HttpError(409, 'Conflict: 同路径已被并行草稿修改——本草稿不合并（后提者拒）'); // L8
      if (!mr.ok) throw new HttpError(502, `draft merge HTTP ${mr.status}`);
      const mj = await mr.json() as { commit_id?: string };
      if (!mj.commit_id) throw new HttpError(502, 'merge 无 commit_id');
      // 合并产物回读→走发布门禁生成新版本并激活（契约 §3）
      const cr = await fetch(bS.replace(/\/+$/, '') + '/v1/projects/' + encodeURIComponent(proj) + '/branches/release/commits/' + encodeURIComponent(mj.commit_id) + '/files', { headers: tS ? { Authorization: `Bearer ${tS}` } : {}, signal: AbortSignal.timeout(10000) });
      const cj = await cr.json() as { files: { path: string; content: string }[] };
      const out = publishAppBody({ slug: aS.slug, files: cj.files, changelog: String(args?.changelog ?? '[draft-merge]'), created_by: 'draft-submit' });
      return { ok: true, merged_commit: mj.commit_id, version: (out.body as any).version, note: '草稿已合并回发布线并激活' };
    }
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
      const sql = `SELECT * FROM sop_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 50`;
      return svc<SopService>('sop').runsQuery(sql, sqlArgs);
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
    case 'app_files_list': {
      const a = getApp(String(args?.slug ?? ''));
      const limit = pageLimit(args?.limit);
      const beforeId = pageBeforeId(args?.before_id);
      const rows = beforeId > 0
        ? svc<AppDataService>('appData').filePage(a.slug, beforeId, limit)
        : svc<AppDataService>('appData').filePage(a.slug, 0, limit);
      const items = (rows as any[]).map((r) => ({ ...r, url: `/api/apps/${a.slug}/files/${r.id}` }));
      return { slug: a.slug, items, count: items.length, has_more: rows.length === limit, next_before_id: rows.length === limit ? items[items.length - 1].id : null };
    }
    case 'app_files_upload': {
      // #164 P1②（批派令）：MCP 侧上传——base64 入 app_files（与 REST multipart 同表同链）
      const slug = String(args?.slug ?? '').trim();
      const name = fixFileName(String(args?.name ?? '').trim());
      const b64 = String(args?.content_base64 ?? '');
      if (!slug || !name || !b64) throw new HttpError(400, 'slug/name/content_base64 必填');
      const a = getApp(slug);
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw new HttpError(400, 'content_base64 解码为空');
      if (buf.length > UPLOAD_MAX) throw new HttpError(413, `文件超 50MB 上限（${buf.length}B）`);
      if (svc<AppDataService>('appData').fileCount(a.slug) >= 200) throw new HttpError(413, '该台文件数已达上限（200）'); // #193 F8：全量计数（原 filePage(0,1) 恒 1 永不触发）
      const dir = join(dataDir, 'uploads');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const safe = name.replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 80);
      const fname = `${Date.now().toString(36)}-${safe}`;
      const abs = join(dir, fname);
      writeFileSync(abs, buf);
      const rel = abs.replace(dataDir, '').replace(/\\/g, '/').replace(/^\/+/, '');
      const createdBy = String(args?.created_by ?? '').trim().slice(0, 128);
      const note = String(args?.note ?? '').trim().slice(0, 500);
      const r = svc<AppDataService>('appData').fileInsert(a.slug, name, String(args?.mime ?? 'application/octet-stream'), buf.length, rel, createdBy, note) as unknown as { lastInsertRowid: number | bigint };
      const id = Number(r.lastInsertRowid);
      return { ok: true, id, slug: a.slug, name, mime: String(args?.mime ?? 'application/octet-stream'), size: buf.length, note, url: `/api/apps/${a.slug}/files/${id}` };
    }
    default:
      throw new HttpError(400, `未知工具: ${name}`);
  }
}

// ---------- MCP 上游聚合（GH #20 P2：外部 MCP 服务以 <prefix>__<tool> 并入市场 /mcp） ----------
// 配置：settings.mcp_upstreams = JSON 数组 [{prefix,url,headers?,enabled?,toolCallTimeoutMs?}]
// prefix 规范 [a-z][a-z0-9]{0,15}（与本地工具名不冲突——本地工具无 __ 分隔）。
// 工具列表 30s 缓存（每请求不直打上游）；上游不可达时跳过其工具、不影响本地工具面。
interface McpUpstream { prefix: string; url: string; headers?: Record<string, string>; enabled?: boolean; toolCallTimeoutMs?: number }
const MCP_UPSTREAM_PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const upstreamToolCache = new Map<string, { at: number; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }>();
const UPSTREAM_CACHE_MS = 30_000;

function mcpUpstreams(): McpUpstream[] {
  try {
    const raw = getSettings()['mcp_upstreams'] ?? '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((u: any) => u && typeof u.prefix === 'string' && MCP_UPSTREAM_PREFIX_RE.test(u.prefix) && typeof u.url === 'string' && /^https?:\/\//.test(u.url) && u.enabled !== false);
  } catch {
    return [];
  }
}

async function upstreamRpc(u: McpUpstream, method: string, params: unknown, id = 1, clientIdent?: string): Promise<any> {
  const timeout = u.toolCallTimeoutMs && u.toolCallTimeoutMs > 0 ? u.toolCallTimeoutMs : 15_000;
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

/** 聚合工具面：本地 17 + 各上游（<prefix>__<name>）；上游失败静默跳过 */
async function mcpAggregatedTools(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]> {
  const out = [...MCP_TOOLS];
  const ups = mcpUpstreams();
  for (const u of ups) {
    const cached = upstreamToolCache.get(u.prefix);
    if (cached && Date.now() - cached.at < UPSTREAM_CACHE_MS) {
      out.push(...cached.tools.map((t) => ({ ...t, name: `${u.prefix}__${t.name}`, description: `[${u.prefix}] ${t.description}` })));
      continue;
    }
    try {
      const res = await upstreamRpc(u, 'tools/list', {}, 1);
      const tools = (res?.tools ?? []) as { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
      upstreamToolCache.set(u.prefix, {
        at: Date.now(),
        tools: tools.filter((t) => typeof t.name === 'string').map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object', properties: {} } })),
      });
      out.push(...tools.filter((t) => typeof t.name === 'string').map((t) => ({ name: `${u.prefix}__${t.name}`, description: `[${u.prefix}] ${t.description ?? ''}`, inputSchema: t.inputSchema ?? { type: 'object', properties: {} } })));
    } catch {
      /* 上游不可达：跳过，不影响本地工具面 */
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

app.get('/api/mcp/upstreams', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json(mcpUpstreams().map((u) => ({ prefix: u.prefix, url: u.url, enabled: u.enabled !== false, headers: Object.keys(u.headers ?? {}), toolCallTimeoutMs: u.toolCallTimeoutMs ?? 15000 })));
});

app.put('/api/mcp/upstreams', (req, res) => {
  if (!adminGuard(req, res)) return;
  const arr = req.body?.upstreams;
  if (!Array.isArray(arr)) bad('upstreams 必须是数组（整体替换语义）');
  const clean: McpUpstream[] = [];
  for (const u of arr) {
    if (!u || typeof u.prefix !== 'string' || !MCP_UPSTREAM_PREFIX_RE.test(u.prefix)) bad(`prefix 规范：[a-z][a-z0-9]{0,15}——${JSON.stringify(u?.prefix)}`);
    if (typeof u.url !== 'string' || !/^https?:\/\//.test(u.url)) bad(`上游 ${u.prefix} 的 url 必须是 http(s)://`);
    if (u.headers !== undefined && (typeof u.headers !== 'object' || u.headers === null || Object.values(u.headers).some((v) => typeof v !== 'string'))) bad(`上游 ${u.prefix} 的 headers 必须是字符串映射`);
    clean.push({ prefix: u.prefix, url: u.url, headers: u.headers ?? {}, enabled: u.enabled !== false, toolCallTimeoutMs: Number(u.toolCallTimeoutMs) || 15000 });
  }
  svc<SettingService>('setting').upsertStmt().run('mcp_upstreams', JSON.stringify(clean));
  upstreamToolCache.clear();
  res.json({ ok: true, upstreams: clean.map((u) => ({ prefix: u.prefix, url: u.url, enabled: u.enabled !== false })) });
});


// #284 缺省开（fail closed）：未设/空/on 均开网关，只有显式 MCP_GATEWAY=off 才关并在启动时告警；
// 其它值拒绝启动（防拼写错误静默放开）。重启漏带环境变量不再把 /mcp 退回匿名可调。
// 网关开而无 ADMIN_TOKEN 时控制面全 403，无法建会话 → /mcp 全 401（拒绝而非放开）。
const MCP_GATEWAY_RAW = process.env.MCP_GATEWAY ?? '';
if (!['', 'on', 'off'].includes(MCP_GATEWAY_RAW)) {
  console.error(`[#284] 拒绝启动：MCP_GATEWAY 只接受 on / off / 不设（当前值无法识别，不按关处理）`);
  process.exit(1);
}
const MCP_GATEWAY_ON = MCP_GATEWAY_RAW !== 'off';
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

// 控制面（全部 X-Admin-Token 常量时间 + Origin 空或同源；MCP 零会话/令牌/授权写工具——人工锁）
app.post('/api/mcp/sessions', (req, res) => {
  if (!adminGuard(req, res)) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().toLowerCase() : '';
  if (!MCP_SESSION_NAME_RE.test(name)) bad('name 规范：小写字母开头，小写字母/数字/连字符，≤64 字符');
  const dup = svc<McpService>('mcp').sessionByName(name);
  if (dup) bad(`会话名已存在: ${name}`);
  // mcp/ 命名空间独立于 dsh/<id8>（A2A 自报身份不混用；关联靠人登记 a2a_node 字段，仅关联不授权）
  const token = randomBytes(32).toString('hex');
  const r = svc<McpService>('mcp').sessionCreateStmt()
    .run(name, sha256Hex(token), '[]') as unknown as { lastInsertRowid: number | bigint }; // 新会话授权空=默认拒绝
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), name, token, grants: [], note: 'token 仅此一次出现——库存 sha256 无取回接口，请立即分发保管' });
});

app.get('/api/mcp/sessions', (req, res) => {
  if (!adminGuard(req, res)) return;
  const rows = svc<McpService>('mcp').sessions();
  res.json(rows.map((r: any) => ({ ...r, grants: JSON.parse(r.grants || '[]') })));
});

app.delete('/api/mcp/sessions/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  const hit = svc<McpService>('mcp').sessionById(id);
  if (!hit) throw new HttpError(404, `session not found: ${id}`);
  svc<McpService>('mcp').sessionRevoke(id); // 软吊销立即生效留审计
  res.json({ ok: true, revoked: id });
});

app.put('/api/mcp/sessions/:id/grants', (req, res, next) => {
  if (!adminGuard(req, res)) return;
  const id = Number(req.params.id);
  const sess = svc<McpService>('mcp').sessionById(id);
  if (!sess) throw new HttpError(404, `session not found: ${id}`);
  const raw = req.body?.grants;
  if (!Array.isArray(raw)) bad('grants 必须是工具名数组（整体替换语义）');
  // 注册表 = 本地工具 + 上游聚合工具（P2：taste__rules 等也可授权）
  void mcpRegisteredNames().then((registered) => {
    try {
      for (const g of raw) {
        if (typeof g !== 'string' || !registered.has(g)) bad(`未知工具名: ${JSON.stringify(g)}（合法面见 GET /api/mcp/tools）`);
      }
      svc<McpService>('mcp').sessionGrants(id, JSON.stringify(raw));
      res.json({ ok: true, id, grants: raw });
    } catch (e) {
      next(e);
    }
  }).catch(next);
});

app.get('/api/mcp/tools', (req, res, next) => {
  if (!adminGuard(req, res)) return;
  // 本地 + 上游聚合面（上游不可达时只列本地，不报错）
  void mcpAggregatedTools()
    .then((tools) => res.json(tools.map((t) => ({ name: t.name, description: t.description }))))
    .catch(next);
});

app.get('/api/mcp/calls', (req, res) => {
  if (!adminGuard(req, res)) return;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = svc<McpService>('mcp').calls(limit);
  res.json(rows);
});

// /mcp 网关化（MCP_GATEWAY=on）：Bearer 有效→会话；无效/缺失/吊销→401+WWW-Authenticate（含 initialize，无兼容期）
app.post('/mcp', async (req, res) => {
  const msg = req.body ?? {};
  const fail = (code: number, message: string) => res.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });

  // 网关会话判定 + 审计
  let sess: { id: number; name: string; grants: string[] } | null = null;
  if (MCP_GATEWAY_ON) {
    const auth = String(req.headers.authorization ?? '');
    const m = /^Bearer ([0-9a-f]{64})$/i.exec(auth);
    if (m) sess = mcpSessionByToken(m[1]);
    if (!sess) {
      mcp401Count += 1; // 401 不进审计只计数
      res.setHeader('WWW-Authenticate', 'Bearer realm="workbench-market mcp"');
      return res.status(401).json({ error: 'unauthorized: valid session token required', hint: '会话与令牌由管理员经 /api/mcp/sessions 创建分发' });
    }
    svc<McpService>('mcp').sessionTouched(sess.id);
  }
  const audit = (method: string, tool: string, ok: boolean, error: string, durationMs: number, args: unknown) => {
    if (!MCP_GATEWAY_ON || !sess) return;
    svc<McpService>('mcp').callInsertStmt()
      .run(sess.name, method, tool, ok ? 1 : 0, error, durationMs, sha256Hex(JSON.stringify(args ?? {}))); // 不存参数原文
  };
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
      return res.json({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: MCP_KNOWN_PROTOCOLS.includes(want) ? want : MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'workbench-market', version: '0.1.0', title: '工作台市场' },
        },
      });
    }
    if (msg.method === 'ping') {
      audit('ping', '', true, '', Date.now() - t0, null);
      return res.json({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
    if (msg.method === 'tools/list') {
      const all = await mcpAggregatedTools(); // 本地 17 + 上游（P2 聚合）
      const tools = sess ? all.filter((t) => sess!.grants.includes(t.name)) : all; // 按授权过滤
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
      if (sess && !sess.grants.includes(toolName)) {
        audit('tools/call', toolName, false, 'not found', Date.now() - t0, msg.params?.arguments);
        return fail(-32601, `Method not found: ${msg.method}`); // 与未知工具同文案族
      }
      try {
        // 上游路由（P2）：<prefix>__<tool> → 转发到对应上游 MCP
        const up = routeUpstream(toolName);
        const out = up
          ? await upstreamRpc(up.upstream, 'tools/call', { name: up.remoteTool, arguments: msg.params.arguments ?? {} }, 2, sess ? `mcp/${sess.name}` : undefined)
          : await callTool(toolName, msg.params.arguments ?? {}, sess ? `mcp:${sess.name}` : 'anonymous');
        audit('tools/call', toolName, true, '', Date.now() - t0, msg.params?.arguments);
        // 上游结果已是 MCP 形状（{content,isError?}）→ 原样透传（下游客户端语义无损）；
        // 本地工具结果是业务对象 → 序列化为 text content。
        if (up && out && typeof out === 'object' && Array.isArray((out as any).content)) {
          return res.json({ jsonrpc: '2.0', id: msg.id, result: out });
        }
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      } catch (e: any) {
        // 工具执行失败按 MCP 规范走 isError（协议层错误才用 JSON-RPC error）
        audit('tools/call', toolName, false, String(e?.message ?? e).slice(0, 200), Date.now() - t0, msg.params?.arguments);
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `执行失败：${e?.message || e}` }], isError: true } });
      }
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
import { installPortal, goPrefix, moduleProxy } from './portal.ts';

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
  const msg = String(err?.message ?? err);
  let status = err instanceof HttpError || err instanceof TaskIntakeError ? err.status : 500;
  if (status === 500 && VALIDATION_ERR_PREFIX.some((p) => msg.startsWith(p))) status = 400;
  if (status === 500) console.error('[server] unhandled:', err);
  res.status(status).json({ error: msg, ...(err instanceof HttpError && err.extra ? err.extra : {}) });
});

// 进程兜底日志（监督席顺查件 direct-db6fc70c③）：不吞异常只记栈——multer 等中间件内部 throw 不经 Express 链时留证
process.on('uncaughtException', (e) => { console.error('[fatal] uncaughtException:', e); });
process.on('unhandledRejection', (r) => { console.error('[fatal] unhandledRejection:', r); });

// ---------- 定期巡检 ----------
let timer: ReturnType<typeof setTimeout> | null = null;
let checking = false;
// 台驱逐冷却（与 a2a-net peer 驱逐冷却同名不同物·命名区分，direct-53caaed3）：
// 连续 down 的台进入 24h 冷却窗，窗内每窗只探一次（防 flapping）。up 即清零；内存态（重启清零，保守）。
const EVICT_COOLDOWN_MS = Number(process.env.A2A_EVICT_COOLDOWN_MS) > 0 ? Number(process.env.A2A_EVICT_COOLDOWN_MS) : 24 * 3_600_000; // 测试可加速
const downSince = new Map<number, number>();
const lastProbeAt = new Map<number, number>();
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
armPatrol();
// 模块级不能取服务（容器异步挂载）：巡检启动标记延到首次 armPatrol 后的下一拍写（行为等价）
setTimeout(() => {
  try { svc<SettingService>('setting').put('patrol_armed_at', new Date().toISOString()); } catch { /* 服务未就绪则跳过 */ }
}, 100).unref?.();

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
const goServer = registerSurface(app, 'market', PORT, () => {
  // #258 breaking：旧开关不再放行任何公网登记，只做兼容检测告警
  if (process.env.ALLOW_PUBLIC_NET === '1') console.warn('[R3] ALLOW_PUBLIC_NET=1: legacy flag no longer grants public registration; use WM_REGISTER_URL_ALLOWLIST exact entries.');
  console.log(`[R3] URL 准入 policy ${URL_POLICY.digest.slice(0, 12)}：精确许可 ${URL_POLICY.size} 条${URL_POLICY.duplicates ? `（去重 ${URL_POLICY.duplicates} 条）` : ''}`);
  {
    const gaps = legacyGaps(listWorkbenches().map((w) => ({ id: w.id, url: w.url })), URL_POLICY);
    // 迁移材料：存量行不删不停，只列按新规会被拒的 id + URL 摘要 + 原因（不出原 URL/query）
    if (gaps.length) console.warn(JSON.stringify({ event: 'workbench_url_legacy_gap', policy_digest: URL_POLICY.digest, count: gaps.length, rows: gaps }));
  }
  const odooTrust = trustedOdooOrigins();
  if (odooTrust.invalid.length) console.warn(`[SSO v1] WM_ODOO_ORIGINS/LC_ODOO_URL 有非法项（已忽略）：${odooTrust.invalid.join(', ')}`);
  if (odooTrust.origins.size === 0 && listWorkbenches().some((w) => isOdooLikeTarget(w.type, w.url))) console.warn('[SSO v1] 未设 WM_ODOO_ORIGINS / LC_ODOO_URL：门户不转发 Odoo 会话，Odoo 台免登不生效（台内会显示 Odoo 自己的登录页）——要免登请把 Odoo 台的源写进 WM_ODOO_ORIGINS');
  const lcProblem = lifecycleConfigProblem();
  if (lcProblem) console.warn(`[lifecycle] 生命周期源不可用：${lcProblem}`);
  const counts = svc<WorkbenchService>('workbench').count() as { n: number };
  console.log(`[workbench-market] server  http://127.0.0.1:${PORT}  (workbenches: ${counts.n}, web-dist: ${existsSync(webDist) ? 'served' : 'none'}, portal: /go/<id>/)`);
  console.log(SURFACE_PORTS.control ? `[workbench-market] control http://127.0.0.1:${SURFACE_PORTS.control}  （#292 M1 管理控制面：浏览器管理写只在这里收）` : '[workbench-market] control 面已关闭（WM_CONTROL_PORT=0）：浏览器管理写一律拒绝，只能用本机命令行');
  startRedis(); // SOP 状态层（生产 Redis；不可达自动降级直写 SQLite，不阻塞启动）
  // 启动自探测（监督席观察项：重载后状态悬空靠人 check-all 兜底已第 3 次）——
  // 延迟 8s 让依赖（上游台）就绪，跑一轮全测归真状态；单台失败不阻断
  const boot = setTimeout(() => { void patrol(); }, 8_000);
  boot.unref?.();
});

if (SURFACE_PORTS.control) registerSurface(app, 'control', SURFACE_PORTS.control);
if (contentCfg && contentRuntime) listenContentSurface(app, contentCfg, contentRuntime);

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
goServer.on('upgrade', (req, socket, head) => {
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
  if (!isOdooSessionTarget(w.url)) stripOdooSession(req.headers); // 同 HTTP 门户：Odoo 会话只转给可信 Odoo 源
  const upstreamHost = u.host; // host:port（authority 形态）
  if (req.headers.origin !== undefined) req.headers.origin = u.origin;
  req.headers.host = upstreamHost;
  (moduleProxy as unknown as { upgrade: (rq: typeof req, sk: typeof socket, hd: typeof head) => void }).upgrade(req, socket, head);
});
