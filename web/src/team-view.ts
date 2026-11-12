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
  /** 最近一次收下这个节点名册的时刻（毫秒）；服务端给的是 ISO 时刻或毫秒数的字符串，整形时统一成毫秒，没有就不带 */
  roster_at?: number;
  department: { id: string; name: string } | null; leads: Lead[]; router: Member | null; members: Member[];
  /** 待确认的提议（关系确认制，只在管理员的视图里有）：认领到哪个部门、指定谁做负责人，等谁确认 */
  pending_claim?: Pending | null; pending_leads?: Pending[];
}
/** 一条待确认的提议：服务端给「等谁确认」的说法，页面原样写 */
export interface Pending { id: number; principal: string | null; department: string | null; confirm_by_text: string }
export interface DeptBlock { id: string; name: string; lead: Person | null; teams: Team[]; pending_lead?: Pending | null }
/** 看的人能做什么（服务端判好）：claim / add_lead 直接生效，propose_claim / propose_lead 只能提议 */
export interface TeamsCan { claim: boolean; propose_claim: boolean; add_lead: boolean; propose_lead: boolean; manage_departments: boolean }
export interface Teams { departments: DeptBlock[]; unclaimed: Team[] | null; can: TeamsCan | null }
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
/** 名册收到的时刻：ISO 时刻，或者毫秒数（数字或数字串）；都不是返回 null。
 *  服务端库里存的是 sqlTime 写法「2026-11-12 06:00:00」：UTC、不带时区、中间是空格（/api/a2a/teams 的 received_at 同一个来源）。
 *  浏览器的 Date.parse 会把不带时区的日期时间当本地时间，在东八区就早了 8 小时；所以不带时区标记的一律按 UTC 解析 */
export function rosterAt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const naive = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d(?::\d\d(?:\.\d+)?)?)$/.exec(s);
  const ms = /^\d{10,}$/.test(s) ? Number(s) : naive ? Date.parse(`${naive[1]}T${naive[2]}Z`) : Date.parse(s);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
function teamOf(v: unknown): Team | null {
  const t = obj(v);
  if (!t || typeof t.host !== 'string' || typeof t.team !== 'string') return null;
  const d = obj(t.department);
  return {
    host: t.host, team: t.team, name: typeof t.name === 'string' ? t.name : '', ...(typeof t.node_name === 'string' && t.node_name.trim() ? { node_name: t.node_name.trim() } : {}), ...(rosterAt(t.roster_received_at) !== null ? { roster_at: rosterAt(t.roster_received_at)! } : {}), status: typeof t.status === 'string' ? t.status : '', in_roster: t.in_roster !== false,
    department: d && typeof d.id === 'string' ? { id: d.id, name: typeof d.name === 'string' ? d.name : d.id } : null,
    leads: arr<unknown>(t.leads).map(obj).filter((l): l is Record<string, unknown> => !!l && typeof l.principal === 'string')
      .map((l) => ({ principal: l.principal as string, display_name: typeof l.display_name === 'string' ? l.display_name : '', source: typeof l.source === 'string' ? l.source : '' })),
    router: memberOf(t.router),
    members: arr<unknown>(t.members).map(memberOf).filter((m): m is Member => !!m),
    ...('pending_claim' in t ? { pending_claim: pendingOf(t.pending_claim) } : {}),
    ...(Array.isArray(t.pending_leads) ? { pending_leads: (t.pending_leads as unknown[]).map(pendingOf).filter((p): p is Pending => !!p) } : {}),
  };
}
function pendingOf(v: unknown): Pending | null {
  const p = obj(v);
  if (!p || typeof p.id !== 'number') return null;
  return { id: p.id, principal: typeof p.principal === 'string' ? p.principal : null, department: typeof p.department === 'string' ? p.department : null,
    confirm_by_text: typeof p.confirm_by_text === 'string' && p.confirm_by_text.trim() ? p.confirm_by_text.trim() : '业务侧' };
}
function canOf(v: unknown): TeamsCan | null {
  const c = obj(v);
  if (!c) return null;
  const b = (k: string) => c[k] === true;
  return { claim: b('claim'), propose_claim: b('propose_claim'), add_lead: b('add_lead'), propose_lead: b('propose_lead'), manage_departments: b('manage_departments') };
}
/** 「已提出，等〈谁〉确认」：谁照服务端给的（没给就写业务侧） */
export const pendingText = (p: Pick<Pending, 'confirm_by_text'>): string => `已提出，等${p.confirm_by_text || '业务侧'}确认`;
/**
 * 写操作回的是提议（202，或者建部门时带 lead_proposal）：给一句「已提出，等〈谁〉确认」，不当成已生效。不是提议返回 null
 */
