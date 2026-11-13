/**
 * 「谁能做什么」页（照产品化原型 3fbfd0b 的 #/access）的判断逻辑：授予的状态、范围、期限怎么说，待核准的卡片，
 * 按人排的权限表，角色矩阵的格子怎么说，读不到时怎么说。纯函数，不碰 React；页面在 pages/access/Access.tsx。
 *
 * 只能 import type：scripts/access-ui-unit.mjs 用 Node 直接加载这个文件。「谁」的通用说法（去前缀、系统来源说人话）
 * 在 people.ts，页面里接上；这里只把授予留痕特有的两种写法（本机命令行 cli、管理员登录 odoo:<登录名>）先换掉。
 */

export type GrantStatus = 'draft' | 'pending' | 'active' | 'revoked' | 'expired';
export interface Grant {
  id: number; principal_id: string; role: string; scope: string; expires_at: number | null; reason: string; status: GrantStatus;
  created_by: string; approved_by: string | null; created_at: number; updated_at: number; source?: 'manual' | 'migration';
  /** 当前看的人能不能放行这一条（服务端算好的，身份线 #618）；不能时的代码和短说法 */
  can_approve?: boolean; approve_denied?: string | null; approve_denied_text?: string | null;
  /** 范围的显示名（身份线在授予的应答里带上；没带时页面不露部门标识） */
  scope_name?: string | null;
}
export type PrincipalKind = 'person' | 'seat' | 'app' | 'system' | 'node';
export interface Principal { id: string; kind: PrincipalKind; display_name: string; owner: string; status: 'active' | 'disabled' | string; identities?: { provider: string; external_id: string }[] }
export interface RoleInfo { id: string; name: string; platform?: boolean; custom?: boolean; approval?: string; approval_text?: string }
export type Cell = 'all' | 'scoped' | 'some' | 'self' | 'none' | 'na';
export interface MatrixRole { id: string; name: string; preset: boolean; custom: boolean; cells: Record<string, Record<string, Cell>>; summary: { see: string; do: string; decide: string; cannot: string } }
export interface Matrix { blocks: { key: string; name: string }[]; kinds: { key: string; name: string }[]; roles: MatrixRole[] }
export interface SourceResult { status: number; body: unknown }
export type Tone = 'success' | 'warning' | 'danger' | 'default';

export const ACCESS_TABS = [{ key: 'people', name: '人和权限' }, { key: 'roles', name: '角色预设' }] as const;
export type AccessTab = (typeof ACCESS_TABS)[number]['key'];
export function tabFromQuery(raw: string | null): AccessTab {
  return raw === 'roles' ? 'roles' : 'people';
}

const STATUS: Record<string, { text: string; tone: Tone; order: number }> = {
  pending: { text: '待核准', tone: 'warning', order: 0 },
  active: { text: '生效中', tone: 'success', order: 1 },
  draft: { text: '草稿', tone: 'default', order: 2 },
  expired: { text: '已过期', tone: 'default', order: 3 },
  revoked: { text: '已收回', tone: 'default', order: 4 },
};
export function statusLabel(status: unknown): { text: string; tone: Tone } {
  const s = Object.hasOwn(STATUS, String(status)) ? STATUS[String(status)] : null;
  return s ? { text: s.text, tone: s.tone } : { text: String(status ?? ''), tone: 'default' };
}

/** 七大块的名字：矩阵给了就用矩阵的；读不到矩阵（不是管理员）时用这一份，和 server/src/roles.ts 的 BLOCKS 一致 */
const BLOCK_NAMES: Record<string, string> = { overview: '全景', work: '事项与对话', attention: '关注', 'bench-data': '工作台数据', team: '团队与 AI 员工', access: '权限与角色', system: '系统与节点' };
const SCOPE_KIND: Record<string, string> = { domain: '这一块', bench: '工作台', sop: '流程', tool: '工具', object: '对象' };
/** 范围：* 是全部，self 是只限自己，domain:<块> 用七大块的名字（矩阵给的），其余是「工作台 x」「流程 x」这样。
 *  name：服务端在授予上带的范围显示名（scope_name，身份线加）；有就用它。部门（dept:<标识>）不露标识：没有名字时写「一个部门」 */
