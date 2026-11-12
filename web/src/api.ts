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

/** 同一份只读请求在短时间内只发一次：外壳和页面同时要（「关注」、当前身份、驾驶舱列表），首屏不重复打。
 *  键带上管理员口令（口令不同结果不同）；读失败不留缓存。办完一件事用 attentionChanged() 清掉「关注」再广播 */
const SHARED_TTL = 2000;
const sharedMemo = new Map<string, { at: number; p: Promise<unknown> }>();
export function shared<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = `${key}|${getAdminToken()}`;
  const hit = sharedMemo.get(k);
  if (hit && Date.now() - hit.at < SHARED_TTL) return hit.p as Promise<T>;
  const p = fn();
  sharedMemo.set(k, { at: Date.now(), p });
  p.catch(() => sharedMemo.delete(k));
  return p;
}
function forgetShared(key: string) { for (const k of [...sharedMemo.keys()]) if (k.startsWith(`${key}|`)) sharedMemo.delete(k); }

/** 「关注」：给这个身份的全部条目和总数。status 0 = 连不上 */
export type AttentionRead = { status: number; items: AttentionItemLite[]; total: number | null };
type AttentionItemLite = { source: string; source_id: string; category: string; [k: string]: unknown };
export function getAttention(): Promise<AttentionRead> {
  return shared('attention', async () => {
    try {
      const token = getAdminToken();
      const r = await fetch('/api/attention', { headers: token ? { 'X-Admin-Token': token } : {} });
      const j = (r.ok ? await r.json().catch(() => ({})) : {}) as { items?: AttentionItemLite[]; counts?: { total?: number } };
      return { status: r.status, items: Array.isArray(j.items) ? j.items : [], total: typeof j.counts?.total === 'number' ? j.counts.total : null };
    } catch { return { status: 0, items: [], total: null }; }
  });
}
/** 办完一件：清掉「关注」的缓存，再广播（侧栏角标、全景都跟着刷新） */
export const ATTENTION_CHANGED = 'wm-attention-changed';
export function attentionChanged() { forgetShared('attention'); window.dispatchEvent(new Event(ATTENTION_CHANGED)); }

/** 等你拍板的条数（侧栏「全景」的角标）：取「关注」的总数；没登录、读不到返回 null，不弹口令 */
export async function getAttentionCount(): Promise<number | null> {
  const a = await getAttention();
  return a.status >= 200 && a.status < 300 ? a.total : null;
}

/** 驾驶舱列表（侧栏「我的驾驶舱」）：和驾驶舱页共用一次读 */
export const listCockpitsShared = (): Promise<Cockpit[]> => shared('cockpits', () => api.listCockpits());

/** 当前登录身份（登录门的 /api/auth/me）：外壳的用户卡、全景的问候语用。拿不到就是 null，不弹口令。
 *  叫 getAuthMe 不叫 getMe：事项详情那条线（#565）在这里也加了一个 getMe，两边先后合进 main 时不撞名；都合了以后收成一份。 */
export type AuthMe = { authenticated?: boolean; login?: string | null; via?: string | null; display_name?: string | null };
export function getAuthMe(): Promise<AuthMe | null> {
  return shared('auth-me', async () => {
    try { const r = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' }); return r.ok ? await r.json() as AuthMe : null; } catch { return null; }
  });
}

/** 生命周期只读接口（观测层扩展挂在市场里）：带登录 cookie；扩展没挂上（404）或没配置（503）由页面给空状态，不弹口令 */
export async function getLifecycle<T>(path: string): Promise<{ status: number; body: T | null }> {
  try {
    const r = await fetch(`/api/lifecycle/${path}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return { status: r.status, body: r.ok ? await r.json() as T : null };
  } catch { return { status: 0, body: null }; }
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

/** 「谁能做什么」（照原型重做的 /access）：授予、主体、角色、角色矩阵各读各的，返回状态码让页面给说法；核准、不给（撤销待核的授予）也一样。
 *  不走 apiFetch（被拒时不弹管理员口令，页面自己说）。带上口令头：管理员用口令时能看全部。断网当状态码 0 */
async function accessCall(url: string, init?: { method: string; body: unknown }): Promise<{ status: number; body: unknown }> {
  try {
    const token = getAdminToken();
    const headers: Record<string, string> = { ...(token ? { 'X-Admin-Token': token } : {}), ...(init ? { 'Content-Type': 'application/json' } : {}) };
    const r = await fetch(url, init ? { method: init.method, headers, body: JSON.stringify(init.body ?? {}) } : { headers });
    if (loginRequired(r)) { redirectToLogin(); return { status: 401, body: null }; }
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}
export const getAccessGrants = () => accessCall('/api/grants');
export const getAccessPrincipals = () => accessCall('/api/principals');
export const getAccessRoles = () => accessCall('/api/roles');
export const getAccessMatrix = () => accessCall('/api/roles/matrix');
export const approveAccessGrant = (id: number) => accessCall(`/api/grants/${id}/approve`, { method: 'POST', body: {} });
export const declineAccessGrant = (id: number, reason: string) => accessCall(`/api/grants/${id}/revoke`, { method: 'POST', body: { reason } });

/** 「安排一件事」（#577）：可派的团队。404 = 服务端还没有这个接口，页面给「还没上线」 */
export async function getAssignableTeams(): Promise<{ status: number; teams: { team: string; name: string }[] }> {
  try {
    const r = await fetch('/api/work-items/teams', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const j = r.ok ? await r.json() as { teams?: { team: string; name: string }[] } : null;
    return { status: r.status, teams: Array.isArray(j?.teams) ? j.teams : [] };
  } catch { return { status: 0, teams: [] }; }
}

/** 建一件事：建立人是登录的本人；带幂等键，重试同一个键不会建两件 */
export async function postWorkItem(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const r = await fetch('/api/work-items', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> | null };
  } catch { return { status: 0, body: null }; }
}