export function proposedText(r: SourceResult): string | null {
  const b = obj(r.body);
  const p = r.status === 202 ? obj(b?.proposal) : obj(b?.lead_proposal);
  if (!p) return null;
  return pendingText({ confirm_by_text: typeof p.confirm_by_text === 'string' ? p.confirm_by_text : '' });
}
function personOf(v: unknown): Person | null {
  const p = obj(v);
  return p && typeof p.principal === 'string' ? { principal: p.principal, display_name: typeof p.display_name === 'string' ? p.display_name : '' } : null;
}

/** GET /api/teams 的应答整形：形状不对的部分按空，不让页面在非数组上崩。unclaimed 只有管理员的应答里有，没有就是 null */
export function teamsOf(body: unknown): Teams {
  const b = obj(body);
  const departments = arr<unknown>(b?.departments).map(obj).filter((d): d is Record<string, unknown> => !!d && typeof d.id === 'string')
    .map((d) => ({ id: d.id as string, name: typeof d.name === 'string' && d.name.trim() ? d.name : (d.id as string), lead: personOf(d.lead), teams: arr<unknown>(d.teams).map(teamOf).filter((t): t is Team => !!t),
      ...('pending_lead' in d ? { pending_lead: pendingOf(d.pending_lead) } : {}) }));
  return { departments, unclaimed: Array.isArray(b?.unclaimed) ? (b!.unclaimed as unknown[]).map(teamOf).filter((t): t is Team => !!t) : null, can: canOf(b?.can) };
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

/** 名册多久没更新算「没更新」：先按 15 分钟（以后由服务端给） */
export const ROSTER_STALE_MIN = 15;
/** 名册超过阈值没更新时的一句提醒；没超过、没有收到时刻的返回 null。时间按分钟写，两小时以上按小时、两天以上按天 */
export function rosterStaleText(t: Pick<Team, 'roster_at'>, now: number, staleMin = ROSTER_STALE_MIN): string | null {
  if (typeof t.roster_at !== 'number') return null;
  const min = Math.floor((now - t.roster_at) / 60_000);
  if (min < staleMin) return null;
  const span = min >= 2 * 24 * 60 ? `${Math.floor(min / (24 * 60))} 天` : min >= 120 ? `${Math.floor(min / 60)} 小时` : `${min} 分钟`;
  return `名册已 ${span}没更新`;
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

// ---------- 关系的提议（规范 14「关系由谁说了算」，GET /api/relations/proposals） ----------
// 服务端已经按看的人裁好（不是管理员只拿到自己能确认的、自己提的），每条带 can_approve / approve_denied_text / can_reject。
// 页面只照这些字段出按钮、写说法，不自己判谁能确认。显示名优先用服务端给的，缺了才用页面已有的，再缺就写人话，不露标识。

export type ProposalKind = 'team-claim' | 'team-lead' | 'dept-lead';
export interface Proposal {
  id: number; kind: ProposalKind; status: string; department_id: string; host: string; team: string; principal_id: string;
  proposed_by: string; proposed_at: number; confirm_by_text: string;
  can_approve: boolean; approve_denied_text: string | null; can_reject: boolean;
  /** 是不是当前看的人提的（服务端给了才有；没有就当不是） */
  mine: boolean | null;
  team_name: string | null; node_name: string | null; department_name: string | null; principal_name: string | null; proposed_by_name: string | null;
  /** 结局（服务端给的，#645）：pending、approved、rejected、withdrawn、expired；后三种带原因。没给时按 status 推，只认 pending */
  outcome: ProposalOutcome; outcome_reason: string | null;
}
export type ProposalOutcome = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
const OUTCOMES: readonly ProposalOutcome[] = ['pending', 'approved', 'rejected', 'withdrawn', 'expired'];
const KINDS: readonly ProposalKind[] = ['team-claim', 'team-lead', 'dept-lead'];
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** 结局：服务端给了 outcome 就用它；没给时只认 status 为 pending 的（处理过的不知道是驳回、撤回还是失效，就不列） */
function outcomeOf(p: Record<string, unknown>): ProposalOutcome | null {
  if (typeof p.outcome === 'string') return (OUTCOMES as readonly string[]).includes(p.outcome) ? p.outcome as ProposalOutcome : null;
  return p.status === 'pending' ? 'pending' : null;
}
/** 应答整形：待确认的都留；处理过的只留自己提的、服务端给了结局的（「你提的」里看得到结局，失效的服务端留 7 天）；形状不对的丢掉 */
export function proposalsOf(body: unknown): Proposal[] {
  return arr<unknown>(obj(body)?.proposals).map(obj).filter((p): p is Record<string, unknown> => !!p && typeof p.id === 'number' && KINDS.includes(p.kind as ProposalKind)
      && (outcomeOf(p) === 'pending' || (outcomeOf(p) !== null && p.mine === true)))
    .map((p) => ({
      id: p.id as number, kind: p.kind as ProposalKind, status: outcomeOf(p) === 'pending' ? 'pending' : 'decided', outcome: outcomeOf(p)!, outcome_reason: strOrNull(p.outcome_reason), department_id: String(p.department_id ?? ''), host: String(p.host ?? ''), team: String(p.team ?? ''),
      principal_id: String(p.principal_id ?? ''), proposed_by: String(p.proposed_by ?? ''), proposed_at: typeof p.proposed_at === 'number' ? p.proposed_at : 0,
      confirm_by_text: strOrNull(p.confirm_by_text) ?? '业务侧',
      can_approve: p.can_approve === true, approve_denied_text: strOrNull(p.approve_denied_text), can_reject: p.can_reject === true,
      mine: typeof p.mine === 'boolean' ? p.mine : null,
      team_name: strOrNull(p.team_name), node_name: strOrNull(p.node_name), department_name: strOrNull(p.department_name),
      principal_name: strOrNull(p.principal_name), proposed_by_name: strOrNull(p.proposed_by_name),
    }));
}

/** 页面已经知道的名字（服务端没给时用）：团队名按「节点 + 团队」，部门名，人名 */
export interface KnownNames { teams: Map<string, string>; departments: Map<string, string>; people: Map<string, string> }
export const teamKey = (host: string, team: string): string => `${host}\u0000${team}`;
export function knownNames(t: Teams, depts: Department[] | null, people: { id: string; name: string }[]): KnownNames {
  const teams = new Map<string, string>();
  for (const x of [...t.departments.flatMap((d) => d.teams), ...(t.unclaimed ?? [])]) if (x.name.trim()) teams.set(teamKey(x.host, x.team), x.name.trim());
  const departments = new Map<string, string>([...t.departments.map((d) => [d.id, d.name] as [string, string]), ...(depts ?? []).map((d) => [d.id, d.name] as [string, string])]);
  return { teams, departments, people: new Map(people.map((p) => [p.id, p.name])) };
}

/** 一条提议怎么说：「把『团队』挂到『部门』」「让某某做『团队』的负责人」「让某某做『部门』的负责人」 */
export function proposalTitle(p: Proposal, k: KnownNames): string {
  const team = p.team_name ?? k.teams.get(teamKey(p.host, p.team)) ?? '一个团队';
  const dept = p.department_name ?? k.departments.get(p.department_id) ?? '一个部门';
  const person = p.principal_name ?? k.people.get(p.principal_id) ?? '一位同事';
  if (p.kind === 'team-claim') return `把「${team}」挂到「${dept}」`;
  if (p.kind === 'team-lead') return `让 ${person} 做「${team}」的负责人`;
  return `让 ${person} 做「${dept}」的负责人`;
}
/** 谁提的：服务端给的名字；没有就按留痕的写法说人话（管理口令、本机命令行），对得到人就用人名，都没有写「一位同事」 */
export function proposerText(p: Proposal, k: KnownNames): string {
  if (p.proposed_by_name) return p.proposed_by_name;
  if (p.proposed_by === 'admin-token') return '管理员';
  if (p.proposed_by === 'cli') return '本机命令行';
  return k.people.get(p.proposed_by) ?? '一位同事';
}

/** 分三组：等你确认的（能确认、不是自己提的）、你提的、别的（管理员看得到、但不归自己确认的） */
export function proposalGroups(list: Proposal[]): { forMe: Proposal[]; mine: Proposal[]; others: Proposal[] } {
  const byTime = (a: Proposal, b: Proposal) => a.proposed_at - b.proposed_at || a.id - b.id;
  // 你提的：待确认的在前，处理过的（有结局的）在后；别的两组只有待确认的
  const mine = list.filter((p) => p.mine === true).sort((a, b) => Number(a.outcome !== 'pending') - Number(b.outcome !== 'pending') || byTime(a, b));
  const pending = list.filter((p) => p.outcome === 'pending' && p.mine !== true);
  const forMe = pending.filter((p) => p.can_approve).sort(byTime);
  const others = pending.filter((p) => !p.can_approve).sort(byTime);
  return { forMe, mine, others };
}
/** 结局怎么说：待确认、已确认、被驳回、已撤回、失效（失效没有人否决，不叫驳回）。按 outcome 判，不看处理人 */
const OUTCOME_LABEL: Record<ProposalOutcome, { text: string; tone: Tone }> = {
  pending: { text: '待确认', tone: 'warning' }, approved: { text: '已确认', tone: 'success' }, rejected: { text: '被驳回', tone: 'danger' },
  withdrawn: { text: '已撤回', tone: 'default' }, expired: { text: '失效', tone: 'default' },
};
export function outcomeLabel(p: Pick<Proposal, 'outcome'>): { text: string; tone: Tone } {
  return OUTCOME_LABEL[p.outcome] ?? OUTCOME_LABEL.pending;
}
/** 结局的原因一行：驳回、撤回、失效才有；服务端没给原因时，驳回和撤回不写，失效写「没有人否决，已经不能确认了」 */
export function outcomeReasonText(p: Pick<Proposal, 'outcome' | 'outcome_reason'>): string | null {
  if (p.outcome === 'rejected' || p.outcome === 'withdrawn') return p.outcome_reason ? `原因：${p.outcome_reason}` : null;
  if (p.outcome === 'expired') return `原因：${p.outcome_reason ?? '没有人否决，已经不能确认了'}`;
  return null;
}
/** 驳回那个按钮：自己提的叫「撤回」，别人提的叫「驳回」；服务端说不能就不出 */
export function rejectLabel(p: Proposal): string | null {
  if (!p.can_reject || p.outcome !== 'pending') return null;
  return p.mine === true ? '撤回' : '驳回';
}
/** 认领按钮：能直接认领写「认领」，只能提议写「提议认领」（系统管理员看到的是提议）；都不能返回 null */
export function claimButtonText(can: TeamsCan | null): string | null {
  if (!can) return '认领';
  if (can.claim) return '认领';
  if (can.propose_claim) return '提议认领';
  return null;
}
/** 认领只是提议、又选了负责人：负责人这一步没做，补一句 */
export const LEAD_SKIPPED_TEXT = '选的负责人这次没有指定：负责人等认领确认后再指定。';
