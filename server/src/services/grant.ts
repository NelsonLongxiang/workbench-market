/**
 * 授予域（阶段六 6b）：谁有哪个角色。一条授予记六样：主体、角色、范围、期限、授予人、理由。
 *
 * 状态只有五种，只能往前走（库里的触发器也管着）：draft 草稿 → pending 待核 → active 生效 → revoked 撤销 或 expired 过期；
 * 草稿和待核也能直接撤销（作废、驳回）。每一步在 grant_events 里记一行，只增不改。
 *
 * 规则在这里和库里，不靠页面：
 *   · 不能给自己授予：起草、提交、放行的人都不能是被授予的主体（库里有约束）；
 *   · 管理员级的授予（属主、管理员，或者权限里带管理类的角色）只有属主能放行：本机命令行，或持有生效的 owner 授予的主体；
 *   · 不是人的主体要有在职的责任人（责任人是启用的人）才能被授予；
 *   · 决定类权限只给人：角色展开 includes 之后带决定类（按类别或按动作）的，不授予给不是人的主体；
 *   · 角色权限里写了范围的，要在授予的范围之内；
 *   · 到期自动失效：判断生效时现比期限；另有周期任务把到期的标成 expired。
 * 每一步都重新核对（主体、角色声明可能在两步之间变了）。
 *
 * 这一步只建结构，不接判定：现有的守卫不读这里，不改变任何人能做什么。判定在 6c。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import { scopeOk, scopeWithin, type RoleView } from '../roles.ts';

export type GrantStatus = 'draft' | 'pending' | 'active' | 'revoked' | 'expired';
export type GrantRow = {
  id: number; principal_id: string; role: string; scope: string; expires_at: number | null; reason: string; status: GrantStatus;
  created_by: string; created_by_principal: string | null; approved_by: string | null; approved_by_principal: string | null; created_at: number; updated_at: number;
};
export type GrantEvent = { seq: number; grant_id: number; event: string; from_status: string | null; to_status: string; actor: string; actor_principal: string | null; reason: string; at: number };
/** 做这一步的是谁：留痕写法（cli、admin-token、odoo:<登录名>）、对到的主体（没有为 null）、是不是属主 */
export type Actor = { by: string; principal: string | null; owner: boolean };
export type Refusal = { ok: false; http: 400 | 403 | 404 | 409 | 422; code: string; message: string };
export type Result<T> = { ok: true } & T | Refusal;

const refuse = (http: Refusal['http'], code: string, message: string): Refusal => ({ ok: false, http, code, message });
const text = (v: string, max: number) => v.slice(0, max);
const VERB: Record<string, string> = { submit: '提交', approve: '放行', revoke: '撤销', expire: '标成过期' };

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

  list(filter: { principal?: string; status?: GrantStatus } = {}): GrantRow[] {
    const where: string[] = [], args: string[] = [];
    if (filter.principal) { where.push('principal_id = ?'); args.push(filter.principal); }
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    return db.prepare(`SELECT * FROM grants ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 500`).all(...args) as GrantRow[];
  }

  /** 这个主体现在生效的授予（现比期限，不等周期任务） */
  activeFor(principal: string, now = Date.now()): GrantRow[] {
    return db.prepare("SELECT * FROM grants WHERE principal_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY id").all(principal, now) as GrantRow[];
  }

  /** 这个主体是不是属主：持有生效的 owner 授予 */
  isOwner(principal: string | null, now = Date.now()): boolean {
    return !!principal && this.activeFor(principal, now).some((g) => g.role === 'owner');
  }

  /** 每一步都要过的核对：角色在、范围合规、主体在且启用、不是人的有在职责任人、决定类不给不是人的、不给自己 */
  private check(g: { principal_id: string; role: string; scope: string }, actor: Actor): Refusal | null {
    const role = this.roleViews.get(g.role);
    if (!role) return refuse(422, 'role_unknown', `角色 ${g.role} 没有声明`);
    if (!scopeOk(g.scope)) return refuse(400, 'scope_invalid', '范围写法不对：*、domain:、bench:、sop:、tool:、self、object:');
    for (const p of role.closure) if (!scopeWithin(p.scope, g.scope)) return refuse(422, 'scope_wider', `角色 ${g.role} 里有范围 ${p.scope} 的权限，不在授予的范围 ${g.scope} 之内`);
    const p = db.prepare('SELECT id, kind, status, owner FROM principals WHERE id = ?').get(g.principal_id) as { id: string; kind: string; status: string; owner: string } | undefined;
    if (!p) return refuse(404, 'principal_missing', `主体 ${g.principal_id} 不存在`);
    if (p.status !== 'active') return refuse(422, 'principal_disabled', `主体 ${g.principal_id} 已停用`);
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
    const bad = this.check({ principal_id: input.principal, role: input.role, scope: input.scope }, actor);
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

  /** 放行：管理员级的只有属主能放行；过了期限的不能生效 */
  approve(id: number, actor: Actor, now = Date.now()): Result<{ grant: GrantRow }> {
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as GrantRow | undefined;
    if (!g) return refuse(404, 'grant_missing', `授予 ${id} 不存在`);
    const bad = this.check(g, actor);
    if (bad) return bad;
    if (this.roleViews.get(g.role)?.adminLevel && !actor.owner) return refuse(403, 'owner_required', `角色 ${g.role} 是管理员级的，只有属主能放行`);
    if (g.expires_at !== null && g.expires_at <= now) return refuse(409, 'expired', `授予 ${id} 已经过了期限，不能生效`);
    return this.move(id, ['pending'], 'active', 'approve', actor, '', now, true);
  }

  /** 撤销：草稿作废、待核驳回、生效的收回。要写理由 */
  revoke(id: number, actor: Actor, reason: string, now = Date.now()): Result<{ grant: GrantRow }> {
    if (!reason.trim()) return refuse(400, 'reason_required', '撤销要写理由');
    if (!db.prepare('SELECT 1 FROM grants WHERE id = ?').get(id)) return refuse(404, 'grant_missing', `授予 ${id} 不存在`);
    return this.move(id, ['draft', 'pending', 'active'], 'revoked', 'revoke', actor, reason, now);
  }

  /** 把到期的生效授予标成过期，返回标了几条（周期任务调；判断生效时本来就现比期限） */
  expireDue(now = Date.now()): number {
    const due = db.prepare("SELECT id FROM grants WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now) as { id: number }[];
    let n = 0;
    for (const { id } of due) if (this.move(id, ['active'], 'expired', 'expire', { by: 'system:expiry', principal: null, owner: false }, '', now).ok) n++;
    return n;
  }
}
