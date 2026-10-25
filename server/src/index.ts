import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, posix, extname, sep as pathSep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import multer from 'multer';
import { svc } from './context.ts';
import type { WorkbenchService } from './services/workbench.ts';
import type { SopService } from './services/sop.ts';
import type { AppService } from './services/app.ts';
import type { AppDataService } from './services/app-data.ts';
import type { CookieService } from './services/cookie.ts';
import type { CockpitService } from './services/cockpit.ts';
import type { SettingService } from './services/setting.ts';
import { db, getSettings, dataDir, rowToWorkbench, rowToCockpit, type WorkbenchRow, type TypeRow, type CockpitRow, type PanelConfig, type AppRow, type AppVersionRow, type SopRunRow } from './db.ts';
import { assertHttpUrl, composeProbeUrl, probe } from './health.ts';
import { parse as parseYaml } from 'yaml';
import { startRedis, redisHealthy, runStateSave, runStateRestore, runStateLoad, runStateRetire, runActiveIds } from './redis.ts';
import { adminTokenOk, buildAgentCard, a2aKeyPath, sopNode8, a2aDirectHandle, a2aSendOutbound, formatA2aReceipt, MARKET_TEAM } from './a2a.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
// issue #1：CORS 从全开放收紧为白名单——生产形态（web/dist 由本服务同源托管）不需要跨源；
// 仅 web dev（vite 5173，其 /api 代理是同源转发、但直连调试场景保留）放行本机回环源。
// /mcp 为 StreamableHTTP POST（非浏览器 fetch 场景不受 CORS 约束；浏览器 MCP 客户端经同源门户）。
const CORS_ALLOW = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ALLOW.has(origin)) return callback(null, true);
    return callback(null, false); // 不回 ACAO 头 = 浏览器侧拒绝读响应
  },
}));
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
const REMOTE_ALLOW_EXACT = new Set(['/mcp', '/.well-known/agent-card.json', '/a2a/direct']);
// ---------- 端点命中计数（总工程师 B 类单：采纳监测 instrumentation）----------
// 必须挂在所有业务路由之前（Express 按注册序匹配，路由先响应则后续 use 不再执行）
app.use(endpointStatsMiddleware());

const REMOTE_ALLOW_PREFIX = [/^\/api\/apps\/[a-z0-9-]{1,64}\/(data|files)(\/|$)/];
app.use((req, res, next) => {
  const ip = String(req.socket.remoteAddress ?? '');
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (isLoopback || req.method === 'GET' || req.method === 'HEAD') return next(); // 读面不拦（掩码已有）；本机全放
  const p = (req.url ?? '').split('?')[0];
  if (REMOTE_ALLOW_EXACT.has(p)) return next();
  if (REMOTE_ALLOW_PREFIX.some((re) => re.test(p))) return next(); // 自产台数据/文件面（主人裁定 A）
  if (p.startsWith('/api/')) {
    // 远程 /api/* 写：走 adminGuard（函数声明有提升，请求期已定义）
    if (adminGuard(req, res)) return next();
    return; // adminGuard 已回 403
  }
  return next(); // 其余远程非 /api 面（如 /go/ 门户读型代理）不在本判据范围
});

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch(next);
  };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
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
    // 以 / 开头 = 市场自产台内部路径（本服务静态托管）；其余必须是 http(s)
    if (!u.startsWith('/')) assertHttpUrl(u);
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

// CRUD 共用核心（REST 与 MCP workbench_register/update/unregister 同链）：
// MCP 面不接受 auth 字段（凭据只经人工 REST/表单——安全边界内置）
function workbenchCreateCore(body: any): ReturnType<typeof rowToWorkbench> {
  const f = validateWorkbenchBody(body);
  const r = svc<WorkbenchService>('workbench').createByNamed({ type: 'web', icon: '', description: '', category: '', tags: '[]', enabled: 1, health_path: '', sort: 0, auth_config: '', ...f }) as unknown as { lastInsertRowid: number | bigint };
  const row = svc<WorkbenchService>('workbench').byId(Number(r.lastInsertRowid)) as unknown as WorkbenchRow;
  return rowToWorkbench(row);
}

