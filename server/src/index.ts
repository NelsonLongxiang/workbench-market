import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, dataDir, rowToWorkbench, rowToCockpit, type WorkbenchRow, type TypeRow, type CockpitRow, type PanelConfig, type AppRow, type AppVersionRow, type SopRunRow } from './db.ts';
import { assertHttpUrl, composeProbeUrl, probe } from './health.ts';
import { parse as parseYaml } from 'yaml';
import { startRedis, redisHealthy, runStateSave, runStateRestore, runStateLoad, runStateRetire, runActiveIds } from './redis.ts';
import { adminTokenOk, buildAgentCard, a2aKeyPath, sopNode8 } from './a2a.ts';

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
app.use(express.json({ limit: '4mb' }));

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
  const rows = db
    .prepare('SELECT * FROM workbenches ORDER BY sort ASC, id ASC')
    .all() as unknown as WorkbenchRow[];
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
  const r = db
    .prepare(
      `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort, auth_config)
       VALUES (@name, @url, @type, @icon, @description, @category, @tags, @enabled, @health_path, @sort, @auth_config)`
    )
    .run({ type: 'web', icon: '', description: '', category: '', tags: '[]', enabled: 1, health_path: '', sort: 0, auth_config: '', ...f });
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as WorkbenchRow;
  return rowToWorkbench(row);
}

function workbenchUpdateCore(id: number, body: any): ReturnType<typeof rowToWorkbench> {
  const cur = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(id) as unknown as WorkbenchRow | undefined;
  if (!cur) throw new HttpError(404, `workbench not found: ${id}`);
  const f = validateWorkbenchBody(body, true);
  // 掩码回传保护（url 面）：编辑表单从 API 取到的是掩码值，原样回传视为「未变更」
  if (f.url !== undefined && f.url.includes('=****') && f.url !== cur.url) delete f.url;
  const merged = { ...cur, ...f };
  db.prepare(
    `UPDATE workbenches SET name=@name, url=@url, type=@type, icon=@icon, description=@description,
     category=@category, tags=@tags, enabled=@enabled, health_path=@health_path, sort=@sort,
     auth_config=@auth_config, updated_at=datetime('now') WHERE id=@id`
  ).run({
    name: merged.name, url: merged.url, type: merged.type, icon: merged.icon,
    description: merged.description, category: merged.category, tags: merged.tags,
    enabled: merged.enabled, health_path: merged.health_path, sort: merged.sort,
    auth_config: merged.auth_config ?? '', id,
  });
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(id) as unknown as WorkbenchRow;
  return rowToWorkbench(row);
}

