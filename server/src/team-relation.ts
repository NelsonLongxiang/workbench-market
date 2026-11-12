/**
 * 「这个人 / 这个席位，对这个部门 / 团队 / 席位是什么关系」（规范 14 第 1 步）。过目、安排、事项详情、数据视图「谁能改这个台」都用它，
 * 不各自查表。负责人、分配是按对象的范围，统一判定还不认（遗留差异 L13），所以这些域自己判、路由声明「状态码不代表授权」。
 *
 * 主体：{ principal: 'user:…' }（人），或者 { seat: { host, team, seat, seat_id? } }（AI 团队的席位，按名册认）。
 * 对象：{ department: '<部门标识>' }、{ team: { host, team } }、{ seat: { host, team, seat, seat_id? } }。
 * 关系（可以有几种）：
 *   · dept-member、dept-lead：这个人是部门成员 / 部门负责人（对团队、席位：看团队所挂的部门）；
 *   · team-lead：这个人是团队的负责人（另外指定的，或所挂部门的负责人）；
 *   · seat-owner：这个席位现在分配给了这个人（对团队：这个团队里有分给他的成员）；
 *   · team-seat：这个席位在名册里、属于这个团队（对部门：属于挂在这个部门下的团队）；
 *   · router：这个席位是这个团队的总工；
 *   · same-seat：主体和对象是同一个席位。
 * 都不是就是空数组。另带显示用的：团队名（画布名）、部门名、负责人的显示名、成员主人的显示名。
 *
 * 约定（规范 14「关系由谁说了算」）：关系不带来权限，只能用来收窄。
 *   · dept-member 来自部门成员表，管理员可写，只是组织信息：任何调用方都不许凭它放行。要按部门放行，问 judgment.ts 的 scopedVerdict（只认已放行的授予）。
 *   · team-lead、dept-lead、team-seat 对部门、seat-owner 反映的是已确认的关系：部门负责人、团队负责人只有属主能定，团队认领到部门要管理层或
 *     接收部门的负责人确认（services/relation-proposal.ts），成员分配只有团队负责人或管理层做。提议期间这些关系不存在，这里查不到。
 */
import { svc } from './context.ts';
import { sameSeat, type SeatKey, type TeamKey, type TeamService, type TeamView } from './services/team.ts';
import type { DepartmentService } from './services/department.ts';
import type { GrantService } from './services/grant.ts';

export type Subject = { principal: string } | { seat: { host: string; team: string; seat: string; seat_id?: string } };
export type Target = { department: string } | { team: TeamKey } | { seat: { host: string; team: string; seat: string; seat_id?: string } };
export type Relation = 'dept-member' | 'dept-lead' | 'team-lead' | 'seat-owner' | 'team-seat' | 'router' | 'same-seat';
export type RelationResult = {
  relations: Relation[];
  display: {
    team: { host: string; team: string; name: string } | null;
    department: { id: string; name: string } | null;
    leads: { principal: string; display_name: string }[];
    owner: { principal: string; display_name: string } | null;
  };
};

const teams = () => svc<TeamService>('teams');
const seatKey = (s: { host: string; team: string; seat: string; seat_id?: string }): SeatKey => ({ host: s.host, team: s.team, seat: s.seat, seat_id: s.seat_id ?? '' });
/** 团队的显示名：画布名（team 是 <区>/canvas/<名字>；空串是不在画布上的席位） */
export const teamName = (team: string): string => (team.includes('/canvas/') ? team.slice(team.indexOf('/canvas/') + 8) : '');
function deptRelations(principal: string, departmentId: string): Relation[] {
  const r = teams().departmentRole(principal, departmentId);
  return [...(r.member ? ['dept-member' as const] : []), ...(r.lead ? ['dept-lead' as const] : [])];
}

export function relationOf(subject: Subject, target: Target): RelationResult {
  const rel = new Set<Relation>();
  const display: RelationResult['display'] = { team: null, department: null, leads: [], owner: null };
  // 对象落在哪个团队、哪个部门上
  let team: TeamKey | null = null;
  let seat: SeatKey | null = null;
  let departmentId = '';
  if ('department' in target) departmentId = target.department;
  else if ('team' in target) team = target.team;
  else { seat = seatKey(target.seat); team = { host: seat.host, team: seat.team }; }
  if (team) {
    const reg = teams().registration(team);
    if (reg?.claimed) departmentId = reg.department_id;
    display.team = { host: team.host, team: team.team, name: teamName(team.team) };
    display.leads = teams().leads(team).map((l) => ({ principal: l.principal, display_name: l.display_name }));
  }
  if (departmentId) {
    display.department = teams().department(departmentId);
  }
  if (seat) {
    // 席位在名册里这个团队下才算有主人（seat_id 按节点认，团队另外核）
    const owner = teams().rosterSeat(seat) ? teams().ownerAt(seat, Date.now()) : null;
    if (owner) display.owner = { principal: owner, display_name: teams().nameOf(owner) };
  }

  if ('principal' in subject) {
    const p = subject.principal;
    if (departmentId) for (const r of deptRelations(p, departmentId)) rel.add(r);
    if (team && display.leads.some((l) => l.principal === p)) rel.add('team-lead');
    if (seat && display.owner?.principal === p) rel.add('seat-owner');
    if (team && !seat && teams().assignedTo(p).some((a) => a.host === team.host && a.team === team.team)) rel.add('seat-owner');
  } else {
    const s = seatKey(subject.seat);
    const inRoster = teams().rosterSeat(s);
    if (inRoster) {
      const sTeam: TeamKey = { host: s.host, team: s.team };
      const sameTeam = team ? team.host === sTeam.host && team.team === sTeam.team : false;
      if ('department' in target) {
        const reg = teams().registration(sTeam);
        if (reg?.claimed && reg.department_id === target.department) rel.add('team-seat');
      } else if (sameTeam) {
        rel.add('team-seat');
        if (inRoster.role === 'router') rel.add('router');
      }
      if (seat && sameSeat({ ...s, seat: inRoster.seat, seat_id: inRoster.seat_id }, seat)) rel.add('same-seat');
    }
  }
  return { relations: [...rel], display };
}

/** 团队页上的「管理层」：持有全组织范围（scope *）的管理层或属主授予 */
export function orgWideManagement(principal: string | null): boolean {
  return !!principal && svc<GrantService>('grants').activeFor(principal).some((g) => (g.role === 'management' || g.role === 'owner') && g.scope === '*');
}

/**
 * 这个人看不看得到这个团队（团队页的列表、事项的「等谁放行」里负责人的名字共用这一处）：
 *   管理员（管理口令、身份来源管理员）看全部；待认领的别人看不到；管理层看全部认领过的；
 *   其余只看自己是负责人、有成员分给自己、或所挂部门里有自己的团队
 */
export function teamVisibleTo(v: { admin: boolean; principal: string | null; management: boolean }, t: TeamView): boolean {
  if (v.admin) return true;
  if (t.status === 'unclaimed') return false;
  if (v.management) return true;
  if (!v.principal) return false;
  if (t.leads.some((l) => l.principal === v.principal)) return true;
  if (t.members.some((m) => m.assigned_to?.principal === v.principal)) return true;
  if (t.department) {
    const d = t.department.id;
    if (svc<DepartmentService>('departments').of(v.principal).some((x) => x.id === d)) return true;
  }
  return false;
}