function workbenchUpdateCore(id: number, body: any): ReturnType<typeof rowToWorkbench> {
  const cur = svc<WorkbenchService>('workbench').byId(id) as unknown as WorkbenchRow | undefined;
  if (!cur) throw new HttpError(404, `workbench not found: ${id}`);
  const f = validateWorkbenchBody(body, true);
  // 掩码回传保护（url 面）：编辑表单从 API 取到的是掩码值，原样回传视为「未变更」
  if (f.url !== undefined && f.url.includes('=****') && f.url !== cur.url) delete f.url;
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

app.post('/api/workbenches', (req, res) => {
  res.status(201).json(workbenchCreateCore(req.body));
});

app.get('/api/workbenches/:id', (req, res) => {
  const row = svc<WorkbenchService>('workbench').byId(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
  if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
  // 与列表同策略掩码（issue #2/#3：auth.value 同为无认证出口的明文凭据向量）；
  // 编辑流由 PUT 掩码回传保护兜底（掩码回传=不变更，DB 原值不毁）
  res.json(maskForApi(rowToWorkbench(row)));
});

app.put('/api/workbenches/:id', (req, res) => {
  res.json(workbenchUpdateCore(Number(req.params.id), req.body));
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
    target = composeProbeUrl(w.url, w.health_path || t?.health_path || '');
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

/** 发布/重发逻辑（REST 与 MCP 工具共用）：返回响应体与状态码 */
function publishAppBody(b: any): { status: number; body: object } {
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) bad('slug 必须是小写字母/数字/连字符（≤64 字符，字母或数字开头）');
  const kind = b.kind === 'sop' ? 'sop' : 'app';
  const files = validateAppFiles(b.files, kind);
  const existing = svc<AppService>('app').bySlug(slug) as unknown as AppRow | undefined;
  if (existing && existing.kind !== kind) bad(`slug 已被 ${existing.kind} 类台占用，kind 不可切换`);

  // SOP 类发布面：sop.yaml 必在且可解析、changelog 必填（版本化治理）
  let changelog = '';
  if (kind === 'sop') {
    const yf = files.find((f) => f.path === 'sop.yaml');
    if (!yf) throw new HttpError(400, 'SOP 发布必须包含 sop.yaml（混合源：结构化字段 + 步骤内嵌 HTML）');
    parseSopManifest(yf.content);
    changelog = typeof b.changelog === 'string' ? b.changelog.trim() : '';
    if (!changelog) throw new HttpError(400, 'SOP 发布必须携带 changelog（本版改了什么）');
  } else if (typeof b.changelog === 'string' && b.changelog.trim()) {
    changelog = b.changelog.trim();
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
  // app 类发布即入册；sop 类走状态机——draft 不入册，publish 时入册
  const workbench_id = appRow.kind === 'app' ? syncWorkbenchRegistration(appRow) : 0;
  return { status: existing ? 200 : 201, body: { ok: true, slug: appRow.slug, version, workbench_id, kind: appRow.kind, status: appRow.status, app: appDetail(appRow) } };
}

app.post('/api/apps', (req, res) => {
  const r = publishAppBody(req.body ?? {});
  res.status(r.status).json(r.body);
});

app.get('/api/apps/:slug', (req, res) => {
  res.json(appDetail(getApp(req.params.slug)));
});

// 版本回滚：activate 指定历史版本为当前生效快照（文件不动，只切换指针）；REST 与 MCP 共用
function activateAppVersion(slug: string, vRaw: unknown): object {
  const a = getApp(slug);
  const v = Number(vRaw);
  if (!Number.isInteger(v) || v < 1) bad('version 必须是正整数');
  const hit = svc<AppService>('app').versionExists(a.id, v) as { version: number } | undefined;
  if (!hit) throw new HttpError(404, `版本不存在: ${v}`);
  svc<AppService>('app').setActiveVersion(a.id, v);
  return appDetail(getApp(a.slug));
}

app.post('/api/apps/:slug/activate', (req, res) => {
  res.json(activateAppVersion(req.params.slug, req.body?.version));
});

app.delete('/api/apps/:slug', (req, res) => {
  const a = getApp(req.params.slug);
  rmSync(join(appsRoot, a.slug), { recursive: true, force: true });
  svc<AppService>('app').versionsDelete(a.id);
  svc<AppService>('app').delete(a.id);
  // 数据面/文件面一并清理（派单 direct-22838fab 与文件提交面）
  svc<AppDataService>('appData').dataDelete(a.slug);
  const files = svc<AppDataService>('appData').filePaths(a.slug) as { storage_path: string }[];
  for (const f of files) { try { rmSync(join(dataDir, f.storage_path), { force: true }); } catch { /* 已删 */ } }
  svc<AppDataService>('appData').filesDelete(a.slug);
  // issue #6：SOP 台的注册 url 是 /sop/<slug>/（非 /apps/），删除时必须一并清理，否则留孤儿工作台（门户 404）
  svc<WorkbenchService>('workbench').deleteByAppUrls(`/apps/${a.slug}/`, `/sop/${a.slug}/`);
  res.json({ ok: true, deleted: a.slug });
});

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
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), slug: a.slug, created_at: new Date().toISOString() });
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
  // 评审 #25：必须先校验台存在再让 multer 落盘（否则 404 后留孤儿文件，远程可无限灌盘）
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
      const r = svc<AppDataService>('appData').fileInsertStmt()
        .run(a.slug, originalName, req.file.mimetype || 'application/octet-stream', req.file.size, rel, created_by) as unknown as { lastInsertRowid: number | bigint };
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

app.get('/api/apps/:slug/files/:id', (req, res) => {
  const a = getApp(req.params.slug);
  const row = svc<AppDataService>('appData').fileById(Number(req.params.id), a.slug) as any;
  if (!row) throw new HttpError(404, `file not found: ${req.params.id}`);
  const abs = join(dataDir, row.storage_path);
  if (!existsSync(abs)) throw new HttpError(404, 'stored file missing on disk');
  res.setHeader('content-type', row.mime || 'application/octet-stream');
  res.setHeader('content-length', String(row.size));
  // 附件下载语义（原始文件名）——inline 由 mime 决定，避免 XSS：非白名单 mime 强制 attachment
  const inlineOk = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/(plain|csv))$/.test(row.mime);
  const disp = inlineOk ? 'inline' : 'attachment';
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
  const a = sopTransition(req.params.slug, ['draft', 'deprecated'], 'published', '发布');
  // publish 附带发布说明（可选）记入当前版本 changelog 末尾
  if (typeof req.body?.note === 'string' && req.body.note.trim()) {
    svc<AppService>('app').appendChangelog(a.id, a.active_version, `\n[publish] ${req.body.note.trim()}`);
  }
  res.json(appDetail(getApp(a.slug)));
});

