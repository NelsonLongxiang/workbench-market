import type { WorkItemListPage } from './work-items-view';
import type { Cockpit, ExportPayload, PanelConfig, SopApp, SopDefinition, SopRun, SopRunDetail, SopRunFile, Summary, Workbench, WorkbenchDraft, WorkbenchType } from './types';
import { getAdminToken, loginRequired, redirectToLogin } from './admin-token';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) baseHeaders['X-Admin-Token'] = token; // 全局口令（direct-92be192a）：一处输入全页面写请求自动携带
  const res = await fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (loginRequired(res)) { redirectToLogin(); throw new Error('需要登录：正在前往登录页'); }
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
  getHealth: () => req<{ version: string; uptime_s: number; workbenches: number; outbound?: { mode: 'off' } }>('/api/health'),
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
  getSopRun: (id: number) => req<SopRunDetail>(`/api/sop/runs/${id}`),
  getSopDefinition: (slug: string, version?: number) =>
    req<SopDefinition>(`/api/sops/${slug}/definition${version ? `?version=${version}` : ''}`),
  /** 单 run 附件：服务端判读授权，未授权 403（needAdminToken 标记不代表要口令，调用方按「需读授权」处理） */
  listSopRunFiles: (id: number) => req<{ run_id: number; items: SopRunFile[]; count: number }>(`/api/sop/runs/${id}/files`),
  listActiveSopRuns: () => req<SopRun[]>('/api/sop/runs/active'),
  /** 事项列表：管理员看全部，登录的人只看自己建立的；cursor 翻页，counts 是整个可见范围按状态的计数 */
  listWorkItems: (params: Record<string, string> = {}) =>
    req<WorkItemListPage>(`/api/work-items?${new URLSearchParams(params)}`),
};

export function typeLabel(types: WorkbenchType[], key: string): WorkbenchType | undefined {
  return types.find((t) => t.key === key);
}

/** 下载需要鉴权的文件：fetch 带上口令头（控制面）与同源 cookie（业务面的读授权会话），再交给浏览器保存。
 *  普通 <a href> 不带 X-Admin-Token，控制面上会 403。 */
export async function downloadAuthed(url: string, filename: string): Promise<void> {
  const token = getAdminToken();
  const res = await fetch(url, { headers: token ? { 'X-Admin-Token': token } : {} });
  if (!res.ok) throw new Error(res.status === 403 ? '没有读授权' : `HTTP ${res.status}`);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** 事项和它的日志（阶段八 8d 事项页）。不走 apiFetch：没登录（401）、看不到（404）由页面自己说，不弹管理员口令。
 *  带上口令头：管理员用口令时也能看全部。 */
export async function getWorkItem(id: string): Promise<{ status: number; body: unknown }> {
  const token = getAdminToken();
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}`, { headers: token ? { 'X-Admin-Token': token } : {} });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 事项对话里的席位消息（阶段七 R2）：看过、回复。管理员带口令；建立人本人凭登录 */
export async function postSeatMessagesRead(id: string): Promise<{ status: number; body: { marked?: number; error?: string } }> {
  const token = getAdminToken();
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/messages/read`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }, body: '{}' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
export async function postSeatMessageReply(id: string, messageId: number, text: string): Promise<{ status: number; body: { sent?: boolean; reason?: string; error?: string } }> {
  const token = getAdminToken();
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/messages/${messageId}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }, body: JSON.stringify({ text }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 建立人本人验收、退回自己的事项（阶段八 8e）。不走 apiFetch：没登录、被拒由页面自己说，不弹管理员口令 */
export async function postCreatorDecision(id: string, answer: string, reason: string): Promise<{ status: number; body: { duplicate?: boolean; result?: { error?: string }; error?: string } }> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer, reason }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 等你拍板的条数（侧栏「全景」的角标）：取「关注」的总数；没登录、读不到返回 null，不弹口令 */
export async function getAttentionCount(): Promise<number | null> {
  try {
    const token = getAdminToken();
    const r = await fetch('/api/attention', { headers: token ? { 'X-Admin-Token': token } : {} });
    if (!r.ok) return null;
    const j = await r.json() as { counts?: { total?: number } };
    return typeof j.counts?.total === 'number' ? j.counts.total : null;
  } catch { return null; }
}

