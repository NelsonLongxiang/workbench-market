/**
 * 「团队」页（规范 14 第一、二、五、十节；骨架和密度照产品化原型 3fbfd0b 的 #/team）的判断逻辑：
 * 团队状态、负责人、成员分配给谁怎么说，读不到时怎么说，部门标识的校验。纯函数，不碰 React；页面在 pages/team/Team.tsx。
 *
 * 只能 import type：scripts/team-ui-unit.mjs 用 Node 直接加载这个文件。
 * 不露代号：节点的标识、团队和席位的句柄都不显示；成员有名字只写名字，查不到名字才用句柄。
 *
 * 接口 GET /api/teams 已经按看的人裁好（部门 → 团队 → 成员；待认领的单列，只给管理员），这里只整形、不拼部门和名册、不判谁能做什么。
 */

export type Tone = 'success' | 'warning' | 'danger' | 'default';
export type TeamStatus = 'unclaimed' | 'off-roster' | 'lead-vacant' | 'active';
export interface Person { principal: string; display_name: string }
export interface Lead extends Person { source: 'explicit' | 'department' | string }
export interface Member {
  seat: string; seat_id: string; name: string; role: string; online: boolean; router: boolean;
  assigned_to: Person | null; active_items: number;
}
export interface Team {
  host: string; team: string; name: string; status: TeamStatus | string; in_roster: boolean;
  /** 节点的名字（服务端给了才有）；节点的标识（host）是内部代号，页面不显示 */
  node_name?: string;
  department: { id: string; name: string } | null; leads: Lead[]; router: Member | null; members: Member[];
}
export interface DeptBlock { id: string; name: string; lead: Person | null; teams: Team[] }
export interface Teams { departments: DeptBlock[]; unclaimed: Team[] | null }
export interface Department { id: string; name: string; lead: Person | null; member_count: number }
export interface SourceResult { status: number; body: unknown }

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function memberOf(v: unknown): Member | null {
  const m = obj(v);
  if (!m || typeof m.seat !== 'string') return null;
  const a = obj(m.assigned_to);
  return {
    seat: m.seat, seat_id: typeof m.seat_id === 'string' ? m.seat_id : '', name: typeof m.name === 'string' ? m.name : '', role: typeof m.role === 'string' ? m.role : '',
    online: m.online === true, router: m.router === true,
    assigned_to: a && typeof a.principal === 'string' ? { principal: a.principal, display_name: typeof a.display_name === 'string' ? a.display_name : '' } : null,
    active_items: typeof m.active_items === 'number' && Number.isFinite(m.active_items) && m.active_items > 0 ? Math.floor(m.active_items) : 0,
  };
}
function teamOf(v: unknown): Team | null {
  const t = obj(v);
  if (!t || typeof t.host !== 'string' || typeof t.team !== 'string') return null;
  const d = obj(t.department);
  return {
    host: t.host, team: t.team, name: typeof t.name === 'string' ? t.name : '', ...(typeof t.node_name === 'string' && t.node_name.trim() ? { node_name: t.node_name.trim() } : {}), status: typeof t.status === 'string' ? t.status : '', in_roster: t.in_roster !== false,
    department: d && typeof d.id === 'string' ? { id: d.id, name: typeof d.name === 'string' ? d.name : d.id } : null,
    leads: arr<unknown>(t.leads).map(obj).filter((l): l is Record<string, unknown> => !!l && typeof l.principal === 'string')
      .map((l) => ({ principal: l.principal as string, display_name: typeof l.display_name === 'string' ? l.display_name : '', source: typeof l.source === 'string' ? l.source : '' })),
    router: memberOf(t.router),
    members: arr<unknown>(t.members).map(memberOf).filter((m): m is Member => !!m),
  };
}
function personOf(v: unknown): Person | null {
  const p = obj(v);
  return p && typeof p.principal === 'string' ? { principal: p.principal, display_name: typeof p.display_name === 'string' ? p.display_name : '' } : null;
}

