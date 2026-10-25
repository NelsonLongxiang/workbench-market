import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'workbench-market.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS workbenches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'web',
  icon TEXT DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  health_path TEXT DEFAULT '',
  last_status TEXT DEFAULT 'unknown',
  last_checked_at TEXT DEFAULT '',
  last_latency_ms INTEGER,
  last_http_code INTEGER,
  last_error TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  auth_config TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '',
  default_port INTEGER,
  health_method TEXT NOT NULL DEFAULT 'GET',
  health_path TEXT NOT NULL DEFAULT '/',
  expect_status INTEGER,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cockpits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  layout_config TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  active_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  changelog TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app_id, version)
);
CREATE TABLE IF NOT EXISTS sop_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sop_slug TEXT NOT NULL,
  sop_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_by TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sop_runs_slug ON sop_runs (sop_slug, status);
CREATE TABLE IF NOT EXISTS sop_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sop_slug TEXT NOT NULL,
  node TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read',
  remote_api_key TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sop_bindings_slug ON sop_bindings (sop_slug, revoked_at);
CREATE TABLE IF NOT EXISTS a2a_run_ctx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_a2a_run_ctx ON a2a_run_ctx (context_id);
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  token_sha256 TEXT NOT NULL,
  grants TEXT NOT NULL DEFAULT '[]',
  revoked_at TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  session_name TEXT NOT NULL,
  method TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  args_sha256 TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_session ON mcp_calls (session_name, at);
CREATE TABLE IF NOT EXISTS a2a_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  context_id TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  next_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_a2a_outbox_due ON a2a_outbox(status, next_at);
CREATE TABLE IF NOT EXISTS sop_run_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sop_run_files_run ON sop_run_files(run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_outbox_run ON a2a_outbox(run_id);
CREATE TABLE IF NOT EXISTS cookie_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  cookies_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_data_slug ON app_data(app_slug, created_at);
CREATE TABLE IF NOT EXISTS app_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_files_slug ON app_files(app_slug, created_at);
-- 技能市场四表（方案 v1 PR#57 · P0-a-1）
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 5),
  layer_name TEXT NOT NULL,
  family_parent TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  argument_hint TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_layer ON skills(layer);
CREATE INDEX IF NOT EXISTS idx_skills_family ON skills(family_parent);
CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  version INTEGER NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  breaking INTEGER NOT NULL DEFAULT 0,
  tree_digest TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  snapshot_path TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(skill_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_digest ON skill_versions(tree_digest);
CREATE TABLE IF NOT EXISTS role_bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  bundle_version INTEGER NOT NULL,
  roster_digest TEXT NOT NULL,
  prompt_soul TEXT NOT NULL DEFAULT '',
  skill_slugs TEXT NOT NULL DEFAULT '[]',
  snapshot_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pack_id, member_name, bundle_version)
);
CREATE TABLE IF NOT EXISTS install_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  version_id INTEGER NOT NULL REFERENCES skill_versions(id),
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expected_digest TEXT NOT NULL,
  installed_path TEXT NOT NULL,
  installed_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed','revoked'))
);

`);

// A2A P3 回执（评审席判据 network/a2a-receipt E1-E7）
{
  const ctxCols = db.prepare('PRAGMA table_info(a2a_run_ctx)').all() as { name: string }[];
  if (!ctxCols.some((c) => c.name === 'task_id')) {
    db.exec("ALTER TABLE a2a_run_ctx ADD COLUMN task_id TEXT NOT NULL DEFAULT ''");
  }
  if (!ctxCols.some((c) => c.name === 'caller')) {
    db.exec("ALTER TABLE a2a_run_ctx ADD COLUMN caller TEXT NOT NULL DEFAULT ''");
  }
  if (!ctxCols.some((c) => c.name === 'team')) {
    db.exec("ALTER TABLE a2a_run_ctx ADD COLUMN team TEXT NOT NULL DEFAULT ''");
  }
  if (!ctxCols.some((c) => c.name === 'receipt_status')) {
    db.exec("ALTER TABLE a2a_run_ctx ADD COLUMN receipt_status TEXT NOT NULL DEFAULT ''");
  }
  if (!ctxCols.some((c) => c.name === 'callback_url')) {
    db.exec("ALTER TABLE a2a_run_ctx ADD COLUMN callback_url TEXT NOT NULL DEFAULT ''");
  }
  const bindCols = db.prepare('PRAGMA table_info(sop_bindings)').all() as { name: string }[];
  if (!bindCols.some((c) => c.name === 'callback_url')) {
    db.exec("ALTER TABLE sop_bindings ADD COLUMN callback_url TEXT NOT NULL DEFAULT ''");
  }
}

// 轻量列迁移：已存库补列（凭据注入 / SOP 台生成器 / A2A 节点短 id / cookie 池挂接）
{
  const cols = db.prepare('PRAGMA table_info(workbenches)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'auth_config')) {
    db.exec("ALTER TABLE workbenches ADD COLUMN auth_config TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === 'cookie_set_id')) {
    db.exec("ALTER TABLE workbenches ADD COLUMN cookie_set_id INTEGER NOT NULL DEFAULT 0");
  }
}
{
  const cols = db.prepare('PRAGMA table_info(apps)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE apps ADD COLUMN kind TEXT NOT NULL DEFAULT 'app'");
  }
  if (!cols.some((c) => c.name === 'code')) {
    db.exec("ALTER TABLE apps ADD COLUMN code TEXT NOT NULL DEFAULT ''");
  }
  // A2A 节点短 id（GH #17：随机生成持久化，禁 slug 推导——修订 3 防抢注）
  if (!cols.some((c) => c.name === 'a2a_node8')) {
    db.exec("ALTER TABLE apps ADD COLUMN a2a_node8 TEXT NOT NULL DEFAULT ''");
  }
}
{
  const cols = db.prepare('PRAGMA table_info(app_versions)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'changelog')) {
    db.exec("ALTER TABLE app_versions ADD COLUMN changelog TEXT NOT NULL DEFAULT ''");
  }
}

/** 内置工作台类型种子：health 探测语义——expect_status 为 NULL 表示任意 HTTP 响应即在线 */
const seedTypes = [
  { key: 'web', name: '通用 Web 工作台', icon: '🌐', port: null, method: 'GET', path: '/', expect: null, desc: '任意 HTTP 响应即视为在线' },
  { key: 'openai-api', name: 'OpenAI 兼容 API', icon: '🤖', port: 8000, method: 'GET', path: '/v1/models', expect: null, desc: '兼容 OpenAI 接口的服务（401 也算存活）' },
  { key: 'ollama', name: 'Ollama 服务', icon: '🦙', port: 11434, method: 'GET', path: '/api/tags', expect: 200, desc: '本地模型服务' },
  { key: 'gradio', name: 'Gradio 应用', icon: '🎨', port: 7860, method: 'GET', path: '/config', expect: null, desc: 'Gradio WebUI 应用' },
  { key: 'streamlit', name: 'Streamlit 应用', icon: '📊', port: 8501, method: 'GET', path: '/_stcore/health', expect: 200, desc: 'Streamlit 数据应用' },
  { key: 'jupyter', name: 'Jupyter 服务', icon: '📓', port: 8888, method: 'GET', path: '/api', expect: null, desc: 'Jupyter Notebook / Lab' },
  { key: 'mcp-sse', name: 'MCP SSE 端点', icon: '🔌', port: 3000, method: 'GET', path: '/sse', expect: null, desc: 'MCP Server-Sent Events 端点' },
  { key: 'docs', name: '文档站', icon: '📚', port: null, method: 'GET', path: '/', expect: null, desc: '静态文档 / 知识库站点' },
  { key: 'market-app', name: '市场自产台', icon: '🧩', port: null, method: 'GET', path: '/', expect: null, desc: '市场内置静态托管（POST /api/apps 发布），服务存活即在线' },
];

const insType = db.prepare(
  `INSERT OR IGNORE INTO types (key, name, icon, default_port, health_method, health_path, expect_status, description)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
