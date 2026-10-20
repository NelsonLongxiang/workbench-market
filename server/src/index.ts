import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, dataDir, rowToWorkbench, rowToCockpit, type WorkbenchRow, type TypeRow, type CockpitRow, type PanelConfig, type AppRow, type AppVersionRow } from './db.ts';
import { assertHttpUrl, composeProbeUrl, probe } from './health.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
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

app.get('/api/workbenches', (req, res) => {
  const { q, category, type, status } = req.query;
  let list = listWorkbenches();
  if (q) { const s = String(q).toLowerCase(); list = list.filter((w) => w.name.toLowerCase().includes(s) || w.url.toLowerCase().includes(s) || (w.description || '').toLowerCase().includes(s)); }
  if (category) list = list.filter((w) => w.category === category);
  if (type) list = list.filter((w) => w.type === type);
  if (status) list = list.filter((w) => w.last_status === status);
  res.json(list);
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
      out.auth_config = JSON.stringify({ type: b.auth.type, value: b.auth.value });
    } else {
      bad('auth 形态：{type:"bearer"|"basic", value:string} 或 null');
    }
  }
  return out;
}

app.post('/api/workbenches', (req, res) => {
  const f = validateWorkbenchBody(req.body);
  const r = db
    .prepare(
      `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort, auth_config)
       VALUES (@name, @url, @type, @icon, @description, @category, @tags, @enabled, @health_path, @sort, @auth_config)`
    )
    .run({ type: 'web', icon: '', description: '', category: '', tags: '[]', enabled: 1, health_path: '', sort: 0, auth_config: '', ...f });
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as WorkbenchRow;
  res.status(201).json(rowToWorkbench(row));
});

app.get('/api/workbenches/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(Number(req.params.id)) as unknown as WorkbenchRow | undefined;
  if (!row) throw new HttpError(404, `workbench not found: ${req.params.id}`);
  res.json(rowToWorkbench(row));
});

app.put('/api/workbenches/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(id) as unknown as WorkbenchRow | undefined;
  if (!cur) throw new HttpError(404, `workbench not found: ${id}`);
  const f = validateWorkbenchBody(req.body, true);
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
  res.json(rowToWorkbench(row));
});

