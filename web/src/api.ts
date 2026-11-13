import type { WorkItemListPage } from './work-items-view';
import type { Cockpit, ExportPayload, PanelConfig, SopApp, SopDefinition, SopRun, SopRunDetail, SopRunFile, Summary, Workbench, WorkbenchDraft, WorkbenchType } from './types';
import { getAdminToken, loginRequired, redirectToLogin } from './admin-token';
import { IDENTITY_DOWN_TEXT, isIdentityUnavailable } from './identity-status';

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
  if (isIdentityUnavailable(res.status, body)) throw new Error(`${IDENTITY_DOWN_TEXT}，稍后再试`);
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
export async function postCreatorDecision(id: string, answer: string, reason: string): Promise<{ status: number; body: { duplicate?: boolean; result?: { error?: string; message?: string }; error?: string; message?: string } }> {
  const res = await fetch(`/api/work-items/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer, reason }) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 同一份只读请求在短时间内只发一次：外壳和页面同时要（「关注」、当前身份、驾驶舱列表），首屏不重复打。
 *  键带上管理员口令（口令不同结果不同）；读失败不留缓存。办完一件事用 attentionChanged() 清掉「关注」再广播 */
const SHARED_TTL = 2000;
const sharedMemo = new Map<string, { at: number; p: Promise<unknown> }>();
/** 身份变了：共用的取数缓存全部丢掉（上一个人读到的不能给下一个人用） */
export function clearShared(): void { sharedMemo.clear(); }
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
/** identityDown：身份服务连不上（502 identity_unavailable）——这时不是「没有待办」，页面要说「暂时取不到」 */
/** stuckCount：停太久的一共几件（counts.stuck_count，含超出上限没列出来的）；旧的应答没有就是 null */
export type AttentionRead = { status: number; items: AttentionItemLite[]; total: number | null; identityDown: boolean; stuckCount: number | null };
type AttentionItemLite = { source: string; source_id: string; category: string; [k: string]: unknown };
export function getAttention(): Promise<AttentionRead> {
  return shared('attention', async () => {
    try {
      const token = getAdminToken();
      const r = await fetch('/api/attention', { headers: token ? { 'X-Admin-Token': token } : {} });
      const raw: unknown = await r.json().catch(() => ({}));
      const j = (r.ok ? raw : {}) as { items?: AttentionItemLite[]; counts?: { total?: number; stuck_count?: number } };
      return { status: r.status, items: Array.isArray(j.items) ? j.items : [], total: typeof j.counts?.total === 'number' ? j.counts.total : null, identityDown: isIdentityUnavailable(r.status, raw), stuckCount: typeof j.counts?.stuck_count === 'number' ? j.counts.stuck_count : null };
    } catch { return { status: 0, items: [], total: null, identityDown: false, stuckCount: null }; }
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
/** identityDown：身份服务连不上（502 identity_unavailable），页面说「暂时取不到」，不当成没有 */
export async function getLifecycle<T>(path: string): Promise<{ status: number; body: T | null; identityDown?: boolean }> {
  try {
    const r = await fetch(`/api/lifecycle/${path}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const raw: unknown = await r.json().catch(() => null);
    return { status: r.status, body: r.ok ? raw as T : null, identityDown: isIdentityUnavailable(r.status, raw) };
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
/** 市场的连接器（MCP 上游）：只给管理员，页面只在管理员身份下才调 */
export const getMarketConnectors = () => marketGet('/api/mcp/upstreams');
/** 单个台的详情页（/market/wb/:id）：带状态码，让页面分「不在了」「没权限」「读不到」 */
export const getMarketWorkbench = (id: number) => marketGet(`/api/workbenches/${id}`);
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

/** 「团队」页（规范 14）：团队、部门、人各读各的，返回状态码让页面给说法；认领、指定负责人、建部门也一样。
 *  不走 apiFetch（被拒时不弹管理员口令，页面自己说）。带上口令头：管理员用口令时能看到待认领的团队。断网当状态码 0 */
async function teamCall(url: string, init?: { method: string; body: unknown }): Promise<{ status: number; body: unknown }> {
  try {
    const token = getAdminToken();
    const headers: Record<string, string> = { Accept: 'application/json', ...(token ? { 'X-Admin-Token': token } : {}), ...(init ? { 'Content-Type': 'application/json' } : {}) };
    const r = await fetch(url, init ? { method: init.method, credentials: 'same-origin', headers, body: JSON.stringify(init.body ?? {}) } : { credentials: 'same-origin', headers });
    if (loginRequired(r)) { redirectToLogin(); return { status: 401, body: null }; }
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}
export const getTeams = () => teamCall('/api/teams');
/** 分给我的成员、我负责的团队（驾驶舱「AI 员工」用） */
export const getMyTeams = () => teamCall('/api/teams/mine');
export const getTeamDepartments = () => teamCall('/api/departments');
export const getTeamPeople = () => teamCall('/api/principals');
export const claimTeam = (host: string, team: string, department: string) => teamCall('/api/teams/claim', { method: 'POST', body: { host, team, department } });
export const addTeamLead = (host: string, team: string, principal: string) => teamCall('/api/teams/leads', { method: 'POST', body: { host, team, principal } });
/** 把一个成员分配给某位员工、收回（规范 14 第二节）：席位按 seat 加 seat_id 认；能不能做服务端判（负责人、管理层） */
export const assignTeamSeat = (host: string, team: string, seat: string, seat_id: string, principal: string) => teamCall('/api/teams/assign', { method: 'POST', body: { host, team, seat, seat_id, principal } });
/** 一步改派（#682）：一个事务里收回并分给另一个人；200 { ok, changed, id, from }，拒绝的状态码和错误码同分配 */
export const reassignTeamSeat = (host: string, team: string, seat: string, seat_id: string, principal: string) => teamCall('/api/teams/reassign', { method: 'POST', body: { host, team, seat, seat_id, principal } });
export const unassignTeamSeat = (host: string, team: string, seat: string, seat_id: string) => teamCall('/api/teams/unassign', { method: 'POST', body: { host, team, seat, seat_id } });
export const putDepartment = (id: string, name: string, lead: string | null) => teamCall(`/api/departments/${encodeURIComponent(id)}`, { method: 'PUT', body: { name, ...(lead ? { lead } : {}) } });

/** 席位名册（阶段七 #581）：登录的人能读，只当显示用（句柄换名字）。读不到给空，页面照旧显示句柄 */
export async function getRosterTeams(): Promise<unknown[]> {
  try {
    // 名册只用来把句柄换成名字：最多等 8 秒，读不到就显示句柄，不让它拖住页面
    const r = await fetch('/api/a2a/teams', { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
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

/** 关系的提议（规范 14「关系由谁说了算」）：服务端按看的人裁好；确认、驳回或撤回。返回状态码让页面给说法 */
export const getRelationProposals = () => teamCall('/api/relations/proposals');
export const approveRelationProposal = (id: number) => teamCall(`/api/relations/proposals/${id}/approve`, { method: 'POST', body: {} });
export const rejectRelationProposal = (id: number, reason: string) => teamCall(`/api/relations/proposals/${id}/reject`, { method: 'POST', body: { reason } });

/** 数据视图的取数入口（驾驶舱按引用取一份视图）：带登录的 cookie，不带管理口令（入口不认口令）。
 *  返回状态码和 error 代号，让块自己给说法；断网当状态码 0 */
export async function getBenchView(ref: { bench: string; view: string }, params: Record<string, string> = {}): Promise<{ status: number; body: unknown; error?: string }> {
  try {
    const q = new URLSearchParams({ view: ref.view });
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v !== '') q.set(`p.${k}`, v);
    const r = await fetch(`/api/bench-views/${encodeURIComponent(ref.bench)}/render?${q}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const body = await r.json().catch(() => null) as { error?: string } | null;
    return { status: r.status, body: r.ok ? body : null, error: typeof body?.error === 'string' ? body.error : undefined };
  } catch { return { status: 0, body: null }; }
}

/** 数据视图的两个只读入口（往驾驶舱里挂视图时选台、选视图用）：带登录的 cookie，不带管理口令。
 *  返回状态码和应答体（出错时应答体里有 error 代号），让页面给说法；断网当状态码 0 */
async function benchViewsGet(path: string): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}
export const listBenchViews = () => benchViewsGet('/api/bench-views');
export const getBenchViewDoc = (bench: string) => benchViewsGet(`/api/bench-views/${encodeURIComponent(bench)}/view`);
/** 视图台页面的入口：ref 写卡片 id 或台标识。200 时 body 是 BenchEntry；读不到的、不存在的、没开台库的、还没有视图描述的都是同一个 404（页面照原来的方式打开卡片）；没登录 401 */
export type BenchEntry = { bench: { slug: string; title: string; workbench_id: number | null }; version: number; title: string; default_view: string; views: { key: string; title: string }[] };
export const getBenchEntry = (ref: string | number) => benchViewsGet(`/api/bench-views/${encodeURIComponent(String(ref))}/entry`) as Promise<{ status: number; body: BenchEntry | { error?: string } | null }>;
/** 视图台页面上交表单：路径写卡片 id。返回状态码和应答体（出错时带 error、message），让表单说原因；断网当状态码 0 */
export async function submitBenchForm(ref: string | number, req: { view: string; block: number; version: number; values: Record<string, unknown> }): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(`/api/bench-views/${encodeURIComponent(String(ref))}/form`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}
/** 这个人能不能新建驾驶舱（/api/auth/me 的 can.create_cockpit，服务端和建驾驶舱的路由同一处判断）。
 *  带着管理口令问（口令持有人也能建）；不缓存：口令输入、清掉之后页面会再问一次。拿不到当不能 */
export async function canCreateCockpit(): Promise<boolean> {
  try {
    const token = getAdminToken();
    const r = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin', headers: token ? { 'X-Admin-Token': token } : {} });
    const b = r.ok ? await r.json() as { can?: { create_cockpit?: unknown } } : null;
    return b?.can?.create_cockpit === true;
  } catch { return false; }
}