app.post('/api/sops/:slug/deprecate', (req, res) => {
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
  if (rest === '' || rest === '/' || rest === 'index.html') {
    // issue #11：非 published 不再渲染下发完整 Runner 页面（信息泄漏面）——403 瘦身为一行
    if (hit.app.status !== 'published') {
      return res.status(403).type('text').send(`SOP ${m[1]} 状态为 ${hit.app.status}，未上架不可执行\n`);
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
  return res.sendFile(abs);
});

// ---------- SOP run API：分层治理（Redis 热态 + SQLite 真源）----------
// core 函数为唯一持久化链：REST 与 MCP（sop_run_* 工具）共用——agent 更新持久化执行数据
// 与人在 Runner 页填数据走同一条链（GH #17 P4 的执行数据面提前交付，不经版本发布）。
const checkpointAt = new Map<number, number>(); // runId → last checkpoint ms（进程内）
const CHECKPOINT_MS = 30_000;

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
function sopRunStartCore(slugRaw: string, startedByRaw: string): { id: number; slug: string; version: number; status: string; data: Record<string, unknown> } {
  const slug = slugRaw.trim().toLowerCase();
  if (!slug) bad('slug 必填');
  const hit = readActiveManifest(slug);
  if (!hit) throw new HttpError(404, `SOP not found: ${slug}`);
  if (hit.app.status !== 'published') throw new HttpError(409, `SOP 状态为 ${hit.app.status}，仅 published 可执行`);
  const started_by = startedByRaw.trim();
  const r = svc<SopService>('sop').runCreate(slug, hit.app.active_version, started_by) as unknown as { lastInsertRowid: number | bigint };
  const id = Number(r.lastInsertRowid);
  void runStateRestore(id, { slug, version: hit.app.active_version, status: 'running', started_by, updated_at: Date.now() }, {}); // Redis 初始化热态（降级态静默跳过）
  return { id, slug, version: hit.app.active_version, status: 'running', started_by, data: {} };
}

/** 更新持久化数据（任意步骤键值；Redis 热写 + 30s checkpoint / 降级直写 SQLite） */
async function sopRunStepSaveCore(id: number, stepKeyRaw: string, value: unknown): Promise<{ ok: boolean; id: number; stepKey: string; persisted: string }> {
  const stepKey = stepKeyRaw.trim();
  if (!stepKey) bad('stepKey 必填');
  if (!/^[\w-]+$/.test(stepKey)) bad('stepKey 仅允许字母/数字/_/-');
  const row = sopRunRow(id);
  if (row.status !== 'running') throw new HttpError(409, `run ${id} 已 ${row.status}，不可再写`);

  const hotOk = await runStateSave(id, { slug: row.sop_slug, version: row.sop_version, status: 'running', started_by: row.started_by, updated_at: Date.now() }, stepKey, value ?? null);
  const now = Date.now();
  const last = checkpointAt.get(id) ?? 0;
  if (!hotOk || now - last >= CHECKPOINT_MS) {
    // 降级直写 / 30s checkpoint：热数据整体沉淀 SQLite（真源）
    let source = mergeRunData(row, stepKey, value ?? null);
    if (hotOk) {
      const hot = await runStateLoad(id);
      if (hot) source = JSON.stringify(hot.data);
    }
    svc<SopService>('sop').runUpdateData(id, source);
    checkpointAt.set(id, now);
  }
  return { ok: true, id, stepKey, persisted: hotOk ? 'redis+checkpoint' : 'sqlite' };
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
  const receipt = receiptStatusOf(id);
  const hot = await runStateLoad(id);
  if (hot) return { id, sop_slug: hot.meta.slug, sop_version: hot.meta.version, status: hot.meta.status, started_by: hot.meta.started_by, data: hot.data, receipt };
  const row = sopRunRow(id);
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  if (row.status === 'running' && redisHealthy()) {
    void runStateRestore(id, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data); // 回填热态
  }
  return { id: row.id, sop_slug: row.sop_slug, sop_version: row.sop_version, status: row.status, started_by: row.started_by, data, receipt };
}

/** 归档（热态全量沉淀 SQLite；Redis 条目 1h 平滑淘汰） */
async function sopRunFinishCore(id: number): Promise<{ ok: boolean; id: number; status: string; steps: number }> {
  const row = sopRunRow(id);
  if (row.status !== 'running') throw new HttpError(409, `run ${id} 已 ${row.status}`);
  let data = row.data || '{}';
  const hot = await runStateLoad(id);
  if (hot && Object.keys(hot.data).length > 0) data = JSON.stringify(hot.data);
  svc<SopService>('sop').runFinish(id, data);
  await runStateRetire(id); // 退出活跃索引 + Redis 条目 1h 平滑淘汰
  checkpointAt.delete(id);
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
  try {
    if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
    const row = sopRunRow(Number(req.params.id));
    if (row.status !== 'running') throw new HttpError(409, `run ${req.params.id} 已 ${row.status}，不可再上传`);
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
      res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), run_id: runId, name: originalName, mime: req.file.mimetype, size: req.file.size, url: `/api/sop/runs/${runId}/files/${Number(r.lastInsertRowid)}` });
    } catch (e) { next(e); }
  });
});
app.get('/api/sop/runs/:id/files', (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) throw new HttpError(404, `run not found: ${req.params.id}`);
  const runId = Number(req.params.id);
  sopRunRow(runId); // 404 语义与 run 一致
  const items = (svc<SopService>('sop').runFiles(runId) as any[]).map((f) => ({ ...f, url: `/api/sop/runs/${runId}/files/${f.id}` }));
  res.json({ run_id: runId, items, count: items.length });
});
app.get('/api/sop/runs/:id/files/:fileId', (req, res) => {
  if (!/^\d+$/.test(String(req.params.id)) || !/^\d+$/.test(String(req.params.fileId))) throw new HttpError(404, 'file not found');
  const runId = Number(req.params.id);
  const row = svc<SopService>('sop').runFileById(runId, Number(req.params.fileId)) as any;
  if (!row) throw new HttpError(404, `file not found: ${req.params.fileId}`);
  const abs = join(dataDir, row.storage_path);
  if (!existsSync(abs)) throw new HttpError(404, 'stored file missing on disk');
  res.setHeader('content-type', row.mime || 'application/octet-stream');
  res.setHeader('content-length', String(row.size));
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name || 'file')}`);
  res.setHeader('x-content-type-options', 'nosniff');
  createReadStream(abs).pipe(res);
});

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
  // 快路径：Redis 活跃索引；降级态回落 SQLite
  const ids = await runActiveIds();
  if (ids.length > 0) {
    const rows = ids.map((id) => svc<SopService>('sop').runByIdRunning(id) as unknown as SopRunRow | undefined).filter(Boolean) as SopRunRow[];
    return res.json(rows);
  }
  const rows = svc<SopService>('sop').runsRunning() as unknown as SopRunRow[];
  res.json(rows);
}));

app.get('/api/stats', (_req, res) => { res.json(statsPayload()); });

// ---------- 统一待办（omni-inbox · 总工程师设计 9c5557c1c0）：只读聚合 ----------
app.get('/api/tasks', wrap(async (_req, res) => {
  const payload = await collectTasks(svc<SopService>('sop') as never);
  res.json(payload);
}));

app.get('/api/sop/runs', (req, res) => {
  // P4（F7）：待验收列表 = running 且有派单来源（a2a_run_ctx 有 callback/task_id），不含人自己开的
  if (req.query.dispatched === '1') {
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
  res.json(await sopRunGetCore(Number(req.params.id)));
}));

app.put('/api/sop/runs/:id(\\d+)', wrap(async (req, res) => {
  res.json(await sopRunStepSaveCore(Number(req.params.id), String(req.body?.stepKey ?? ''), req.body?.value));
}));

app.post('/api/sop/runs/:id(\\d+)/finish', wrap(async (req, res) => {
  res.json(await sopRunFinishCore(Number(req.params.id)));
}));

// ---------- 自产台静态托管：GET /apps/:slug/* → DATA_DIR/apps/<slug>/v<active>/* ----------
function serveApp(req: express.Request, res: express.Response) {
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
  const root = join(appsRoot, m[1], `v${a.active_version}`);
  let rel = posix.normalize(rest || 'index.html');
  if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = join(root, rel);
  if (!abs.startsWith(root)) return res.status(400).json({ error: '路径非法' });
  res.setHeader('X-App-Version', `v${a.active_version}`);
  if (!existsSync(abs)) {
    // 无扩展名的深链回退到 index.html（SPA 路由习惯）
    if (!posix.extname(rel)) return res.sendFile(join(root, 'index.html'));
    return res.status(404).json({ error: `file not found: ${rel}` });
  }
  res.sendFile(abs);
}
// 必须在 web/dist SPA fallback 之前注册
app.get(/^\/apps\/[a-z0-9][a-z0-9-]*(\/.*)?$/, serveApp);

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
function isLoopbackReq(req: express.Request): boolean {
  const ip = String(req.socket.remoteAddress ?? '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

app.get('/api/admin-token/state', (req, res) => {
  res.json({
    source: process.env.ADMIN_TOKEN ? 'env' : (dbAdminTokenSet() ? 'db' : 'none'),
    settable: !process.env.ADMIN_TOKEN && isLoopbackReq(req), // env 未设时可由本机页面设置
  });
});

app.put('/api/admin-token', (req, res) => {
  if (!isLoopbackReq(req)) return res.status(403).json({ error: '仅本机可设置管理员口令' });
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
  if (!isLoopbackReq(req)) return res.status(403).json({ error: '仅本机可清除管理员口令' });
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
  const allowed = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'a2a_peers', 'mcp_upstreams'];
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
  // 导入侧对掩码行跳过/剥除（见 import 循环）——掩码数据永不落库。
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

app.post('/api/import', (req, res) => {
  const b = req.body ?? {};
  if (!Array.isArray(b.workbenches)) bad('导入文件缺少 workbenches 数组');
  // issue #7：mode 支持 query 优先（README 的 ?mode=replace 写法），body.mode 次之
  const modeRaw = (typeof req.query.mode === 'string' ? req.query.mode : b.mode) ?? 'merge';
  const mode = modeRaw === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace') {
    svc<WorkbenchService>('workbench').deleteAll();
    svc<WorkbenchService>('workbench').typeDeleteAllExcept('web');
  }
  const insType = svc<WorkbenchService>('workbench').typeInsertIgnoreStmt();
  if (Array.isArray(b.types)) {
    for (const t of b.types) insType.run(t.key, t.name, String(t.icon ?? ''), t.default_port ?? null, t.health_method ?? 'GET', String(t.health_path ?? '/'), t.expect_status ?? null, String(t.description ?? ''));
  }
  const ins = svc<WorkbenchService>('workbench').importInsertStmt();
  let imported = 0;
  for (const w of b.workbenches) {
    // issue #7：自产台/SOP 注册行的 url 是市场内部路径（/ 开头）——断言 http URL 会把它们
    // 静默丢掉（replace 清库后导回再丢 = 注册永久消失）；内部路径直接放行
    if (!String(w.url).startsWith('/')) {
      try { assertHttpUrl(String(w.url)); } catch { continue; }
    }
    // 导出脱敏配套：掩码行（url 含 =****）不落库——掩码数据写库会毁真实 query 门；
    // 需要完整恢复请用 ?reveal=1 的导出文件
    if (String(w.url).includes('=****')) continue;
    let authCfg = '';
    if (w.auth && (w.auth.type === 'bearer' || w.auth.type === 'basic') && typeof w.auth.value === 'string' && w.auth.value) {
      // auth.value 掩码（****）同样剥除——凭据为空导入，由人重新配置
      if (w.auth.value !== '****') authCfg = JSON.stringify({ type: w.auth.type, value: w.auth.value });
    }
    ins.run(
      String(w.name ?? '未命名'), String(w.url), String(w.type ?? 'web'), String(w.icon ?? ''),
      String(w.description ?? ''), String(w.category ?? ''),
      JSON.stringify(Array.isArray(w.tags) ? w.tags : []), w.enabled === false ? 0 : 1,
      String(w.health_path ?? ''), Number(w.sort) || 0, authCfg
    );
    imported += 1;
  }
  // PR#15 评审吸收的增量思路：replace 重排自增 id 后，驾驶舱面板里指向旧 id 的引用已成悬空
  // （保存布局恒 400）——导入完成后全量剔除不存在引用（比按 id 精确清理更通用，也清历史遗留）
  {
    const wbExists = (id: number) => !!svc<WorkbenchService>('workbench').exists(id);
    for (const c of svc<CockpitService>('cockpit').all() as unknown as CockpitRow[]) {
      let panels: PanelConfig[];
      try { panels = JSON.parse(c.layout_config || '[]'); } catch { continue; }
      // 待办卡 kind='tasks' 以 workbenchId=0 占位、不引用工作台，不参与悬空剔除
      const kept = panels.filter((p) => p.kind === 'tasks' || wbExists(p.workbenchId));
      if (kept.length !== panels.length) {
        svc<CockpitService>('cockpit').setLayout(c.id, JSON.stringify(kept));
      }
    }
  }
  res.json({ ok: true, mode, imported, skipped: b.workbenches.length - imported });
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

function adminGuard(req: express.Request, res: express.Response): boolean {
  if (!adminTokenCheck(req.headers['x-admin-token'])) {
    res.status(403).json({ error: '需要有效的 X-Admin-Token（管理员口令未设置时一律拒绝；可在设置页手动设置）' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
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

function maskKey(v: string): string {
  return v ? '****' : '';
}

app.get('/api/sops/:slug/bindings', (req, res) => {
  if (!adminGuard(req, res)) return;
  const a = getApp(req.params.slug);
  if (a.kind !== 'sop') throw new HttpError(400, `${a.slug} 不是 SOP 台`);
  const rows = svc<SopService>('sop').bindings(a.slug) as unknown as {
    id: number; sop_slug: string; node: string; mode: string; remote_api_key: string; revoked_at: string; created_by: string; created_at: string;
  }[];
  // remote_api_key 与工作台凭据同规：列表/详情一律掩码，不进 MCP、不进导出
  res.json(rows.map((r) => ({ ...r, remote_api_key: maskKey(r.remote_api_key) })));
});

app.post('/api/sops/:slug/bindings', (req, res) => {
  if (!adminGuard(req, res)) return;
  const a = getApp(req.params.slug);
  if (a.kind !== 'sop') throw new HttpError(400, `${a.slug} 不是 SOP 台`);
  const b = req.body ?? {};
  const node = typeof b.node === 'string' ? b.node.trim() : '';
  const mode = b.mode === 'run' ? 'run' : 'read';
  // 绑定对象是具体会话节点（dsh/<id8> 形态）或队名（队名绑定时回执广播到队——设计取舍 2 以节点为准，队名允许但提示）
  if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9_-]{0,63}$/i.test(node)) bad('node 形态：<zone>/<id8>，如 dsh/1a2b3c4d');
  const remoteKey = typeof b.remote_api_key === 'string' ? b.remote_api_key.trim() : '';
  // P3：回执地址由人写在绑定上（评审席裁定：派单请求体自报的 callback 一律不用于投递）
  const callbackUrlRaw = typeof b.callback_url === 'string' ? b.callback_url.trim() : '';
  if (callbackUrlRaw !== '' && !/^https?:\/\/[^\s]+$/.test(callbackUrlRaw)) bad('callback_url 必须是 http(s):// 根地址');
  const callbackUrl = mode === 'read' ? '' : callbackUrlRaw.replace(/\/+$/, '');
  const r = svc<SopService>('sop').bindingCreateFull(a.slug, node, mode, remoteKey, callbackUrl, 'admin') as unknown as { lastInsertRowid: number | bigint };
  sopNode8(a.slug); // 确保节点短 id 已生成（上卡用）
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), node, mode, remote_api_key: maskKey(remoteKey) });
});

app.delete('/api/sops/:slug/bindings/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  const a = getApp(req.params.slug);
  const id = Number(req.params.id);
  const hit = svc<SopService>('sop').bindingExists(id, a.slug) as { id: number } | undefined;
  if (!hit) throw new HttpError(404, `binding not found: ${id}`);
  // 软撤销（留审计）：卡片即下线该 SOP（若无其他有效绑定）
  svc<SopService>('sop').bindingRevoke(id);
  res.json({ ok: true, revoked: id });
});

// /a2a/direct（P2）：准入开放——有效绑定 + 同 context 续 run + 上游幂等族 + 512KiB + DELIVERED 形状。
// 查无 SOP 仍 404 不泄露；无绑定/draft/mode 不足 → 200 TASK_STATE_FAILED -32000（对齐上游 admission 形状）。
// ADMIN_TOKEN 未设置时绑定面休眠（主人裁定：内网信任模型）——direct 对无绑定的 SOP 自然全拒。
app.post('/a2a/direct', express.json({ limit: '600kb' }), (req, res) => {
  const rawBytes = Number(req.headers['content-length'] ?? 0) || JSON.stringify(req.body ?? {}).length;
  // run 操作桥（P2 note 写入走 sop_runs 的哑数据面：step_key=note-<ts> 追加不覆盖）
  const runOps = {
    start: (slug: string, startedBy: string): number => sopRunStartCore(slug, startedBy).id,
    saveNote: (runId: number, text: string): void => {
      const row = sopRunRow(runId);
      if (row.status !== 'running') throw new HttpError(409, `run ${runId} 已 ${row.status}，不可再写`);
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
      const notes = Array.isArray(data['a2a-notes']) ? (data['a2a-notes'] as unknown[]) : [];
      notes.push({ at: new Date().toISOString(), text });
      data['a2a-notes'] = notes;
      svc<SopService>('sop').runUpdateData(runId, JSON.stringify(data));
    },
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
    const out = a2aDirectHandle(req.body, rawBytes, runOps);
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

import { renderSopRunner } from './sop-runner.ts';
import { collectTasks } from './tasks.ts';
import { endpointStatsMiddleware, statsPayload } from './endpoint-stats.ts';

// ---------- MCP 生产通道（StreamableHTTP · stateless：AI 会话直连市场，零依赖手写 JSON-RPC） ----------
const MCP_PROTOCOL = '2025-03-26';
const MCP_KNOWN_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

async function callTool(name: string, args: any): Promise<unknown> {
  switch (name) {
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
    case 'app_publish':
      return publishAppBody({ ...args, created_by: args?.created_by || 'mcp' }).body;
    case 'app_activate':
      return activateAppVersion(String(args?.slug), args?.version);
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
    case 'sop_run_get':
      return sopRunGetCore(Number(args?.run_id));
    case 'sop_run_list': {
      const slug = typeof args?.slug === 'string' ? args.slug : '';
      const status = typeof args?.status === 'string' ? args.status : '';
      const where: string[] = [];
      const sqlArgs: unknown[] = [];
      if (slug) { where.push('sop_slug = ?'); sqlArgs.push(slug); }
      if (status) { where.push('status = ?'); sqlArgs.push(status); }
      const sql = `SELECT id, sop_slug, sop_version, status, started_by, started_at, updated_at, finished_at FROM sop_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 50`;
      return svc<SopService>('sop').runsQuery(sql, sqlArgs);
    }
    case 'sop_run_finish':
      return sopRunFinishCore(Number(args?.run_id));
    // 工作台注册 CRUD（agent 登记外部台——与 REST 同链；凭据字段不接受：传入即拒）
    case 'workbench_register': {
      if (args?.auth !== undefined) throw new HttpError(400, '凭据不接受 MCP 写入——请人工经市场页配置');
      const w = workbenchCreateCore(args);
      return maskForApi(w);
    }
    case 'workbench_update': {
      if (args?.auth !== undefined) throw new HttpError(400, '凭据不接受 MCP 写入——请人工经市场页配置');
      const { id: _ignored, ...rest } = args ?? {};
      const w = workbenchUpdateCore(Number(args?.id), rest);
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


// 合并与激活解耦：代码进 main 可评审；激活=主人同设 ADMIN_TOKEN+MCP_GATEWAY=on 重启
// （单设 MCP_GATEWAY 而无 ADMIN_TOKEN 时控制面全 403，无法建会话 → /mcp 全 401，拒绝半激活）。
const MCP_GATEWAY_ON = process.env.MCP_GATEWAY === 'on';
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
          : await callTool(toolName, msg.params.arguments ?? {});
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
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback 只兜「路由路径」：静态资源（/assets/*、带扩展名文件）不存在的直接 404——
  // 否则旧缓存 index.html 引用的已删 hash 会被回成 200 text/html，前端炸 MIME 错且难定位（实盘踩坑）
  app.get(/^(?!\/api\/|\/assets\/).*/, (_req, res, next) => {
    if (/\.[A-Za-z0-9]+$/.test(_req.path)) return next(); // 带扩展名的文件请求不兜底
    res.sendFile(join(webDist, 'index.html'));
  });
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
}

// ---------- 统一错误出口 ----------
// issue #8：校验类普通 Error（assertHttpUrl 的「非法 URL/仅支持 http」）统一映射 400——
// 输入校验错误不得 500 泄内部细节。
const VALIDATION_ERR_PREFIX = ['非法 URL', '仅支持 http'];
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = String(err?.message ?? err);
  let status = err instanceof HttpError ? err.status : 500;
  if (status === 500 && VALIDATION_ERR_PREFIX.some((p) => msg.startsWith(p))) status = 400;
  if (status === 500) console.error('[server] unhandled:', err);
  res.status(status).json({ error: msg });
});

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

const goServer = app.listen(PORT, () => {
  const counts = svc<WorkbenchService>('workbench').count() as { n: number };
  console.log(`[workbench-market] server  http://127.0.0.1:${PORT}  (workbenches: ${counts.n}, web-dist: ${existsSync(webDist) ? 'served' : 'none'}, portal: /go/<id>/)`);
  startRedis(); // SOP 状态层（生产 Redis；不可达自动降级直写 SQLite，不阻塞启动）
  // 启动自探测（监督席观察项：重载后状态悬空靠人 check-all 兜底已第 3 次）——
  // 延迟 8s 让依赖（上游台）就绪，跑一轮全测归真状态；单台失败不阻断
  const boot = setTimeout(() => { void patrol(); }, 8_000);
  boot.unref?.();
});

// WebSocket 升级（Jupyter kernel / MCP / DSH web 实时通道等长连接走 /go/ 代理）。
// 关键：upgrade 事件不流经 Express 中间件链——前置中间件设置的 goOrigin/goBase/goQuery/goAuth
// 在这里全部不存在，必须对 upgrade 请求重做同样的准备，否则 router 兜底到 http://127.0.0.1（80 端口
// 无服务）→ DSH 台经门户打开后 WS 永远连不上（页面「重新连接中…」，实测踩坑）。
goServer.on('upgrade', (req, socket, head) => {
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
  const upstreamHost = u.host; // host:port（authority 形态）
  if (req.headers.origin !== undefined) req.headers.origin = u.origin;
  req.headers.host = upstreamHost;
  (moduleProxy as unknown as { upgrade: (rq: typeof req, sk: typeof socket, hd: typeof head) => void }).upgrade(req, socket, head);
});
