/**
 * 授予域（阶段六 6b）：谁有哪个角色。一条授予记六样：主体、角色、范围、期限、授予人、理由。
 *
 * 状态只有五种，只能往前走（库里的触发器也管着）：draft 草稿 → pending 待核 → active 生效 → revoked 撤销 或 expired 过期；
 * 草稿和待核也能直接撤销（作废、驳回）。每一步在 grant_events 里记一行，只增不改。
 *
 * 规则在这里和库里，不靠页面：
 *   · 不能给自己授予：起草、提交、放行的人都不能是被授予的主体（库里有约束）；
 *   · 放行分三档（roles.ts 的 approvalOf）：管理员级的、带业务拍板的（管理层、部门负责人）只有属主能放行；
 *     带业务写的（部门成员、AI 员工）要业务侧：属主，或持有范围 * 的、全公司写和决定都有的授予的主体（管理层）；
 *     其余（普通员工、访客、只碰系统域的）管理员即可。
 *     业务侧在自己管的范围里也能放行（2026-11-16 属主定）：持生效的、带业务拍板的授予（管理层、部门负责人）的人，
 *     能看到并放行范围落在他那条授予范围内的「带业务写」和「给业务数据的普通档」授予——管理层（范围 *）管全部，
 *     部门负责人（dept:<部门>）只管同一个部门范围的。
 *     属主 = 本机命令行（L1：授予面上本机命令行算属主），或持有生效的 owner 授予的主体。管理口令对不到人，第二、三档放行不了；
 *   · 第二、三档：起草的人不能自己放行（属主除外），一律等另一位放行；
 *   · 不是人的主体要有在职的责任人（责任人是启用的人）才能被授予；
 *   · 决定类权限只给人：角色展开 includes 之后带决定类（按类别或按动作）的，不授予给不是人的主体；
 *   · 角色权限里写了范围的，要在授予的范围之内；部门范围（dept:<标识>）的部门要在部门表里；
 *   · 领域范围（area:<标识>，docs/domains-step1.md）：领域要在、没撤、是 active；领域的三个预设只能带 area: 范围。
 *     例外只有一项：领域还是 pending-lead（没有生效的负责人）时，属主（含本机命令行）可以起草覆盖负责人动作的授予，第一位负责人只能这时起草；
 *     放行第一位负责人时，同一个事务里领域改成 active；
 *   · 带 area: 范围、角色的权限覆盖定规范或负责人专有动作的（按权限覆盖判，不按角色名），只有属主能起草；放行本来就只有属主（带业务拍板）；
 *   · 到期自动失效：判断生效时现比期限；另有周期任务把到期的标成 expired。
 * 每一步都重新核对（主体、角色声明可能在两步之间变了）。
 *
 * 这一步只建结构，不接判定：现有的守卫不读这里，不改变任何人能做什么。判定在 6c。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { svc } from '../context.ts';
import type { AreaService } from './area.ts';
import { AREA_PRESETS, coversAreaPower, APPROVAL_TEXT, EXPIRY_REQUIRED_ROLES, NON_PERSON_ONLY_ROLES, approvalOf, grantsBusinessData, isBusinessSide, scopeOk, scopeWithin, type RoleView } from '../roles.ts';

export type GrantStatus = 'draft' | 'pending' | 'active' | 'revoked' | 'expired';
export type GrantRow = {
  id: number; principal_id: string; role: string; scope: string; expires_at: number | null; reason: string; status: GrantStatus;
  created_by: string; created_by_principal: string | null; approved_by: string | null; approved_by_principal: string | null; created_at: number; updated_at: number;
  /** manual 人起草的；migration 迁移出来的（阶段六 6c） */
  source: 'manual' | 'migration';
};
export type GrantEvent = { seq: number; grant_id: number; event: string; from_status: string | null; to_status: string; actor: string; actor_principal: string | null; reason: string; at: number };
/** 做这一步的是谁：留痕写法（cli、admin-token、odoo:<登录名>）、对到的主体（没有为 null）、是不是属主 */
/** 做这一步的是谁。admin：过了管理员门（口令、管理员登录、本机命令行）；为 false 是登录的人自己（L19：放行入口对登录的人放开），
 *  这时第一档（普通员工、访客这类，管理员即可放行的）不归他放行。不写当成过了管理员门（老的调用方都从管理员门进来） */
/** systemOnly：经手的管理员只是系统管理员（只持 admin 授予）——碰业务的授予不能经手，业务侧主体的授予不能收回 */
export type Actor = { by: string; principal: string | null; owner: boolean; admin?: boolean; systemOnly?: boolean };
export type Refusal = { ok: false; http: 400 | 403 | 404 | 409 | 422; code: string; message: string };
export type Result<T> = { ok: true } & T | Refusal;