function workbenchDeleteCore(id: number): { ok: boolean; deleted: number } {
  const r = db.prepare('DELETE FROM workbenches WHERE id = ?').run(id);
  if (!r.changes) throw new HttpError(404, `workbench not found: ${id}`);
  // issue #9：删除工作台同步清掉各驾驶舱对它的面板引用——否则悬空面板会让之后每次保存布局 400
  const cocks = db.prepare('SELECT * FROM cockpits').all() as unknown as CockpitRow[];
  for (const c of cocks) {
    let panels: PanelConfig[];
    try { panels = JSON.parse(c.layout_config || '[]'); } catch { continue; }
    const kept = panels.filter((p) => p.workbenchId !== id);
    if (kept.length !== panels.length) {
      db.prepare(`UPDATE cockpits SET layout_config = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(kept), c.id);
    }
  }
  return { ok: true, deleted: id };
}

app.post('/api/workbenches', (req, res) => {
  res.status(201).json(workbenchCreateCore(req.body));
});

app.get('/api/workbenches/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
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
  return db.prepare('SELECT * FROM types WHERE key = ?').get(key) as unknown as TypeRow | undefined;
}

async function checkOne(w: WorkbenchRow): Promise<ReturnType<typeof rowToWorkbench>> {
  // 自产台（url 以 / 开头）由本服务静态托管：服务活着即在线，探测短路
  if (w.url.startsWith('/')) {
    db.prepare(
      `UPDATE workbenches SET last_status='up', last_checked_at=datetime('now'), last_latency_ms=0, last_http_code=200, last_error='' WHERE id=?`
    ).run(w.id);
    const selfRow = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(w.id) as unknown as WorkbenchRow;
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
    db.prepare(`UPDATE workbenches SET last_status='down', last_checked_at=datetime('now'),
      last_latency_ms=NULL, last_http_code=NULL, last_error=? WHERE id=?`).run(reason, w.id);
    const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(w.id) as unknown as WorkbenchRow;
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
    db.prepare(`UPDATE workbenches SET last_status='down', last_checked_at=datetime('now'),
      last_latency_ms=NULL, last_http_code=NULL, last_error=? WHERE id=?`).run(`探测失败：${reason}`, w.id);
    const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(w.id) as unknown as WorkbenchRow;
    return rowToWorkbench(row);
  }
  db.prepare(
    `UPDATE workbenches SET last_status=@status, last_checked_at=datetime('now'),
     last_latency_ms=@latency, last_http_code=@code, last_error=@error WHERE id=@id`
  ).run({ status: result.status, latency: result.latency_ms, code: result.http_code, error: result.error, id: w.id });
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(w.id) as unknown as WorkbenchRow;
  return rowToWorkbench(row);
}

app.post('/api/workbenches/:id/check', wrap(async (req, res) => {
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
  if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
  res.json(await checkOne(row));
}));

app.post('/api/check-all', wrap(async (_req, res) => {
  const settings = getSettings();
  const limit = Math.max(1, Number(settings.health_concurrency) || 8);
  const rows = db.prepare('SELECT * FROM workbenches WHERE enabled = 1').all() as unknown as WorkbenchRow[];
  const results: ReturnType<typeof rowToWorkbench>[] = [];
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let w = queue.shift(); w; w = queue.shift()) results.push(await checkOne(w));
  });
  await Promise.all(workers);
  res.json({ checked: results.length, up: results.filter((r) => r.last_status === 'up').length, down: results.filter((r) => r.last_status === 'down').length });
}));

// ---------- 驾驶舱 CRUD（任务驾驶舱：多工作台分屏组合视图） ----------
function getCockpit(id: number): CockpitRow {
  const row = db.prepare('SELECT * FROM cockpits WHERE id = ?').get(id) as unknown as CockpitRow | undefined;
  if (!row) throw new HttpError(404, `cockpit not found: ${id}`);
  return row;
}

function validatePanels(raw: unknown): PanelConfig[] {
  if (!Array.isArray(raw)) bad('layout_config 必须是面板数组');
  const seen = new Set<number>();
  return raw.map((p: any) => {
    const workbenchId = Number(p?.workbenchId ?? Number(String(p?.i ?? '').replace('wb-', '')));
    if (!Number.isInteger(workbenchId) || workbenchId < 1) bad(`面板 workbenchId 非法: ${JSON.stringify(p)}`);
    if (seen.has(workbenchId)) bad(`面板重复引用工作台 ${workbenchId}`);
    seen.add(workbenchId);
    if (!db.prepare('SELECT id FROM workbenches WHERE id = ?').get(workbenchId)) bad(`面板引用的工作台不存在: ${workbenchId}`);
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
  const rows = db.prepare('SELECT * FROM cockpits ORDER BY updated_at DESC, id DESC').all() as unknown as CockpitRow[];
  res.json(rows.map(rowToCockpit));
});

app.post('/api/cockpits', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) bad('name 不能为空');
  const description = String(req.body?.description ?? '');
  const panels = validatePanels(req.body?.panels ?? []);
  const r = db
    .prepare(`INSERT INTO cockpits (name, description, layout_config) VALUES (?, ?, ?)`)
    .run(name, description, JSON.stringify(panels)) as unknown as { lastInsertRowid: number | bigint };
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
  db.prepare(`UPDATE cockpits SET name = ?, description = ?, layout_config = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, description, JSON.stringify(panels), cur.id);
  res.json(rowToCockpit(getCockpit(cur.id)));
});

app.delete('/api/cockpits/:id', (req, res) => {
  const cur = getCockpit(Number(req.params.id));
  db.prepare('DELETE FROM cockpits WHERE id = ?').run(cur.id);
  res.json({ ok: true });
});

// ---------- 自产台（台生成器：AI 发布 API + 全版本快照，发布即入册） ----------
const appsRoot = join(dataDir, 'apps');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_APP_FILES = 64;
const MAX_APP_TOTAL_BYTES = 2 * 1024 * 1024;

function getApp(slug: string): AppRow {
  const row = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as unknown as AppRow | undefined;
  if (!row) throw new HttpError(404, `app not found: ${slug}`);
  return row;
}

function appDetail(a: AppRow) {
  const versions = db
    .prepare('SELECT * FROM app_versions WHERE app_id = ? ORDER BY version DESC')
    .all(a.id) as unknown as AppVersionRow[];
  const url = a.kind === 'sop' ? `/sop/${a.slug}/` : `/apps/${a.slug}/`;
  const wb = db
    .prepare(`SELECT id FROM workbenches WHERE url = ? AND type = 'market-app'`)
    .get(url) as { id: number } | undefined;
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
  const cur = db.prepare('SELECT id FROM workbenches WHERE url = ?').get(url) as { id: number } | undefined;
  if (cur) {
    db.prepare(`UPDATE workbenches SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?`).run(a.title, a.description, cur.id);
    return cur.id;
  }
  const r = db
    .prepare(
      `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort)
       VALUES (?, ?, 'market-app', ?, ?, ?, '[]', 1, '/', 0)`
    )
    .run(a.title, url, icon, a.description, category) as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

app.get('/api/apps', (_req, res) => {
  const rows = db.prepare('SELECT * FROM apps ORDER BY updated_at DESC, id DESC').all() as unknown as AppRow[];
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
  const a = db.prepare("SELECT * FROM apps WHERE slug = ? AND kind = 'sop'").get(slug) as unknown as AppRow | undefined;
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
  const existing = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as unknown as AppRow | undefined;
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
    const maxV = db.prepare('SELECT MAX(version) AS v FROM app_versions WHERE app_id = ?').get(existing.id) as { v: number | null };
    version = (maxV.v ?? 0) + 1;
    const st = writeAppFiles(slug, version, files);
    db.prepare(`UPDATE apps SET title = ?, description = ?, created_by = ?, code = ?, active_version = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(title, description, created_by, code, version, existing.id);
    db.prepare(`INSERT INTO app_versions (app_id, version, file_count, total_bytes, created_by, changelog) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(existing.id, version, st.file_count, st.total_bytes, created_by, changelog);
    appRow = getApp(slug);
  } else {
    if (typeof b.title !== 'string' || !b.title.trim()) bad('首次发布必须提供 title');
    const created_by = String(b.created_by ?? '');
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const st = writeAppFiles(slug, 1, files);
    const r = db
      .prepare(`INSERT INTO apps (slug, title, description, created_by, active_version, kind, code, status) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(slug, b.title.trim(), String(b.description ?? ''), created_by, kind, code, kind === 'sop' ? 'draft' : 'active') as unknown as { lastInsertRowid: number | bigint };
    db.prepare(`INSERT INTO app_versions (app_id, version, file_count, total_bytes, created_by, changelog) VALUES (?, 1, ?, ?, ?, ?)`)
      .run(Number(r.lastInsertRowid), st.file_count, st.total_bytes, created_by, changelog);
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
  const hit = db.prepare('SELECT version FROM app_versions WHERE app_id = ? AND version = ?').get(a.id, v) as { version: number } | undefined;
  if (!hit) throw new HttpError(404, `版本不存在: ${v}`);
  db.prepare(`UPDATE apps SET active_version = ?, updated_at = datetime('now') WHERE id = ?`).run(v, a.id);
  return appDetail(getApp(a.slug));
}

app.post('/api/apps/:slug/activate', (req, res) => {
  res.json(activateAppVersion(req.params.slug, req.body?.version));
});

app.delete('/api/apps/:slug', (req, res) => {
  const a = getApp(req.params.slug);
  rmSync(join(appsRoot, a.slug), { recursive: true, force: true });
  db.prepare('DELETE FROM app_versions WHERE app_id = ?').run(a.id);
  db.prepare('DELETE FROM apps WHERE id = ?').run(a.id);
  // issue #6：SOP 台的注册 url 是 /sop/<slug>/（非 /apps/），删除时必须一并清理，否则留孤儿工作台（门户 404）
  db.prepare(`DELETE FROM workbenches WHERE (url = ? OR url = ?) AND type = 'market-app'`).run(`/apps/${a.slug}/`, `/sop/${a.slug}/`);
  res.json({ ok: true, deleted: a.slug });
});

// ---------- SOP 台：状态机（draft → published → deprecated）+ 执行 Runner + 分层持久化 ----------
app.get('/api/sops', (_req, res) => {
  const rows = db.prepare("SELECT * FROM apps WHERE kind = 'sop' ORDER BY updated_at DESC, id DESC").all() as unknown as AppRow[];
  res.json(rows.map(appDetail));
});

function sopTransition(slug: string, from: string[], to: string, label: string): AppRow {
  const a = getApp(slug);
  if (a.kind !== 'sop') throw new HttpError(400, `${slug} 不是 SOP 台`);
  if (!from.includes(a.status)) throw new HttpError(409, `状态机拒绝：当前 ${a.status}，${label} 仅允许 ${from.join('/')}`);
  db.prepare(`UPDATE apps SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(to, a.id);
  const updated = getApp(slug);
  if (to === 'published') {
    syncWorkbenchRegistration(updated); // 发布即入册（门户/市场/驾驶舱全链可见）
    // issue #10：废弃→重新上架时市场行仍是停用态（enabled=0），上架必须恢复启用
    db.prepare(`UPDATE workbenches SET enabled = 1, updated_at = datetime('now') WHERE url = ? AND type = 'market-app'`).run(`/sop/${updated.slug}/`);
  }
  return updated;
}

app.post('/api/sops/:slug/publish', (req, res) => {
  const a = sopTransition(req.params.slug, ['draft', 'deprecated'], 'published', '发布');
  // publish 附带发布说明（可选）记入当前版本 changelog 末尾
  if (typeof req.body?.note === 'string' && req.body.note.trim()) {
    db.prepare(`UPDATE app_versions SET changelog = changelog || ? WHERE app_id = ? AND version = ?`)
      .run(`\n[publish] ${req.body.note.trim()}`, a.id, a.active_version);
  }
  res.json(appDetail(getApp(a.slug)));
});

app.post('/api/sops/:slug/deprecate', (req, res) => {
  const a = sopTransition(req.params.slug, ['published'], 'deprecated', '废弃');
  // 废弃不入册删除：历史 run 仍可回放；市场行禁用（enabled=0）
  db.prepare(`UPDATE workbenches SET enabled = 0, updated_at = datetime('now') WHERE url = ? AND type = 'market-app'`).run(`/sop/${a.slug}/`);
  res.json(appDetail(getApp(a.slug)));
});

// ---------- SOP Runner：GET /sop/:slug/ → 内置执行页（读活跃版本 sop.yaml 服务端渲染）----------
function renderSopRunner(manifest: SopManifest, app: AppRow): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stepsHtml = manifest.steps
    .map(
      (s, i) => `
      <section class="step" data-step="${esc(s.key)}">
        <header><span class="no">${i + 1}</span><h2>${esc(s.title)}</h2><span class="dot" data-dot="${esc(s.key)}" title="未保存"></span></header>
        <div class="body">${s.body ?? '<p class="muted">（本步骤无说明）</p>'}</div>
      </section>`
    )
    .join('\n');
  const boot = JSON.stringify({ slug: app.slug, version: app.active_version, code: app.code || manifest.code || '', title: manifest.title, steps: manifest.steps.map((s) => s.key) })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(manifest.title)} · SOP Runner</title>
<style>
  :root { --navy:#1E3A5F; --emerald:#059669; --ink:#0F172A; --line:#E2E8F0; --mut:#5A6577; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:Inter,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--ink); background:#F6F8FB; }
  .bar { position:sticky; top:0; z-index:5; background:var(--ink); color:#fff; padding:10px 20px; display:flex; align-items:center; gap:12px; }
  .bar .code { font-family:"Cascadia Mono",Consolas,monospace; font-size:12px; color:#94A3B8; }
  .bar h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.02em; }
  .badge { font-size:12px; padding:2px 10px; border-radius:999px; background:rgba(5,150,105,.25); color:#6EE7B7; }
  .runmeta { margin-left:auto; font-family:"Cascadia Mono",Consolas,monospace; font-size:12px; color:#94A3B8; }
  main { max-width:860px; margin:24px auto; padding:0 16px; }
  .step { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px 20px; margin-bottom:14px; }
  .step header { display:flex; align-items:center; gap:10px; }
  .step .no { width:24px; height:24px; border-radius:50%; background:var(--navy); color:#fff; font-size:12px; display:flex; align-items:center; justify-content:center; font-family:"Cascadia Mono",Consolas,monospace; }
  .step h2 { font-size:15px; margin:0; font-weight:600; }
  .dot { margin-left:auto; width:8px; height:8px; border-radius:50%; background:#CBD5E1; }
  .dot.saved { background:var(--emerald); }
  .dot.dirty { background:#F59E0B; }
  .body { margin-top:10px; font-size:14px; line-height:1.7; }
  .body:empty { display:none; }
  .muted { color:var(--mut); }
  input[data-field], select[data-field], textarea[data-field] { width:100%; max-width:420px; padding:7px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; font-family:"Cascadia Mono",Consolas,monospace; font-size:13px; }
  input[data-field]:focus-visible, textarea[data-field]:focus-visible, select[data-field]:focus-visible { outline:2px solid rgba(5,150,105,.6); outline-offset:1px; }
  .foot { display:flex; align-items:center; gap:14px; margin:20px 0 40px; }
  .btn { border:none; border-radius:6px; padding:9px 22px; font:inherit; font-weight:600; cursor:pointer; }
  .btn.primary { background:var(--emerald); color:#fff; }
  .btn:disabled { opacity:.5; cursor:default; }
  .state { font-size:13px; color:var(--mut); font-family:"Cascadia Mono",Consolas,monospace; }
</style>
</head>
<body>
<div class="bar">
  <span class="code">${esc(app.code || manifest.code || 'SOP')}</span>
  <h1>${esc(manifest.title)}</h1>
  <span class="badge">v${app.active_version}</span>
  <span class="runmeta" id="runmeta">未开始</span>
</div>
<main>
${stepsHtml}
<div class="foot">
  <button class="btn primary" id="finish" disabled>完成执行</button>
  <span class="state" id="state"></span>
</div>
</main>
<script>
window.__SOP__ = ${boot};
(function () {
  var BOOT = window.__SOP__;
  var runId = null;
  var timers = {};
  var LS = 'wm.sop.run.' + BOOT.slug;
  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return Array.from((el || document).querySelectorAll(s)); }
  function setState(t) { $('#state').textContent = t; }
  function setRunMeta(t) { $('#runmeta').textContent = t; }
  function dot(key, cls) { var d = $('[data-dot="' + key + '"]'); if (d) d.className = 'dot ' + cls; }

  function collect(stepKey) {
    var sec = $('[data-step="' + stepKey + '"]');
    var out = {};
    $$('[data-field]', sec).forEach(function (el) {
      var f = el.getAttribute('data-field');
      out[f] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }
  function fill(stepKey, value) {
    var sec = $('[data-step="' + stepKey + '"]');
    if (!value) return;
    Object.keys(value).forEach(function (f) {
      var el = $('[data-field="' + f + '"]', sec);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!value[f]; else el.value = value[f];
    });
  }

  function queueSave(stepKey) {
    dot(stepKey, 'dirty');
    clearTimeout(timers[stepKey]);
    timers[stepKey] = setTimeout(function () { save(stepKey); }, 800);
  }
  function save(stepKey) {
    if (!runId) return;
    var value = collect(stepKey);
    try { localStorage.setItem(LS + '.' + stepKey, JSON.stringify(value)); } catch (e) {}
    fetch('/api/sop/runs/' + runId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepKey: stepKey, value: value })
    }).then(function (r) {
      dot(stepKey, r.ok ? 'saved' : 'dirty');
      if (!r.ok) setState('保存失败（HTTP ' + r.status + '）——已缓冲本地，将随下次输入重试');
    }).catch(function () {
      dot(stepKey, 'dirty'); setState('离线——已缓冲本地，恢复网络后继续填写即可');
    });
  }

  function startRun() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) {}
    var resume = saved && saved.id && saved.status === 'running' ? saved.id : null;
    var p = resume
      ? fetch('/api/sop/runs/' + resume).then(function (r) { return r.ok ? r.json() : null; })
      : fetch('/api/sop/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: BOOT.slug }) }).then(function (r) { return r.json(); });
    p.then(function (run) {
      if (!run || !run.id) { setState('开启执行记录失败'); return; }
      runId = run.id;
      localStorage.setItem(LS, JSON.stringify({ id: run.id, status: 'running' }));
      setRunMeta('run #' + run.id + ' · v' + (run.version || BOOT.version));
      // 回填已有数据（恢复现场）：远端优先，本地缓冲兜底
      BOOT.steps.forEach(function (k) {
        var remote = run.data && run.data[k];
        var local = null;
        try { local = JSON.parse(localStorage.getItem(LS + '.' + k) || 'null'); } catch (e) {}
        fill(k, remote || local);
        if (remote || local) dot(k, 'saved');
      });
      $('#finish').disabled = false;
      setState('执行中——数据自动保存');
    }).catch(function () { setState('无法连接市场服务——填写仍会缓冲本地'); });
  }

  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || !el.hasAttribute || !el.hasAttribute('data-field')) return;
    var sec = el.closest('[data-step]');
    if (sec) queueSave(sec.getAttribute('data-step'));
  });
  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (!el || !el.hasAttribute || !el.hasAttribute('data-field')) return;
    var sec = el.closest('[data-step]');
    if (sec) queueSave(sec.getAttribute('data-step'));
  });

  $('#finish').addEventListener('click', function () {
    if (!runId) return;
    // 收尾前把所有未落盘的缓冲步骤推上去
    Promise.all(BOOT.steps.filter(function (k) { return timers[k]; }).map(function (k) {
      clearTimeout(timers[k]); return save(k), Promise.resolve();
    })).then(function () {
      return fetch('/api/sop/runs/' + runId + '/finish', { method: 'POST' });
    }).then(function (r) { return r.json(); }).then(function (out) {
      localStorage.setItem(LS, JSON.stringify({ id: runId, status: 'finished' }));
      setRunMeta('run #' + out.id + ' · 已完成');
      setState('执行完成，记录已归档（' + out.steps + ' 个步骤数据）');
      $('#finish').disabled = true;
    }).catch(function () { setState('完成失败——数据仍在，稍后重试'); });
  });

  startRun();
})();
</script>
</body>
</html>`;
}

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
  const r = db.prepare('SELECT * FROM sop_runs WHERE id = ?').get(id) as unknown as SopRunRow | undefined;
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
  const r = db
    .prepare(`INSERT INTO sop_runs (sop_slug, sop_version, started_by) VALUES (?, ?, ?)`)
    .run(slug, hit.app.active_version, started_by) as unknown as { lastInsertRowid: number | bigint };
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
    db.prepare(`UPDATE sop_runs SET data = ?, updated_at = datetime('now') WHERE id = ?`).run(source, id);
    checkpointAt.set(id, now);
  }
  return { ok: true, id, stepKey, persisted: hotOk ? 'redis+checkpoint' : 'sqlite' };
}

/** 读 run（热读优先，miss 回 SQLite 真源并回填热态） */
async function sopRunGetCore(id: number): Promise<{ id: number; sop_slug: string; sop_version: number; status: string; started_by: string; data: Record<string, unknown> }> {
  const hot = await runStateLoad(id);
  if (hot) return { id, sop_slug: hot.meta.slug, sop_version: hot.meta.version, status: hot.meta.status, started_by: hot.meta.started_by, data: hot.data };
  const row = sopRunRow(id);
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  if (row.status === 'running' && redisHealthy()) {
    void runStateRestore(id, { slug: row.sop_slug, version: row.sop_version, status: row.status, started_by: row.started_by, updated_at: Date.now() }, data); // 回填热态
  }
  return { id: row.id, sop_slug: row.sop_slug, sop_version: row.sop_version, status: row.status, started_by: row.started_by, data };
}

/** 归档（热态全量沉淀 SQLite；Redis 条目 1h 平滑淘汰） */
async function sopRunFinishCore(id: number): Promise<{ ok: boolean; id: number; status: string; steps: number }> {
  const row = sopRunRow(id);
  if (row.status !== 'running') throw new HttpError(409, `run ${id} 已 ${row.status}`);
  let data = row.data || '{}';
  const hot = await runStateLoad(id);
  if (hot && Object.keys(hot.data).length > 0) data = JSON.stringify(hot.data);
  db.prepare(`UPDATE sop_runs SET status = 'finished', data = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(data, id);
  await runStateRetire(id); // 退出活跃索引 + Redis 条目 1h 平滑淘汰
  checkpointAt.delete(id);
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(data); } catch { parsed = {}; }
  return { ok: true, id, status: 'finished', steps: Object.keys(parsed).length };
}

app.post('/api/sop/runs', (req, res) => {
  const out = sopRunStartCore(String(req.body?.slug ?? ''), String(req.body?.started_by ?? ''));
  res.status(201).json(out);
});

app.get('/api/sop/runs/active', async (_req, res) => {
  // 快路径：Redis 活跃索引；降级态回落 SQLite
  const ids = await runActiveIds();
  if (ids.length > 0) {
    const rows = ids.map((id) => db.prepare('SELECT * FROM sop_runs WHERE id = ? AND status = ?').get(id, 'running') as unknown as SopRunRow | undefined).filter(Boolean) as SopRunRow[];
    return res.json(rows);
  }
  const rows = db.prepare("SELECT * FROM sop_runs WHERE status = 'running' ORDER BY updated_at DESC").all() as unknown as SopRunRow[];
  res.json(rows);
});

app.get('/api/sop/runs', (req, res) => {
  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const where: string[] = [];
  const args: unknown[] = [];
  if (slug) { where.push('sop_slug = ?'); args.push(slug); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM sop_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 200`;
  res.json(db.prepare(sql).all(...(args as never[])) as unknown as SopRunRow[]);
});

app.get('/api/sop/runs/:id(\\d+)', async (req, res) => {
  res.json(await sopRunGetCore(Number(req.params.id)));
});

app.put('/api/sop/runs/:id(\\d+)', async (req, res) => {
  res.json(await sopRunStepSaveCore(Number(req.params.id), String(req.body?.stepKey ?? ''), req.body?.value));
});

app.post('/api/sop/runs/:id(\\d+)/finish', async (req, res) => {
  res.json(await sopRunFinishCore(Number(req.params.id)));
});

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
  const a = db.prepare('SELECT * FROM apps WHERE slug = ?').get(m[1]) as unknown as AppRow | undefined;
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
  res.json(db.prepare('SELECT * FROM types ORDER BY id ASC').all());
});

app.post('/api/types', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.key !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(b.key)) bad('key 必须是小写字母/数字/连字符');
  if (typeof b.name !== 'string' || !b.name.trim()) bad('name 不能为空');
  if (b.key === 'web') bad('内置类型 web 不允许覆盖');
  const exists = db.prepare('SELECT id FROM types WHERE key = ?').get(b.key);
  if (exists) bad(`类型已存在: ${b.key}`);
  const r = db.prepare(
    `INSERT INTO types (key, name, icon, default_port, health_method, health_path, expect_status, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    b.key, b.name.trim(), String(b.icon ?? ''), b.default_port ?? null,
    b.health_method === 'HEAD' ? 'HEAD' : 'GET',
    String(b.health_path ?? '/'), b.expect_status == null ? null : Number(b.expect_status), String(b.description ?? '')
  );
  res.status(201).json(db.prepare('SELECT * FROM types WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.put('/api/types/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM types WHERE id = ?').get(id) as unknown as TypeRow | undefined;
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
  db.prepare(
    `UPDATE types SET name=@name, icon=@icon, default_port=@default_port, health_method=@health_method,
     health_path=@health_path, expect_status=@expect_status, description=@description WHERE id=@id`
  ).run({ ...next, id });
  res.json(db.prepare('SELECT * FROM types WHERE id = ?').get(id));
});

app.delete('/api/types/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM types WHERE id = ?').get(id) as unknown as TypeRow | undefined;
  if (!cur) throw new HttpError(404, `type not found: ${id}`);
  if (cur.key === 'web' || cur.key === 'market-app') bad(`内置类型 ${cur.key} 不允许删除`);
  const used = db.prepare('SELECT COUNT(*) AS n FROM workbenches WHERE type = ?').get(cur.key) as { n: number };
  if (used.n > 0) throw new HttpError(409, `类型 ${cur.key} 仍被 ${used.n} 个工作台使用，先改挂其他类型`);
  db.prepare('DELETE FROM types WHERE id = ?').run(id);
  res.json({ ok: true, deleted: id });
});

// ---------- 设置 / 导入导出 ----------
app.get('/api/settings', (_req, res) => { res.json(getSettings()); });

app.put('/api/settings', (req, res) => {
  const b = req.body ?? {};
  if (typeof b !== 'object' || b === null) bad('body 必须是 {key: value} 对象');
  const allowed = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency', 'a2a_peers'];
  const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(b)) {
    if (!allowed.includes(k)) continue;
    upd.run(k, String(v));
  }
  armPatrol(); // issue #5：改巡检设置即重挂定时器（幂等 clearTimeout 开头），不必重启服务
  res.json(getSettings());
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
    types: db.prepare('SELECT * FROM types ORDER BY id ASC').all(),
    settings: getSettings(),
  });
});

