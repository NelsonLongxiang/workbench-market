import type { Cockpit, ExportPayload, PanelConfig, SopApp, SopRun, Summary, Workbench, WorkbenchDraft, WorkbenchType } from './types';
import { getAdminToken } from './admin-token';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) baseHeaders['X-Admin-Token'] = token; // 全局口令（direct-92be192a）：一处输入全页面写请求自动携带
  const res = await fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...(init?.headers as Record<string, string> | undefined) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; message?: string; row_index?: number; control_url?: string | null };
    // #258 准入错误带具名码 + 中文 message（导入另带 row_index）：两者都显示，不当成缺口令
    const text = b.message ? `${b.message}（${b.error}${b.row_index !== undefined ? ` · 第 ${b.row_index + 1} 行` : ''}）` : (b.error || `HTTP ${res.status}`);
    const err = new Error(text + (b.control_url ? `：${b.control_url}${window.location.pathname}` : '')) as Error & { needAdminToken?: boolean };
    const admission = typeof b.error === 'string' && /^url_/.test(b.error);
    if ((res.status === 401 || res.status === 403) && !admission) err.needAdminToken = true; // 前端可捕获弹口令输入
    throw err;
  }
  return body as T;
}

export const api = {
  listWorkbenches: (params: Record<string, string> = {}) =>
    req<Workbench[]>(`/api/workbenches?${new URLSearchParams(params)}`),
  getWorkbench: (id: number) => req<Workbench>(`/api/workbenches/${id}`),
  createWorkbench: (data: Partial<WorkbenchDraft>) =>
    req<Workbench>('/api/workbenches', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkbench: (id: number, data: Partial<Workbench>) =>
    req<Workbench>(`/api/workbenches/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWorkbench: (id: number) => req<{ ok: boolean }>(`/api/workbenches/${id}`, { method: 'DELETE' }),
  checkOne: (id: number) => req<Workbench>(`/api/workbenches/${id}/check`, { method: 'POST' }),
  checkAll: () => req<{ checked: number; up: number; down: number }>('/api/check-all', { method: 'POST' }),
  summary: () => req<Summary>('/api/summary'),
  listTypes: () => req<WorkbenchType[]>('/api/types'),
  createType: (data: Partial<WorkbenchType>) =>
    req<WorkbenchType>('/api/types', { method: 'POST', body: JSON.stringify(data) }),
  updateType: (id: number, data: Partial<WorkbenchType>) =>
    req<WorkbenchType>(`/api/types/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteType: (id: number) => req<{ ok: boolean }>(`/api/types/${id}`, { method: 'DELETE' }),
  getSettings: () => req<Record<string, string>>('/api/settings'),
  putSettings: (data: Record<string, string>) =>
    req<Record<string, string>>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),
  exportAll: () => req<ExportPayload>('/api/export'),
  listCockpits: () => req<Cockpit[]>('/api/cockpits'),
  getCockpit: (id: number) => req<Cockpit>(`/api/cockpits/${id}`),
  createCockpit: (data: { name: string; description?: string; panels?: PanelConfig[] }) =>
    req<Cockpit>('/api/cockpits', { method: 'POST', body: JSON.stringify(data) }),
  updateCockpit: (id: number, data: Partial<{ name: string; description: string; panels: PanelConfig[] }>) =>
    req<Cockpit>(`/api/cockpits/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCockpit: (id: number) => req<{ ok: boolean }>(`/api/cockpits/${id}`, { method: 'DELETE' }),
  getHealth: () => req<{ version: string; uptime_s: number; workbenches: number }>('/api/health'),
  importAll: (payload: ExportPayload, mode: 'merge' | 'replace') =>
    req<{ ok: boolean; imported: number; skipped: number }>('/api/import', {
      method: 'POST',
      body: JSON.stringify({ ...payload, mode }),
    }),
  // SOP 台管理面
  listSops: () => req<SopApp[]>('/api/sops'),
  publishSop: (slug: string, note?: string) =>
    req<SopApp>(`/api/sops/${slug}/publish`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }),
  deprecateSop: (slug: string) => req<SopApp>(`/api/sops/${slug}/deprecate`, { method: 'POST', body: '{}' }),
  listSopRuns: (params: Record<string, string> = {}) =>
    req<SopRun[]>(`/api/sop/runs?${new URLSearchParams(params)}`),
  getSopRun: (id: number) => req<SopRun & { data: Record<string, unknown> }>(`/api/sop/runs/${id}`),
  listActiveSopRuns: () => req<SopRun[]>('/api/sop/runs/active'),
};

export function typeLabel(types: WorkbenchType[], key: string): WorkbenchType | undefined {
  return types.find((t) => t.key === key);
}
