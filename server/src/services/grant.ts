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
 *     属主 = 本机命令行（L1：授予面上本机命令行算属主），或持有生效的 owner 授予的主体。管理口令对不到人，第二、三档放行不了；
 *   · 第二、三档：起草的人不能自己放行（属主除外），一律等另一位放行；
 *   · 不是人的主体要有在职的责任人（责任人是启用的人）才能被授予；
 *   · 决定类权限只给人：角色展开 includes 之后带决定类（按类别或按动作）的，不授予给不是人的主体；
 *   · 角色权限里写了范围的，要在授予的范围之内；部门范围（dept:<标识>）的部门要在部门表里；
 *   · 到期自动失效：判断生效时现比期限；另有周期任务把到期的标成 expired。
 * 每一步都重新核对（主体、角色声明可能在两步之间变了）。
 *
 * 这一步只建结构，不接判定：现有的守卫不读这里，不改变任何人能做什么。判定在 6c。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { APPROVAL_TEXT, EXPIRY_REQUIRED_ROLES, NON_PERSON_ONLY_ROLES, approvalOf, isBusinessSide, scopeOk, scopeWithin, type RoleView } from '../roles.ts';

export type GrantStatus = 'draft' | 'pending' | 'active' | 'revoked' | 'expired';
export type GrantRow = {
  id: number; principal_id: string; role: string; scope: string; expires_at: number | null; reason: string; status: GrantStatus;
  created_by: string; created_by_principal: string | null; approved_by: string | null; approved_by_principal: string | null; created_at: number; updated_at: number;
  /** manual 人起草的；migration 迁移出来的（阶段六 6c） */
  source: 'manual' | 'migration';
};
export type GrantEvent = { seq: number; grant_id: number; event: string; from_status: string | null; to_status: string; actor: string; actor_principal: string | null; reason: string; at: number };
/** 做这一步的是谁：留痕写法（cli、admin-token、odoo:<登录名>）、对到的主体（没有为 null）、是不是属主 */
export type Actor = { by: string; principal: string | null; owner: boolean };
export type Refusal = { ok: false; http: 400 | 403 | 404 | 409 | 422; code: string; message: string };
export type Result<T> = { ok: true } & T | Refusal;

const refuse = (http: Refusal['http'], code: string, message: string): Refusal => ({ ok: false, http, code, message });
const text = (v: string, max: number) => v.slice(0, max);
const VERB: Record<string, string> = { submit: '提交', approve: '放行', revoke: '撤销', expire: '标成过期' };
/** 放行被拒时给页面的短说法（按拒绝代码；没列的用拒绝本身的说法） */
const DENIED_TEXT: Record<string, string> = {
  owner_required: APPROVAL_TEXT.owner, business_approval_required: APPROVAL_TEXT.business, self_grant: '不能放行授给自己的',
  drafter_cannot_approve: '起草的人不能自己放行，要另一位放行', expired: '已经过了期限', state: '不在待核',
};

export class GrantService extends Service {
  private roleViews = new Map<string, RoleView>();

  constructor(ctx: any) {
    super(ctx, 'grants');
  }

  /** 启动时交进来已经校验过的角色声明（roles.ts 的 buildRoles） */
  setRoles(views: Map<string, RoleView>): void { this.roleViews = views; }
  roles(): RoleView[] { return [...this.roleViews.values()]; }

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

