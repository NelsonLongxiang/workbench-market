/**
 * 事项上「这个人能做什么、是不是轮到他」——事项详情（GET /api/work-items/:id 的 can、turn、creator）和「关注」（每条的 mine、creator）用。
 *
 * can 的每一项和对应动作接口用同一处判断，不另写规则：
 *   release  事项在 held、releaseBlock 放行（事件在、任务没撤回），并且 releaseRole 认这个人（和 POST /api/work-items/:id/release 同一处）：
 *            负责人；团队没有负责人时持有管理层授予的人代办（管理门不算）；建立人勾了「先给我过目」的由建立人本人放行。只过了管理门的系统管理员不放行
 *   verify   事项在 ready，并且：管理员（「关注」里答 verify），或者建立人本人（writerVerdict 是 ok，和 POST /api/work-items/:id/decision 同一处）
 *   reply    事项不在终态，有可回复的席位消息（replyableMessages，和回复接口同一个判断），并且 writerVerdict 是 admin 或 ok（和回复接口的认人同一处）
 *   answer   事项不在终态，有在等答复的提问（pendingAsksOfEvent，和「关注」里答席位提问同一个定义），并且是管理员
 *            （建立人答提问的入口在阶段七 #567，合并后这里改成 writerVerdict，另一个小 PR）
 *
 * turn（是不是轮到这个人）只有两句：answer、verify 轮到的是建立人；release 轮到的是负责人（或勾了先过目的建立人），管理层代办不算轮到。
 * can 为真而 turn 为假，就是「能代办」。
 */
import type express from 'express';
import { svc } from './context.ts';
import { identity, sourceDown } from './identity.ts';
import { isCreator, type WorkItemRow, type WorkItemService } from './services/work-item.ts';
import type { PrincipalService } from './services/principal.ts';
import { pendingAsksOfEvent } from './services/attention-sources.ts';
import { eventOfItem, replyableMessages } from './seat-messages.ts';
import { releaseBlock } from './workbench-events.ts';
import { judge } from './judgment.ts';
import { rosterHosts } from './services/a2a-roster.ts';
import { relationOf } from './team-relation.ts';
import type { TeamKey, TeamService } from './services/team.ts';
import type { GrantService } from './services/grant.ts';
import type { ViewScope } from './services/work-item.ts';

/** 终态：事项不再往下走，不能再回复、答复、验收 */
export const TERMINAL_STATES: readonly string[] = ['done', 'failed', 'dropped', 'cancelled'];

/** 看的人：admin 是过了管理门；management 是管理层（有 work-items.view-all 这个动作，按统一判定认，不按角色名）。
 *  现有管理员迁移后两样都有；以后单独授了系统管理员、没授管理层的人，看不到事项 */
export type WorkItemViewer = {
  admin: boolean; principal: string | null; person: boolean; actor: string; management: boolean;
  /** 带了 cookie，但身份来源不可达（认不出的原因是来源，不是没登录）：路由回 502 identity_unavailable */
  sourceDown?: boolean;
};

/**
 * 管理层这个动作：事项列表的「全部」视角报的就是它（路由的 refine），看任何一件事项的详情也按它判。
 * 业务域（work-items，「事项与对话」那一块）里的动作，类别是「拍板」（decide）：预设里全公司范围的拍板只有属主和管理层，
 * 系统管理员预设没有业务域的拍板，普通员工的拍板只到自己的事，部门负责人的拍板只到本部门。
 * 不用「看」（read）：普通员工预设能看全部业务域，按「看」问会让每个员工都过；不用「管理」（admin）：那样系统管理员过、管理层反而不过
 */
export const VIEW_ALL_ACTION = 'work-items.view-all';
export const VIEW_ALL_KIND = 'decide' as const;
/**
 * 是不是管理层：过了管理门的人（口令、身份来源的管理员——现有的管理员迁移后同时是系统管理员和管理层），
 * 或者按统一判定有 work-items.view-all 这个动作的人（以后单独授的管理层角色）。
 * 管理门今天只认这两种现有管理员；统一判定生效（6d）以后，管理门也按授予判，那时「只授了系统管理员、没授管理层」的人才会出现，看不到事项。
 */
export function isManagement(principal: string | null, admin: boolean): boolean {
  return admin || holdsManagementGrant(principal);
}

/**
 * 持有管理层授予：按统一判定有 work-items.view-all 这个动作，不认管理门。
 * 读（isManagement）照旧认管理门；新的写——团队没有负责人时代办放行——只认它（协调方 2026-11-12 定的口径）：
 * 管理口令、没有管理层授予的身份来源管理员都不能代办
 */