const refuse = (http: Refusal['http'], code: string, message: string): Refusal => ({ ok: false, http, code, message });
const text = (v: string, max: number) => v.slice(0, max);
/**
 * 部门范围停止新发（docs/domains-step1.md 第六节，红线 dept-scope-closed）：新起草 dept:<部门> 范围的授予一律拒，不论角色。
 * 只拦「新起草」：停写前就在草稿、待核的照常提交、放行，已生效的过渡期照旧算（统筹 11-20 Q1），第 5 步统一撤。
 */
export function deptScopeClosed(scope: string): Refusal | null {
  return scope.startsWith('dept:') ? refuse(422, 'dept_scope_closed', '部门已停写，不再新发部门范围（dept:）的授予；改用领域范围（area:<领域>）') : null;
}
const VERB: Record<string, string> = { submit: '提交', approve: '放行', revoke: '撤销', expire: '标成过期' };
/** 放行被拒时给页面的短说法（按拒绝代码；没列的用拒绝本身的说法） */
const DENIED_TEXT: Record<string, string> = {
  owner_required: APPROVAL_TEXT.owner, business_approval_required: APPROVAL_TEXT.business, self_grant: '不能放行授给自己的',
  drafter_cannot_approve: '起草或提交的人不能自己放行，要另一位放行', expired: '已经过了期限', state: '不在待核', admin_required: '由管理员放行',
  system_admin_business_grant: '给业务数据的授予，系统管理员不能放行',
};

export class GrantService extends Service {
  private roleViews = new Map<string, RoleView>();

  constructor(ctx: any) {
    super(ctx, 'grants');
  }

  /** 启动时交进来已经校验过的角色声明（roles.ts 的 buildRoles） */
  setRoles(views: Map<string, RoleView>): void { this.roleViews = views; }
  roles(): RoleView[] { return [...this.roleViews.values()]; }
  /** 一个角色现在的展开（没有声明为 null） */
  roleView(id: string): RoleView | null { return this.roleViews.get(id) ?? null; }
  /** 起草前的各项核对（角色、范围、主体、不能授给自己），给别的服务在自己的事务里发授予之前用；能发返回 null */
  issueCheck(g: { principal_id: string; role: string; scope: string; expires_at?: number | null }, actor: Actor): Refusal | null {
    return this.check(g, actor);
  }

