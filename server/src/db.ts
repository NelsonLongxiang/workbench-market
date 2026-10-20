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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app_id, version)
);
`);

// 轻量列迁移：已存库补 auth_config（凭据注入：JSON {type:'bearer'|'basic', value}，空串=无）
{
  const cols = db.prepare('PRAGMA table_info(workbenches)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'auth_config')) {
    db.exec("ALTER TABLE workbenches ADD COLUMN auth_config TEXT NOT NULL DEFAULT ''");
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

/** 自产台（台生成器）：slug 唯一标识，active_version 指向当前生效快照 */
export interface AppRow {
  id: number; slug: string; title: string; description: string; created_by: string;
  active_version: number; status: string; created_at: string; updated_at: string;
}

/** 自产台版本快照：文件树落在 DATA_DIR/apps/<slug>/v<version>/ */
export interface AppVersionRow {
  id: number; app_id: number; version: number; file_count: number; total_bytes: number;
  created_by: string; created_at: string;
}

export interface CockpitRow {
  id: number; name: string; description: string; layout_config: string;
  created_at: string; updated_at: string;
}

/** 驾驶舱面板配置：workbenchId 指向 workbenches.id，x/y/w/h 为网格布局 */
export interface PanelConfig {
  i: string;
  workbenchId: number;
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
