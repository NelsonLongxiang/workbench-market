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
-- #159 M3 B1（决策 #010）：任务中心三面——任务真源 / 事件只增 / 中心级策略（两把锁之一·任务级锁在 tasks.enabled）
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '录入',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft', -- draft|published|withdrawn
  material_sha256 TEXT, -- 发布冻结（同录入只发一次）
  published_at TEXT, published_by TEXT,
  enabled INTEGER NOT NULL DEFAULT 0, -- 任务级锁（默认关）
  agent_dispatch_enabled INTEGER NOT NULL DEFAULT 0, -- 任务级 agent 派发开关（默认关·监督席对齐②）
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
-- Uniqueness is per intake run; migrated by task-center.ts.
CREATE TABLE IF NOT EXISTS task_events ( -- 只增不改（无 UPDATE/DELETE 端点·零触发器）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  type TEXT NOT NULL, -- created|toggled|published|withdrawn
  actor TEXT NOT NULL DEFAULT '', actor_kind TEXT NOT NULL DEFAULT 'human',
  at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS task_center_policy (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO task_center_policy(key, value) VALUES ('center_switch', 'off'); -- 中心级锁默认关
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
CREATE TABLE IF NOT EXISTS app_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug TEXT NOT NULL,
  node TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_bindings_slug ON app_bindings (app_slug, revoked_at);
-- 联合评审①裁定 C（2026-10-26）：统一绑定表——表层统一+语义分离（admits=入站准入/notify=出站推送，
-- both=显式双授永非默认）；跨型 CHECK 锁 app 行的 sop 专属字段（remote_api_key 恒空/mode 恒 read）。
-- #94 v3 S1 统一人审门：破坏性操作（台回滚/删除）经请求-批准两段——agent 经 MCP 只能提请求，人带口令批准才执行
CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('app','skill')),
  slug TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('rollback','delete')),
  target_version INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'mcp',
  requested_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests (status, created_at);
-- P0 安全（总工 direct-c2b55f91）：SOP run 交付文件写面审计（run/文件/sha/来源/时间）
CREATE TABLE IF NOT EXISTS sop_run_file_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_srfa_run ON sop_run_file_audit (run_id, created_at);
-- #94 S3：agent 端摘要上报（K14 漂移记——D5 薄分发·agent 本机算摘要回传）
CREATE TABLE IF NOT EXISTS skill_digest_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  expected TEXT NOT NULL,
  match_result INTEGER NOT NULL,
  reported_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sdr_skill ON skill_digest_reports (skill_id, version);
