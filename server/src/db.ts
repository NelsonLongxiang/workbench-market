import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_BUSY_TIMEOUT_MS } from './db-busy.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });

// 别的连接锁着写时最多等 DB_BUSY_TIMEOUT_MS（见 db-busy.ts）：短暂重叠不直接失败，超过上限照样报错
export const db = new DatabaseSync(join(dataDir, 'workbench-market.db'), { timeout: DB_BUSY_TIMEOUT_MS });

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
  shadow_status TEXT NOT NULL DEFAULT 'pending',
  shadow_error TEXT NOT NULL DEFAULT '',
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
  cache_revision INTEGER NOT NULL DEFAULT 0,
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
-- 技能包下载票据：MCP skill_download 签发，10 分钟有效；URL 里只有随机票号，不带会话令牌。id 存票号的 sha256，不存明文
CREATE TABLE IF NOT EXISTS skill_download_tickets (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  issued_to TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  last_download_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
-- 门户 SSO 回调票据（同域登录中继·odoo-session.ts）：放库里重启不丢、同一 DATA_DIR 的多个实例共享；只存台 id/源/来源/到期，不存会话
CREATE TABLE IF NOT EXISTS sso_tickets (
  state TEXT PRIMARY KEY,
  wb_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  source TEXT NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_tickets_exp ON sso_tickets(exp);
CREATE INDEX IF NOT EXISTS idx_sso_tickets_source ON sso_tickets(source, exp);
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
-- /a2a/direct 入站签名防重放：验过的签名摘要存到有效期结束（落库，重启后重放照样拒）
CREATE TABLE IF NOT EXISTS a2a_sig_seen (
  sig_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_sig_seen_exp ON a2a_sig_seen (expires_at);
-- /a2a/direct 幂等登记：task_id → 指纹 sha256，30 分钟窗口（落库，重启后同一 task_id 仍判 replay / conflict）
CREATE TABLE IF NOT EXISTS a2a_idempotency (
  task_id TEXT PRIMARY KEY,
  fp_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_idempotency_at ON a2a_idempotency (created_at);
-- 阶段七 R3：我们发出的每个 A2A 任务号 → 它属于哪个事件、哪次投递，以及发出那一刻对端是谁（名片 team 与根地址）。
-- 回执按任务号找回事项；只认签名方等于这里记下的对端。kind=delivery 是接单投递，answer 是 R2 的答复发送。
CREATE TABLE IF NOT EXISTS a2a_sent_tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery','answer')),
  event_id TEXT NOT NULL,
  delivery_id INTEGER NOT NULL,
  peer_root TEXT NOT NULL DEFAULT '',
  peer_zone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_a2a_sent_tasks_delivery ON a2a_sent_tasks (delivery_id);
CREATE INDEX IF NOT EXISTS idx_a2a_sent_tasks_peer_root ON a2a_sent_tasks (peer_root);
-- 收到并采信的回执：同一任务号的接单回执（acknowledged）一条、终局回执（attention / result）一条，按 idempotencyKey 去重
-- 阶段七 R2：席位发来的跟进（同 context 的普通 A2A 任务，任务号 a2a-…）。签名方是我们投递到的那台宿主、context 是我们发出的，才收下。
-- 落成事项对话里的席位消息（open=未读、acknowledged=看过、replied=已回复），不进「关注」；超过每次投递的上限的照存、不算未读（status=over-cap）；超过对端限频的不存正文（status=rate-limited），两种都照常回执。时间由代码生成后写入。
CREATE TABLE IF NOT EXISTS workbench_event_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  delivery_id INTEGER NOT NULL,
  peer_zone TEXT NOT NULL,
  inbound_task TEXT NOT NULL,
  context_id TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('open','replied','acknowledged','over-cap','rate-limited')),
  handled_by TEXT NOT NULL DEFAULT '',
  handled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (delivery_id, inbound_task)
);
CREATE INDEX IF NOT EXISTS idx_wbe_followups_status ON workbench_event_followups (status, id);
CREATE INDEX IF NOT EXISTS idx_wbe_followups_zone ON workbench_event_followups (peer_zone, created_at);
-- 阶段七 R2：市场回给团队的消息，只放发送状态。kind：
--   answer          人答复席位回执里的提问 → 同 context 的新任务（每次尝试一个任务号）
--   followup-reply  人回复席位来信 → 同 context 的新任务（每次尝试一个任务号）
--   followup-receipt 收下跟进后结清它的回执：任务号固定为 receipt-<跟进任务号>，只用跟进的任务号；发不出去一直重试（不判 dead）
-- 发送复用事件投递的 a2aSendOutbound（Sig2 + Sig3）、退避与终止码。唯一 outbox 那一步并进 a2a_outbox_items。时间由代码生成后写入。
CREATE TABLE IF NOT EXISTS workbench_event_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('answer','followup-reply','followup-receipt')),
  event_id TEXT NOT NULL,
  delivery_id INTEGER NOT NULL,
  ref INTEGER NOT NULL,
  qid TEXT NOT NULL DEFAULT '',
  fixed_task TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL,
  caller_session TEXT NOT NULL,
  context_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT '',
  UNIQUE (kind, delivery_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_wbe_replies_due ON workbench_event_replies (status, next_at);
CREATE TABLE IF NOT EXISTS a2a_inbound_receipts (
  task_id TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('ack','final')),
  disposition TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, class)
);
-- 阶段七：团队名册（dsh-open-a2a-net#604 P3，[A2A roster]）。只认我们投递过的宿主、Sig3、席位只认签名这台宿主自己区里的；只当信息，不授予任何东西。
-- a2a_rosters 每台宿主一行（来源、报的时间）；a2a_roster_seats 每个席位一行，键是「节点（宿主指纹）+ 团队 + 席位句柄」（14 号文档：团队登记、
-- 负责人、分配建在它上面）；每次全量快照以新替旧（按宿主报的时间）。a2a_roster_changes 记入库时算出的变化（新团队、新成员、成员消失、
-- 团队消失、换总工），给上层做通知和「等你拍板」。host 是验过签的那把节点公钥的指纹（sha256 前 8 位十六进制，上游 canvasOwnerFingerprint），
-- 正文里报的 host 只拿来核对；同一个 host 只认第一次报它的根地址。seat_id 是宿主给成员位的稳定 id（上游 B1 起，句柄随会话变、它不变；旧节点不带就是空）。
-- 时间由代码生成后写入。
CREATE TABLE IF NOT EXISTS a2a_rosters (
  host TEXT PRIMARY KEY,
  peer_root TEXT NOT NULL,
  peer_zone TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS a2a_roster_seats (
  host TEXT NOT NULL,
  team TEXT NOT NULL,
  seat TEXT NOT NULL,
  seat_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '' CHECK (role IN ('', 'router', 'member', 'observer')),
  online INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (host, team, seat)
);
CREATE TABLE IF NOT EXISTS a2a_roster_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('team-added', 'seat-added', 'seat-removed', 'team-removed', 'router-changed')),
  team TEXT NOT NULL,
  seat TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_roster_changes_at ON a2a_roster_changes (id);