/** GET /api/teams 的应答整形：形状不对的部分按空，不让页面在非数组上崩。unclaimed 只有管理员的应答里有，没有就是 null */
export function teamsOf(body: unknown): Teams {
  const b = obj(body);
  const departments = arr<unknown>(b?.departments).map(obj).filter((d): d is Record<string, unknown> => !!d && typeof d.id === 'string')
    .map((d) => ({ id: d.id as string, name: typeof d.name === 'string' && d.name.trim() ? d.name : (d.id as string), lead: personOf(d.lead), teams: arr<unknown>(d.teams).map(teamOf).filter((t): t is Team => !!t) }));
  return { departments, unclaimed: Array.isArray(b?.unclaimed) ? (b!.unclaimed as unknown[]).map(teamOf).filter((t): t is Team => !!t) : null };
}
/** GET /api/departments：部门列表（认领时选、判断「还没有部门」） */
export function departmentsOf(body: unknown): Department[] {
  return arr<unknown>(obj(body)?.departments).map(obj).filter((d): d is Record<string, unknown> => !!d && typeof d.id === 'string')
    .map((d) => ({ id: d.id as string, name: typeof d.name === 'string' && d.name.trim() ? d.name : (d.id as string), lead: personOf(d.lead), member_count: typeof d.member_count === 'number' ? d.member_count : 0 }));
}

/**
 * 看的人是不是管理员：接口只给管理员带「待认领的团队」这一栏，有这一栏就是管理员的视图。
 * 认领、建部门这两个管理员的操作只在这时出现（服务端照样判，不是管理员会被拒）。
 */
export function isAdminView(t: Teams): boolean {
  return t.unclaimed !== null;
}

const STATUS: Record<string, { text: string; tone: Tone }> = {
  active: { text: '正常', tone: 'success' },
  'lead-vacant': { text: '负责人缺位', tone: 'warning' },
  'off-roster': { text: '不在名册', tone: 'default' },
  unclaimed: { text: '待认领', tone: 'warning' },
};
export function teamStatusLabel(status: unknown): { text: string; tone: Tone } {
  return Object.hasOwn(STATUS, String(status)) ? STATUS[String(status)] : { text: '状态未知', tone: 'default' };
}

/** 人的名字：有显示名用显示名，没有就去掉标识的前缀（user:zhang → zhang） */
export function personName(p: Person | null | undefined): string {
  if (!p) return '';
  return p.display_name?.trim() || String(p.principal ?? '').replace(/^[a-z]+:/, '');
}

/** 团队名：画布团队用画布名。没有名字的不露团队的句柄和节点的标识（都是内部代号） */
export function teamTitle(t: Pick<Team, 'name' | 'team'>): string {
  if (t.name.trim()) return t.name.trim();
  return t.team ? '一个没有名字的团队' : '不在画布里的成员';
}

/** 节点：服务端给了名字就用名字；没有名字返回空串，页面不写这一项。节点的标识不显示 */
export function nodeLabel(t: Pick<Team, 'node_name'>): string {
  return t.node_name?.trim() || '';
}

/** 成员、总工的名字：只写名字，不带席位句柄（和事项列表同一个口径；排障要的句柄以后放成员详情）。
 *  节点报的名字有时自带「 (0a1b2c3d)」这样的句柄后缀，一并去掉——和 #606 names.ts 的 cleanSeatName 同一条，它合进来后换成引用它。
 *  只有席位没有名字时才用句柄（不然几个没名字的成员分不出来） */
export function memberLabel(m: Pick<Member, 'name' | 'seat'>): string {
  return (m.name || '').replace(/\s*[（(][0-9a-f]{6,}[)）]\s*$/i, '').trim() || m.seat;
}

/** 成员归谁用：分配给某人，或者团队公用（由总工分派） */
export function assignedText(m: Pick<Member, 'assigned_to'>): string {
  return m.assigned_to ? `分配给 ${personName(m.assigned_to)}` : '团队公用';
}