  get(id: number): (GrantRow & { events: GrantEvent[] }) | null {
    const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!row) return null;
    const events = db.prepare('SELECT * FROM grant_events WHERE grant_id = ? ORDER BY seq').all(id) as GrantEvent[];
    return { ...row, events };
  }

  list(filter: { principal?: string; status?: GrantStatus; source?: 'manual' | 'migration' } = {}): GrantRow[] {
    const where: string[] = [], args: string[] = [];
    if (filter.principal) { where.push('principal_id = ?'); args.push(filter.principal); }
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    if (filter.source) { where.push('source = ?'); args.push(filter.source); }
    return db.prepare(`SELECT * FROM grants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`).all(...args) as GrantRow[];
  }

  /** 现在持有这些角色里任一个生效授予的主体（去重；不限条数） */
  activeHolders(roles: string[], now = Date.now()): string[] {
    if (roles.length === 0) return [];
    return (db.prepare(`SELECT DISTINCT principal_id FROM grants WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?) AND role IN (${roles.map(() => '?').join(', ')}) ORDER BY principal_id`).all(now, ...roles) as { principal_id: string }[]).map((r) => r.principal_id);
  }

  /** 这个主体现在生效的授予（现比期限，不等周期任务） */
  activeFor(principal: string, now = Date.now()): GrantRow[] {
    return db.prepare("SELECT * FROM grants WHERE principal_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY id").all(principal, now) as GrantRow[];
  }

  /**
   * 站内管理员（docs/local-accounts.md 第 5 节）：持有生效中的、范围是 * 的 owner 或 admin 授予，回是哪一种（都有算 owner），都没有回 null。
   * 迁移来的 admin 授予不算（见下）。
   *   owner：完整的管理员；admin：系统管理员——管系统，不看业务数据（属主 2026-11-16 定）。
   * 认人时现查（身份服务每次认出人都问一次，不进缓存）：授予撤销、到期，下一个请求就不再是管理员。
   */
  heldAdmin(principal: string | null, now = Date.now()): 'owner' | 'admin' | null {
    if (!principal) return null;
    // 迁移来的 admin 授予（source=migration，以前判定比对开着时按「身份来源说是管理员」补的）不算：
    // 管理员只认授予（Odoo 下线后身份来源不再能说谁是管理员），这类旧授予由管理员核过之后另发正式授予；整批撤销见 revoke-migration
    const held = this.activeFor(principal, now).filter((g) => g.scope === '*' && (g.role === 'owner' || (g.role === 'admin' && g.source !== 'migration')));
    return held.some((g) => g.role === 'owner') ? 'owner' : held.length ? 'admin' : null;
  }

  /** 这个主体是不是业务侧：持有范围 * 的生效授予，角色全公司的写和决定都有（管理层；属主另由 Actor.owner 认） */
  isBusinessSide(principal: string | null, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => g.scope === '*' && isBusinessSide(this.roleViews.get(g.role)?.closure ?? []));
  }

  /** 这个主体在这个范围（* 或 dept:<部门>）有没有生效的、带业务拍板的授予（部门负责人、管理层、属主这类） */
  decidesBusinessIn(principal: string | null, scope: string, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => (g.scope === '*' || g.scope === scope) && !!this.roleViews.get(g.role)?.businessDecide);
  }

  /**
   * 业务侧的主体：持有 owner 授予，或者持有任何给业务数据的授予（业务域的读写决定，范围不论；见 roles.ts 的 grantsBusinessData）——
   * 生效的、草稿、待放行的都算（还没放行的，放行之后就是业务侧；先动了手再等放行，等于拿到业务）。
   * 系统管理员不能对这样的主体动手（重置密码、绑定解绑、停用恢复、收回授予，见 admin-tier.ts）
   */
  businessProtected(principal: string | null, now = Date.now()): boolean {
    if (!principal) return false;
    const rows = db.prepare("SELECT role FROM grants WHERE principal_id = ? AND status IN ('draft', 'pending', 'active') AND (expires_at IS NULL OR expires_at > ?)").all(principal, now) as { role: string }[];
    return rows.some((g) => g.role === 'owner' || this.businessData(g.role));
  }

  /** 认管理员时不算的那些：迁移来的、生效中的 admin 授予（见 heldAdmin）有几条。启动时记一行，授予列表上每行标 ignored_for_admin */
  migrationAdminsIgnored(now = Date.now()): number {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM grants WHERE role = 'admin' AND source = 'migration' AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)").get(now) as { n: number }).n);
  }

  /** 这个角色给不给业务数据（owner、没声明的都算给） */
  businessData(role: string): boolean {
    const view = this.roleViews.get(role);
    return role === 'owner' || !view || grantsBusinessData(view.closure);
  }

  /**
   * 两人制（docs/local-accounts.md 第 5 节）：给业务数据的授予，系统管理员可以起草、提交（日常开新人要用），不能放行——
   * 放行只给属主、完整的管理员、业务侧的人，而且起草、提交的人不能自己放行（见 approvalRefusal）。给自己控制的别的账号开业务这条路就走不通
   */
  private systemAdminRefusal(role: string, actor: Actor): Refusal | null {
    if (!actor.systemOnly) return null;
    return this.businessData(role) ? refuse(403, 'system_admin_business_grant', `角色 ${role} 给业务数据：系统管理员不能放行，要属主、完整的管理员或业务侧的人放行`) : null;
  }

  /** 这条授予是谁提交的（最近一次 submit 那一行的经手人） */
  private submitterOf(id: number): { by: string; principal: string | null } | null {
    const r = db.prepare("SELECT actor, actor_principal FROM grant_events WHERE grant_id = ? AND event = 'submit' ORDER BY seq DESC LIMIT 1").get(id) as { actor: string; actor_principal: string | null } | undefined;
    return r ? { by: r.actor, principal: r.actor_principal } : null;
  }

  /** 这个主体是不是属主：持有生效的 owner 授予 */
  isOwner(principal: string | null, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => g.role === 'owner');
  }

  /** 带 area: 范围、角色覆盖定规范或负责人专有动作时，回覆盖的是什么（给拒绝的说法）；否则 null */
  private areaOwnerOnly(role: string, scope: string): string | null {
    const view = this.roleViews.get(role);
    if (!view || !scope.startsWith('area:')) return null;
    const c = coversAreaPower(view.closure);
    return c.spec && c.lead ? '定规范和负责人的动作' : c.spec ? '定规范' : c.lead ? '负责人的动作' : null;
  }

  /** 每一步都复核角色、范围、主体；自授仅允许有效属主兼任领域负责人 */
  private check(g: { principal_id: string; role: string; scope: string; expires_at?: number | null }, actor: Actor, now = Date.now()): Refusal | null {
    const role = this.roleViews.get(g.role);
    if (!role) return refuse(422, 'role_unknown', `角色 ${g.role} 没有声明`);
    // 访客必须有期限
    if (EXPIRY_REQUIRED_ROLES.includes(g.role) && (g.expires_at === null || g.expires_at === undefined)) return refuse(422, 'expiry_required', `角色 ${g.role}（访客）的授予必须有期限`);
    if (!scopeOk(g.scope)) return refuse(400, 'scope_invalid', '范围写法不对：*、domain:、dept:、bench:、sop:、tool:、self、object:');
    // 部门范围只认部门表里有的标识（只有一套部门名）
    if (g.scope.startsWith('dept:') && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(g.scope.slice(5))) return refuse(422, 'department_unknown', `部门 ${g.scope.slice(5)} 不存在，先在部门里建好`);
    // 领域的三个预设只能带 area: 范围；area: 范围的领域要在、没撤、是 active（pending-lead 只许属主起草第一位负责人）
    if (AREA_PRESETS.includes(g.role) && !g.scope.startsWith('area:')) return refuse(422, 'area_scope_required', `角色 ${g.role} 只能带领域范围（area:<领域>）授予`);
    if (g.scope.startsWith('area:')) {
      const area = svc<AreaService>('areas').get(g.scope.slice(5));
      if (!area) return refuse(422, 'area_unknown', `领域 ${g.scope.slice(5)} 不存在，先建好`);
      if (area.status === 'retired') return refuse(422, 'area_retired', `领域 ${area.id} 已经撤了`);
      if (area.status === 'pending-lead' && !(actor.owner && coversAreaPower(role.closure).lead)) return refuse(409, 'area_pending_lead', `领域 ${area.id} 还没有负责人：只有属主能先给它起草负责人，别的授予等负责人生效之后再起草`);
    }
    for (const p of role.closure) if (!scopeWithin(p.scope, g.scope)) return refuse(422, 'scope_wider', `角色 ${g.role} 里有范围 ${p.scope} 的权限，不在授予的范围 ${g.scope} 之内`);
    const p = db.prepare('SELECT id, kind, status, owner FROM principals WHERE id = ?').get(g.principal_id) as { id: string; kind: string; status: string; owner: string } | undefined;
    if (!p) return refuse(404, 'principal_missing', `主体 ${g.principal_id} 不存在`);
    if (p.status !== 'active') return refuse(422, 'principal_disabled', `主体 ${g.principal_id} 已停用`);
    // AI 员工只授予非人主体（席位）；人不拿这个预设
    if (NON_PERSON_ONLY_ROLES.includes(g.role) && p.kind === 'person') return refuse(422, 'non_person_only', `角色 ${g.role}（AI 员工）只授予席位这类非人主体，不授予人`);
    if (p.kind !== 'person') {
      const o = p.owner ? db.prepare('SELECT kind, status FROM principals WHERE id = ?').get(p.owner) as { kind: string; status: string } | undefined : undefined;
      if (!o || o.kind !== 'person' || o.status !== 'active') return refuse(422, 'no_responsible', `${g.principal_id} 不是人，要有在职的责任人才能被授予`);
      if (role.decides) return refuse(422, 'decide_non_person', `角色 ${g.role} 带决定类权限，决定只认人，不授予给 ${g.principal_id}`);
    }
    if (actor.principal === g.principal_id && (g.role !== 'area-lead' || p.kind !== 'person' || this.heldAdmin(actor.principal, now) !== 'owner')) {
      return refuse(403, 'self_grant', '不能给自己授予');
    }
    return null;
  }

  /** 状态变化和留痕同一个事务；状态没对上（并发里别人先动了）回 409 */
  private move(id: number, from: GrantStatus[], to: GrantStatus, event: string, actor: Actor, reason: string, now: number, approve = false): Result<{ grant: GrantRow }> {
    db.exec('BEGIN IMMEDIATE');
    try {
      const cur = db.prepare('SELECT status FROM grants WHERE id = ?').get(id) as { status: GrantStatus } | undefined;
      if (!cur || !from.includes(cur.status)) { db.exec('ROLLBACK'); return refuse(409, 'state', `授予 ${id} 现在是 ${cur?.status ?? '不存在'}，不能${VERB[event] ?? event}`); }
      // 领域至少要有一位负责人：收回生效的负责人授予时，在这个写事务里数剩下的（BEGIN IMMEDIATE 已经拿到写锁，两个并发收回只成一个）。
      // 撤领域走 revokeScopeInTx，不经这里；到期（expire）收不住，退回 pending-lead 由下面的重算做
      const leadArea = this.leadAreaOf(id);
      if (leadArea && cur.status === 'active' && to === 'revoked' && this.activeLeadCount(leadArea, now, id) === 0) {
        db.exec('ROLLBACK');
        return refuse(409, 'area_last_lead', `领域 ${leadArea} 至少要有一位负责人：先给它放行另一位负责人，再收回这一位（属主撤领域时会一并收回）`);
      }
      const sql = approve
        ? 'UPDATE grants SET status = ?, approved_by = ?, approved_by_principal = ?, updated_at = ? WHERE id = ? AND status = ?'
        : 'UPDATE grants SET status = ?, updated_at = ? WHERE id = ? AND status = ?';
      const args = approve ? [to, actor.by, actor.principal, now, id, cur.status] : [to, now, id, cur.status];
      if (db.prepare(sql).run(...args).changes !== 1) { db.exec('ROLLBACK'); return refuse(409, 'state', `授予 ${id} 的状态变了`); }
      db.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, event, cur.status, to, actor.by, actor.principal, text(reason, 500), now);
      // 领域负责人的授予生效、收回、到期：同一个事务里重算领域状态（pending-lead ↔ active，留痕写原因）
      if (leadArea && (to === 'active' || cur.status === 'active')) {
        const why = to === 'active' ? `负责人授予 ${id} 放行` : to === 'expired' ? `负责人授予 ${id} 到期` : `负责人授予 ${id} 收回${reason.trim() ? `：${reason.trim()}` : ''}`;
        svc<AreaService>('areas').reconcileLead(leadArea, why, actor, now);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
      throw e;
    }
    return { ok: true, grant: db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow };
  }

  /** 这条授予是不是某个领域的负责人授予（范围 area:<领域>、角色覆盖负责人专有动作）：是回领域标识 */
  private leadAreaOf(id: number): string | null {
    const g = db.prepare('SELECT role, scope FROM grants WHERE id = ?').get(id) as { role: string; scope: string } | undefined;
    const view = g ? this.roleViews.get(g.role) : undefined;
    return g && view && g.scope.startsWith('area:') && coversAreaPower(view.closure).lead ? g.scope.slice(5) : null;
  }

  /**
   * 这个领域现在有几位生效的负责人：授予生效、没过期、范围正好是 area:<领域>、角色覆盖负责人专有动作，被授予的是启用的人。
   * except：不算这一条（收回它之前问「剩下几位」）。领域服务的 reconcileLead、收回时的「至少一位」都问这一处
   */
  activeLeadCount(area: string, now = Date.now(), except: number | null = null): number {
    const rows = db.prepare(`/* area-last-lead */ SELECT g.id, g.role FROM grants g JOIN principals p ON p.id = g.principal_id
      WHERE g.scope = ? AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ?) AND p.kind = 'person' AND p.status = 'active'`).all(`area:${area}`, now) as { id: number; role: string }[];
    return rows.filter((r) => Number(r.id) !== except && (() => { const v = this.roleViews.get(r.role); return !!v && coversAreaPower(v.closure).lead; })()).length;
  }

  /**
   * 一个领域的负责人（给页面看）：范围正好是 area:<领域>、角色覆盖负责人专有动作的授予里，生效的（active）和等放行的（pending：草稿、待核）。
   * 生效但被授予的人已停用的标 disabled（不算生效的负责人，见 activeLeadCount）。显示名取主体表
   */
  leadsOf(area: string, now = Date.now()): { grant: number; principal: string; display_name: string; status: 'active' | 'pending' | 'disabled' }[] {
    const rows = db.prepare(`SELECT g.id, g.role, g.principal_id, g.status, g.expires_at, COALESCE(p.display_name, '') AS display_name, COALESCE(p.status, '') AS p_status
      FROM grants g LEFT JOIN principals p ON p.id = g.principal_id WHERE g.scope = ? AND g.status IN ('draft', 'pending', 'active') ORDER BY g.id`).all(`area:${area}`) as
      { id: number; role: string; principal_id: string; status: GrantStatus; expires_at: number | null; display_name: string; p_status: string }[];
    return rows.filter((r) => { const v = this.roleViews.get(r.role); return !!v && coversAreaPower(v.closure).lead && (r.expires_at === null || r.expires_at > now); })
      .map((r) => ({ grant: Number(r.id), principal: r.principal_id, display_name: r.display_name, status: r.status !== 'active' ? 'pending' as const : r.p_status === 'active' ? 'active' as const : 'disabled' as const }));
  }

  /** 这个人持有生效负责人授予的领域（停用、恢复这个人之后重算用） */
  leadAreasHeldBy(principal: string, now = Date.now()): string[] {
    return [...new Set(this.activeFor(principal, now).filter((g) => g.scope.startsWith('area:') && (() => { const v = this.roleViews.get(g.role); return !!v && coversAreaPower(v.closure).lead; })()).map((g) => g.scope.slice(5)))];
  }

  /**
   * 在调用方已经开着的写事务里起草一条授予，submit 为真时接着提交（待核），每步记一行痕；自己不开事务，没开着就抛错。
   * 核对和起草、提交一样（角色、范围、主体、不给自己，领域范围只有属主起草定规范和负责人的）。部门迁成领域时用（services/area.ts 的 migrateDepartments）
   */
  draftInTx(input: { principal: string; role: string; scope: string; reason: string }, actor: Actor, now: number, submit: boolean): Result<{ id: number }> {
    if (!db.isTransaction) throw new Error('draftInTx 要在调用方的写事务里用');
    const closed = deptScopeClosed(input.scope);
    if (closed) return closed;
    const bad = this.check({ principal_id: input.principal, role: input.role, scope: input.scope, expires_at: null }, actor, now);
    if (bad) return bad;
    const ownerOnly = this.areaOwnerOnly(input.role, input.scope);
    if (ownerOnly && !actor.owner) return refuse(403, 'area_owner_only', `角色 ${input.role} 在领域范围里覆盖${ownerOnly}，只有属主能起草`);
    const id = Number(db.prepare('INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_by_principal, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(input.principal, input.role, input.scope, text(input.reason, 500), actor.by, actor.principal, now, now).lastInsertRowid);
    const ev = db.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ev.run(id, 'draft', null, 'draft', actor.by, actor.principal, text(input.reason, 500), now);
    if (submit) {
      db.prepare("UPDATE grants SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft'").run(now, id);
      ev.run(id, 'submit', 'draft', 'pending', actor.by, actor.principal, '', now);
    }
    return { ok: true, id };
  }

  /**
   * 迁移去重（docs/domains-step1.md 第二节第 3 小节，统筹 11-20 裁定）：按「人 + 角色 + 范围」看，不看理由。
   *   · 'already_open'：已经有一条还没结束的（草稿、待核、生效），不管是手工起草的还是迁移起草的；
   *   · 'refused_before'：迁移起草过、后来被收回或否决了（属主的否决不能因为再跑一次迁移就被推翻）；
   *   · null：都没有，可以起草。
   * migrateReason 是迁移起草时写的理由，用来认出「迁移起草过」
   */
  /** 这个人、角色、范围下还没结束（草稿、待核、生效）的那条授予的编号；去重命中 already_open 时给调用方指回去 */
  openGrantId(principal: string, role: string, scope: string): number | null {
    const r = db.prepare("SELECT id FROM grants WHERE principal_id = ? AND role = ? AND scope = ? AND status IN ('draft', 'pending', 'active') ORDER BY id LIMIT 1").get(principal, role, scope) as { id: number } | undefined;
    return r?.id ?? null;
  }

  migrationHandled(principal: string, role: string, scope: string, migrateReason: string): 'already_open' | 'refused_before' | null {
    if (db.prepare("SELECT 1 FROM grants WHERE principal_id = ? AND role = ? AND scope = ? AND status IN ('draft', 'pending', 'active')").get(principal, role, scope)) return 'already_open';
    if (db.prepare("SELECT 1 FROM grants WHERE principal_id = ? AND role = ? AND scope = ? AND reason = ? AND status = 'revoked'").get(principal, role, scope, migrateReason)) return 'refused_before';
    return null;
  }

  /** 起草 */
  draft(input: { principal: string; role: string; scope: string; expiresAt: number | null; reason: string }, actor: Actor, now = Date.now()): Result<{ grant: GrantRow }> {
    if (input.expiresAt !== null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) return refuse(400, 'expires_invalid', 'expires_at 要是将来的时刻（毫秒），或者不写');
    if (!input.reason.trim()) return refuse(400, 'reason_required', '要写理由');
    const closed = deptScopeClosed(input.scope);
    if (closed) return closed;
    const bad = this.check({ principal_id: input.principal, role: input.role, scope: input.scope, expires_at: input.expiresAt }, actor, now);
    if (bad) return bad;
    const ownerOnly = this.areaOwnerOnly(input.role, input.scope);
    if (ownerOnly && !actor.owner) return refuse(403, 'area_owner_only', `角色 ${input.role} 在领域范围里覆盖${ownerOnly}，只有属主能起草`);
    db.exec('BEGIN IMMEDIATE');
    let id: number;
    try {
      id = Number(db.prepare('INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_by_principal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.principal, input.role, input.scope, input.expiresAt, text(input.reason, 500), actor.by, actor.principal, now, now).lastInsertRowid);
      db.prepare("INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, 'draft', NULL, 'draft', ?, ?, ?, ?)")
        .run(id, actor.by, actor.principal, text(input.reason, 500), now);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
      throw e;
    }
    return { ok: true, grant: db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow };
  }

  /** 提交待核 */
  submit(id: number, actor: Actor, now = Date.now()): Result<{ grant: GrantRow }> {
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!g) return refuse(404, 'grant_missing', `授予 ${id} 不存在`);
    const bad = this.check(g, actor, now);
    if (bad) return bad;
    return this.move(id, ['draft'], 'pending', 'submit', actor, '', now);
  }

  /**
   * 这个人能不能放行这条授予。放行接口和授予列表的 can_approve 共用这一处，页面不自己判。
   * 顺序：各项核对（含不能放行授给自己的）→ 三档放行人 → 第二三档自己起草的 → 期限 → 状态要是待核。
   */
  approvalRefusal(g: GrantRow, actor: Actor, now = Date.now()): Refusal | null {
    const bad = this.check(g, actor, now);
    if (bad) return bad;
    const view = this.roleViews.get(g.role);
    const tier = view ? approvalOf(view) : 'owner';
    // 管这个范围的业务侧（管理层、本部门的部门负责人）：给业务数据的普通档、带业务写的，都归他放行
    const managesIt = () => this.decidesBusinessIn(actor.principal, g.scope, now);
    if (tier === 'admin' && !actor.owner && actor.admin === false && !(this.businessData(g.role) && managesIt())) return refuse(403, 'admin_required', `角色 ${g.role} 由管理员放行`);
    if (tier === 'owner' && !actor.owner) return refuse(403, 'owner_required', `角色 ${g.role} ${view?.businessDecide ? '带业务的拍板' : '是管理员级的'}，${APPROVAL_TEXT.owner}`);
    if (tier === 'business' && !actor.owner && !this.isBusinessSide(actor.principal, now) && !managesIt()) return refuse(403, 'business_approval_required', `角色 ${g.role} 带业务的写，${APPROVAL_TEXT.business}`);
    const sys = this.systemAdminRefusal(g.role, actor);
    if (sys) return sys;
    // 起草、提交的人不能自己放行：第二、三档，和一切给业务数据的授予（第一档的普通员工这类也算，两人制）；属主不在此限
    const sub = this.submitterOf(g.id);
    const mine = g.created_by === actor.by || (!!actor.principal && g.created_by_principal === actor.principal)
      || (!!sub && (sub.by === actor.by || (!!actor.principal && sub.principal === actor.principal)));
    if ((tier !== 'admin' || this.businessData(g.role)) && !actor.owner && mine) {
      return refuse(403, 'drafter_cannot_approve', `授予 ${g.id} 是你起草或提交的，角色 ${g.role} 要另一位放行`);
    }
    if (g.expires_at !== null && g.expires_at <= now) return refuse(409, 'expired', `授予 ${g.id} 已经过了期限，不能生效`);
    if (g.status !== 'pending') return refuse(409, 'state', `授予 ${g.id} 现在是 ${g.status}，不能放行`);
    return null;
  }

  /** 给页面的：当前这个人能不能放行，不能时的代码和一句说法（说法短，页面原样显示） */
  approvability(g: GrantRow, actor: Actor, now = Date.now()): { can_approve: boolean; approve_denied: string | null; approve_denied_text: string | null } {
    const r = this.approvalRefusal(g, actor, now);
    if (!r) return { can_approve: true, approve_denied: null, approve_denied_text: null };
    const text = DENIED_TEXT[r.code] ?? r.message;
    return { can_approve: false, approve_denied: r.code, approve_denied_text: text };
  }

  /**
   * 放行：按三档认放行人（见文件头）；第二、三档起草的人不能自己放行；过了期限的不能生效。
   * readable：这个人读不读得到这一条（管理员都读得到；登录的人只读得到自己能放行的，和列表、单条同一处）。
   * 读不到的，任何失败都回和这一条不存在时一样的 404，不带档位、角色、状态
   */
  approve(id: number, actor: Actor, now = Date.now()): Result<{ grant: GrantRow }> {
    const missing = () => refuse(404, 'grant_missing', `授予 ${id} 不存在`);
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!g) return missing();
    const bad = this.approvalRefusal(g, actor, now);
    if (bad && actor.admin === false) return missing();
    if (bad && bad.code !== 'state') return bad;
    return this.move(id, ['pending'], 'active', 'approve', actor, '', now, true);
  }

  /** 撤销：草稿作废、待核驳回、生效的收回。要写理由 */
  revoke(id: number, actor: Actor, reason: string, now = Date.now()): Result<{ grant: GrantRow }> {
    if (!reason.trim()) return refuse(400, 'reason_required', '撤销要写理由');
    const g = db.prepare('SELECT principal_id FROM grants WHERE id = ?').get(id) as { principal_id: string } | undefined;
    if (!g) return refuse(404, 'grant_missing', `授予 ${id} 不存在`);
    // 系统管理员不能收回业务侧主体（持 owner 或碰业务的授予）的授予
    if (actor.systemOnly && this.businessProtected(g.principal_id, now)) return refuse(403, 'system_admin_business_principal', '这个人持有业务授予或属主授予：系统管理员不能收回他的授予，要属主或完整的管理员');
    return this.move(id, ['draft', 'pending', 'active'], 'revoked', 'revoke', actor, reason, now);
  }

  /**
   * 迁移（阶段六 6c，只在比对用的实例上跑）：给一个启用的人一条生效的授予，来源记 migration，放行人记 system:migration（系统的属主级动作）。
   * 同一个人、同一个角色迁移过一次（不管后来撤没撤）就不再迁：可以重复跑，结果相同；人撤掉的不会被迁移补回来。
   * 起草、提交、放行三步照样各记一行痕。返回新建的授予，没建为 null。
   */
  migrate(principal: string, role: string, reason: string, now = Date.now()): GrantRow | null {
    if (!this.roleViews.has(role)) return null;
    const p = db.prepare('SELECT kind, status FROM principals WHERE id = ?').get(principal) as { kind: string; status: string } | undefined;
    if (!p || p.kind !== 'person' || p.status !== 'active') return null;
    const actor = { by: 'system:migration', principal: null };
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare("SELECT 1 FROM grants WHERE principal_id = ? AND role = ? AND source = 'migration'").get(principal, role)) { db.exec('ROLLBACK'); return null; }
      const id = Number(db.prepare("INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_by_principal, created_at, updated_at, source) VALUES (?, ?, '*', NULL, ?, ?, NULL, ?, ?, 'migration')")
        .run(principal, role, text(reason, 500), actor.by, now, now).lastInsertRowid);
      const ev = db.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
      ev.run(id, 'draft', null, 'draft', actor.by, text(reason, 500), now);
      db.prepare("UPDATE grants SET status = 'pending', updated_at = ? WHERE id = ?").run(now, id);
      ev.run(id, 'submit', 'draft', 'pending', actor.by, '', now);
      db.prepare("UPDATE grants SET status = 'active', approved_by = ?, updated_at = ? WHERE id = ?").run(actor.by, now, id);
      ev.run(id, 'approve', 'pending', 'active', actor.by, '', now);
      db.exec('COMMIT');
      return db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
      throw e;
    }
  }

  /**
   * 范围正好是 scope 的、没结束的授予（草稿、待核、生效）整批撤销，每条记一行痕，返回撤了的授予编号。
   * 只在调用方已经开着的写事务里用（撤领域：和领域改成 retired 同一个事务，docs/domains-step1.md 统筹裁定 2），自己不开事务；没开着就抛错。
   */
  revokeScopeInTx(scope: string, actor: Actor, reason: string, now: number): number[] {
    if (!db.isTransaction) throw new Error('revokeScopeInTx 要在调用方的写事务里用');
    if (!reason.trim()) throw new Error('revokeScopeInTx 要写理由');
    const rows = db.prepare("SELECT id, status FROM grants WHERE scope = ? AND status IN ('draft','pending','active') ORDER BY id").all(scope) as { id: number; status: GrantStatus }[];
    const ev = db.prepare("INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, 'revoke', ?, 'revoked', ?, ?, ?, ?)");
    for (const r of rows) {
      if (db.prepare("UPDATE grants SET status = 'revoked', updated_at = ? WHERE id = ? AND status = ?").run(now, r.id, r.status).changes !== 1) throw new Error(`授予 ${r.id} 的状态变了`);
      ev.run(r.id, r.status, actor.by, actor.principal, text(reason, 500), now);
    }
    return rows.map((r) => Number(r.id));
  }

  /** 迁移出来、还没撤销或过期的授予整批撤销（要写理由），返回撤了几条 */
  revokeMigrated(actor: Actor, reason: string, now = Date.now()): Result<{ revoked: number }> {
    if (!reason.trim()) return refuse(400, 'reason_required', '撤销要写理由');
    const ids = db.prepare("SELECT id FROM grants WHERE source = 'migration' AND status IN ('draft','pending','active') ORDER BY id").all() as { id: number }[];
    let revoked = 0;
    for (const { id } of ids) if (this.move(id, ['draft', 'pending', 'active'], 'revoked', 'revoke', actor, reason, now).ok) revoked++;
    return { ok: true, revoked };
  }

  /** 把到期的生效授予标成过期，返回标了几条（周期任务调；判断生效时本来就现比期限） */
  expireDue(now = Date.now()): number {
    const due = db.prepare("SELECT id FROM grants WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as { id: number }[];
    let n = 0;
    for (const { id } of due) if (this.move(id, ['active'], 'expired', 'expire', { by: 'system:expiry', principal: null, owner: false }, '', now).ok) n++;
    return n;
  }
}