export function holdsManagementGrant(principal: string | null): boolean {
  if (!principal) return false;
  const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string; owner?: string } | undefined;
  if (!p) return false;
  return judge({ actor: { type: 'principal', id: principal, kind: p.kind ?? '', status: p.status ?? '', owner: p.owner ?? '' }, action: VIEW_ALL_ACTION, kind: VIEW_ALL_KIND, declared: true }).verdict === 'allow';
}

/**
 * 现在有几个主体持有管理层授予（health 只给管理口令看，只给个数、不给是谁）。
 * 是 0 时，团队没有负责人、又没人能代办：那些团队的等过目的事项没人放得了（存量差异清单 L21）。
 * 只看生效的授予（授予表最多取 500 条，够这个量级）
 */
export function managementGrantHolders(): number {
  const ps = new Set(svc<GrantService>('grants').list({ status: 'active' }).map((g) => g.principal_id));
  return [...ps].filter(holdsManagementGrant).length;
}

/** UTC「YYYY-MM-DD hh:mm:ss」和毫秒互换（事项表里的时间是前者，团队服务的时间是后者） */
const sqlTimeMs = (t: string): number => Date.parse(t.replace(' ', 'T') + 'Z');
const msSqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * 接手时刻归哪一段分配（只有这一处定口径）：左闭右开，接手时刻 ≥ 分配开始且 < 分配结束；同一时刻收回又分给别人，归后一段的从它开始算。
 * 详情（itemRoles 的 owner）拿这个人的各段分配（团队服务的 assignmentHistory，毫秒）逐段调 inSegment；
 * 列表（seats 视角）用同一份分配段，的 SQL 用 segmentBound 把段的边界换成 seat_at 的写法：seat_at 只到秒，
 * 「秒 ≥ 毫秒的 from」等价于「秒 ≥ from 向上取整到秒」，「秒 < 毫秒的 to」等价于「秒 < to 向上取整到秒」，所以两边结论一样
 */
export const inSegment = (atMs: number, seg: { from: number; to: number | null }): boolean => seg.from <= atMs && (seg.to === null || atMs < seg.to);
export const segmentBound = (ms: number): string => msSqlTime(Math.ceil(ms / 1000) * 1000);

/**
 * 事项发往哪些团队（团队键和名册同一个：host 是名册里的节点标识，team 是画布团队地址）。从事件的投递来：
 * 投递地址的根地址到名册里换 host；目标团队不是画布团队地址的、名册还没到（换不出 host）的不算。
 */
export function itemTeams(item: Pick<WorkItemRow, 'id' | 'source_ref'>): TeamKey[] {
  const ev = eventOfItem(item);
  if (!ev) return [];
  const hostOf = new Map(rosterHosts().map((r) => [r.peer_root, r.host]));
  const out: TeamKey[] = [];
  for (const d of svc<WorkItemService>('workItems').deliveryTargets(ev)) {
    if (!d.team.includes('/canvas/')) continue;
    let root = '';
    try { root = new URL(d.url).origin; } catch { continue; }
    const host = hostOf.get(root);
    if (host && !out.some((t) => t.host === host && t.team === d.team)) out.push({ host, team: d.team });
  }
  return out;
}

export type ItemRole = 'creator' | 'owner' | 'lead' | 'management';
/**
 * 这个人对这件事项是哪几种人（规范 14 第九节第 1 条，只有这一处）：
 *   creator     建立人（isCreator）
 *   owner       成员的主人：承接席位在接手那一刻（seat_at）分配给了他（团队服务的 ownerAt；seat_id 为空的旧席位按句柄认）
 *   lead        事项交给的团队的负责人（团队服务的 relationOf 里有 team-lead）
 *   management  管理层（isManagement）
 * 系统管理员（只过了管理门）不在里面：看不到事项。
 */