/** 负责人：去重，按出现先后；挂部门带来的标「部门负责人」 */
export function leadsOf(t: Pick<Team, 'leads'>): { name: string; viaDepartment: boolean }[] {
  const seen = new Set<string>();
  const out: { name: string; viaDepartment: boolean }[] = [];
  for (const l of t.leads) {
    if (seen.has(l.principal)) continue;
    seen.add(l.principal);
    out.push({ name: personName(l), viaDepartment: l.source === 'department' });
  }
  return out;
}

/** 团队头卡上的两个数：几个成员（不算总工）、几件在办（总工和成员合计） */
export function teamCounts(t: Pick<Team, 'members' | 'router'>): { members: number; active: number } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { members: t.members.length, active: t.members.reduce((s, m) => s + n(m.active_items), 0) + n(t.router?.active_items) };
}

/** 团队下面没有成员时怎么说：不在名册的说已经不在名册了，别的说名册里还没有成员 */
export function memberlessText(t: Pick<Team, 'status' | 'in_roster'>): string {
  return t.status === 'off-roster' || !t.in_roster ? '这个团队已经不在节点的名册里，看不到它的成员了。' : '名册里这个团队还没有成员。';
}

/** 页面整体是空的时候怎么说 */
export function emptyText(t: Teams, departments: Department[] | null, admin: boolean): string | null {
  const anyTeam = t.departments.some((d) => d.teams.length > 0) || (t.unclaimed?.length ?? 0) > 0;
  if (departments !== null && departments.length === 0) {
    return admin
      ? '还没有部门。先建部门，再把待认领的团队挂到部门上，部门负责人就是团队的负责人。'
      : '还没有部门，团队要等管理员先建部门、认领之后才会出现在这里。';
  }
  if (!anyTeam) return admin ? '还没有团队。节点报上名册之后，团队会先出现在「待认领的团队」里。' : '还没有你能看到的团队。你所在部门的团队、你负责的团队、分给你的 AI 员工所在的团队会出现在这里。';
  return null;
}

/** 读不到时怎么说（what 是这一块叫什么）；读到了返回 null */
export function sourceProblem(what: string, r: SourceResult | null): { type: 'warning' | 'info'; text: string } | null {
  if (!r) return null;
  if (r.status === 401) return { type: 'warning', text: `请先登录，登录后才能看到${what}。` };
  if (r.status === 403) return { type: 'warning', text: `你的账号现在不能查看${what}。` };
  if (r.status === 404) return { type: 'info', text: `${what}的服务还没上线。` };
  if (r.status === 0 || r.status >= 400) return { type: 'warning', text: `读不到${what}，稍后再试。` };
  return null;
}
/** 写操作被拒时怎么说：服务端给了说法就用它 */
export function actionProblem(r: SourceResult): string | null {
  if (r.status >= 200 && r.status < 300) return null;
  const msg = obj(r.body)?.message ?? obj(r.body)?.error;
  if (typeof msg === 'string' && msg.trim() && !/^[a-z_]+$/.test(msg.trim())) return msg.trim();
  if (r.status === 401) return '请先登录。';
  if (r.status === 403) return '你的账号现在不能做这一步。';
  if (r.status === 404) return '找不到这个部门或团队，刷新一下再试。';
  if (r.status === 409) return '状态变了，刷新一下再试。';
  return '没办成，稍后再试。';
}

/** 部门标识：小写字母开头，小写字母、数字、连字符，最多 48 个字（和服务端同一条）；名称 1～64 个字 */
export const DEPT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export function newDeptProblem(id: string, name: string, existing: Department[]): string | null {
  const i = id.trim(), n = name.trim();
  if (!n) return '写一个部门名称';
  if (n.length > 64) return '部门名称最多 64 个字';
  if (!DEPT_ID_RE.test(i)) return '标识用小写字母开头，只用小写字母、数字和连字符，比如 ops 或 finance-2';
  if (existing.some((d) => d.id === i)) return '这个标识已经有部门在用';
  return null;
}
