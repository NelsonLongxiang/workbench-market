/**
 * 事项上「这个人能做什么、是不是轮到他」——事项详情（GET /api/work-items/:id 的 can、turn、creator）和「关注」（每条的 mine、creator）用。
 *
 * 事项上替人做决定的动作——答席位提问（answer）、回复席位消息（reply）、验收（verify）、退回（return）、放行（release）——
 * 谁能做只有一处：itemDecisionVerdict。can.* 和真去调接口（事项自己的入口、「关注」的答复入口）都出自它：
 *   建立人本人；或团队负责人（只限 release 和退回自己团队的）；或持有管理层授予的人（代办，留痕记 acting_for）。
 *   只过了管理门（管理口令、身份来源管理员登录）而没有管理层授予的，一律不算（存量差异清单 L21）。
 * can 还要看事情此刻在不在等：release 要事项在 held、事件和任务让放；verify、return 要在 ready；
 * reply 要不在终态、有可回复的席位消息；answer 要不在终态、有在等答复的提问。
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
import { judge, rolesCovering } from './judgment.ts';
import { rosterHosts } from './services/a2a-roster.ts';
import { orgWideManagement, relationOf, teamName, teamVisibleTo } from './team-relation.ts';
import type { TeamKey, TeamService, TeamView } from './services/team.ts';
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
 * 现在有几个主体持有管理层授予（health 只给管理口令看，只给个数、不给是谁）。
 * 是 0 时，团队没有负责人、又没人能代办：那些团队的等过目的事项没人放得了（存量差异清单 L21）。
 * 先按角色在库里筛（闭包覆盖 work-items.view-all 的角色、生效的授予，不限条数），再逐个照 holdsManagementGrant 判（主体启用、范围对）
 */
export function managementGrantHolders(): number {
  return svc<GrantService>('grants').activeHolders(rolesCovering(VIEW_ALL_ACTION, VIEW_ALL_KIND)).filter(holdsManagementGrant).length;
}

/**
 * 持有管理层授予：按统一判定有 work-items.view-all 这个动作，不认管理门。
 * 读（isManagement）照旧认管理门；替建立人做业务决定（代办）只认它（协调方 2026-11-12 定的口径）：
 * 管理口令、没有管理层授予的身份来源管理员都不能代办
 */
export function holdsManagementGrant(principal: string | null): boolean {
  if (!principal) return false;
  const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string; owner?: string } | undefined;
  if (!p) return false;
  return judge({ actor: { type: 'principal', id: principal, kind: p.kind ?? '', status: p.status ?? '', owner: p.owner ?? '' }, action: VIEW_ALL_ACTION, kind: VIEW_ALL_KIND, declared: true }).verdict === 'allow';
}

/** 主体是不是启用的人（事项上写和做决定的都得是） */
export function isActivePerson(principal: string | null): boolean {
  if (!principal) return false;
  const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string } | undefined;
  return !!p && p.kind === 'person' && p.status === 'active';
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
      person = isActivePerson(principal);
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

export type Can = { release: boolean; answer: boolean; verify: boolean; return: boolean; reply: boolean };
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

/**
 * 等谁放行（只在 held 的事项上给，别的状态是 null；和 releaseRole 同一个推导）：
 *   creator     建立人勾了「先给我过目」：等建立人本人
 *   team-lead   交给的团队里有在职负责人：列出这些团队和负责人；负责人的名字只给看得到这个团队的人（teamVisibleTo，和团队页同一处），
 *               看不到的这个团队的 leads 是 null
 *   management  这些团队都没有在职负责人（或名册里换不出团队）：等管理层（持有管理层授予的人）代办
 * text 是给页面直接显示的一句话，已经按看的人裁过
 */
export type ReleaseBy =
  | { kind: 'creator'; text: string; creator: { principal: string; display_name: string | null } | null }
  | { kind: 'team-lead'; text: string; teams: { team: string; name: string; leads: { principal: string; display_name: string }[] | null }[] }
  | { kind: 'management'; text: string };
/** views：列表一页里有好几件时先取一次全部团队视图传进来，不每件重取 */
export function releaseBy(item: WorkItemRow, viewer: WorkItemViewer, views?: TeamView[]): ReleaseBy | null {
  if (item.state !== 'held') return null;
  if (item.review_by === 'requester') {
    const c = creatorOf(item);
    return { kind: 'creator', text: c?.display_name ? `建立人 ${c.display_name}` : '建立人', creator: c };
  }
  const withLeads = itemTeams(item).map((t) => ({ key: t, leads: svc<TeamService>('teams').leads(t) })).filter((t) => t.leads.length > 0);
  if (withLeads.length === 0) return { kind: 'management', text: '管理层' };
  const all = views ?? svc<TeamService>('teams').allViews();
  const who = { admin: viewer.admin, principal: viewer.principal, management: orgWideManagement(viewer.principal) };
  const teams = withLeads.map(({ key, leads }) => {
    const v = all.find((x) => x.host === key.host && x.team === key.team);
    const seen = !!v && teamVisibleTo(who, v);
    return { team: key.team, name: teamName(key.team), leads: seen ? leads.map((l) => ({ principal: l.principal, display_name: l.display_name })) : null };
  });
  const text = teams.map((t) => (t.leads ? `${t.name} 的负责人 ${t.leads.map((l) => l.display_name).join('、')}` : `${t.name} 的负责人`)).join('；');
  return { kind: 'team-lead', text, teams };
}