for (const t of seedTypes) insType.run(t.key, t.name, t.icon, t.port, t.method, t.path, t.expect, t.desc);

const defaultSettings: Record<string, string> = {
  health_interval_seconds: '0',
  health_timeout_ms: '5000',
  health_concurrency: '8',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) insSetting.run(k, v);

export function getSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export interface WorkbenchRow {
  id: number; name: string; url: string; type: string; icon: string; description: string;
  category: string; tags: string; enabled: number; health_path: string;
  last_status: string; last_checked_at: string; last_latency_ms: number | null;
  last_http_code: number | null; last_error: string; sort: number; auth_config: string;
  created_at: string; updated_at: string;
}

/** 凭据注入配置：bearer → Authorization: Bearer <value>；basic → value 为 user:pass，注入时编码 */
export interface AuthConfig {
  type: 'bearer' | 'basic';
  value: string;
}

export interface TypeRow {
  id: number; key: string; name: string; icon: string; default_port: number | null;
  health_method: string; health_path: string; expect_status: number | null;
  description: string; created_at: string;
}

/** 自产台（台生成器）：slug 唯一标识，active_version 指向当前生效快照；kind=app|sop，code=SOP 编号 */
export interface AppRow {
  id: number; slug: string; title: string; description: string; created_by: string;
  active_version: number; status: string; kind: string; code: string;
  created_at: string; updated_at: string;
}

/** 自产台版本快照：文件树落在 DATA_DIR/apps/<slug>/v<version>/；changelog=SOP 每版必填变更记录 */
export interface AppVersionRow {
  id: number; app_id: number; version: number; file_count: number; total_bytes: number;
  created_by: string; changelog: string; created_at: string;
}

/** SOP 执行实例（分层治理·持久层真源）：data=stepKey→value JSON；热态在 Redis（redis.ts） */
export interface SopRunRow {
  id: number; sop_slug: string; sop_version: number; status: string; started_by: string;
  data: string; started_at: string; updated_at: string; finished_at: string;
}

export interface CockpitRow {
  id: number; name: string; description: string; layout_config: string;
  created_at: string; updated_at: string;
}

/** 驾驶舱面板配置：workbenchId 指向 workbenches.id，x/y/w/h 为网格布局 */
export interface PanelConfig {
  i: string;
  workbenchId: number;
  /** 面板种类：默认工作台面板；'tasks' = 统一待办卡（omni-inbox，workbenchId=0 占位） */
  kind?: 'tasks';
  x: number; y: number; w: number; h: number;
}

export function rowToCockpit(r: CockpitRow) {
  let panels: PanelConfig[] = [];
  try { panels = JSON.parse(r.layout_config || '[]'); } catch { panels = []; }
  return { ...r, panels };
}

export function rowToWorkbench(r: WorkbenchRow) {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
  let auth: AuthConfig | null = null;
  try { const a = JSON.parse(r.auth_config || 'null'); if (a && (a.type === 'bearer' || a.type === 'basic') && typeof a.value === 'string') auth = a; } catch { auth = null; }
  const { auth_config: _ac, ...rest } = r;
  return { ...rest, enabled: !!r.enabled, tags, auth };
}
