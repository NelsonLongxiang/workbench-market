/**
 * 关系的提议（规范 14「关系由谁说了算」）。Cordis 服务 `relationProposals`。
 *
 * 会带来业务权限的关系，只有系统管理员身份的人一个人造不出来：
 *   · 部门负责人（dept-lead）、团队负责人（team-lead）：带拍板，只有属主能放行；
 *   · 团队认领到部门（team-claim，包括换部门）：管理层（业务侧），或接收的那个部门的负责人（在 dept:<部门> 有带业务拍板的授予）确认；
 *   · 不是这些人做的，只记成提议；提议期间关系不存在（不写 departments.lead_principal / team_leads / teams），不带来任何权限。
 * 收紧方向的（清掉部门负责人、移除团队负责人、退回待认领）不经这里，管理员一步完成。
 * 部门成员表不经这里：它只是组织信息，不带来权限（team-relation.ts 写明了，按部门放行要问 judgment.ts 的 scopedVerdict）。
 *
 * 「能不能确认」只有一处（confirmRefusal）：确认接口和页面的 can_approve 都用它。
 * 属主 = 本机命令行（L1：授予面上算属主），或持有生效 owner 授予的主体。管理口令对不到人，确认不了。
 * 不是属主的人不能确认自己提的。
 *
 * 没人处理的提议会失效（不是驳回，没有人否决它）：每小时一轮（随服务停，不往外发），
 *   · 目标不在了：部门删了、被提名的人停用或不再是人、团队已退回待认领（负责人提议）、团队已经挂到了部门（认领提议）；
 *     团队不在节点名册里要「持续」才算：节点照常在报名册（没超过名册停推阈值），而这个团队连续不在超过 WM_PROPOSAL_ROSTER_GONE_HOURS
 *     （缺省 24 小时，按名册变化记录里最后一次「团队消失」算）。短暂掉出又回来的不收；节点整个停推的，不按「团队不在」收（那是节点的事，
 *     另有「名册停推」进等你拍板），只走总期限；
 *   · 超过 WM_PROPOSAL_TTL_DAYS（缺省 14 天）没人处理。
 * 库里记成 rejected、处理人 system:expire、reason 写原因（不改表）；接口上给 outcome: 'expired' 和 outcome_reason，页面不靠处理人去猜。
 * 失效的在提议人的「你提的」里留 7 天（EXPIRED_SHOW_MS）。确认时照旧重新核对目标。
 * 人手确认（核对、改状态、落关系）和失效那一轮各包在一个 BEGIN IMMEDIATE 事务里，互斥。
 */
import { Service } from '@deepseek-ai/cordis';
import { svc } from '../context.ts';
import { db } from '../db.ts';
import type { GrantService } from './grant.ts';
import type { DepartmentService } from './department.ts';
import type { TeamService } from './team.ts';
import type { PrincipalService } from './principal.ts';
import { isoTime } from './team.ts';

export type ProposalKind = 'dept-lead' | 'team-lead' | 'team-claim';
export type ProposalRow = {
  id: number; kind: ProposalKind; department_id: string; host: string; team: string; principal_id: string;
  status: 'pending' | 'approved' | 'rejected'; proposed_by: string; proposed_by_principal: string | null; proposed_at: number;
  decided_by: string | null; decided_by_principal: string | null; decided_at: number | null; reason: string;
};
/** 做这一步的是谁：留痕写法、对到的主体（没有为 null）、是不是属主 */
export type ProposalActor = { by: string; principal: string | null; owner: boolean };
export type ProposalRefusal = { ok: false; http: 403 | 404 | 409 | 422; code: string; message: string };

const refuse = (http: ProposalRefusal['http'], code: string, message: string): ProposalRefusal => ({ ok: false, http, code, message });
const grants = () => svc<GrantService>('grants');
const departments = () => svc<DepartmentService>('departments');
const teams = () => svc<TeamService>('teams');
const principals = () => svc<PrincipalService>('principals');

/** 失效的处理人写法（库里沿用 rejected，靠它和人手驳回分开）；失效的在提议人那里留多久 */
export const EXPIRED_BY = 'system:expire';
export const EXPIRED_SHOW_MS = 7 * 24 * 3600_000;
const EXPIRE_EVERY_MS = 3600_000;
/** 一条提议的结局：待确认、已确认、被驳回、提的人撤回、失效 */
export type ProposalOutcome = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';

