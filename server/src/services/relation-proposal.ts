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
 */
import { Service } from '@deepseek-ai/cordis';
import { svc } from '../context.ts';
import { db } from '../db.ts';
import type { GrantService } from './grant.ts';
import type { DepartmentService } from './department.ts';
import type { TeamService } from './team.ts';

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

/** 被拒时给页面的短说法（按代码） */
export const CONFIRM_TEXT: Readonly<Record<string, string>> = {
  owner_required: '只有属主能放行',
  business_confirm_required: '要管理层或接收部门的负责人确认',
  proposer_cannot_confirm: '提议的人不能自己确认，要另一位确认',
  state: '不在待确认',
};

export class RelationProposalService extends Service {
  constructor(ctx: any) {
    super(ctx, 'relationProposals');
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
    const p = this.get(id);
    if (!p) return refuse(404, 'proposal_missing', `提议 ${id} 不存在`);
    const no = this.confirmRefusal(p, actor, now);
    if (no) return no;
    const applied = this.apply(p, actor, now);
    if (applied) return applied;
    if (db.prepare("UPDATE relation_proposals SET status = 'approved', decided_by = ?, decided_by_principal = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(actor.by.slice(0, 256), actor.principal, now, id).changes !== 1) return refuse(409, 'state', `提议 ${id} 的状态变了`);
    return { ok: true, proposal: this.get(id)! };
  }

  /** 驳回或撤回：能确认的人、提的人、管理员（收紧方向，调用方核过是管理员时 admin 为真）都行 */
  reject(id: number, actor: ProposalActor, admin: boolean, reason: string, now: number): { ok: true; proposal: ProposalRow } | ProposalRefusal {
    const p = this.get(id);
    if (!p) return refuse(404, 'proposal_missing', `提议 ${id} 不存在`);
    if (p.status !== 'pending') return refuse(409, 'state', `提议 ${id} 现在是 ${p.status}，不能驳回`);
    const mine = p.proposed_by === actor.by || (!!actor.principal && p.proposed_by_principal === actor.principal);
    const confirmer = this.confirmRefusal(p, actor, now) === null || (p.kind === 'team-claim' && this.direct('team-claim', actor, p.department_id, now));
    if (!admin && !mine && !confirmer) return refuse(403, 'reject_not_allowed', '只有能确认的人、提议的人或管理员能驳回');
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