export function scopeLabel(scope: unknown, blocks?: Map<string, string>, name?: unknown): string {
  const s = String(scope ?? '').trim();
  if (s === '*' || s === '') return '全部';
  if (s === 'self') return '只限自己';
  const k = s.indexOf(':');
  const kind = k > 0 ? s.slice(0, k) : '';
  const given = typeof name === 'string' ? name.trim() : '';
  if (kind === 'dept') return given ? `「${given}」这个部门` : '一个部门';
  if (given) return kind === 'domain' ? `「${given}」这一块` : Object.hasOwn(SCOPE_KIND, kind) ? `${SCOPE_KIND[kind]}「${given}」` : given;
  if (k > 0 && s.slice(0, k) === 'domain') {
    const key = s.slice(k + 1), name = blocks?.get(key) ?? (Object.hasOwn(BLOCK_NAMES, key) ? BLOCK_NAMES[key] : '');
    if (name) return `「${name}」这一块`;
  }
  if (k > 0 && Object.hasOwn(SCOPE_KIND, s.slice(0, k))) return `${SCOPE_KIND[s.slice(0, k)]} ${s.slice(k + 1)}`;
  return s;
}
/** 按范围的授予、矩阵里「范围内」的格子都要带的说明（身份线把对象范围接进判定后去掉） */
export const SCOPE_PENDING = '尚未生效：按范围的授予要等对象范围接进判定';
/** 按范围的授予现在还不生效（判定还没接上范围，遗留差异 L13）：范围不是「全部」的生效中授予要标出来 */
export function scopeNotYetEffective(g: Pick<Grant, 'scope' | 'status'>): boolean {
  return g.status === 'active' && String(g.scope ?? '').trim() !== '*';
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** 期限：没有就是长期；过了的写「已到期」 */
export function termLabel(expiresAt: unknown, now: number): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '长期';
  return expiresAt <= now ? `已到期（${ymd(expiresAt)}）` : `到 ${ymd(expiresAt)}`;
}

const KIND: Record<string, string> = { person: '人', seat: 'AI 员工', app: '工作台', system: '系统', node: '外部节点' };
export function kindLabel(kind: unknown): string {
  return Object.hasOwn(KIND, String(kind)) ? KIND[String(kind)] : '';
}