/** 团队连续不在名册多久才算「不在了」（小时）：WM_PROPOSAL_ROSTER_GONE_HOURS，缺省 24，1～720 的整数；别的值返回 null（启动时拒绝） */
export function rosterGoneHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.WM_PROPOSAL_ROSTER_GONE_HOURS ?? '');
  if (raw === '') return 24;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 720 ? n : null;
}

/** 提议多久没人处理就失效（天）：WM_PROPOSAL_TTL_DAYS，缺省 14，1～365 的整数；别的值返回 null（启动时拒绝） */
export function proposalTtlDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = String(env.WM_PROPOSAL_TTL_DAYS ?? '');
  if (raw === '') return 14;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 365 ? n : null;
}

/** 这种提议等谁确认（给页面原样显示：「已提出，等〈谁〉确认」）。和 confirmRefusal 的规则对应 */
export const CONFIRM_BY: Readonly<Record<ProposalKind, string>> = {
  'dept-lead': '属主', 'team-lead': '属主', 'team-claim': '管理层或接收部门的负责人',
};

/** 被拒时给页面的短说法（按代码） */
export const CONFIRM_TEXT: Readonly<Record<string, string>> = {
  owner_required: '只有属主能放行',
  business_confirm_required: '要管理层或接收部门的负责人确认',
  proposer_cannot_confirm: '提议的人不能自己确认，要另一位确认',
  state: '不在待确认',
};

export class RelationProposalService extends Service {
  private ttlMs = 14 * 24 * 3600_000;
  private rosterGoneMs = 24 * 3600_000;
  /** 启动时由 index.ts 按 WM_PROPOSAL_ROSTER_GONE_HOURS 设一次 */
  setRosterGoneHours(hours: number): void { this.rosterGoneMs = hours * 3600_000; }

  /** 团队连续不在名册多久了（毫秒）：节点照常在报、名册变化里最后一条是这个团队「消失」才算；节点停推、没有记录、又回来了都是 null */
  private absentFor(host: string, team: string, now: number): number | null {
    if (teams().staleRosters(now).some((r) => r.host === host)) return null; // 节点整个停推：不按「团队不在」算
    if (!db.prepare('SELECT 1 FROM a2a_rosters WHERE host = ?').get(host)) return null;
    const last = db.prepare('SELECT kind, at FROM a2a_roster_changes WHERE host = ? AND team = ? AND kind IN (\'team-added\', \'team-removed\') ORDER BY id DESC LIMIT 1').get(host, team) as { kind: string; at: string } | undefined;
    if (last?.kind !== 'team-removed') return null;
    const at = Date.parse(isoTime(last.at));
    return Number.isFinite(at) ? now - at : null;
  }