-- 阶段七 R2：提问回执（attention-<task>-<qid>，preview.13 起）。不占接单 / 终局的槽：同一任务可以有多个问题，按（任务号、问题 id）去重。
-- 时间由代码生成后写入。
CREATE TABLE IF NOT EXISTS a2a_inbound_questions (
  task_id TEXT NOT NULL,
  qid TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (task_id, qid)
);
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
-- #324: explicit project authority, bound to the configured workspace; no implicit grants.
CREATE TABLE IF NOT EXISTS task_source_read_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'ygl-trees'),
  project TEXT NOT NULL,
  workspace_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_source_subject ON task_source_read_grants(subject, source, revoked_at);
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
-- #437③ 进行中的 run 升级到当前 SOP 版本：人确认、留审计（只记版本、操作者、理由和预检计数，不记字段值）
CREATE TABLE IF NOT EXISTS sop_run_upgrade_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  violations INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sop_run_upgrade_audit_run ON sop_run_upgrade_audit(run_id, id);
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
  shadow_status TEXT NOT NULL DEFAULT 'pending',
  shadow_error TEXT NOT NULL DEFAULT '',
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
try { const svCols = db.prepare('PRAGMA table_info(skill_versions)').all() as any[]; if (!svCols.some((c) => c.name === 'commit_id')) db.exec("ALTER TABLE skill_versions ADD COLUMN commit_id TEXT NOT NULL DEFAULT ''"); if (!svCols.some((c) => c.name === 'shadow_status')) db.exec("ALTER TABLE skill_versions ADD COLUMN shadow_status TEXT NOT NULL DEFAULT 'pending'"); if (!svCols.some((c) => c.name === 'shadow_error')) db.exec("ALTER TABLE skill_versions ADD COLUMN shadow_error TEXT NOT NULL DEFAULT ''"); db.exec("UPDATE skill_versions SET shadow_status='succeeded', shadow_error='' WHERE commit_id <> '' AND shadow_status='pending'"); } catch { /* 列已在 */ }
// 技能回滚=移「当前版本」指针（skills.active_version，NULL=跟随最新版）：版本链只增、同技能同指纹唯一（K9）都不动，回滚不再复制出同指纹的新版本撞唯一索引
try { const dlCols = db.prepare('PRAGMA table_info(skill_download_tickets)').all() as any[]; if (!dlCols.some((c) => c.name === 'denied')) db.exec('ALTER TABLE skill_download_tickets ADD COLUMN denied INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已在 */ } // #462：旧库补拒绝计数（旧明文票按哈希查不到，自然失效）
try { const skCols = db.prepare('PRAGMA table_info(skills)').all() as any[]; if (!skCols.some((c) => c.name === 'active_version')) db.exec('ALTER TABLE skills ADD COLUMN active_version INTEGER'); if (!skCols.some((c) => c.name === 'active_by')) db.exec("ALTER TABLE skills ADD COLUMN active_by TEXT NOT NULL DEFAULT ''"); if (!skCols.some((c) => c.name === 'active_at')) db.exec("ALTER TABLE skills ADD COLUMN active_at TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// #94 P1 影子双写：apps.layerfs_project + app_versions.commit_id（幂等 ALTER）
try { const appCols = db.prepare('PRAGMA table_info(apps)').all() as any[]; if (!appCols.some((c) => c.name === 'layerfs_project')) db.exec("ALTER TABLE apps ADD COLUMN layerfs_project TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const avCols = db.prepare('PRAGMA table_info(app_versions)').all() as any[]; if (!avCols.some((c) => c.name === 'commit_id')) db.exec("ALTER TABLE app_versions ADD COLUMN commit_id TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// 属主 2026-11-02 来源收敛：自产台/SOP 台只接受 GitHub 仓库 main——apps 记来源仓库与子目录，app_versions 记拉取的 commit sha（幂等 ALTER）
try { const appCols = db.prepare('PRAGMA table_info(apps)').all() as any[]; if (!appCols.some((c) => c.name === 'source_repo')) db.exec("ALTER TABLE apps ADD COLUMN source_repo TEXT NOT NULL DEFAULT ''"); if (!appCols.some((c) => c.name === 'source_path')) db.exec("ALTER TABLE apps ADD COLUMN source_path TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const avCols = db.prepare('PRAGMA table_info(app_versions)').all() as any[]; if (!avCols.some((c) => c.name === 'source_commit')) db.exec("ALTER TABLE app_versions ADD COLUMN source_commit TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const avCols = db.prepare('PRAGMA table_info(app_versions)').all() as any[]; if (!avCols.some((c) => c.name === 'commit_id')) db.exec("ALTER TABLE app_versions ADD COLUMN commit_id TEXT NOT NULL DEFAULT ''"); if (!avCols.some((c) => c.name === 'shadow_status')) db.exec("ALTER TABLE app_versions ADD COLUMN shadow_status TEXT NOT NULL DEFAULT 'pending'"); if (!avCols.some((c) => c.name === 'shadow_error')) db.exec("ALTER TABLE app_versions ADD COLUMN shadow_error TEXT NOT NULL DEFAULT ''"); db.exec("UPDATE app_versions SET shadow_status='succeeded', shadow_error='' WHERE commit_id <> '' AND shadow_status='pending'"); } catch { /* 列已在 */ }
// S1 表形状迁移（PR#103 旧形状 kind=app_rollback… → v3 契约 kind×op·表新落地零产数据直接重建）
try { const crCols = db.prepare("PRAGMA table_info(change_requests)").all() as any[]; if (crCols.length > 0 && !crCols.some((c) => c.name === 'op')) { db.exec('DROP TABLE change_requests'); db.exec("CREATE TABLE change_requests (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  kind TEXT NOT NULL CHECK (kind IN ('app','skill')),\n  slug TEXT NOT NULL,\n  op TEXT NOT NULL CHECK (op IN ('rollback','delete')),\n  target_version INTEGER,\n  reason TEXT NOT NULL DEFAULT '',\n  source TEXT NOT NULL DEFAULT 'mcp',\n  requested_by TEXT NOT NULL DEFAULT '',\n  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),\n  reviewed_by TEXT NOT NULL DEFAULT '',\n  reviewed_at TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT (datetime('now'))\n)"); } } catch { /* 无表 */ }
// 审核进「关注」：不通过的理由（review_note）、经身份认出来的审核人（reviewed_by_principal，reviewed_by 是旧入口自填的名字，只做显示）。幂等补列
for (const [column, ddl] of [
  ['review_note', "review_note TEXT NOT NULL DEFAULT ''"],
  ['reviewed_by_principal', "reviewed_by_principal TEXT NOT NULL DEFAULT ''"],
] as const) {
  const cols = db.prepare('PRAGMA table_info(change_requests)').all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === column)) db.exec(`ALTER TABLE change_requests ADD COLUMN ${ddl}`);
}
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
// MCP 工具 REST 开放：调用审计区分渠道（mcp = /mcp JSON-RPC，rest = /api/mcp-rest/tools/*）
// MCP 内嵌 REST：文件 sha256 入库时存下，下载 ETag 不再整份重算（存量行首次下载时回写）
try { const shaCols = db.prepare('PRAGMA table_info(app_files)').all() as any[]; if (!shaCols.some((c) => c.name === 'sha256')) db.exec("ALTER TABLE app_files ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const mcCols = db.prepare('PRAGMA table_info(mcp_calls)').all() as any[]; if (!mcCols.some((c) => c.name === 'channel')) db.exec("ALTER TABLE mcp_calls ADD COLUMN channel TEXT NOT NULL DEFAULT 'mcp'"); } catch { /* 列已在 */ }
try { const afCols = db.prepare('PRAGMA table_info(app_files)').all() as any[]; if (!afCols.some((c) => c.name === 'note')) db.exec("ALTER TABLE app_files ADD COLUMN note TEXT NOT NULL DEFAULT ''"); if (!afCols.some((c) => c.name === 'deleted_at')) db.exec("ALTER TABLE app_files ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
try { const adCols = db.prepare('PRAGMA table_info(app_data)').all() as any[]; if (!adCols.some((c) => c.name === 'deleted_at')) db.exec("ALTER TABLE app_data ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// MCP 权限自助申请：会话经 access_request 提、管理员批/驳；批准把 tools 并入会话 grants，与审计行同一事务。
// app_data.idempotency_key：app_data_submit / REST 提交带幂等键时同台同键只落一行（空串不参与唯一）。IF NOT EXISTS / 补列幂等。
db.exec(`
CREATE TABLE IF NOT EXISTS mcp_access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  tools TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_access_requests_session ON mcp_access_requests (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_access_requests_status ON mcp_access_requests (status, id);
CREATE TABLE IF NOT EXISTS mcp_grant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  request_id INTEGER,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  grants_before TEXT NOT NULL DEFAULT '[]',
  grants_after TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_grant_audit_session ON mcp_grant_audit (session_id, id);
`);
try { const adCols = db.prepare('PRAGMA table_info(app_data)').all() as any[]; if (!adCols.some((c) => c.name === 'idempotency_key')) db.exec("ALTER TABLE app_data ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_idem ON app_data (app_slug, idempotency_key) WHERE idempotency_key <> ''");
// #336：按工作台隔离的变量与常量（workbench_id 为隔离键；value 存 JSON 原文；revision 乐观锁，每次写 +1）。
// 审计只记值的 sha256 不记原文；IF NOT EXISTS 幂等，旧库启动即补表。
db.exec(`
CREATE TABLE IF NOT EXISTS workbench_vars (
  workbench_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'var' CHECK (kind IN ('var','const')),
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workbench_id, key)
);
CREATE TABLE IF NOT EXISTS workbench_var_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workbench_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  old_revision INTEGER,
  new_revision INTEGER,
  old_sha256 TEXT NOT NULL DEFAULT '',
  new_sha256 TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workbench_var_audit_wb ON workbench_var_audit(workbench_id, key, id);
`);
// 常量作者（谁写的谁维护）：只记个人身份 mcp:<会话名> / odoo:<登录名>；旧常量按最后写入者回填，共享身份（口令、本机、台令牌）留空=只有本机命令行能修订
try { const wvCols = db.prepare('PRAGMA table_info(workbench_vars)').all() as any[]; if (!wvCols.some((c) => c.name === 'owner')) db.exec("ALTER TABLE workbench_vars ADD COLUMN owner TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// 回填每次启动都跑（幂等）：补列后中途退出也不会漏。作者为空的常量只可能由共享身份最后写过，所以按个人身份回填不会改掉兜底移交的结果
db.exec("UPDATE workbench_vars SET owner = updated_by WHERE kind = 'const' AND owner = '' AND (updated_by LIKE 'mcp:%' OR updated_by LIKE 'odoo:%')");
// 阶段五：主体与外部身份。主体是「谁」的那一张表，五类（人、席位、台、系统、外部节点）；
//   标识带类别前缀：user: / seat: / app: / system: / node:；不是人的主体必须有责任人（责任人写主体标识）。
//   停用是本地动作：status 一改，所有入口现查现拒（见 services/principal.ts）。最近一次状态变更是谁、什么时候、为什么，记在行上。
// 外部身份（登录账号等）挂在主体上：提供方 + 对方的用户标识唯一，一个主体可以有多个。
//   旧留痕里的 `odoo:<登录名>` 就是这张表里的（provider='odoo', external_id=<登录名>），不改历史记录。
// id_key / external_key 是比较用的规范化值（services/principal.ts 的 comparisonKey：NFKC、大小写折叠、去掉零宽一类的字符），
//   唯一约束按它算：只差大小写、全角半角、夹零宽字符的写法，表这一层就建不出第二份。原值照存，显示和留痕用原值。
// IF NOT EXISTS 幂等，旧库启动即补表。
db.exec(`
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  id_key TEXT NOT NULL UNIQUE CHECK (id_key <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('person','seat','app','system','node')),
  display_name TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  status_changed_at TEXT NOT NULL DEFAULT '',
  status_changed_by TEXT NOT NULL DEFAULT '',
  status_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind = 'person' AND id GLOB 'user:?*') OR (kind = 'seat' AND id GLOB 'seat:?*') OR (kind = 'app' AND id GLOB 'app:?*')
    OR (kind = 'system' AND id GLOB 'system:?*') OR (kind = 'node' AND id GLOB 'node:?*')),
  CHECK (kind = 'person' OR owner <> '')
);
CREATE INDEX IF NOT EXISTS idx_principals_status ON principals (status, id);
CREATE TABLE IF NOT EXISTS principal_identities (
  provider TEXT NOT NULL CHECK (provider <> ''),
  external_id TEXT NOT NULL CHECK (external_id <> ''),
  external_key TEXT NOT NULL CHECK (external_key <> ''),
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, external_id),
  UNIQUE (provider, external_key)
);
CREATE INDEX IF NOT EXISTS idx_principal_identities_principal ON principal_identities (principal_id);
`);
// 阶段五 5b：市场自己的会话，和登录过程中的 state。
//   login_states：发起登录时签一个 state（只存哈希），绑着这次登录要回到的站内地址和发起它的浏览器（browser_sha256 是浏览器那一半的哈希）。
//     一次性：回调核对时原子地取出并删除；有期限；按来源限额（见 services/login-session.ts）。
//   principal_pending：等管理员对接的清单。只放认人需要的最少信息（对方的用户标识、显示名、企业邮箱）和最近一次来的时间；
//     保留 30 天，过期清掉（见 services/principal.ts）。
//   login_events_seen：登录方式推来的事件（比如飞书通讯录变更）处理过的事件号，防重放；多个实例共用，保留 7 天。
//   market_sessions：登录之后发给浏览器的会话（cookie 里是随机值，库里只存哈希）。绝对期限，不续期；
//     注销即 revoked_at；主体停用由认人时现查主体状态管住。provider/external_id 记着这次是凭哪条外部身份进来的（留痕用）。
db.exec(`
CREATE TABLE IF NOT EXISTS login_states (
  state_sha256 TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  next TEXT NOT NULL DEFAULT '/',
  browser_sha256 TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_states_expires ON login_states (expires_at);
CREATE TABLE IF NOT EXISTS market_sessions (
  token_sha256 TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_market_sessions_principal ON market_sessions (principal_id, expires_at);
CREATE TABLE IF NOT EXISTS login_events_seen (
  flow TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (flow, event_id)
);
CREATE TABLE IF NOT EXISTS principal_pending (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, external_id)
);
`);
// 阶段六 6b：授予（谁有哪个角色）。角色本身是声明（server/src/roles.ts），这里只放数据。
//   grants：主体、角色、范围、期限、理由、起草人、放行人、状态。状态只有五种，只能往前走：
//     draft 草稿 → pending 待核 → active 生效 → revoked 撤销 或 expired 过期；草稿和待核也可以直接撤销（作废、驳回）。
//     规则写在库里，不靠页面：不能给自己授予（起草人、放行人都不能是被授予的主体）；放行人只在待核→生效那一步写；
//     生效时没过期；过期只能在到期之后；主体、角色、范围、期限、理由、起草人建好就不能改；不删除。
//     管理员级的授予只有属主能放行、不是人的主体要有在职的责任人、决定类权限不给不是人的主体：这几条要看角色声明，在服务里判。
//   grant_events：每一步一行（起草、提交、放行、撤销、过期），只增不改。
db.exec(`
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL CHECK (principal_id GLOB '?*:?*'),
  role TEXT NOT NULL CHECK (role GLOB '[a-z]*'),
  scope TEXT NOT NULL CHECK (scope <> ''),
  expires_at INTEGER,
  reason TEXT NOT NULL CHECK (reason <> ''),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','active','revoked','expired')),
  created_by TEXT NOT NULL CHECK (created_by <> ''),
  created_by_principal TEXT,
  approved_by TEXT,
  approved_by_principal TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (created_by_principal IS NULL OR created_by_principal <> principal_id),
  CHECK (approved_by_principal IS NULL OR approved_by_principal <> principal_id),
  CHECK (status NOT IN ('active','expired') OR approved_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_grants_principal ON grants (principal_id, status);
CREATE TRIGGER IF NOT EXISTS grants_start_draft BEFORE INSERT ON grants WHEN NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_by_principal IS NOT NULL
  BEGIN SELECT RAISE(ABORT, '授予一律从草稿开始'); END;
CREATE TRIGGER IF NOT EXISTS grants_no_replace BEFORE INSERT ON grants WHEN EXISTS (SELECT 1 FROM grants WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, '授予不删除，也不能用同一个 id 覆盖'); END;
CREATE TRIGGER IF NOT EXISTS grants_no_delete BEFORE DELETE ON grants
  BEGIN SELECT RAISE(ABORT, '授予不删除'); END;
CREATE TRIGGER IF NOT EXISTS grants_fixed BEFORE UPDATE ON grants
  WHEN NEW.id IS NOT OLD.id OR NEW.principal_id IS NOT OLD.principal_id OR NEW.role IS NOT OLD.role OR NEW.scope IS NOT OLD.scope
    OR NEW.expires_at IS NOT OLD.expires_at OR NEW.reason IS NOT OLD.reason OR NEW.created_by IS NOT OLD.created_by
    OR NEW.created_by_principal IS NOT OLD.created_by_principal OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, '授予的主体、角色、范围、期限、理由、起草人建好就不能改'); END;
CREATE TRIGGER IF NOT EXISTS grants_forward_only BEFORE UPDATE OF status ON grants
  WHEN NOT ((OLD.status = 'draft' AND NEW.status IN ('pending','revoked')) OR (OLD.status = 'pending' AND NEW.status IN ('active','revoked'))
    OR (OLD.status = 'active' AND NEW.status IN ('revoked','expired')))
  BEGIN SELECT RAISE(ABORT, '授予的状态只能按 草稿→待核→生效→撤销或过期 往前走'); END;
CREATE TRIGGER IF NOT EXISTS grants_approver_once BEFORE UPDATE ON grants
  WHEN (NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_by_principal IS NOT OLD.approved_by_principal) AND NOT (OLD.status = 'pending' AND NEW.status = 'active')
  BEGIN SELECT RAISE(ABORT, '放行人只在待核→生效那一步写'); END;
CREATE TRIGGER IF NOT EXISTS grants_activate_unexpired BEFORE UPDATE OF status ON grants
  WHEN NEW.status = 'active' AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
  BEGIN SELECT RAISE(ABORT, '已经过了期限的授予不能生效'); END;
CREATE TRIGGER IF NOT EXISTS grants_expire_when_due BEFORE UPDATE OF status ON grants
  WHEN NEW.status = 'expired' AND (OLD.expires_at IS NULL OR OLD.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))
  BEGIN SELECT RAISE(ABORT, '没到期限的授予不能标成过期'); END;
-- 自定义角色（角色预设之后）：从内置预设复制出来、界面上改的角色是数据。校验和声明文件同一套（roles.ts）；
--   status：active 能授予；pending 新建时带管理类或决定类权限、要属主放行，放行前不能授予。
--   proposed：待属主放行的改动（JSON：{name, permissions}），没有为 NULL。时间是毫秒，由代码给
CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  based_on TEXT NOT NULL,
  permissions TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active')),
  proposed TEXT,
  proposed_by TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 自定义角色的每次建、改、放行、删都留一行（seq 由代码在事务里取下一个）
CREATE TABLE IF NOT EXISTS custom_role_events (
  seq INTEGER NOT NULL PRIMARY KEY,
  role_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('create','propose','update','approve','delete')),
  actor TEXT NOT NULL,
  actor_principal TEXT,
  before TEXT,
  after TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grant_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('draft','submit','approve','revoke','expire')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor <> ''),
  actor_principal TEXT,
  reason TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grant_events_grant ON grant_events (grant_id, seq);
CREATE TRIGGER IF NOT EXISTS grant_events_no_update BEFORE UPDATE ON grant_events
  BEGIN SELECT RAISE(ABORT, 'grant_events 只增不改'); END;
CREATE TRIGGER IF NOT EXISTS grant_events_no_delete BEFORE DELETE ON grant_events
  BEGIN SELECT RAISE(ABORT, 'grant_events 只增不改'); END;
CREATE TRIGGER IF NOT EXISTS grant_events_no_replace BEFORE INSERT ON grant_events WHEN EXISTS (SELECT 1 FROM grant_events WHERE seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT, 'grant_events 只增不改'); END;
`);
// 阶段六 6c：授予的来源（manual 人起草的；migration 迁移出来的，能整批列出、整批撤销）。建好不能改
try { const gCols = db.prepare('PRAGMA table_info(grants)').all() as { name: string }[]; if (!gCols.some((c) => c.name === 'source')) db.exec("ALTER TABLE grants ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','migration'))"); } catch (e) { console.warn('[db] grants 补 source 列失败：', (e as Error).message); }
db.exec(`
CREATE TRIGGER IF NOT EXISTS grants_source_fixed BEFORE UPDATE OF source ON grants WHEN NEW.source IS NOT OLD.source
  BEGIN SELECT RAISE(ABORT, '授予的来源建好就不能改'); END;
`);
// 阶段六 6c：判定的并行比对（开关 WM_JUDGMENT_COMPARE，缺省关）的记账，放在单独的库文件 judgment-compare.db 里：
//   比对攒批、在应答之后异步写，不和业务库抢锁（测试自己开旁路连接改业务库时也不会撞上）。只在比对打开时才建。
//   只记路由模式、动作、身份类别、两边结论、命中的规则，不记请求体、查询串、凭据，也不记路径里的 id。
//   judgment_tally：每条路由每种结果的计数（一致、不一致、不确定、404 不判、没报动作、状态码不代表授权、被完整性门拦下、出错、溢出）。
//   judgment_mismatches：不一致按「路由模式、身份类别、两边结论、命中规则」合并计数，留一个主体标识和一条授予做样例；最多 1000 种。
//   judgment_enforced：切换开关（WM_JUDGMENT_ENFORCE）打开的域里，新判定在路由处理之前拒掉的请求，按「路由模式、身份类别、结论、规则」计数（旧守卫没跑，不比）。
let compareDb: DatabaseSync | null = null;
export function judgmentCompareDb(): DatabaseSync {
  if (compareDb) return compareDb;
  const handle = new DatabaseSync(join(dataDir, 'judgment-compare.db'), { timeout: DB_BUSY_TIMEOUT_MS });
  handle.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS judgment_tally (
  route TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('agree','mismatch','uncertain','skip-404','unregistered','not-verdict','integrity-blocked','error','overflow')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route, outcome)
);
CREATE TABLE IF NOT EXISTS judgment_mismatches (
  key TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  old TEXT NOT NULL,
  new TEXT NOT NULL,
  rule TEXT NOT NULL,
  status INTEGER NOT NULL,
  principal_sample TEXT NOT NULL DEFAULT '',
  grant_sample INTEGER,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS judgment_enforced (
  route TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('deny','ask')),
  rule TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route, actor_kind, verdict, rule)
);
`);
  compareDb = handle;
  return handle;
}
// 这两张表只在本分支的早先版本里有过没有规范化列的形状（从没发布过）。碰上就拒绝启动，说清楚怎么办：
// 带着它跑，新来的人一律认不出（503），不如一开始就停下
for (const [table, column] of [['principals', 'id_key'], ['principal_identities', 'external_key']]) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) {
    throw new Error(`[db] 拒绝启动：${table} 表缺 ${column} 列（是开发分支早先版本建的，从没发布过）。删掉 principals、principal_identities 两张表再启动`);
  }
}
// 阶段八 8a：事项与事项日志（见 services/work-item.ts）。
//   work_items：一件要办的事的索引。只存 id 和摘要，原件各回各家（投递在 workbench_event_deliveries，run 在 sop_runs）。
//     state 只由事项服务按迁移表推进；object、phase 是观测层给的不透明标识，只存、只按它筛。
//   work_item_log：只增不改。每条事实一行，(item_id, fact_source, fact_id) 唯一——同一条事实送两次只记一次。
//     改写、删除、用 INSERT OR REPLACE 覆盖，在库这一层都被触发器拒绝。
//   work_items 不删除、不覆盖、不改 id；state 只能改成日志里最近一行的 to_state（拦的是「状态和日志对不上」：
//     先插一行日志再改状态是能过的，但那一行会永久留在只增不改的日志里）。
// IF NOT EXISTS 幂等，旧库启动即补表。
db.exec(`
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL CHECK (created_by GLOB '?*:?*'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('task-center','app-data','agent','cockpit')),
  source_ref TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '{}',
  event_id INTEGER,
  task_ids TEXT NOT NULL DEFAULT '[]',
  target_team TEXT NOT NULL DEFAULT '',
  seat TEXT NOT NULL DEFAULT '',
  eval TEXT NOT NULL DEFAULT '' CHECK (eval IN ('','accept','stop','ignore','unavailable')),
  eval_reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','held','delivered','accepted','progress','waiting','ready','blocked','done','failed','dropped','cancelled')),
  progress_summary TEXT NOT NULL DEFAULT '',
  progress_at TEXT NOT NULL DEFAULT '',
  open_asks TEXT NOT NULL DEFAULT '[]',
  receipt_outcome TEXT NOT NULL DEFAULT '',
  receipt_at TEXT NOT NULL DEFAULT '',
  outputs TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  object TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_items_state ON work_items (state, updated_at);
CREATE INDEX IF NOT EXISTS idx_work_items_object ON work_items (object, phase);
CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items (source_kind, source_ref);
CREATE TABLE IF NOT EXISTS work_item_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES work_items (id),
  fact TEXT NOT NULL CHECK (fact <> ''),
  fact_source TEXT NOT NULL CHECK (fact_source <> ''),
  fact_id TEXT NOT NULL CHECK (fact_id <> ''),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, fact_source, fact_id)
);
CREATE INDEX IF NOT EXISTS idx_work_item_log_item ON work_item_log (item_id, seq);
CREATE TRIGGER IF NOT EXISTS work_item_log_no_update BEFORE UPDATE ON work_item_log
  BEGIN SELECT RAISE(ABORT, 'work_item_log 只增不改'); END;
CREATE TRIGGER IF NOT EXISTS work_item_log_no_delete BEFORE DELETE ON work_item_log
  BEGIN SELECT RAISE(ABORT, 'work_item_log 只增不改'); END;
-- INSERT OR REPLACE 删旧行时不触发 DELETE 触发器（除非开了 recursive_triggers），所以键已存在的插入一律拦下
CREATE TRIGGER IF NOT EXISTS work_item_log_no_replace BEFORE INSERT ON work_item_log
  WHEN EXISTS (SELECT 1 FROM work_item_log WHERE seq = NEW.seq)
    OR EXISTS (SELECT 1 FROM work_item_log WHERE item_id = NEW.item_id AND fact_source = NEW.fact_source AND fact_id = NEW.fact_id)
  BEGIN SELECT RAISE(ABORT, 'work_item_log 只增不改'); END;
CREATE TRIGGER IF NOT EXISTS work_items_state_follows_log BEFORE UPDATE OF state ON work_items
  WHEN NEW.state IS NOT OLD.state AND NEW.state IS NOT (SELECT to_state FROM work_item_log WHERE item_id = NEW.id ORDER BY seq DESC LIMIT 1)
  BEGIN SELECT RAISE(ABORT, 'work_items.state 只能经事项服务推进'); END;
CREATE TRIGGER IF NOT EXISTS work_items_no_delete BEFORE DELETE ON work_items
  BEGIN SELECT RAISE(ABORT, '事项不删除'); END;
CREATE TRIGGER IF NOT EXISTS work_items_no_replace BEFORE INSERT ON work_items WHEN EXISTS (SELECT 1 FROM work_items WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, '事项不删除，也不能用同一个 id 覆盖'); END;
CREATE TRIGGER IF NOT EXISTS work_items_no_rekey BEFORE UPDATE OF id ON work_items WHEN NEW.id IS NOT OLD.id
  BEGIN SELECT RAISE(ABORT, '事项不删除，id 也不能改'); END;
CREATE TRIGGER IF NOT EXISTS work_items_start_draft BEFORE INSERT ON work_items WHEN NEW.state <> 'draft'
  BEGIN SELECT RAISE(ABORT, '事项一律从 draft 开始'); END;
`);
// 阶段八 8c 前：被拒的事实（f8d07a9）原因记在 work_item_log 单独的 rejected 列，不再放调用方能写的 detail 里。
//   旧库补列，并把 8b 写在 detail.rejected 里的原因搬过来（那时只有事项服务自己写日志，detail.rejected 都是真的）。
//   日志只增不改：搬的这一次在同一个事务里先拿掉改写触发器、改完立刻装回；补列之后不会再走这段。
if (!(db.prepare('PRAGMA table_info(work_item_log)').all() as { name: string }[]).some((c) => c.name === 'rejected')) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE work_item_log ADD COLUMN rejected TEXT NOT NULL DEFAULT '' CHECK (rejected IN ('', 'not_allowed', 'terminal'));
DROP TRIGGER IF EXISTS work_item_log_no_update;
UPDATE work_item_log SET rejected = json_extract(detail, '$.rejected'), detail = json_remove(detail, '$.rejected')
  WHERE json_extract(detail, '$.rejected') IN ('not_allowed', 'terminal');
CREATE TRIGGER work_item_log_no_update BEFORE UPDATE ON work_item_log
  BEGIN SELECT RAISE(ABORT, 'work_item_log 只增不改'); END;`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// 阶段八 8e：建立人的主体标识（可空）。「是不是他的事项」只认这一列；created_by 只用于显示，不参与任何判定。
//   只在建立事项时由事项服务从事件里取：提交请求经身份服务认出了人、且事件的提交方是已验证的，才有值；否则留空。
//   留空的事项没有「建立人」，只有管理员能看、能处理。不猜、不按名字去对主体表。
//   一经记下不再改（空的可以补成有值：回填按事件确定了已验证主体时）。
if (!(db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).some((c) => c.name === 'creator_principal')) {
  db.exec("ALTER TABLE work_items ADD COLUMN creator_principal TEXT CHECK (creator_principal IS NULL OR creator_principal GLOB 'user:?*')");
}
// 规范 14 第 2 步：事项是怎么交出去的（建的时候记下，之后分配变了也不改）。
//   handoff：team = 交给团队（总工分派；存量一律算这个），own-seat = 交给自己的 AI 员工，lead-directed = 负责人指名
//   review_by：等谁过目——lead = 目标团队的负责人，requester = 建立人自己（交给自己的 AI 员工时勾了「先过目再派出去」），空 = 不过目
//   directed_seat_id：指名的席位（seatId，形如 seat-<8hex>；句柄跟会话走会变，不存句柄）。第 3 步才按它派
//   seat_id、seat_at：承接席位的 seatId 和第一次有承接的时间（「我的 AI 员工手上的」按这个时间点查分配）；由记承接的那一路写
for (const [column, ddl] of [
  ['handoff', "handoff TEXT NOT NULL DEFAULT 'team' CHECK (handoff IN ('team', 'own-seat', 'lead-directed'))"],
  ['review_by', "review_by TEXT NOT NULL DEFAULT '' CHECK (review_by IN ('', 'lead', 'requester'))"],
  ['directed_seat_id', "directed_seat_id TEXT NOT NULL DEFAULT ''"],
  ['seat_id', "seat_id TEXT NOT NULL DEFAULT ''"],
  ['seat_at', "seat_at TEXT NOT NULL DEFAULT ''"],
  // 从哪个驾驶舱安排的（驾驶舱的 id）：只在「安排一件事」那一刻记，之后不改；别的路子建的、存量都是 null，不回填。
  //   只是个标签，不给任何权限；驾驶舱删了也照旧留着这个数
  ['cockpit_id', 'cockpit_id INTEGER'],
] as const) {
  if (!(db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).some((c) => c.name === column)) db.exec(`ALTER TABLE work_items ADD COLUMN ${ddl}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_cockpit ON work_items (cockpit_id, updated_at)');
db.exec(`
CREATE TRIGGER IF NOT EXISTS work_items_creator_principal_once BEFORE UPDATE OF creator_principal ON work_items
  WHEN OLD.creator_principal IS NOT NULL AND NEW.creator_principal IS NOT OLD.creator_principal
  BEGIN SELECT RAISE(ABORT, '事项的建立人主体一经记下不再改'); END;
`);
// 阶段八 8f：提需求的人。建录入（task-center 的 run）时经身份服务认出的主体记在 run 上，发布时事项的建立人主体取它；
//   认不出就空着，不拿发布的人顶替。一经记下不再改。
if (!(db.prepare('PRAGMA table_info(sop_runs)').all() as { name: string }[]).some((c) => c.name === 'requester_principal')) {
  db.exec("ALTER TABLE sop_runs ADD COLUMN requester_principal TEXT CHECK (requester_principal IS NULL OR requester_principal GLOB 'user:?*')");
}
// 阶段八 8f：「人提需求」的提交计数。只有通道、有没有登录凭据、认没认出人三个维度和次数，按天（UTC）累计；不存任何提交内容。
//   用来看各通道的提交里有多少能认出提交人（生产上直接查这张表）。
db.exec(`
CREATE TRIGGER IF NOT EXISTS sop_runs_requester_once BEFORE UPDATE OF requester_principal ON sop_runs
  WHEN OLD.requester_principal IS NOT NULL AND NEW.requester_principal IS NOT OLD.requester_principal
  BEGIN SELECT RAISE(ABORT, '录入的提需求人一经记下不再改'); END;
CREATE TABLE IF NOT EXISTS submission_counts (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  channel TEXT NOT NULL CHECK (channel IN ('task-center.intake', 'task-center.publish', 'app-data.rest', 'app-data.tool')),
  has_credential INTEGER NOT NULL CHECK (has_credential IN (0, 1)),
  resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, channel, has_credential, resolved)
);
`);
// 阶段八 8f-2：台的提交带了有效的提交人票据时，记下提交人（主体标识，可空）。读数据的接口都按列名取，不带出这一列。
if (!(db.prepare('PRAGMA table_info(app_data)').all() as { name: string }[]).some((c) => c.name === 'submitter_principal')) {
  db.exec("ALTER TABLE app_data ADD COLUMN submitter_principal TEXT CHECK (submitter_principal IS NULL OR submitter_principal GLOB 'user:?*')");
}
// 阶段八 8f-2：提交人票据验得过、验不过的次数，出台页面回落到原样页面的次数，按天累计。不记票据、不记原因、不记是谁
db.exec(`
CREATE TABLE IF NOT EXISTS submitter_ticket_counts (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  outcome TEXT NOT NULL CHECK (outcome IN ('valid', 'invalid', 'page_fallback')),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, outcome)
);
`);
// 事项回填的进度（单行）：回填在后台分批跑，不挡启动。version 是代码里的回填版本号（services/work-item.ts 的 BACKFILL_VERSION），
//   status：running = 跑到一半（phase 是全量还是增量，cursor 是那一阶段的游标，重启接着跑）；done = 跑完；
//   stale = 这一轮期间监听器漏过事实，下次启动从头全量核。log_mark 是上次跑完时事件日志的水位：版本没变时，启动从它往后增量核
//   （不在场的进程写进来的事件和事实靠它补回来）。dirty = 监听器漏过事实，下次启动从头全量核。时间由代码生成后传进来（不用 SQLite 特有的取时间写法，以后要支持 PostgreSQL）。
db.exec(`
CREATE TABLE IF NOT EXISTS work_item_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'stale')),
  phase TEXT NOT NULL DEFAULT 'full' CHECK (phase IN ('full', 'incremental')),
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  batches INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  log_mark INTEGER NOT NULL DEFAULT 0 CHECK (log_mark >= 0),
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  updated_at TEXT NOT NULL
);
`);
// 开发中间版本建过只有前几列的这张表：缺的列补上（幂等，和别的表的补列一样）
for (const [column, ddl] of [
  ['phase', "phase TEXT NOT NULL DEFAULT 'full' CHECK (phase IN ('full', 'incremental'))"],
  ['log_mark', 'log_mark INTEGER NOT NULL DEFAULT 0 CHECK (log_mark >= 0)'],
  ['dirty', 'dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))'],
] as const) {
  if (!(db.prepare('PRAGMA table_info(work_item_backfill)').all() as { name: string }[]).some((c) => c.name === column)) db.exec(`ALTER TABLE work_item_backfill ADD COLUMN ${ddl}`);
}
// 对端登记表：一个节点（DSH 实例，经 a2a 插件接入）一行。登记时取一次名片、验签，钉住完整公钥；名片上的公钥变了不自动接受，
//   状态改成 key_changed、新公钥记在 pending_*，等管理员确认。status：active = 正常；pending_registration = 升级回填时取不到名片
//   （不挡投递，页面上标出来）；key_changed = 等管理员确认新公钥（投递挂起）；disabled = 停用（投递挂起）。
//   registered_by 是登记人（升级回填建出来的记 system:migration）。时间都由代码生成后传进来；id 由代码生成（不用自增）。
db.exec(`
CREATE TABLE IF NOT EXISTS a2a_peers (
  id TEXT PRIMARY KEY,
  root_url TEXT NOT NULL UNIQUE,
  zone TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL DEFAULT '',
  key_fingerprint TEXT NOT NULL DEFAULT '',
  card_capabilities TEXT NOT NULL DEFAULT '{}',
  card_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'pending_registration', 'key_changed', 'disabled')),
  pending_public_key TEXT NOT NULL DEFAULT '',
  pending_fingerprint TEXT NOT NULL DEFAULT '',
  registered_by TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_by TEXT NOT NULL DEFAULT '',
  disabled_at TEXT NOT NULL DEFAULT '',
  disabled_reason TEXT NOT NULL DEFAULT '',
  card_fetched_at TEXT NOT NULL DEFAULT '',
  card_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_a2a_peers_status ON a2a_peers (status);
CREATE INDEX IF NOT EXISTS idx_a2a_peers_registered_by ON a2a_peers (registered_by);
`);
// 「安排一件事」（POST /api/work-items）的请求记账：一个人（requester）的一个幂等键一行。同一个人同一个键再发，回第一次的结果；
//   键相同、请求体不同（body_sha256 对不上）拒。限流也按这张表数（每人最近一分钟、一天各几行）。时间、id 都由代码生成后传进来。
db.exec(`
CREATE TABLE IF NOT EXISTS work_item_requests (
  requester TEXT NOT NULL CHECK (requester <> ''),
  idem_key TEXT NOT NULL CHECK (idem_key <> ''),
  body_sha256 TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (requester, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_work_item_requests_time ON work_item_requests(requester, created_at);
`);
// 阶段八 8d：「关注」的答复记账。每个（来源、来源里的 id）一行：第一次答成功就记下应答，同一条再答返回这一份；
//   pending 表示正有人在答（并发的第二个人被告知正在处理）；答失败就删掉这一行，可以再答。原件的状态和留痕在来源自己那里。
db.exec(`
CREATE TABLE IF NOT EXISTS attention_answers (
  source TEXT NOT NULL CHECK (source <> ''),
  source_id TEXT NOT NULL CHECK (source_id <> ''),
  answer TEXT NOT NULL CHECK (answer <> ''),
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  status INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '',
  answered_by TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, source_id)
);
`);
// 部门（管理员维护；以后从 Odoo 同步的写进同一套表，source 分来源）。部门标识就是授予范围 dept:<标识> 里的那个名字，只有这一套。
//   departments：标识、名称、职能代号（和生命周期阶段的负责部门对上，可空；非空时唯一）、负责人（主体，可空）、来源、改动的时间和人。
//   department_members：部门和主体的归属（一个主体可在多个部门）。时间由代码给（毫秒），不在 SQL 里取。
db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  name TEXT NOT NULL CHECK (name <> ''),
  function_code TEXT NOT NULL DEFAULT '',
  lead_principal TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'odoo')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_function_code ON departments (function_code) WHERE function_code <> '';
CREATE TABLE IF NOT EXISTS department_members (
  department_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'odoo')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (department_id, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_department_members_principal ON department_members (principal_id);
`);
// 团队与分配（规范 14 第 1 步）。团队、席位是节点名册里的事实（a2a_roster_seats，市场只读）；这三张表是公司的安排，只在市场里。
//   键和名册一致：团队 (host, team)，host 是节点公钥指纹的前 8 位十六进制（小写）；席位以 (host, seat_id) 为主，seat_id 空的旧节点退回 (host, team, seat)。
//   teams：团队的登记——认领了没有、挂在哪个部门。没认领的团队不一定有行（名册里出现了、还没人认领）。
//   team_leads：另外指定的负责人（部门负责人自动是团队负责人，读的时候从部门表推，不存）。移除不删行，记结束时间。
//   seat_assignments：成员分配给谁，起止时间；同一席位同时只有一条生效（两个部分唯一索引）。按时间点能查「那时这个成员归谁」。
//   team_events：每次认领、退回、换部门、加减负责人、分配、收回一行，只增不改。时间都由代码给（毫秒）。
db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  host TEXT NOT NULL CHECK (length(host) = 8), -- 只有 0-9a-f 由代码核（不用 SQLite 特有的写法）
  team TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0, 1)),
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (host, team),
  CHECK (claimed = 0 OR department_id <> '')
);
CREATE TABLE IF NOT EXISTS team_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  team TEXT NOT NULL,
  principal_id TEXT NOT NULL CHECK (principal_id <> ''),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  ended_by TEXT,
  ended_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_leads_active ON team_leads (host, team, principal_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS seat_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  team TEXT NOT NULL,
  seat TEXT NOT NULL,
  seat_id TEXT NOT NULL DEFAULT '',
  principal_id TEXT NOT NULL CHECK (principal_id <> ''),
  assigned_by TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  ended_by TEXT,
  ended_at INTEGER,
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_assign_active_id ON seat_assignments (host, seat_id) WHERE ended_at IS NULL AND seat_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_assign_active_handle ON seat_assignments (host, team, seat) WHERE ended_at IS NULL AND seat_id = '';
CREATE INDEX IF NOT EXISTS idx_seat_assign_principal ON seat_assignments (principal_id, ended_at);
CREATE TABLE IF NOT EXISTS team_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  team TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claim','release','department','lead-add','lead-remove','assign','unassign')),
  seat TEXT NOT NULL DEFAULT '',
  seat_id TEXT NOT NULL DEFAULT '',
  principal_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  actor_principal TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_events_team ON team_events (host, team, seq);
`);

// 首次安装向导（角色预设 ②）：一次运行按形态生成一批草稿授予。授予本身照常在 grants 里（来源列只认 manual、migration，老库改不了），
//   「这条是向导建的」记在这两张表里，读的时候推出来源 wizard。属主一次放行这一批。时间由代码给（毫秒）。
db.exec(`
CREATE TABLE IF NOT EXISTS setup_wizard_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shape TEXT NOT NULL CHECK (shape IN ('small', 'standard')),
  created_by TEXT NOT NULL,
  created_by_principal TEXT,
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  approved_at INTEGER
);
CREATE TABLE IF NOT EXISTS setup_wizard_grants (
  run_id INTEGER NOT NULL,
  grant_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, grant_id)
);
CREATE INDEX IF NOT EXISTS idx_setup_wizard_grants_grant ON setup_wizard_grants (grant_id);
`);

// 关系的提议（规范 14「关系由谁说了算」）：会带来业务权限的关系——部门负责人、团队负责人、团队认领到部门——不是属主（或业务侧）做的，
//   只记成提议，确认之后才写进 departments.lead_principal / team_leads / teams。提议期间关系不存在，不带来任何权限。
//   kind：dept-lead（department_id、principal_id）、team-lead（host、team、principal_id）、team-claim（host、team、department_id）。
//   状态只往前走：pending → approved / rejected。时间由代码给（毫秒）。
db.exec(`
CREATE TABLE IF NOT EXISTS relation_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('dept-lead', 'team-lead', 'team-claim')),
  department_id TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  team TEXT NOT NULL DEFAULT '',
  principal_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  proposed_by TEXT NOT NULL,
  proposed_by_principal TEXT,
  proposed_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_by_principal TEXT,
  decided_at INTEGER,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_relation_proposals_status ON relation_proposals (status, id);
-- 随部门负责人发的那条授予（规范 14「关系由谁说了算」）：属主确认部门负责人时，同一事务里落负责人字段、发这个部门范围的 dept-lead 授予，
--   记在这里；换人、移除负责人时只收这一条，这个人另外持有的授予不碰。一个部门同时最多一条（换人时先删后记）
CREATE TABLE IF NOT EXISTS dept_lead_grants (
  department_id TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
// 阶段八 8d：待对接清单的「出现序号」。同一条外部身份绑定后又出现在清单里，是新的一轮待决；「关注」的记账按它分轮，
//   不靠时间（只到秒，同一秒里又出现就分不开）。每次新插入一行（主体服务是 upsert，只在真的新进清单时插入）取一个全局只增的号：
//   号来自一张 AUTOINCREMENT 表，删掉旧号不会回退。只加这一列和取号，清单本身的写法不变。
if (!(db.prepare('PRAGMA table_info(principal_pending)').all() as { name: string }[]).some((c) => c.name === 'appearance')) {
  db.exec('ALTER TABLE principal_pending ADD COLUMN appearance INTEGER NOT NULL DEFAULT 0');
}
// 待对接清单的原因：unbound（认出来了，等价写法撞上已有的、对不到主体）；bound-to-non-person（这条外部身份绑在席位、节点这类非人主体上，
// 不能拿来登录，要先解绑那条外部身份）。加列用两边都认的 ALTER，已经有这一列时数据库报重复，照常往下走
try { db.exec("ALTER TABLE principal_pending ADD COLUMN reason TEXT NOT NULL DEFAULT 'unbound'"); } catch (e) {
  if (!/duplicate column|already exists/i.test(String((e as Error)?.message ?? e))) throw e;
}

db.exec(`
CREATE TABLE IF NOT EXISTS principal_pending_seq (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TRIGGER IF NOT EXISTS principal_pending_appearance AFTER INSERT ON principal_pending
  BEGIN
    INSERT INTO principal_pending_seq (id) VALUES (NULL);
    UPDATE principal_pending SET appearance = last_insert_rowid() WHERE provider = NEW.provider AND external_id = NEW.external_id;
    DELETE FROM principal_pending_seq WHERE id < last_insert_rowid();
  END;
`);
// #337: a durable monotonic generation invalidates stale Redis snapshots, including same-value writes.
{
  const cols = db.prepare('PRAGMA table_info(sop_runs)').all() as { name: string }[];
  if (!cols.some(c => c.name === 'cache_revision')) db.exec('ALTER TABLE sop_runs ADD COLUMN cache_revision INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TRIGGER IF NOT EXISTS sop_runs_cache_revision AFTER UPDATE OF data, status ON sop_runs
    BEGIN UPDATE sop_runs SET cache_revision = OLD.cache_revision + 1 WHERE id = NEW.id; END;`);
  // #448: hot_pending=1 while Redis may hold an acknowledged write newer than SQLite. Any durable data write
  // (checkpoint, finish, upgrade, note) is built from the latest state, so it clears the flag.
  // Exception (#466): sop-run-access.ts save/finish write SQLite-only data; they are not routed yet and must join
  // runCheckpoints.serial + runLiveData before they are, or this trigger would clear the flag on stale data.
  if (!cols.some(c => c.name === 'hot_pending')) db.exec('ALTER TABLE sop_runs ADD COLUMN hot_pending INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TRIGGER IF NOT EXISTS sop_runs_hot_pending_clear AFTER UPDATE OF data ON sop_runs WHEN NEW.hot_pending <> 0
    BEGIN UPDATE sop_runs SET hot_pending = 0 WHERE id = NEW.id; END;`);
}
// P0：sop_runs.upload_token（run-scoped 上传令牌·启动签发——总工 direct-c2b55f91）
try { const srtCols = db.prepare('PRAGMA table_info(sop_runs)').all() as any[]; if (!srtCols.some((c) => c.name === 'upload_token')) db.exec("ALTER TABLE sop_runs ADD COLUMN upload_token TEXT NOT NULL DEFAULT ''"); } catch { /* 列已在 */ }
// #437② run 文件记 sha256（上传时算）；引用已有文件的行记 ref_of=源文件 id（同一份存储，不另占上传配额）
try { const rfCols = db.prepare('PRAGMA table_info(sop_run_files)').all() as any[]; if (!rfCols.some((c) => c.name === 'sha256')) db.exec("ALTER TABLE sop_run_files ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''"); if (!rfCols.some((c) => c.name === 'ref_of')) db.exec('ALTER TABLE sop_run_files ADD COLUMN ref_of INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已在 */ }
db.exec("CREATE INDEX IF NOT EXISTS idx_sop_run_files_sha ON sop_run_files(sha256) WHERE sha256 <> ''");
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
  source_repo: string; source_path: string;
  created_at: string; updated_at: string;
}

/** 自产台版本快照：文件树落在 DATA_DIR/apps/<slug>/v<version>/；changelog=SOP 每版必填变更记录 */
export interface AppVersionRow {
  id: number; app_id: number; version: number; file_count: number; total_bytes: number;
  created_by: string; changelog: string; source_commit: string; created_at: string;
}

/** SOP 执行实例（分层治理·持久层真源）：data=stepKey→value JSON；热态在 Redis（redis.ts） */
export interface SopRunRow {
  id: number; sop_slug: string; sop_version: number; status: string; started_by: string;
  data: string; cache_revision: number; hot_pending?: number; started_at: string; updated_at: string; finished_at: string;
}

export interface CockpitRow {
  id: number; name: string; description: string; layout_config: string;
  created_at: string; updated_at: string;
}

/** 驾驶舱面板配置：workbenchId 指向 workbenches.id，x/y/w/h 为网格布局 */
export interface PanelConfig {
  i: string;
  workbenchId: number;
  /** 面板种类：默认工作台面板；'tasks' = 统一待办卡（omni-inbox，workbenchId=0 占位）；'bench-view' = 视图面板 */
  kind?: 'tasks' | 'bench-view';
  /** 视图面板（kind='bench-view'，workbenchId=0 占位）：引用哪个视图台的哪份视图、放在哪一页、排第几 */
  bench?: string; view?: string; tab?: 'board' | 'detail'; order?: number;
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
// ---------- 视图台的登记（数据视图，docs/data-views.md 第二节）----------
// 主库里只有登记：有这个台、叫什么、谁在什么时候建的。台里的数据都在台自己的库里（见下面「台库」）。
// 登记过的台才有库：没登记的标识一律 404，不会因为有人问一句就建出一个库文件。
db.exec(`CREATE TABLE IF NOT EXISTS bench_views (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
// 台绑到哪个部门（必要时细到这个部门下的一个团队）。空串是没绑：只有管理层进得来。
// 谁能读写一个绑了部门的台，看的是「已放行的、范围是这个部门的授予」（judgment.ts 的 scopedVerdict），不看部门成员表。
try {
  const bvCols = db.prepare('PRAGMA table_info(bench_views)').all() as { name: string }[];
  for (const c of ['department_id', 'team_host', 'team']) if (!bvCols.some((x) => x.name === c)) db.exec(`ALTER TABLE bench_views ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
} catch (e) { console.error(`[db] bench_views 加绑定列失败：${(e as Error).message}`); throw e; }
db.exec(`CREATE TABLE IF NOT EXISTS bench_bind_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT NOT NULL DEFAULT '',
  after TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_bind_audit_slug ON bench_bind_audit (slug, id);`);
// 数据视图的 MCP 工具授予（docs/data-views.md 第十节 3b）：按「会话 × 台 × 工具」记，不放进会话的 grants——
// 那一份由系统管理员改写，而台里是业务数据。申请由会话提、台的管理层批；留痕记谁批的、哪个台。
db.exec(`CREATE TABLE IF NOT EXISTS bench_mcp_grants (
  session_id INTEGER NOT NULL,
  bench TEXT NOT NULL,
  tool TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  request_id INTEGER,
  PRIMARY KEY (session_id, bench, tool)
);
CREATE INDEX IF NOT EXISTS idx_bench_mcp_grants_bench ON bench_mcp_grants (bench, session_id);
CREATE TABLE IF NOT EXISTS bench_mcp_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  bench TEXT NOT NULL,
  tools TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_mcp_requests_bench ON bench_mcp_requests (bench, id);
CREATE INDEX IF NOT EXISTS idx_bench_mcp_requests_session ON bench_mcp_requests (session_id, created_at);
CREATE TABLE IF NOT EXISTS bench_mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bench TEXT NOT NULL,
  session_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL,
  request_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_mcp_audit_bench ON bench_mcp_audit (bench, id);`);


// ---------- 台库（数据视图，docs/data-views.md）----------
// 每个视图台一份自己的库，和上面的主库分开。表结构照约定登记在这里；语句由 services/bench-store.ts 在台自己的库上执行，不在主库上跑。
// 只用两种库都认的写法；随库不同的只有类型名和自增主键，收在下面两个小函数里。时间一律由调用方给（毫秒整数），不在语句里取。
export const BENCH_STORE_SCHEMA_VERSION = 1;
export type BenchDialect = 'sqlite' | 'postgres';
export type BenchColumnType = 'text' | 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean';

const benchAutoId = (d: BenchDialect) => (d === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
/** 数据集的列在库里用什么类型存：日期和时间存成规范化的文本（可排序、两种库一样），布尔存 0/1 */
function benchSqlType(d: BenchDialect, t: BenchColumnType): string {
  if (t === 'integer') return d === 'sqlite' ? 'INTEGER' : 'BIGINT';
  if (t === 'decimal') return d === 'sqlite' ? 'REAL' : 'DOUBLE PRECISION';
  if (t === 'boolean') return d === 'sqlite' ? 'INTEGER' : 'SMALLINT';
  return 'TEXT';
}

/** 台库里固定的几张表（第 1 版）。数据集自己的表按列定义另建，模板见 benchSqlKit */
function benchStoreSchema(d: BenchDialect): string[] {
  const big = d === 'sqlite' ? 'INTEGER' : 'BIGINT';
  return [
    `CREATE TABLE IF NOT EXISTS bs_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS bs_datasets (
      name TEXT PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL, columns TEXT NOT NULL, key_cols TEXT NOT NULL,
      row_count INTEGER NOT NULL, data_bytes ${big} NOT NULL, created_at ${big} NOT NULL, updated_at ${big} NOT NULL, updated_by TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS bs_dataset_versions (
      dataset TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, columns TEXT NOT NULL, key_cols TEXT NOT NULL,
      author TEXT NOT NULL, note TEXT NOT NULL, at ${big} NOT NULL, PRIMARY KEY (dataset, version))`,
    `CREATE TABLE IF NOT EXISTS bs_view_versions (
      version INTEGER PRIMARY KEY, content TEXT NOT NULL, sha256 TEXT NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL, at ${big} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS bs_snapshots (
      id ${benchAutoId(d)}, dataset TEXT NOT NULL, dataset_version INTEGER NOT NULL, reason TEXT NOT NULL,
      row_count INTEGER NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, author TEXT NOT NULL, at ${big} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS bs_writes (
      id ${benchAutoId(d)}, dataset TEXT NOT NULL, op TEXT NOT NULL, idem_key TEXT UNIQUE, body_sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL, actor TEXT NOT NULL, at ${big} NOT NULL, result TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS bs_changes (
      id ${benchAutoId(d)}, kind TEXT NOT NULL, target TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
      actor TEXT NOT NULL, note TEXT NOT NULL, at ${big} NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_bs_snapshots_dataset ON bs_snapshots (dataset, id)`,
    // 快照的行：一行数据一条，row 是按留快照时的列次序排的 JSON 数组。bs_snapshots.content 只放列定义和主键
    `CREATE TABLE IF NOT EXISTS bs_snapshot_rows (snapshot_id ${big} NOT NULL, seq ${big} NOT NULL, row TEXT NOT NULL, PRIMARY KEY (snapshot_id, seq))`,
  ];
}

/**
 * 台库用到的、属于表结构或随库不同的写法，打成一份纯数据。
 *
 * 台库的读写在工作线程里跑（services/bench-store-worker.ts）。线程不能引用这个文件：一引用就会在线程里再开一次主库。
 * 所以这些写法由市场进程从这里取出来，在起线程的时候递给它；表结构因此仍然只登记在这一处。
 * 模板里的 {名字} 由台库的数据访问服务填；填进去的表名、列名都先过白名单并加了固定前缀，值一律走参数。
 */
export type BenchSqlKit = {
  dialect: BenchDialect;
  schemaVersion: number;
  /** 固定的几张表 */
  schema: string[];
  /** 打开库时逐条试一遍：哪条跑不通，就是库文件的结构和这份代码对不上（比如还没定稿时旧代码建的文件），明确拒绝，不静默照用 */
  probes: string[];
  /** 数据集的列类型在库里的写法 */
  types: [BenchColumnType, string][];
  /** 数据集的表：一个自增行号加各列。{columns} 是若干个「, 列名 类型」 */
  createTable: string;
  addColumn: string;
  dropColumn: string;
  keyIndex: string;
  dropIndex: string;
  /** 「这一列的文本里包含某段文本」（区分大小写）：两种库的函数名不同 */
  contains: string;
  /** 把一行的各列拼成一个 JSON 数组的文本（留快照时在库里直接从数据集的表复制到快照的表，不经过服务的内存） */
  snapshotRow: string;
  /**
   * 扫描守卫：把一条查询的筛选条件 {cond} 包起来，让库每扫过约 256 行回到服务里看一眼时限（bench_tick 由连接登记）。
   * 直接写「条件 AND bench_tick()」不行：条件先不成立时后一半不会算，一条全表扫但没有命中的查询就一次也回不来。
   * 没有这一项（null）的库靠自己的语句时限。
   */
  scanGuard: string | null;
};
export function benchSqlKit(d: BenchDialect): BenchSqlKit {
  const types: BenchColumnType[] = ['text', 'integer', 'decimal', 'date', 'datetime', 'boolean'];
  return {
    dialect: d,
    schemaVersion: BENCH_STORE_SCHEMA_VERSION,
    schema: benchStoreSchema(d),
    probes: [
      'SELECT name, title, version, columns, key_cols, row_count, data_bytes, created_at, updated_at, updated_by FROM bs_datasets WHERE 1 = 0',
      'SELECT dataset, version, title, columns, key_cols, author, note, at FROM bs_dataset_versions WHERE 1 = 0',
      'SELECT version, content, sha256, author, note, at FROM bs_view_versions WHERE 1 = 0',
      'SELECT id, dataset, dataset_version, reason, row_count, content, content_sha256, author, at FROM bs_snapshots WHERE 1 = 0',
      'SELECT id, dataset, op, idem_key, body_sha256, row_count, actor, at, result FROM bs_writes WHERE 1 = 0',
      'SELECT id, kind, target, from_version, to_version, actor, note, at FROM bs_changes WHERE 1 = 0',
      'SELECT snapshot_id, seq, row FROM bs_snapshot_rows WHERE 1 = 0',
    ],
    types: types.map((t) => [t, benchSqlType(d, t)]),
    createTable: `CREATE TABLE {table} (rid ${benchAutoId(d)}{columns})`,
    addColumn: 'ALTER TABLE {table} ADD COLUMN {col} {type}',
    dropColumn: 'ALTER TABLE {table} DROP COLUMN {col}',
    keyIndex: 'CREATE UNIQUE INDEX {index} ON {table} ({cols})',
    dropIndex: 'DROP INDEX IF EXISTS {index}',
    contains: d === 'sqlite' ? 'instr({col}, ?) > 0' : 'strpos({col}, ?) > 0',
    snapshotRow: d === 'sqlite' ? 'json_array({cols})' : 'json_build_array({cols})::text',
    scanGuard: d === 'sqlite' ? 'CASE WHEN (rid & 255) <> 0 OR bench_tick() THEN ({cond}) ELSE 0 END' : null,
  };
}