  /** 这个主体是不是业务侧：持有范围 * 的生效授予，角色全公司的写和决定都有（管理层；属主另由 Actor.owner 认） */
  isBusinessSide(principal: string | null, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => g.scope === '*' && isBusinessSide(this.roleViews.get(g.role)?.closure ?? []));
  }

  /** 这个主体在这个范围（* 或 dept:<部门>）有没有生效的、带业务拍板的授予（部门负责人、管理层、属主这类） */
  decidesBusinessIn(principal: string | null, scope: string, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => (g.scope === '*' || g.scope === scope) && !!this.roleViews.get(g.role)?.businessDecide);
  }

  /** 这个主体是不是属主：持有生效的 owner 授予 */
  isOwner(principal: string | null, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => g.role === 'owner');
  }

  /** 每一步都要过的核对：角色在、范围合规、主体在且启用、不是人的有在职责任人、决定类不给不是人的、不给自己 */
  private check(g: { principal_id: string; role: string; scope: string; expires_at?: number | null }, actor: Actor): Refusal | null {
    const role = this.roleViews.get(g.role);
    if (!role) return refuse(422, 'role_unknown', `角色 ${g.role} 没有声明`);
    // 访客必须有期限
    if (EXPIRY_REQUIRED_ROLES.includes(g.role) && (g.expires_at === null || g.expires_at === undefined)) return refuse(422, 'expiry_required', `角色 ${g.role}（访客）的授予必须有期限`);
    if (!scopeOk(g.scope)) return refuse(400, 'scope_invalid', '范围写法不对：*、domain:、dept:、bench:、sop:、tool:、self、object:');
    // 部门范围只认部门表里有的标识（只有一套部门名）
    if (g.scope.startsWith('dept:') && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(g.scope.slice(5))) return refuse(422, 'department_unknown', `部门 ${g.scope.slice(5)} 不存在，先在部门里建好`);
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
    if (actor.principal && actor.principal === g.principal_id) return refuse(403, 'self_grant', '不能给自己授予');
    return null;
  }

  /** 状态变化和留痕同一个事务；状态没对上（并发里别人先动了）回 409 */
  private move(id: number, from: GrantStatus[], to: GrantStatus, event: string, actor: Actor, reason: string, now: number, approve = false): Result<{ grant: GrantRow }> {
    db.exec('BEGIN IMMEDIATE');
    try {
      const cur = db.prepare('SELECT status FROM grants WHERE id = ?').get(id) as { status: GrantStatus } | undefined;
      if (!cur || !from.includes(cur.status)) { db.exec('ROLLBACK'); return refuse(409, 'state', `授予 ${id} 现在是 ${cur?.status ?? '不存在'}，不能${VERB[event] ?? event}`); }
      const sql = approve
        ? 'UPDATE grants SET status = ?, approved_by = ?, approved_by_principal = ?, updated_at = ? WHERE id = ? AND status = ?'
        : 'UPDATE grants SET status = ?, updated_at = ? WHERE id = ? AND status = ?';
      const args = approve ? [to, actor.by, actor.principal, now, id, cur.status] : [to, now, id, cur.status];
      if (db.prepare(sql).run(...args).changes !== 1) { db.exec('ROLLBACK'); return refuse(409, 'state', `授予 ${id} 的状态变了`); }
      db.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, event, cur.status, to, actor.by, actor.principal, text(reason, 500), now);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
      throw e;
    }
    return { ok: true, grant: db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow };
  }

  /** 起草 */
  draft(input: { principal: string; role: string; scope: string; expiresAt: number | null; reason: string }, actor: Actor, now = Date.now()): Result<{ grant: GrantRow }> {
    if (input.expiresAt !== null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) return refuse(400, 'expires_invalid', 'expires_at 要是将来的时刻（毫秒），或者不写');
    if (!input.reason.trim()) return refuse(400, 'reason_required', '要写理由');
    const bad = this.check({ principal_id: input.principal, role: input.role, scope: input.scope, expires_at: input.expiresAt }, actor);
    if (bad) return bad;
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
    const bad = this.check(g, actor);
    if (bad) return bad;
    return this.move(id, ['draft'], 'pending', 'submit', actor, '', now);
  }

  /**
   * 这个人能不能放行这条授予。放行接口和授予列表的 can_approve 共用这一处，页面不自己判。
   * 顺序：各项核对（含不能放行授给自己的）→ 三档放行人 → 第二三档自己起草的 → 期限 → 状态要是待核。
   */
  approvalRefusal(g: GrantRow, actor: Actor, now = Date.now()): Refusal | null {
    const bad = this.check(g, actor);
    if (bad) return bad;
    const view = this.roleViews.get(g.role);
    const tier = view ? approvalOf(view) : 'owner';
    if (tier === 'owner' && !actor.owner) return refuse(403, 'owner_required', `角色 ${g.role} ${view?.adminLevel ? '是管理员级的' : '带业务的拍板'}，${APPROVAL_TEXT.owner}`);
    if (tier === 'business' && !actor.owner && !this.isBusinessSide(actor.principal, now)) return refuse(403, 'business_approval_required', `角色 ${g.role} 带业务的写，${APPROVAL_TEXT.business}`);
    if (tier !== 'admin' && !actor.owner && (g.created_by === actor.by || (!!actor.principal && g.created_by_principal === actor.principal))) {
      return refuse(403, 'drafter_cannot_approve', `授予 ${g.id} 是你起草的，角色 ${g.role} 这一档要另一位放行：${APPROVAL_TEXT[tier]}`);
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

  /** 放行：按三档认放行人（见文件头）；第二、三档起草的人不能自己放行；过了期限的不能生效 */
  approve(id: number, actor: Actor, now = Date.now()): Result<{ grant: GrantRow }> {
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!g) return refuse(404, 'grant_missing', `授予 ${id} 不存在`);
    const bad = this.approvalRefusal(g, actor, now);
    if (bad && bad.code !== 'state') return bad;
    return this.move(id, ['pending'], 'active', 'approve', actor, '', now, true);
  }

  /** 撤销：草稿作废、待核驳回、生效的收回。要写理由 */
  revoke(id: number, actor: Actor, reason: string, now = Date.now()): Result<{ grant: GrantRow }> {
    if (!reason.trim()) return refuse(400, 'reason_required', '撤销要写理由');
    if (!db.prepare('SELECT 1 FROM grants WHERE id = ?').get(id)) return refuse(404, 'grant_missing', `授予 ${id} 不存在`);
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