app.delete('/api/workbenches/:id', (req, res) => {
  const r = db.prepare('DELETE FROM workbenches WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) throw new HttpError(404, `workbench not found: ${req.params.id}`);
  res.json({ ok: true, deleted: Number(req.params.id) });
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
  const target = composeProbeUrl(w.url, w.health_path || t?.health_path || '');
  const result = await probe(target, {
    method: t?.health_method || 'GET',
    timeoutMs: Number(settings.health_timeout_ms) || 5000,
    expectStatus: t?.expect_status ?? null,
  });
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
  const wb = db
    .prepare(`SELECT id FROM workbenches WHERE url = ? AND type = 'market-app'`)
    .get(`/apps/${a.slug}/`) as { id: number } | undefined;
  return { ...a, versions, workbench_id: wb?.id ?? null };
}

function validateAppFiles(raw: unknown): { path: string; content: string }[] {
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
  if (!seen.has('index.html')) bad('files 必须包含根目录 index.html（入口）');
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
  const url = `/apps/${a.slug}/`;
  const cur = db.prepare('SELECT id FROM workbenches WHERE url = ?').get(url) as { id: number } | undefined;
  if (cur) {
    db.prepare(`UPDATE workbenches SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?`).run(a.title, a.description, cur.id);
    return cur.id;
  }
  const r = db
    .prepare(
      `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort)
       VALUES (?, ?, 'market-app', '🧩', ?, '自产台', '[]', 1, '/', 0)`
    )
    .run(a.title, url, a.description) as unknown as { lastInsertRowid: number | bigint };
  return Number(r.lastInsertRowid);
}

app.get('/api/apps', (_req, res) => {
  const rows = db.prepare('SELECT * FROM apps ORDER BY updated_at DESC, id DESC').all() as unknown as AppRow[];
  res.json(rows.map(appDetail));
});

app.post('/api/apps', (req, res) => {
  const b = req.body ?? {};
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  if (!SLUG_RE.test(slug)) bad('slug 必须是小写字母/数字/连字符（≤64 字符，字母或数字开头）');
  const files = validateAppFiles(b.files);
  const existing = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as unknown as AppRow | undefined;

  let appRow: AppRow;
  let version: number;
  if (existing) {
    // 重新发布 = 新版本快照（title/description/created_by 缺省保留原值）
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : existing.title;
    const description = b.description !== undefined ? String(b.description) : existing.description;
    const created_by = typeof b.created_by === 'string' && b.created_by.trim() ? b.created_by.trim() : existing.created_by;
    const maxV = db.prepare('SELECT MAX(version) AS v FROM app_versions WHERE app_id = ?').get(existing.id) as { v: number | null };
    version = (maxV.v ?? 0) + 1;
    const st = writeAppFiles(slug, version, files);
    db.prepare(`UPDATE apps SET title = ?, description = ?, created_by = ?, active_version = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(title, description, created_by, version, existing.id);
    db.prepare(`INSERT INTO app_versions (app_id, version, file_count, total_bytes, created_by) VALUES (?, ?, ?, ?, ?)`)
      .run(existing.id, version, st.file_count, st.total_bytes, created_by);
    appRow = getApp(slug);
  } else {
    if (typeof b.title !== 'string' || !b.title.trim()) bad('首次发布必须提供 title');
    const created_by = String(b.created_by ?? '');
    const st = writeAppFiles(slug, 1, files);
    const r = db
      .prepare(`INSERT INTO apps (slug, title, description, created_by, active_version) VALUES (?, ?, ?, ?, 1)`)
      .run(slug, b.title.trim(), String(b.description ?? ''), created_by) as unknown as { lastInsertRowid: number | bigint };
    db.prepare(`INSERT INTO app_versions (app_id, version, file_count, total_bytes, created_by) VALUES (?, 1, ?, ?, ?)`)
      .run(Number(r.lastInsertRowid), st.file_count, st.total_bytes, created_by);
    version = 1;
    appRow = getApp(slug);
  }
  const workbench_id = syncWorkbenchRegistration(appRow);
  res.status(existing ? 200 : 201).json({ ok: true, slug: appRow.slug, version, workbench_id, app: appDetail(appRow) });
});

app.get('/api/apps/:slug', (req, res) => {
  res.json(appDetail(getApp(req.params.slug)));
});

// 版本回滚：activate 指定历史版本为当前生效快照（文件不动，只切换指针）
app.post('/api/apps/:slug/activate', (req, res) => {
  const a = getApp(req.params.slug);
  const v = Number(req.body?.version);
  if (!Number.isInteger(v) || v < 1) bad('version 必须是正整数');
  const hit = db.prepare('SELECT version FROM app_versions WHERE app_id = ? AND version = ?').get(a.id, v) as { version: number } | undefined;
  if (!hit) throw new HttpError(404, `版本不存在: ${v}`);
  db.prepare(`UPDATE apps SET active_version = ?, updated_at = datetime('now') WHERE id = ?`).run(v, a.id);
  res.json(appDetail(getApp(a.slug)));
});

app.delete('/api/apps/:slug', (req, res) => {
  const a = getApp(req.params.slug);
  rmSync(join(appsRoot, a.slug), { recursive: true, force: true });
  db.prepare('DELETE FROM app_versions WHERE app_id = ?').run(a.id);
  db.prepare('DELETE FROM apps WHERE id = ?').run(a.id);
  db.prepare(`DELETE FROM workbenches WHERE url = ? AND type = 'market-app'`).run(`/apps/${a.slug}/`);
  res.json({ ok: true, deleted: a.slug });
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

app.get('/api/summary', (_req, res) => {
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
  res.json({
    total: rows.length,
    enabled: rows.filter((w) => w.enabled).length,
    up: up.length,
    down: rows.filter((w) => w.enabled && w.last_status === 'down').length,
    unknown: rows.filter((w) => w.enabled && w.last_status === 'unknown').length,
    avg_latency_ms: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    categories: Object.fromEntries([...byCategory].map(([k, v]) => [k, v])),
  });
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
  const allowed = ['health_interval_seconds', 'health_timeout_ms', 'health_concurrency'];
  const upd = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(b)) {
    if (!allowed.includes(k)) continue;
    upd.run(k, String(v));
  }
  res.json(getSettings());
});

app.get('/api/export', (_req, res) => {
  res.json({
    format: 'workbench-market/export@1',
    exported_at: new Date().toISOString(),
    workbenches: listWorkbenches(),
    types: db.prepare('SELECT * FROM types ORDER BY id ASC').all(),
    settings: getSettings(),
  });
});

app.post('/api/import', (req, res) => {
  const b = req.body ?? {};
  if (!Array.isArray(b.workbenches)) bad('导入文件缺少 workbenches 数组');
  const mode = b.mode === 'replace' ? 'replace' : 'merge';
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
    try { assertHttpUrl(String(w.url)); } catch { continue; }
    let authCfg = '';
    if (w.auth && (w.auth.type === 'bearer' || w.auth.type === 'basic') && typeof w.auth.value === 'string' && w.auth.value) {
      authCfg = JSON.stringify({ type: w.auth.type, value: w.auth.value });
    }
    ins.run(
      String(w.name ?? '未命名'), String(w.url), String(w.type ?? 'web'), String(w.icon ?? ''),
      String(w.description ?? ''), String(w.category ?? ''),
      JSON.stringify(Array.isArray(w.tags) ? w.tags : []), w.enabled === false ? 0 : 1,
      String(w.health_path ?? ''), Number(w.sort) || 0, authCfg
    );
    imported += 1;
  }
  res.json({ ok: true, mode, imported, skipped: b.workbenches.length - imported });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'workbench-market-server', version: '0.1.0', uptime_s: Math.round(process.uptime()) });
});

// ---------- 统一门户：/go/:id/* 反向代理到对应工作台 ----------
// 所有注册工作台挂到 9800 同域路径下：一个端口号 + 同源（CORS 消失）+
// 代理剥掉 X-Frame-Options / CSP（禁嵌防线失效）→ 使用页/驾驶舱全量可嵌。
const wbById = (id: number): ReturnType<typeof rowToWorkbench> | null => {
  const row = db.prepare('SELECT * FROM workbenches WHERE id = ?').get(id) as unknown as WorkbenchRow | undefined;
  return row ? rowToWorkbench(row) : null;
};
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
      // 3xx Location 改写回 /go/N/ 前缀，防跳回原域丢前缀
      const loc = proxyRes.headers.location;
      if (typeof loc === 'string') {
        const m = goPrefix.exec(req.url ?? '');
        if (m) {
          const base = (req as express.Request & { goBase?: string }).goBase ?? '';
          if (loc.startsWith('/')) {
            proxyRes.headers.location = `/go/${m[1]}${loc.startsWith(base + '/') ? loc.slice(base.length) : loc}`;
          } else if (/^https?:\/\//i.test(loc)) {
            try {
              const lu = new URL(loc);
              if (lu.origin === (req as express.Request & { goOrigin?: string }).goOrigin) {
                let p = lu.pathname;
                if (base && p.startsWith(base)) p = p.slice(base.length);
                proxyRes.headers.location = `/go/${m[1]}${p}${lu.search}${lu.hash}`;
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
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error('[server] unhandled:', err);
  res.status(status).json({ error: String(err.message ?? err) });
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
