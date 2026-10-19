export type HealthStatus = 'up' | 'down' | 'unknown';

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