export function itemRoles(item: WorkItemRow, viewer: WorkItemViewer): ItemRole[] {
  const roles: ItemRole[] = [];
  const p = viewer.principal;
  if (p && isCreator(item, p)) roles.push('creator');
  if (p) {
    const teams = itemTeams(item);
    if ((item.seat_id || item.seat) && item.seat_at) {
      const at = sqlTimeMs(item.seat_at);
      // 席位按完整的键：有 seat_id 的（节点, seat_id）；旧席位（seat_id 空）的（节点, 团队, 句柄）三项全等。和列表 seats 视角同一份分配段、同一个 inSegment
      const sameSeat = (g: { host: string; team: string; seat: string; seat_id: string }, t: TeamKey) => g.host === t.host
        && (g.seat_id ? g.seat_id === item.seat_id : item.seat_id === '' && g.team === t.team && g.seat === item.seat);
      if (Number.isFinite(at) && svc<TeamService>('teams').assignmentHistory(p).some((g) => inSegment(at, g) && teams.some((t) => sameSeat(g, t)))) roles.push('owner');
    }
    if (teams.some((t) => relationOf({ principal: p }, { team: t }).relations.includes('team-lead'))) roles.push('lead');
  }
  if (viewer.management) roles.push('management');
  return roles;
}
/** 看得到这件事项：建立人、成员的主人、负责人、管理层之一 */
export const canSee = (item: WorkItemRow, viewer: WorkItemViewer): boolean => itemRoles(item, viewer).length > 0;

export type ViewName = 'mine' | 'seats' | 'team' | 'all';
export const VIEWS: readonly ViewName[] = ['mine', 'seats', 'team', 'all'];
/**
 * 这个人有哪些视角、各自圈出哪些事项（规范 14 第九节第 4 条、第十节第 4、6 条）：
 *   mine   我安排的：登录认出来的人都有
 *   seats  我的 AI 员工手上的：有过分配的人才有；只算成员分配给我的那段时间里交到它手上的事（按 seat_at 落在哪一段）
 *   team   我团队的：是团队负责人的人才有
 *   all    全部：管理层才有
 */
export function viewScopes(viewer: WorkItemViewer): Partial<Record<ViewName, ViewScope>> {
  const out: Partial<Record<ViewName, ViewScope>> = {};
  const p = viewer.principal;
  if (p && viewer.person) {
    out.mine = { kind: 'mine', principal: p };
    const segs = svc<TeamService>('teams').assignmentHistory(p);
    const rootOf = new Map(rosterHosts().map((r) => [r.host, r.peer_root]));
    // 节点在名册里换不出根地址的段不算（和 itemTeams 一样：换不出节点的投递不认团队）
    const known = segs.filter((g) => rootOf.has(g.host));
    if (segs.length) out.seats = { kind: 'seats', segments: known.map((g) => ({ root: rootOf.get(g.host)!, team: g.team, seat: g.seat, seat_id: g.seat_id, from: segmentBound(g.from), to: g.to === null ? null : segmentBound(g.to) })) };
    const led = svc<TeamService>('teams').allViews().filter((v) => v.leads.some((l) => l.principal === p));
    const teams = led.map((v) => ({ root: rootOf.get(v.host) ?? '', team: v.team })).filter((t) => t.root !== '');
    if (led.length) out.team = { kind: 'team', teams };
  }
  if (viewer.management) out.all = { kind: 'all' };
  return out;
}

/** 不落地的应答：管理门判不过时写的 403 写到这里 */
function silentRes(): express.Response {
  const res: Record<string, unknown> = { statusCode: 200 };
  for (const m of ['status', 'json', 'send', 'set', 'setHeader', 'end', 'vary', 'type']) res[m] = () => res;
  return res as unknown as express.Response;
}

/** 看的人是谁：管理员（和各动作接口同一个管理门）、登录认出来的主体、是不是启用的人 */
export async function workItemViewer(req: express.Request, deps: { markOdooAdmin: (req: express.Request) => Promise<void>; adminGuard: (req: express.Request, res: express.Response) => boolean; adminActor?: (req: express.Request) => string }): Promise<WorkItemViewer> {
  await deps.markOdooAdmin(req);
  const admin = deps.adminGuard(req, silentRes());
  let principal: string | null = null, person = false, down = false;
  const cookie = String(req.headers.cookie ?? '');
  if (cookie) {
    const who = await identity().resolveViewer(cookie);
    down = sourceDown(who);
    if (who.ok) {
      principal = who.viewer.sub;
      const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string } | undefined;
      person = !!p && p.kind === 'person' && p.status === 'active';
    }
  }
  return { admin, principal, person, actor: admin ? (deps.adminActor?.(req) ?? 'admin') : principal ?? 'anonymous', management: isManagement(principal, admin), ...(down ? { sourceDown: true } : {}) };
}

/**
 * 写事项对话、验收的人是谁（只有这一处）：管理员 → admin；没登录 → unauthenticated；不是建立人 → not_found；
 * 主体不是启用的人 → inactive；建立人但事项不能由建立人处理 → not_eligible；ok。
 */
