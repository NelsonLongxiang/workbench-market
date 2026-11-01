export type HealthStatus = 'up' | 'down' | 'unknown';

/** 凭据注入：经统一门户 /go/ 代理时注入 Authorization 头 */
export interface AuthConfig {
  type: 'bearer' | 'basic';
  value: string;
}

export interface Workbench {
  id: number;
  name: string;
  url: string;
  type: string;
  icon: string;
  description: string;
  category: string;
  tags: string[];
  enabled: boolean;
  health_path: string;
  auth: AuthConfig | null;
  last_status: HealthStatus;
  last_checked_at: string;
  last_latency_ms: number | null;
  last_http_code: number | null;
  last_error: string;
  sort: number;
  created_at: string;
  updated_at: string;
}

export type WorkbenchDraft = Omit<Workbench, 'id' | 'last_status' | 'last_checked_at' | 'last_latency_ms' | 'last_http_code' | 'last_error' | 'created_at' | 'updated_at'>;

export interface WorkbenchType {
  id: number;
  key: string;
  name: string;
  icon: string;
  default_port: number | null;
  health_method: 'GET' | 'HEAD';
  health_path: string;
  expect_status: number | null;
  description: string;
  created_at: string;
}

export interface Summary {
  total: number;
  enabled: number;
  up: number;
  down: number;
  unknown: number;
  avg_latency_ms: number | null;
  categories: Record<string, { total: number; up: number }>;
}

export interface ExportPayload {
  format: string;
  exported_at: string;
  workbenches: Workbench[];
  types: WorkbenchType[];
  settings: Record<string, string>;
}

/** 驾驶舱面板：网格布局项 + 指向的工作台 */
export interface PanelConfig {
  i: string;
  workbenchId: number;
  /** 面板种类：'tasks' = 统一待办卡（workbenchId=0 占位） */
  kind?: 'tasks';
  x: number; y: number; w: number; h: number;
}

export interface Cockpit {
  id: number;
  name: string;
  description: string;
  layout_config: string;
  panels: PanelConfig[];
  created_at: string;
  updated_at: string;
}

/** SOP 台（apps kind='sop'）：状态机 draft→published→deprecated，版本链带 changelog */
export interface SopVersion {
  id: number;
  app_id: number;
  version: number;
  file_count: number;
  total_bytes: number;
  created_by: string;
  changelog: string;
  created_at: string;
}

export interface SopApp {
  id: number;
  slug: string;
  title: string;
  description: string;
  created_by: string;
  active_version: number;
  status: 'draft' | 'published' | 'deprecated';
  kind: string;
  code: string;
  created_at: string;
  updated_at: string;
  versions: SopVersion[];
  workbench_id: number | null;
}

/** SOP 执行列表只提供元数据；字段值另走单项接口（读授权收口为第二段）。 */
export interface SopRun {
  id: number;
  sop_slug: string;
  sop_version: number;
  status: 'running' | 'finished';
  started_by: string;
  steps: number;
  started_at: string;
  updated_at: string;
  finished_at: string;
}

/** #318 SOP 定义（GET /api/sops/:slug/definition）：只有步骤 key / 标题，不含步骤正文 HTML。 */
export interface SopDefinition {
  slug: string;
  version: number;
  active_version: number;
  status: SopApp['status'];
  title: string;
  code: string;
  description: string;
  steps: Array<{ key: string; title: string }>;
}

/** 单次记录：已授权回 data（步骤填写值）；未授权服务端只回元数据并带 private_read，前端照此渲染、不自行隐藏。 */
export type SopRunDetail =
  | { id: number; sop_slug: string; sop_version: number; status: SopRun['status']; started_by: string; receipt?: string; data: Record<string, unknown> }
  | (SopRun & { receipt?: string; private_read: 'authorization-required' });

export interface SopRunFile {
  id: number;
  run_id: number;
  original_name?: string;
  name?: string;
  mime: string;
  size: number;
  created_by?: string;
  created_at: string;
  url: string;
}