app.post('/api/import', (req, res) => {
  const b = req.body ?? {};
  if (!Array.isArray(b.workbenches)) bad('导入文件缺少 workbenches 数组');
  // issue #7：mode 支持 query 优先（README 的 ?mode=replace 写法），body.mode 次之
  const modeRaw = (typeof req.query.mode === 'string' ? req.query.mode : b.mode) ?? 'merge';
  const mode = modeRaw === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace') {
    db.prepare('DELETE FROM workbenches').run();
    db.prepare('DELETE FROM types WHERE key != ?').run('web');
  }
  const insType = db.prepare(
    `INSERT OR IGNORE INTO types (key, name, icon, default_port, health_method, health_path, expect_status, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  if (Array.isArray(b.types)) {
    for (const t of b.types) insType.run(t.key, t.name, String(t.icon ?? ''), t.default_port ?? null, t.health_method ?? 'GET', String(t.health_path ?? '/'), t.expect_status ?? null, String(t.description ?? ''));
  }
  const ins = db.prepare(
    `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort, auth_config, last_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`
  );
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
    const exists = db.prepare('SELECT 1 AS x FROM workbenches WHERE id = ?');
    for (const c of db.prepare('SELECT * FROM cockpits').all() as unknown as CockpitRow[]) {
      let panels: PanelConfig[];
      try { panels = JSON.parse(c.layout_config || '[]'); } catch { continue; }
      const kept = panels.filter((p) => exists.get(p.workbenchId));
      if (kept.length !== panels.length) {
        db.prepare(`UPDATE cockpits SET layout_config = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(kept), c.id);
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
function adminGuard(req: express.Request, res: express.Response): boolean {
  if (!adminTokenOk(req.headers['x-admin-token'])) {
    res.status(403).json({ error: '需要有效的 X-Admin-Token（管理员口令未设置时一律拒绝）' });
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
  const rows = db.prepare('SELECT * FROM sop_bindings WHERE sop_slug = ? ORDER BY id DESC').all(a.slug) as unknown as {
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
  const r = db.prepare('INSERT INTO sop_bindings (sop_slug, node, mode, remote_api_key, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(a.slug, node, mode, remoteKey, 'admin') as unknown as { lastInsertRowid: number | bigint };
  sopNode8(a.slug); // 确保节点短 id 已生成（上卡用）
  res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), node, mode, remote_api_key: maskKey(remoteKey) });
});