  constructor(ctx: any) {
    super(ctx, 'relationProposals');
    // 每小时一轮收掉失效的提议：只改本库，不往外发；随插件卸载停下，不拦进程退出
    ctx.effect(() => {
      const timer = setInterval(() => {
        try { const n = this.expireStale(Date.now()); if (n) console.log(JSON.stringify({ source: 'relations', event: 'expire', count: n, at: new Date().toISOString() })); } catch (e) {
          console.error(`[relations] 收失效的提议出错（下一轮再试）：${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }, EXPIRE_EVERY_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'relationProposals.expire');
  }

  /** 启动时由 index.ts 按 WM_PROPOSAL_TTL_DAYS 设一次 */
  setTtlDays(days: number): void { this.ttlMs = days * 24 * 3600_000; }

  /** 这条提议的目标还在不在、过没过期限：失效的原因，还有效返回 null */
  staleReason(p: ProposalRow, now: number): string | null {
    const personGone = (id: string) => { const x = principals().get(id) as { kind?: string; status?: string } | null; return !x || x.kind !== 'person' || x.status !== 'active'; };
    if (p.kind === 'dept-lead') {
      if (!departments().get(p.department_id)) return '部门已经不在了';
      if (personGone(p.principal_id)) return '被提名的人已停用或不在了';
    } else {
      const k = { host: p.host, team: p.team };
      const inRoster = [...teams().rosterTeams().values()].some((t) => t.host === p.host && t.team === p.team);
      if (!inRoster) {
        const gone = this.absentFor(p.host, p.team, now);
        if (gone !== null && gone > this.rosterGoneMs) return `团队已经不在节点名册里超过 ${Math.round(this.rosterGoneMs / 3600_000)} 小时`;
      }
      const reg = teams().registration(k);
      if (p.kind === 'team-lead') {
        if (!reg?.claimed) return '团队已退回待认领';
        if (personGone(p.principal_id)) return '被提名的人已停用或不在了';
      } else {
        if (!departments().get(p.department_id)) return '要挂的部门已经不在了';
        if (reg?.claimed) return reg.department_id === p.department_id ? '团队已经挂到这个部门了' : '团队已经挂到了别的部门';
      }
    }
    if (now - p.proposed_at > this.ttlMs) return `超过 ${Math.round(this.ttlMs / 86_400_000)} 天没人处理`;
    return null;
  }

  /** 收掉失效的提议：标成 rejected、处理人 system:expire、reason 写原因。返回收了几条 */
  expireStale(now: number): number {
    // 一轮包在一个事务里：和人手确认互斥（确认那边也是 BEGIN IMMEDIATE）
    return this.exclusive(() => {
      let n = 0;
      for (const p of db.prepare("SELECT * FROM relation_proposals WHERE status = 'pending' ORDER BY id").all() as ProposalRow[]) {
        const why = this.staleReason(p, now);
        if (!why) continue;
        n += Number(db.prepare("UPDATE relation_proposals SET status = 'rejected', decided_by = ?, decided_by_principal = NULL, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'")
          .run(EXPIRED_BY, now, why, p.id).changes);
      }
      return n;
    });
  }

  /** BEGIN IMMEDIATE 包一段：出错回滚；拒绝（返回 ok:false）也回滚，不留半截 */
  private exclusive<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === false) db.exec('ROLLBACK'); else db.exec('COMMIT');
      return r;
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
  }

  /** 结局：失效和人手驳回分开，提的人自己驳回的算撤回 */
  outcomeOf(p: ProposalRow): ProposalOutcome {
    if (p.status === 'pending') return 'pending';
    if (p.status === 'approved') return 'approved';
    if (p.decided_by === EXPIRED_BY) return 'expired';
    if (p.decided_by === p.proposed_by || (!!p.decided_by_principal && p.decided_by_principal === p.proposed_by_principal)) return 'withdrawn';
    return 'rejected';
  }

  get(id: number): ProposalRow | null {
    return (db.prepare('SELECT * FROM relation_proposals WHERE id = ?').get(id) as ProposalRow | undefined) ?? null;
  }

  /** 待确认的全部，加上最近处理过的（最多 50 条） */
  list(): ProposalRow[] {
    const pending = db.prepare("SELECT * FROM relation_proposals WHERE status = 'pending' ORDER BY id").all() as ProposalRow[];
    const recent = db.prepare("SELECT * FROM relation_proposals WHERE status <> 'pending' ORDER BY id DESC LIMIT 50").all() as ProposalRow[];
    return [...pending, ...recent];
  }

  /** 这个关系要不要经提议：属主直接做；团队认领另外认业务侧和接收部门的负责人 */
  direct(kind: ProposalKind, actor: ProposalActor, departmentId = '', now = Date.now()): boolean {
    if (actor.owner) return true;
    if (kind !== 'team-claim') return false;
    return grants().isBusinessSide(actor.principal, now) || grants().decidesBusinessIn(actor.principal, `dept:${departmentId}`, now);
  }

  /** 记一条提议。同样的提议已经在等就不重复记，返回原来那条 */
  propose(p: { kind: ProposalKind; department_id?: string; host?: string; team?: string; principal_id?: string }, actor: ProposalActor, now: number): { id: number; created: boolean } {
    const f = { department_id: p.department_id ?? '', host: p.host ?? '', team: p.team ?? '', principal_id: p.principal_id ?? '' };
    const cur = db.prepare("SELECT id FROM relation_proposals WHERE status = 'pending' AND kind = ? AND department_id = ? AND host = ? AND team = ? AND principal_id = ?")
      .get(p.kind, f.department_id, f.host, f.team, f.principal_id) as { id: number } | undefined;
    if (cur) return { id: cur.id, created: false };
    const id = Number(db.prepare('INSERT INTO relation_proposals (kind, department_id, host, team, principal_id, proposed_by, proposed_by_principal, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.kind, f.department_id, f.host, f.team, f.principal_id, actor.by.slice(0, 256), actor.principal, now).lastInsertRowid);
    return { id, created: true };
  }

  /** 这个人能不能确认这条提议：确认接口和页面的 can_approve 共用这一处。能就返回 null */
  confirmRefusal(p: ProposalRow, actor: ProposalActor, now = Date.now()): ProposalRefusal | null {
    if (p.status !== 'pending') return refuse(409, 'state', `提议 ${p.id} 现在是 ${p.status}，不能确认`);
    if (actor.owner) return null;
    if (p.kind !== 'team-claim') return refuse(403, 'owner_required', `指定负责人带拍板，${CONFIRM_TEXT.owner_required}`);
    if (!this.direct('team-claim', actor, p.department_id, now)) return refuse(403, 'business_confirm_required', `把团队认领到部门，${CONFIRM_TEXT.business_confirm_required}`);
    if (p.proposed_by === actor.by || (!!actor.principal && p.proposed_by_principal === actor.principal)) return refuse(403, 'proposer_cannot_confirm', CONFIRM_TEXT.proposer_cannot_confirm);
    return null;
  }

  /** 确认：先把关系写进去（经各自的服务，规则一条不少），成功了才把提议标成 approved */
  approve(id: number, actor: ProposalActor, now: number): { ok: true; proposal: ProposalRow } | ProposalRefusal {
    // 核对（在事务里重读）、落关系、改状态一起：和失效那一轮互斥，不会确认到一半被收掉，也不会落了关系没改状态
    return this.exclusive((): { ok: true; proposal: ProposalRow } | ProposalRefusal => {
      const p = this.get(id);
      if (!p) return refuse(404, 'proposal_missing', `提议 ${id} 不存在`);
      const no = this.confirmRefusal(p, actor, now);
      if (no) return no;
      const applied = this.apply(p, actor, now);
      if (applied) return applied;
      if (db.prepare("UPDATE relation_proposals SET status = 'approved', decided_by = ?, decided_by_principal = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(actor.by.slice(0, 256), actor.principal, now, id).changes !== 1) return refuse(409, 'state', `提议 ${id} 的状态变了`);
      return { ok: true, proposal: this.get(id)! };
    });
  }

  /**
   * 驳回或撤回：驳回只归能确认它的人，提的人只能撤回自己提的。系统管理员（管理口令、身份来源的管理员登录，没有相应业务授予的）
   * 对别人提的既不能确认也不能驳回——替业务否决和替业务放行是同一类事（规范 14「关系由谁说了算」）。
   */
  rejectRefusal(p: ProposalRow, actor: ProposalActor, now = Date.now()): ProposalRefusal | null {
    if (p.status !== 'pending') return refuse(409, 'state', `提议 ${p.id} 现在是 ${p.status}，不能驳回`);
    if (this.isMine(p, actor) || this.confirmRefusal(p, actor, now) === null) return null;
    return refuse(403, 'reject_not_allowed', '只有能确认的人能驳回；提议的人只能撤回自己提的');
  }

  /** 这条是不是这个人提的 */
  isMine(p: ProposalRow, actor: ProposalActor): boolean {
    return p.proposed_by === actor.by || (!!actor.principal && p.proposed_by_principal === actor.principal);
  }

  reject(id: number, actor: ProposalActor, reason: string, now: number): { ok: true; proposal: ProposalRow } | ProposalRefusal {
    const p = this.get(id);
    if (!p) return refuse(404, 'proposal_missing', `提议 ${id} 不存在`);
    const no = this.rejectRefusal(p, actor, now);
    if (no) return no;
    db.prepare("UPDATE relation_proposals SET status = 'rejected', decided_by = ?, decided_by_principal = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'")
      .run(actor.by.slice(0, 256), actor.principal, now, reason.slice(0, 500), id);
    return { ok: true, proposal: this.get(id)! };
  }

  private apply(p: ProposalRow, actor: ProposalActor, now: number): ProposalRefusal | null {
    if (p.kind === 'dept-lead') {
      const d = departments().get(p.department_id);
      if (!d) return refuse(409, 'department_missing', `部门 ${p.department_id} 已经不在了`);
      const r = departments().upsert({ id: d.id, name: d.name, functionCode: d.function_code, lead: p.principal_id }, actor.by, now);
      return r.ok ? null : refuse(r.http === 400 ? 422 : r.http as ProposalRefusal['http'], r.code, r.message);
    }
    const k = { host: p.host, team: p.team };
    const r = p.kind === 'team-lead' ? teams().addLead(k, p.principal_id, actor, now) : teams().claim(k, p.department_id, actor, now);
    return r.ok ? null : refuse(r.http === 400 ? 422 : r.http as ProposalRefusal['http'], r.code, r.message);
  }
}