export type WriterVerdict = 'admin' | 'unauthenticated' | 'inactive' | 'not_found' | 'not_eligible' | 'ok';
export function writerVerdict(viewer: WorkItemViewer, itemId: string, allowAdmin = true): WriterVerdict {
  if (allowAdmin && viewer.admin) return 'admin';
  if (!viewer.principal) return 'unauthenticated';
  // 顺序和对话写入口原来一样：不是建立人先 404（不说有没有这件），再看主体启用没有，再看能不能由建立人处理
  const verdict = svc<WorkItemService>('workItems').creatorCheck(itemId, viewer.principal);
  if (verdict === 'not_found') return 'not_found';
  if (!viewer.person) return 'inactive';
  return verdict;
}

export type Can = { release: boolean; answer: boolean; verify: boolean; reply: boolean };
export type Turn = { release: boolean; answer: boolean; verify: boolean };

const pendingAsks = (item: WorkItemRow): number => { const ev = eventOfItem(item); return ev ? pendingAsksOfEvent(ev).length : 0; };
const releasable = (item: WorkItemRow): boolean => { const ev = eventOfItem(item); return item.state === 'held' && !!ev && releaseBlock(ev) === null; };

/** 现在能不能放：事项在等过目、事件和任务让放，并且 releaseRole 认这个人（详情的 can.release、「关注」的过目条目都用它） */
export const canRelease = (item: WorkItemRow, viewer: WorkItemViewer): boolean => releasable(item) && releaseRole(item, viewer) !== null;

/**
 * 谁能放行这件事项（规范 14 第九节，只有这一处；不看事项现在是不是 held，那是 releasable 的事）：
 *   建立人勾了「先给我过目」（review_by = requester）：建立人本人（启用的人）放行，别人都不放
 *   其余：事项交给的团队的负责人（relationOf 里有 team-lead）；
 *         这些团队都没有在职负责人（包括名册里还换不出团队的）时，持有管理层授予的人代办（管理口令、没有授予的身份来源管理员不算），acting_for 记 team-lead
 * 系统管理员（只过了管理门、不是管理层）不放行。返回 null 是不能放；acting_for 为空串是本人的事，不是代办
 */
export function releaseRole(item: WorkItemRow, viewer: WorkItemViewer): { acting_for: '' | 'team-lead' } | null {
  const p = viewer.principal;
  if (item.review_by === 'requester') return p && viewer.person && isCreator(item, p) ? { acting_for: '' } : null;
  const teams = itemTeams(item);
  if (p && viewer.person && teams.some((t) => relationOf({ principal: p }, { team: t }).relations.includes('team-lead'))) return { acting_for: '' };
  const vacant = teams.every((t) => svc<TeamService>('teams').leads(t).length === 0);
  // 代办只认持有管理层授予的主体，不认管理门（读的 isManagement 认，写不扩过去）
  return vacant && holdsManagementGrant(viewer.principal) ? { acting_for: 'team-lead' } : null;
}

export function canOf(item: WorkItemRow, viewer: WorkItemViewer): Can {
  const live = !TERMINAL_STATES.includes(item.state);
  const creatorOk = writerVerdict(viewer, item.id, false) === 'ok';
  return {
    release: canRelease(item, viewer),
    answer: live && viewer.admin && pendingAsks(item) > 0,
    verify: item.state === 'ready' && (viewer.admin || creatorOk),
    reply: live && (viewer.admin || creatorOk) && replyableMessages(item).length > 0,
  };
}

/** 是不是轮到这个人：answer、verify 轮到建立人；release 轮到负责人或勾了先过目的建立人（管理层代办不算）。只在事情确实在等的时候为真 */
export function turnOf(item: WorkItemRow, viewer: WorkItemViewer): Turn {
  const live = !TERMINAL_STATES.includes(item.state);
  const mine = viewer.principal !== null && isCreator(item, viewer.principal);
  return {
    release: releasable(item) && releaseRole(item, viewer)?.acting_for === '',
    answer: live && mine && pendingAsks(item) > 0,
    verify: item.state === 'ready' && mine,
  };
}

/** 建立人：主体和显示名（主体表里的显示名，认人时从登录提供方写进去的；没有就是 null，前端退回显示登录名）。建立人空着是 null */
export function creatorOf(item: Pick<WorkItemRow, 'creator_principal'>): { principal: string; display_name: string | null } | null {
  const p = item.creator_principal;
  if (!p) return null;
  const row = svc<PrincipalService>('principals').get(p) as { display_name?: string } | undefined;
  const name = typeof row?.display_name === 'string' && row.display_name.trim() !== '' ? row.display_name : null;
  return { principal: p, display_name: name };
}