app.delete('/api/sops/:slug/bindings/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  const a = getApp(req.params.slug);
  const id = Number(req.params.id);
  const hit = db.prepare('SELECT id FROM sop_bindings WHERE id = ? AND sop_slug = ?').get(id, a.slug) as { id: number } | undefined;
  if (!hit) throw new HttpError(404, `binding not found: ${id}`);
  // 软撤销（留审计）：卡片即下线该 SOP（若无其他有效绑定）
  db.prepare(`UPDATE sop_bindings SET revoked_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true, revoked: id });
});

// /a2a/direct（P1）：一律 not-found——不区分「存在但未绑定」与「不存在」，不泄露存在性（P2 再开放）
app.post('/a2a/direct', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});
app.get('/a2a/direct', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// ---------- 统一门户：/go/:id/* 反向代理到对应工作台 ----------
// 所有注册工作台挂到 9800 同域路径下：一个端口号 + 同源（CORS 消失）+
// 代理剥掉 X-Frame-Options / CSP（禁嵌防线失效）→ 使用页/驾驶舱全量可嵌。
const wbById = (id: number): ReturnType<typeof rowToWorkbench> | null => {
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(id) as unknown as WorkbenchRow | undefined;
  return row ? rowToWorkbench(row) : null;
};

// ---------- MCP 生产通道（StreamableHTTP · stateless：AI 会话直连市场，零依赖手写 JSON-RPC） ----------
const MCP_PROTOCOL = '2025-03-26';
const MCP_KNOWN_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'workbench_list',
    description: '列出市场中的工作台（可按关键词/类型/状态过滤），返回 id/名称/类型/状态/延迟/地址/分类/启用——找台的入口。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（名称/地址/描述子串，不区分大小写）' },
        type: { type: 'string', description: '类型 key，如 web / ollama / market-app' },
        status: { type: 'string', enum: ['up', 'down', 'unknown'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workbench_summary',
    description: '市场总览统计：总数/启用/在线/离线/未探测/平均延迟/分类聚合。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_check',
    description: '立即健康探测并回写状态：传 id 探测单个台；all=true 并发探测全部启用台。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: '工作台 id' }, all: { type: 'boolean', description: '探测全部启用台' } },
      additionalProperties: false,
    },
  },
  {
    name: 'use_url',
    description: '取某工作台的访问入口：portal（/go/<id>/ 同源代理，自动带凭据/剥禁嵌头）与 direct 直连地址。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'app_publish',
    description:
      '发布/更新自产台（市场自己长台）：files=[{path,content}] 发上来即静态托管 /apps/<slug>/ 并自动入册，门户/市场立即可用；同 slug 重发=新版本快照。kind="sop" 走 SOP 台（须含 sop.yaml + changelog，首发 draft，需再调 sop_publish 上架）。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '小写字母/数字/连字符，≤64 字符' },
        title: { type: 'string', description: '显示名（首次发布必填）' },
        description: { type: 'string' },
        created_by: { type: 'string', description: '发布者标识（如 AI 会话名）' },
        code: { type: 'string', description: 'SOP 编号（如 SOP-OPS-001，kind=sop 时用）' },
        kind: { type: 'string', enum: ['app', 'sop'] },
        changelog: { type: 'string', description: '本版改了什么（kind=sop 必填）' },
        files: {
          type: 'array',
          description: '文件集（UTF-8 文本，单文件 ≤2MB；app 类须含根 index.html，sop 类须含 sop.yaml）',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
      },
      required: ['slug', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'app_activate',
    description: '版本回滚：把某自产台/SOP 台切回历史版本（版本链见 GET /api/apps/<slug>）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, version: { type: 'integer' } }, required: ['slug', 'version'], additionalProperties: false },
  },
  {
    name: 'sop_publish',
    description: 'SOP 台上架：draft/deprecated → published（首次入册市场；note 记入当前版本 changelog）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, note: { type: 'string', description: '发布说明（可选）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'sop_run_start',
    description: '开一次 SOP 执行 run（钉当前版本；仅 published）——agent 更新持久化执行数据的入口，不触发版本发布。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, started_by: { type: 'string', description: '执行者标识（如 agent 会话名）' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'sop_run_step_save',
    description: '更新 run 的持久化数据（stepKey→value 任意键值；与人在 Runner 页填数据同一条链：Redis 热写+30s checkpoint 沉淀 SQLite）。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' }, step_key: { type: 'string', description: '字母/数字/_/-（不必是 sop.yaml 里的步骤——数据面哑存储）' }, value: { description: '任意 JSON 值' } }, required: ['run_id', 'step_key'], additionalProperties: false },
  },
  {
    name: 'sop_run_get',
    description: '读 run 详情（热读优先，miss 回 SQLite 真源）——恢复执行现场。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' } }, required: ['run_id'], additionalProperties: false },
  },
  {
    name: 'sop_run_list',
    description: '列 SOP 执行记录（可按 slug/status 过滤）。',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, status: { type: 'string', enum: ['running', 'finished'] } }, additionalProperties: false },
  },
  {
    name: 'sop_run_finish',
    description: '归档 run（热态全量沉淀 SQLite，Redis 条目平滑淘汰）。',
    inputSchema: { type: 'object', properties: { run_id: { type: 'integer' } }, required: ['run_id'], additionalProperties: false },
  },
  {
    name: 'workbench_register',
    description: '登记外部工作台入册（agent 发现内网新服务时自主登记；门户/市场即刻可用）。凭据不接受——需人工经市场页配置（安全边界）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, url: { type: 'string', description: 'http(s) 地址（自产台内部路径请用 app_publish）' },
        type: { type: 'string', description: '类型 key，默认 web' }, category: { type: 'string' }, description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, health_path: { type: 'string' }, sort: { type: 'integer' },
      },
      required: ['name', 'url'], additionalProperties: false,
    },
  },
  {
    name: 'workbench_update',
    description: '更新工作台配置（name/category/tags/description/enabled/health_path/sort/url）。不接受 auth——凭据变更人工操作；掩码 url 回传视为未变更。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, url: { type: 'string' }, category: { type: 'string' },
        description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' },
        health_path: { type: 'string' }, sort: { type: 'integer' },
      },
      required: ['id'], additionalProperties: false,
    },
  },
  {
    name: 'workbench_unregister',
    description: '解除工作台注册（不删服务本体；驾驶舱面板引用联动清理）。',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
  },
];

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
        const rows = db.prepare('SELECT * FROM workbenches WHERE enabled = 1').all() as unknown as WorkbenchRow[];
        const results: ReturnType<typeof rowToWorkbench>[] = [];
        const queue = [...rows];
        const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
          for (let w = queue.shift(); w; w = queue.shift()) results.push(await checkOne(w));
        });
        await Promise.all(workers);
        return { checked: results.length, up: results.filter((w) => w.last_status === 'up').length, down: results.filter((w) => w.last_status === 'down').length };
      }
      const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(Number(args?.id)) as unknown as WorkbenchRow | undefined;
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
        db.prepare(`UPDATE app_versions SET changelog = changelog || ? WHERE app_id = ? AND version = ?`)
          .run(`\n[publish] ${args.note.trim()}`, a.id, a.active_version);
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
      return db.prepare(sql).all(...(sqlArgs as never[]));
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
    default:
      throw new HttpError(400, `未知工具: ${name}`);
  }
}

app.post('/mcp', async (req, res) => {
  const msg = req.body ?? {};
  const fail = (code: number, message: string) => res.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (msg.id === undefined || msg.id === null) return res.status(202).end(); // notification（含 notifications/initialized）——stateless 无会话态需要跟踪
  try {
    if (msg.method === 'initialize') {
      const want = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return res.json({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: MCP_KNOWN_PROTOCOLS.includes(want) ? want : MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'workbench-market', version: '0.1.0', title: '工作台市场' },
        },
      });
    }
    if (msg.method === 'ping') return res.json({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'tools/list') return res.json({ jsonrpc: '2.0', id: msg.id, result: { tools: MCP_TOOLS } });
    if (msg.method === 'tools/call') {
      if (typeof msg.params?.name !== 'string') return fail(-32602, 'params.name 必填');
      try {
        const out = await callTool(msg.params.name, msg.params.arguments ?? {});
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      } catch (e: any) {
        // 工具执行失败按 MCP 规范走 isError（协议层错误才用 JSON-RPC error）
        return res.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `执行失败：${e?.message || e}` }], isError: true } });
      }
    }
    return fail(-32601, `Method not found: ${msg.method}`);
  } catch (e: any) {
    return fail(-32603, `Internal error: ${e?.message || e}`);
  }
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'stateless StreamableHTTP：仅支持 POST（无服务端会话流）' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: '无会话可终止（stateless）' }));
const goPrefix = /^\/go\/(\d+)(.*)$/;

// id 校验 + 404（在代理前拦截，避免 router 内抛错变 500）
// 注意：必须全局挂载（不能用 app.use('/go', ...) 前缀挂载——Express 会剥掉
// req.url 的挂载前缀，goPrefix 与 http-proxy-middleware 的 pathFilter 都会失配）
app.use((req, res, next) => {
  if (!goPrefix.test(req.url ?? '')) return next();
  const m = goPrefix.exec(req.url ?? '')!;
  let origin = '', basePath = '', goQuery = '', goAuth = '';
  try {
    const w = wbById(Number(m[1]));
    if (!w) return res.status(404).json({ error: `工作台不存在: ${m[1]}` });
    if (w.url.startsWith('/sop/')) {
      // SOP 台：重写为 /sop/<slug>/… 后直接交给 SOP Runner 路由（同自产台坑：next() 不回流已注册路由）
      req.url = w.url.replace(/\/+$/, '') + (m[2] || '/');
      const mm = /^\/sop\/([a-z0-9][a-z0-9-]*)\/?(.*)$/.exec(req.path ?? req.url ?? '');
      const rest = mm ? mm[2] || '' : '';
      const hit = readActiveManifest(mm ? mm[1] : '');
      if (!hit) return res.status(404).json({ error: `SOP not found` });
      res.setHeader('X-App-Version', `v${hit.app.active_version}`);
      if (rest === '' || rest === '/' || rest === 'index.html') {
        // issue #11：门户内联分流同款——draft 403 瘦身，不渲染 Runner
        if (hit.app.status !== 'published') {
          return res.status(403).type('text').send(`SOP ${hit.app.slug} 状态为 ${hit.app.status}，未上架不可执行\n`);
        }
        return res.status(200).type('html').send(renderSopRunner(hit.manifest, hit.app));
      }
      const root = join(appsRoot, mm![1], `v${hit.app.active_version}`);
      let rel = posix.normalize(rest);
      if (rel === '.' || rel.startsWith('/') || rel.startsWith('..')) return res.status(400).json({ error: '路径非法' });
      const abs = join(root, rel);
      if (!abs.startsWith(root)) return res.status(400).json({ error: '路径非法' });
      if (!existsSync(abs)) return res.status(404).json({ error: `file not found: ${rel}` });
      return res.sendFile(abs);
    }
    if (w.url.startsWith('/')) {
      // 自产台：本服务静态路径，重写后直接交给静态托管（/go/N/xyz → /apps/<slug>/xyz）。
      // 不能只 next()：serveApp 路由注册在本中间件之前，重写后的 URL 不会再流经它，
      // 会漏到 web/dist SPA fallback（实测踩坑）。
      req.url = w.url.replace(/\/+$/, '') + (m[2] || '/');
      return serveApp(req, res);
    }
    const u = new URL(w.url);
    origin = u.origin;
    basePath = u.pathname.replace(/\/+$/, ''); // base 自带路径（如 /preview）时保留
    // base 自带 query（如 dsh web 启动 token ?token=…）：请求自身无 query 时补上，
    // 否则 token 换 cookie 的一次性认证过不了门户代理（实测 /go/84/ 401 踩坑）
    goQuery = u.search;
    // 凭据注入：在此解析（此处还知道工作台 id）；proxyReq 钩子里 req.url 已被
    // pathRewrite 改写成上游路径，无法再从 URL 反查 id（实测注入不达的根因）
    if (w.auth?.type === 'bearer') goAuth = `Bearer ${w.auth.value}`;
    else if (w.auth?.type === 'basic') goAuth = `Basic ${Buffer.from(w.auth.value, 'utf8').toString('base64')}`;
  } catch {
    return res.status(502).json({ error: `工作台地址非法: ${m[1]}` });
  }
  (req as express.Request & { goOrigin?: string }).goOrigin = origin;
  (req as express.Request & { goBase?: string }).goBase = basePath;
  (req as express.Request & { goQuery?: string }).goQuery = goQuery;
  (req as express.Request & { goAuth?: string }).goAuth = goAuth;
  // issue #4：3xx Location 改写在 proxyRes 里也要 id——但那时 req.url 已被 pathRewrite
  // 写回上游路径（goPrefix 失配，改写从不生效）；在此备份原始 id 供 proxyRes 使用。
  (req as express.Request & { goWid?: string }).goWid = m[1];
  next();
});

const goProxy = createProxyMiddleware({
  // HPM 4.x 默认 logger 是 noopLogger（options.logger || noop）——pathFilter/配置错误零输出，
  // 静默漏到 SPA fallback 返回 200 假绿（实测踩坑：RegExp pathFilter 坏了整整一天没人发现）。
  // 显式传 console，让配置类错误至少可见。
  logger: console,
  // HPM 4.x 的 pathFilter 不支持 RegExp（matchPathFilter 抛 Invalid pathFilter，被 shouldProxy
  // 吞成 next() → 静默漏到 SPA fallback）；函数形式走 custom-matching 分支（实测透传 3080 的 401）
  pathFilter: (pathname: string) => goPrefix.test(pathname),
  target: 'http://127.0.0.1', // 占位：router 按请求覆盖
  changeOrigin: true,
  xfwd: true,
  ws: true,
  cookieDomainRewrite: '', // 上游 Cookie 去掉 Domain 属性，落到 9800 同域
  cookiePathRewrite: '/',
  router: (req) => (req as express.Request & { goOrigin?: string }).goOrigin ?? 'http://127.0.0.1',
  pathRewrite: (path, req) => {
    const m = goPrefix.exec(path);
    if (!m) return path;
    const base = (req as express.Request & { goBase?: string; goQuery?: string }).goBase ?? '';
    const rest = m[2] || '/';
    if (!rest.startsWith('/')) return path;
    // /go/N/xyz → base + /xyz（base 是工作台地址自带的路径前缀，可空）
    // 请求自身无 query 时补 base 自带 query（启动 token 等）；请求显式带 query 则原样透传。
    // 已带 dsh-auth-* cookie（token 换票完成）后不再补，否则根路径每次被强制重签 → 303 死循环（实测踩坑）
    const goQuery = (req as express.Request & { goBase?: string; goQuery?: string }).goQuery ?? '';
    const hasAuth = /(?:^|;\s*)dsh-auth-/.test(String(req.headers.cookie ?? ''));
    return base + rest + (goQuery && !rest.includes('?') && !hasAuth ? goQuery : '');
  },
  on: {
    // 凭据注入：前置中间件已解析好 req.goAuth（此处 req.url 已被 pathRewrite 改写，
    // 不能再从 URL 反查工作台——实测注入不达的根因）
    // Origin 改写：上游若做 Origin 校验（如 DSH web 的 authority 防护），浏览器经门户
    // 发出的 Origin=http://…:9800 与上游 authority 不符会被 403 拒（WS 握手同理，
    // 实测握手 403→改写后通过）。代理作为可信客户端把 Origin 重写为上游自身 origin。
    proxyReq: (proxyReq, req) => {
      const rq = req as typeof req & { goAuth?: string; goOrigin?: string };
      if (rq.goAuth) proxyReq.setHeader('authorization', rq.goAuth);
      if (rq.goOrigin) proxyReq.setHeader('origin', rq.goOrigin);
    },
    proxyRes: (proxyRes, req, res) => {
      // 剥禁嵌头：代理后与市场同源，这两个头只会误伤 iframe 嵌入（使用页/驾驶舱）
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      // 3xx Location 改写回 /go/N/ 前缀，防跳回原域丢前缀（issue #4：req.url 已被
      // pathRewrite 写回上游路径，goPrefix 失配——改用前置中间件备份的 req.goWid）
      const loc = proxyRes.headers.location;
      const wid = (req as express.Request & { goWid?: string }).goWid;
      if (typeof loc === 'string' && wid) {
        {
          const base = (req as express.Request & { goBase?: string }).goBase ?? '';
          if (loc.startsWith('/')) {
            proxyRes.headers.location = `/go/${wid}${loc.startsWith(base + '/') ? loc.slice(base.length) : loc}`;
          } else if (/^https?:\/\//i.test(loc)) {
            try {
              const lu = new URL(loc);
              if (lu.origin === (req as express.Request & { goOrigin?: string }).goOrigin) {
                let p = lu.pathname;
                if (base && p.startsWith(base)) p = p.slice(base.length);
                proxyRes.headers.location = `/go/${wid}${p}${lu.search}${lu.hash}`;
              }
            } catch { /* 异常 URL 透传 */ }
          }
        }
      }
      void res;
    },
  },
});
app.use(goProxy);

// ---------- 静态托管前端（生产形态：单端口） ----------
const webDist = join(here, '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => { res.sendFile(join(webDist, 'index.html')); });
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
async function patrol(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const rows = db.prepare('SELECT * FROM workbenches WHERE enabled = 1').all() as unknown as WorkbenchRow[];
    for (const w of rows) { try { await checkOne(w); } catch { /* 单个失败不阻断巡检 */ } }
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
const dbWriteSettings = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
dbWriteSettings.run('patrol_armed_at', new Date().toISOString());

const PORT = Number(process.env.PORT) || 9800;
const goServer = app.listen(PORT, () => {
  const counts = db.prepare('SELECT COUNT(*) AS n FROM workbenches').get() as { n: number };
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
  (goProxy as unknown as { upgrade: (rq: typeof req, sk: typeof socket, hd: typeof head) => void }).upgrade(req, socket, head);
});