export const ITEM_DECISIONS = ['answer', 'reply', 'verify', 'return', 'release'] as const;
export type ItemDecision = (typeof ITEM_DECISIONS)[number];
/** 代谁办：空串是本人的事；creator 是替建立人做（负责人退回、管理层代办）；team-lead 是替负责人放行（团队没有负责人时管理层代办） */
export type ActingFor = '' | 'creator' | 'team-lead';
export type DecisionVerdict = { ok: true; acting_for: ActingFor; as: 'creator' | 'lead' | 'management' } | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * 事项上替人做决定的动作谁能做（只有这一处；不看事情此刻在不在等，那是 canOf 和各入口的事）：
 *   401：没认出人，也没过管理门
 *   404：看不到这件事项（canSee），不说有没有
 *   release：照 releaseRole（建立人勾了先过目的由建立人本人；其余负责人；团队没有负责人时持有管理层授予的人代办，acting_for = team-lead）
 *   其余：建立人本人（启用的人，事项可由建立人处理）——本人的事；
 *         return 还认事项交给的团队的负责人——替建立人退回，acting_for = creator；
 *         持有管理层授予的人——代办，acting_for = creator
 *   403：看得到但不归他做。只过了管理门（管理口令、没有管理层授予的身份来源管理员）落在这里
 */
export function itemDecisionVerdict(item: WorkItemRow | undefined, viewer: WorkItemViewer, action: ItemDecision): DecisionVerdict {
  if (!viewer.admin && !viewer.principal) return { ok: false, status: 401, error: 'work_items_auth_required' };
  if (!item || !canSee(item, viewer)) return { ok: false, status: 404, error: 'work_item_not_found' };
  const no: DecisionVerdict = { ok: false, status: 403, error: 'work_item_decision_not_yours' };
  if (action === 'release') {
    const r = releaseRole(item, viewer);
    if (!r) return no;
    return { ok: true, acting_for: r.acting_for, as: r.acting_for ? 'management' : item.review_by === 'requester' ? 'creator' : 'lead' };
  }
  const p = viewer.principal;
  const creatorCheck = p && viewer.person && isCreator(item, p) ? svc<WorkItemService>('workItems').creatorCheck(item.id, p) : null;
  if (creatorCheck === 'ok') return { ok: true, acting_for: '', as: 'creator' };
  if (action === 'return' && p && viewer.person && itemRoles(item, viewer).includes('lead')) return { ok: true, acting_for: 'creator', as: 'lead' };
  if (holdsManagementGrant(p)) return { ok: true, acting_for: 'creator', as: 'management' };
  // 建立人本人、但事项不能由建立人处理（来源未验证、建立人不是人）：照旧说清楚是这个原因
  if (creatorCheck === 'not_eligible') return { ok: false, status: 403, error: 'work_item_creator_not_eligible' };
  return no;
}
const decides = (item: WorkItemRow, viewer: WorkItemViewer, action: ItemDecision): boolean => itemDecisionVerdict(item, viewer, action).ok;

export function canOf(item: WorkItemRow, viewer: WorkItemViewer): Can {
  const live = !TERMINAL_STATES.includes(item.state);
  const ready = item.state === 'ready';
  return {
    release: releasable(item) && decides(item, viewer, 'release'),
    answer: live && pendingAsks(item) > 0 && decides(item, viewer, 'answer'),
    verify: ready && decides(item, viewer, 'verify'),
    return: ready && decides(item, viewer, 'return'),
    reply: live && replyableMessages(item).length > 0 && decides(item, viewer, 'reply'),
  };
}

/**
 * 从请求认出看的人（「关注」的列表和答复入口用；事项自己的入口用 workItemViewer，两者同一个口径）：
 * admin 是调用方已经判过的管理门；principal 经身份服务认 cookie；person 是主体表里启用的人；management 和 isManagement 同一处
 */
export async function requestViewer(req: express.Request, admin: boolean): Promise<WorkItemViewer> {
  let principal: string | null = null, person = false;
  const cookie = String(req.headers.cookie ?? '');
  if (cookie) {
    const who = await identity().resolveViewer(cookie);
    if (who.ok) {
      principal = who.viewer.sub;
      const p = svc<PrincipalService>('principals').get(principal) as { kind?: string; status?: string } | undefined;
      person = !!p && p.kind === 'person' && p.status === 'active';
    }
  }
  return { admin, principal, person, actor: principal ?? 'admin', management: isManagement(principal, admin) };
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
