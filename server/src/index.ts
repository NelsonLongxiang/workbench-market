import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, rowToWorkbench, type WorkbenchRow, type TypeRow } from './db.ts';
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
    assertHttpUrl(b.url.trim());
    out.url = b.url.trim();
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
  return out;
}

app.post('/api/workbenches', (req, res) => {
  const f = validateWorkbenchBody(req.body);
  const r = db
    .prepare(
      `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort)
       VALUES (@name, @url, @type, @icon, @description, @category, @tags, @enabled, @health_path, @sort)`
    )
    .run({ type: 'web', icon: '', description: '', category: '', tags: '[]', enabled: 1, health_path: '', sort: 0, ...f });
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
     updated_at=datetime('now') WHERE id=@id`
  ).run({ ...merged, id });
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
  if (cur.key === 'web') bad('内置类型 web 不允许删除');
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
    `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort, last_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`
  );
  let imported = 0;
  for (const w of b.workbenches) {
    try { assertHttpUrl(String(w.url)); } catch { continue; }
    ins.run(
      String(w.name ?? '未命名'), String(w.url), String(w.type ?? 'web'), String(w.icon ?? ''),
      String(w.description ?? ''), String(w.category ?? ''),
      JSON.stringify(Array.isArray(w.tags) ? w.tags : []), w.enabled === false ? 0 : 1,
      String(w.health_path ?? ''), Number(w.sort) || 0
    );
    imported += 1;
  }
  res.json({ ok: true, mode, imported, skipped: b.workbenches.length - imported });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'workbench-market-server', version: '0.1.0', uptime_s: Math.round(process.uptime()) });
});

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
app.listen(PORT, () => {
  const counts = db.prepare('SELECT COUNT(*) AS n FROM workbenches').get() as { n: number };
  console.log(`[workbench-market] server  http://127.0.0.1:${PORT}  (workbenches: ${counts.n}, web-dist: ${existsSync(webDist) ? 'served' : 'none'})`);
});