/** 主体的名字：有显示名用显示名，没有就用标识去掉前缀（user:alpha → alpha） */
export function principalName(id: string, byId: Map<string, Principal>): string {
  const p = byId.get(id);
  const name = p?.display_name?.trim();
  return name || String(id ?? '').replace(/^[a-z]+:/, '');
}
export function indexPrincipals(body: unknown): Map<string, Principal> {
  const list = body && typeof body === 'object' && Array.isArray((body as { principals?: unknown }).principals) ? (body as { principals: Principal[] }).principals : [];
  return new Map(list.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
}

/** 授予留痕特有的两种写法先换成人话，其余交给 people.ts 的 actorLabel：本机命令行 cli；管理员登录 odoo:<登录名>，
 *  能从主体的登录身份对到人就用那个人的名字，对不到就用登录名 */
export function grantActorRaw(raw: unknown, byId?: Map<string, Principal>): string {
  const s = String(raw ?? '').trim();
  if (s === 'cli') return '本机命令行';
  if (s.startsWith('odoo:')) {
    const login = s.slice(5);
    for (const p of byId?.values() ?? []) if (p.identities?.some((i) => i.external_id === login) && p.display_name?.trim()) return p.display_name.trim();
    return login;
  }
  return s;
}

export function grantsOf(body: unknown): Grant[] {
  return body && typeof body === 'object' && Array.isArray((body as { grants?: unknown }).grants)
    ? (body as { grants: Grant[] }).grants.filter((g) => g && Number.isInteger(g.id) && typeof g.principal_id === 'string')
    : [];
}
export function rolesOf(body: unknown): Map<string, RoleInfo> {
  const list = body && typeof body === 'object' && Array.isArray((body as { roles?: unknown }).roles) ? (body as { roles: RoleInfo[] }).roles : [];
  return new Map(list.filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
}
/** 角色的名字：取 /api/roles 的；读不到（没有管理权的人不去问）时内置预设用固定的名字（和 server/src/roles.ts 的 PLATFORM_ROLES 一致），
 *  别的写「自定义角色」，不露角色标识 */
export const PRESET_ROLE_NAMES: Record<string, string> = { owner: '属主', admin: '系统管理员', management: '管理层', 'dept-lead': '部门负责人', member: '普通员工', guest: '访客', 'ai-staff': 'AI 员工' };
export function roleName(id: string, roles: Map<string, RoleInfo>): string {
  return roles.get(id)?.name || (Object.hasOwn(PRESET_ROLE_NAMES, id) ? PRESET_ROLE_NAMES[id] : '自定义角色');
}
/** 这个角色的授予要谁放行：服务端（GET /api/roles 的 approval_text）给的说法原样用，页面不自己判谁放行得了；
 *  没有这个字段（服务端还没加）就返回 null，页面照旧不显示 */
export function approvalText(id: string, roles: Map<string, RoleInfo>): string | null {
  const t = roles.get(id)?.approval_text;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/** 「核准」按钮：照服务端给的 can_approve 置灰，旁边写不能的说法。页面不自己判谁放行得了。
 *  服务端还没给这个字段（不是布尔）就照旧可点，点了被拒再显示应答里的说法 */
export function approveState(g: Pick<Grant, 'can_approve' | 'approve_denied_text'>): { enabled: boolean; note: string | null } {
  if (g.can_approve !== false) return { enabled: true, note: null };
  const t = typeof g.approve_denied_text === 'string' ? g.approve_denied_text.trim() : '';
  return { enabled: false, note: t || '你现在放行不了这一项' };
}

/** 待你核准的：先提交的在前 */
export function pendingGrants(grants: Grant[]): Grant[] {
  return grants.filter((g) => g.status === 'pending').sort((a, b) => a.updated_at - b.updated_at || a.id - b.id);
}
/** 表里的行：按人排（名字），同一个人的按状态（待核准、生效中、草稿、过期、收回）再按新旧 */
export function grantRows(grants: Grant[], byId: Map<string, Principal>): Grant[] {
  const order = (s: string) => (Object.hasOwn(STATUS, s) ? STATUS[s].order : 9);
  return [...grants].sort((a, b) => principalName(a.principal_id, byId).localeCompare(principalName(b.principal_id, byId), 'zh-CN')
    || order(a.status) - order(b.status) || b.id - a.id);
}
/** 负责人：不是人的主体挂在谁名下；人自己就是「本人」 */
export function responsibleOf(id: string, byId: Map<string, Principal>): string {
  const p = byId.get(id);
  if (!p || p.kind === 'person' || !p.owner) return '本人';
  return principalName(p.owner, byId);
}

/** 每个角色有几条生效中的授予在用 */
export function roleUsage(grants: Grant[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of grants) if (g.status === 'active') out.set(g.role, (out.get(g.role) ?? 0) + 1);
  return out;
}

const CELL: Record<Cell, { text: string; tone: Tone }> = {
  all: { text: '全部', tone: 'success' },
  scoped: { text: '范围内', tone: 'warning' },
  some: { text: '部分', tone: 'warning' },
  self: { text: '只限自己', tone: 'default' },
  none: { text: '不能', tone: 'default' },
  na: { text: '—', tone: 'default' },
};
export function cellLabel(cell: unknown): { text: string; tone: Tone } {
  return Object.hasOwn(CELL, String(cell)) ? CELL[String(cell) as Cell] : { text: '—', tone: 'default' };
}
export const CELL_LEGEND: Cell[] = ['all', 'scoped', 'some', 'self', 'none', 'na'];
export function matrixOf(body: unknown): Matrix | null {
  const m = body as Matrix | null;
  return m && Array.isArray(m.blocks) && Array.isArray(m.kinds) && Array.isArray(m.roles) ? m : null;
}

/** 别人的权限谁能看：授予、主体、角色、矩阵几个接口今天只认管理员（口令或管理员登录）；管理层的授予要到判定切换之后才生效，到时再改这句 */
export const OTHERS_ONLY_ADMINS = '别人的权限现在只有管理员能看。';

/** 「你的权限」：/api/auth/me 带本人生效中的角色（{ id, name, scope, preset, expires_at, ... }）。
 *  认出了人（有 principal）才返回列表，可以是空的；没登录、只有口令、读不到都返回 null */
export interface MyRole { id: string; name: string; scope: string; expires_at: number | null; /** 范围的显示名（服务端带了才有） */ scope_name?: string }
export function myRolesOf(me: unknown): MyRole[] | null {
  if (!me || typeof me !== 'object') return null;
  const m = me as { authenticated?: unknown; principal?: unknown; roles?: unknown };
  if (m.authenticated !== true || typeof m.principal !== 'string' || !m.principal || !Array.isArray(m.roles)) return null;
  return (m.roles as MyRole[]).filter((r) => r && typeof r.id === 'string')
    .map((r) => ({ id: r.id, name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id, scope: String(r.scope ?? '*'), expires_at: typeof r.expires_at === 'number' ? r.expires_at : null,
      ...(typeof r.scope_name === 'string' && r.scope_name.trim() ? { scope_name: r.scope_name.trim() } : {}) }));
}

/** 主体、角色、矩阵三个读接口只给能管的人（服务端那边是「管理」类动作）。认出了人、又明知他没有管理权的，页面就不去问，
 *  免得每次打开都白挨 403。授予不在这里判：L19（#659）起登录的人读得到自己能放行的那些，页面照常问。能管的：页面以管理员身份工作（持口令或 Odoo 管理员），或本人角色里有带「管理」类的内置预设
 *  （属主、系统管理员，见 server/src/roles.ts 的 PLATFORM_ROLES），或有自定义角色（能不能管页面不知道，照旧去问、由服务端判）。
 *  没认出人（没登录、本机命令行、/api/auth/me 读不到）也照旧去问：页面不知道，交给服务端。 */
export const ADMIN_PRESETS: readonly string[] = ['owner', 'admin'];
export function mayReadAccessAdmin(me: unknown, adminMode: boolean): boolean {
  if (adminMode) return true;
  if (!me || typeof me !== 'object') return true;
  const m = me as { authenticated?: unknown; principal?: unknown; roles?: unknown };
  if (m.authenticated !== true || typeof m.principal !== 'string' || !m.principal || !Array.isArray(m.roles)) return true;
  return (m.roles as { id?: unknown; preset?: unknown }[]).some((r) => !!r && (r.preset !== true || ADMIN_PRESETS.includes(String(r.id))));
}

/** 角色的「能做」一格：服务端的 summary.do 是「能做：…；能管：…」，能管交给矩阵的「管理」一列去说，这一格只留能做 */
export function summaryDo(s: unknown): string {
  return String(s ?? '').replace(/^能做：/, '').replace(/；能管：.*$/, '').trim();
}

/** 读不到时怎么说（what 是这一块叫什么）；读到了返回 null */
export function sourceProblem(what: string, r: SourceResult | null): { type: 'warning' | 'info'; text: string } | null {
  if (!r) return null;
  if (r.status === 401) return { type: 'warning', text: `请先登录，登录后才能看到${what}。` };
  if (r.status === 403) return { type: 'warning', text: `你的账号现在不能查看${what}：${OTHERS_ONLY_ADMINS}` };
  if (r.status === 404) return { type: 'info', text: `${what}的服务还没上线。` };
  if (r.status === 0 || r.status >= 400) return { type: 'warning', text: `读不到${what}，稍后再试。` };
  return null;
}
/** 核准、不给被拒时怎么说：服务端给了说法就用它 */
export function actionProblem(r: SourceResult): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const msg = r.body && typeof r.body === 'object' ? (r.body as { message?: unknown }).message : undefined;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  if (r.status === 401) return '请先登录。';
  if (r.status === 403) return '你的账号现在不能做这一步。';
  return '没办成，稍后再试。';
}
/** 不给要写理由：去掉首尾空白，1～500 字 */
export function declineReasonOk(reason: string): boolean {
  const s = reason.trim();
  return s.length >= 1 && s.length <= 500;
}