/** 当前登录身份（登录门的 /api/auth/me）：外壳的用户卡、全景的问候语用。拿不到就是 null，不弹口令。
 *  叫 getAuthMe 不叫 getMe：事项详情那条线（#565）在这里也加了一个 getMe，两边先后合进 main 时不撞名；都合了以后收成一份。 */
export type AuthMe = { authenticated?: boolean; login?: string | null; via?: string | null; display_name?: string | null };
export async function getAuthMe(): Promise<AuthMe | null> {
  try { const r = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' }); return r.ok ? await r.json() as AuthMe : null; } catch { return null; }
}

/** 答席位提问（阶段七：建立人能答自己事项上的提问）：带选项的给 answer（必须是选项之一），否则给 text。
 *  管理员带口令；建立人本人凭登录。不走 apiFetch：没登录、看不到由页面自己说，不弹管理员口令。 */
export async function postAskAnswer(id: string, qid: string, input: { answer?: string; text?: string }): Promise<{ status: number; body: { duplicate?: boolean; result?: { ok?: boolean; sent?: boolean; reason?: string; message?: string; error?: string }; error?: string; options?: string[] } }> {
  const token = getAdminToken();
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/asks/${encodeURIComponent(qid)}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }, body: JSON.stringify(input) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 当前登录身份（登录门的 /api/auth/me）：拿不到就是 null，不弹口令 */
export async function getMe(): Promise<{ authenticated?: boolean; login?: string | null; via?: string | null } | null> {
  try { const r = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** 工作台市场（照原型重做的 /market）：工作台、流程、技能、在办的流程四个来源各读各的，返回状态码让页面给说法；
 *  不走 apiFetch（读不到不弹管理员口令）。带上口令头：管理员用口令时和别处看到的一样。断网当状态码 0 */
async function marketGet(url: string): Promise<{ status: number; body: unknown }> {
  try {
    const token = getAdminToken();
    const r = await fetch(url, { headers: token ? { 'X-Admin-Token': token } : {} });
    if (loginRequired(r)) { redirectToLogin(); return { status: 401, body: null }; }
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}
export const getMarketWorkbenches = () => marketGet('/api/workbenches');
export const getMarketSops = () => marketGet('/api/sops');
export const getMarketSkills = () => marketGet('/api/skills');
export const getMarketRunningSops = () => marketGet('/api/sop/runs/active');

/** 席位名册（阶段七 #581）：登录的人能读，只当显示用（句柄换名字）。读不到给空，页面照旧显示句柄 */
export async function getRosterTeams(): Promise<unknown[]> {
  try {
    const r = await fetch('/api/a2a/teams', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const j = r.ok ? await r.json() as { teams?: unknown } : null;
    return Array.isArray(j?.teams) ? j.teams : [];
  } catch { return []; }
}

/** 生命周期里各条线、各阶段的显示名（事项列表把代号换成名字用）：阶段码表一次，对象按类型翻页取（每类最多 5 页）。
 *  读不到（观测层没挂、没登录）给空表，页面写中性说法，不露代号 */
export async function getLifecycleNameSources(): Promise<{ types: unknown[]; objects: unknown[] }> {
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    try { const r = await fetch(`/api/lifecycle/${path}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } }); return r.ok ? await r.json() as Record<string, unknown> : null; } catch { return null; }
  };
  const st = await get('stages');
  const types = Array.isArray(st?.types) ? st.types as { type?: unknown }[] : [];
  const objects: unknown[] = [];
  for (const t of types) {
    if (typeof t?.type !== 'string') continue;
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const q = new URLSearchParams({ type: t.type, limit: '200', ...(cursor ? { cursor } : {}) });
      const page = await get(`objects?${q}`);
      if (!page || !Array.isArray(page.items)) break;
      objects.push(...page.items);
      cursor = typeof page.next_cursor === 'string' ? page.next_cursor : null;
      if (!cursor) break;
    }
  }
  return { types, objects };
}