-- 旧两表保留一版作回滚锚与迁移源（下版删除）。
CREATE TABLE IF NOT EXISTS bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('sop','app')),
  target_slug TEXT NOT NULL,
  agent_node TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('admits','notify','both')),
  mode TEXT NOT NULL DEFAULT 'read',
  notify_url TEXT NOT NULL DEFAULT '',
  remote_api_key TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT NOT NULL DEFAULT '',
  CHECK ((target_type = 'sop') OR (target_type = 'app' AND remote_api_key = '' AND mode = 'read'))
);
CREATE INDEX IF NOT EXISTS idx_bindings_target ON bindings (target_type, target_slug, revoked_at);
CREATE INDEX IF NOT EXISTS idx_bindings_node ON bindings (agent_node, revoked_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bindings_natural ON bindings (target_type, target_slug, agent_node, direction);
-- S3 豁免面可观测（评审席裁下批）：REMOTE_ALLOW 快照逐次落库·启动 diff 变更面
CREATE TABLE IF NOT EXISTS remote_allow_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
-- #309 phase2：run 私有读授权（cap 只存摘要；grant 主体制，缺归属即拒私有值）
CREATE TABLE IF NOT EXISTS sop_run_read_caps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  cap_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sop_run_read_caps_sha ON sop_run_read_caps (cap_sha256);
CREATE TABLE IF NOT EXISTS sop_run_read_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reader',
  granted_by TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  revoked_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sop_run_read_grants_run ON sop_run_read_grants (run_id, subject);
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
-- #94 S0⑥（K9）：digest 唯一性按 skill 域（不同技能同内容各自可发布——全局唯一是误拒）
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_versions_domain_digest ON skill_versions(skill_id, tree_digest);
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
// #94 S2：skill_versions.commit_id（技能入 LayerFS·wm-skills 项目 skill/<slug> 分支）
try { const svCols = db.prepare('PRAGMA table_info(skill_versions)').all() as any[]; if (!svCols.some((c) => c.name === 'commit_id')) db.exec("ALTER TABLE skill_versions ADD COLUMN commit_id TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// #94 P1 影子双写：apps.layerfs_project + app_versions.commit_id（幂等 ALTER）
try { const appCols = db.prepare('PRAGMA table_info(apps)').all() as any[]; if (!appCols.some((c) => c.name === 'layerfs_project')) db.exec("ALTER TABLE apps ADD COLUMN layerfs_project TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const avCols = db.prepare('PRAGMA table_info(app_versions)').all() as any[]; if (!avCols.some((c) => c.name === 'commit_id')) db.exec("ALTER TABLE app_versions ADD COLUMN commit_id TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// S1 表形状迁移（PR#103 旧形状 kind=app_rollback… → v3 契约 kind×op·表新落地零产数据直接重建）
try { const crCols = db.prepare("PRAGMA table_info(change_requests)").all() as any[]; if (crCols.length > 0 && !crCols.some((c) => c.name === 'op')) { db.exec('DROP TABLE change_requests'); db.exec("CREATE TABLE change_requests (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  kind TEXT NOT NULL CHECK (kind IN ('app','skill')),\n  slug TEXT NOT NULL,\n  op TEXT NOT NULL CHECK (op IN ('rollback','delete')),\n  target_version INTEGER,\n  reason TEXT NOT NULL DEFAULT '',\n  source TEXT NOT NULL DEFAULT 'mcp',\n  requested_by TEXT NOT NULL DEFAULT '',\n  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),\n  reviewed_by TEXT NOT NULL DEFAULT '',\n  reviewed_at TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT (datetime('now'))\n)"); } } catch { /* 无表 */ }
// #94 S0⑥（K9）幂等迁移：拆全局 digest 唯一索引（域级复合索引由 DDL 建）
try { db.exec('DROP INDEX IF EXISTS idx_skill_versions_digest'); } catch { /* 旧库无此索引 */ }

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
  // 联合评审① C：旧两表幂等平移入统一表（natural key 唯一索引承载 OR REPLACE 语义；重复启动安全）
try {
  db.exec(`INSERT OR REPLACE INTO bindings (target_type,target_slug,agent_node,direction,mode,notify_url,remote_api_key,created_by,created_at,revoked_at)
    SELECT 'sop', sop_slug, node, 'admits', mode, callback_url, remote_api_key, created_by, created_at, revoked_at FROM sop_bindings`);
  db.exec(`INSERT OR REPLACE INTO bindings (target_type,target_slug,agent_node,direction,mode,notify_url,created_by,created_at,revoked_at)
    SELECT 'app', app_slug, node, 'notify', 'read', base_url, created_by, created_at, revoked_at FROM app_bindings`);
} catch { /* 首启表未建等情形由外层建表先行——此处静默重试下次启动 */ }
const bindCols = db.prepare('PRAGMA table_info(sop_bindings)').all() as { name: string }[];
  if (!bindCols.some((c) => c.name === 'callback_url')) {
    db.exec("ALTER TABLE sop_bindings ADD COLUMN callback_url TEXT NOT NULL DEFAULT ''");
  }
}

// #601（P0·属主实测装不下）：skill_versions 绝对快照路径归一到相对形
try {
  const _sv = db.prepare("SELECT id, snapshot_path FROM skill_versions").all() as any[];
  let _n = 0;
  for (const _r of _sv) {
    const _p = String(_r.snapshot_path ?? "").replace(/\\/g, "/");
    const _i = _p.indexOf("/skill-snapshots/");
    if (/^[A-Za-z]:\//.test(_p) && _i >= 0) {
      db.prepare("UPDATE skill_versions SET snapshot_path = ? WHERE id = ?").run("skill-snapshots/" + _p.slice(_i + 17), _r.id);
      _n++;
    }
  }
  if (_n) console.log("[migrate] skill_versions 快照路径归一", _n, "行");
} catch { /* 表未建 */ }

// 轻量列迁移：已存库补列（凭据注入 / SOP 台生成器 / A2A 节点短 id / cookie 池挂接）
// #132 P0：app_files.note+deleted_at·app_data.deleted_at（幂等 ALTER·软删原行留审计）
try { const afCols = db.prepare('PRAGMA table_info(app_files)').all() as any[]; if (!afCols.some((c) => c.name === 'note')) db.exec("ALTER TABLE app_files ADD COLUMN note TEXT NOT NULL DEFAULT ''"); if (!afCols.some((c) => c.name === 'deleted_at')) db.exec("ALTER TABLE app_files ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const adCols = db.prepare('PRAGMA table_info(app_data)').all() as any[]; if (!adCols.some((c) => c.name === 'deleted_at')) db.exec("ALTER TABLE app_data ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// P0：sop_runs.upload_token（run-scoped 上传令牌·启动签发——总工 direct-c2b55f91）
try { const srtCols = db.prepare('PRAGMA table_info(sop_runs)').all() as any[]; if (!srtCols.some((c) => c.name === 'upload_token')) db.exec("ALTER TABLE sop_runs ADD COLUMN upload_token TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
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
