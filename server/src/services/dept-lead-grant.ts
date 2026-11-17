/**
 * 部门负责人：字段和授予一起落（规范 14「关系由谁说了算」）。
 *
 * 部门负责人带业务拍板，权力只来自已放行的授予：`dept:<部门>` 范围的 dept-lead（或 `*` 范围带业务拍板的授予）。
 * departments.lead_principal 这个字段本身只是组织信息——外部同步、存量、直接写库都可能写它，它单独不带来任何权力
 * （TeamService.leads 推「部门的负责人是团队负责人」时也要看授予）。
 *
 * 字段的写入来源和定性：
 *   · 属主确认的提议、属主直接指定（本机命令行、持 owner 授予的人）：同一事务里落字段、发授予（属主放行），记进 dept_lead_grants；
 *   · 首次安装向导（属主在场一次放行）：向导自己发授予，这里只把那条记进 dept_lead_grants；
 *   · 别的来源（迁移、导入、将来的同步、直接写库）：只有字段，没有授予，是「待属主放行」，不带权力；启动时补记一条负责人提议给属主。
 * 收紧（移除负责人、换人）谁都能做一步：收回 dept_lead_grants 里记着的那一条，这个人另外持有的授予不碰。
 *
 * 这里的函数都可以在调用方已经开着的事务里跑（用保存点），出错或拒绝时由调用方整体回滚。
 */
import { db } from '../db.ts';
import { svc } from '../context.ts';
import type { Actor, GrantService, Refusal } from './grant.ts';
import type { DepartmentService } from './department.ts';

const grants = () => svc<GrantService>('grants');
const departments = () => svc<DepartmentService>('departments');
const refuse = (http: Refusal['http'], code: string, message: string): Refusal => ({ ok: false, http, code, message });

export const DEPT_LEAD_ROLE = 'dept-lead';
/** 随负责人发的授予，起草、收回时写的理由 */
const ISSUE_REASON = '随部门负责人确认';
const REVOKE_REASON = '随部门负责人变更收回';

/** 这个人现在有没有当这个部门负责人的权力：持有生效的 dept:<部门>（或 *）范围带业务拍板的授予 */
export function leadGrantActive(principal: string, departmentId: string, now = Date.now()): boolean {
  return grants().decidesBusinessIn(principal, `dept:${departmentId}`, now);
}

/** 保存点：外面开着事务就嵌进去，没有就自己开一个 */
function tx<T>(fn: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT dept_lead' : 'BEGIN IMMEDIATE');
  try {
    const r = fn();
    const failed = !!r && typeof r === 'object' && (r as { ok?: unknown }).ok === false;
    if (nested) { if (failed) db.exec('ROLLBACK TO dept_lead'); db.exec('RELEASE dept_lead'); } else db.exec(failed ? 'ROLLBACK' : 'COMMIT');
    return r;
  } catch (e) {
    try { if (nested) { db.exec('ROLLBACK TO dept_lead'); db.exec('RELEASE dept_lead'); } else db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ }
    throw e;
  }
}

const event = db.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

/** 收回 dept_lead_grants 记着的那条（还在草稿、待核、生效的），删掉记录 */
function revokeLinked(departmentId: string, actor: Pick<Actor, 'by' | 'principal'>, now: number): void {
  const link = db.prepare('SELECT grant_id FROM dept_lead_grants WHERE department_id = ?').get(departmentId) as { grant_id: number } | undefined;
  if (!link) return;
  const g = db.prepare('SELECT status FROM grants WHERE id = ?').get(link.grant_id) as { status: string } | undefined;
  if (g && ['draft', 'pending', 'active'].includes(g.status)) {
    db.prepare("UPDATE grants SET status = 'revoked', updated_at = ? WHERE id = ?").run(now, link.grant_id);
    event.run(link.grant_id, 'revoke', g.status, 'revoked', actor.by.slice(0, 256), actor.principal, REVOKE_REASON, now);
  }
  db.prepare('DELETE FROM dept_lead_grants WHERE department_id = ?').run(departmentId);
}

/** 发一条 dept-lead / dept:<部门> 的授予，属主放行（起草、提交、放行三步各记一行痕），记进 dept_lead_grants */
function issue(departmentId: string, principal: string, actor: Actor, now: number): Refusal | null {
  const role = grants().roleView(DEPT_LEAD_ROLE);
  if (!role || !role.businessDecide) return refuse(422, 'dept_lead_role_unusable', `角色 ${DEPT_LEAD_ROLE} 没有声明，或者不带业务拍板：确认不了部门负责人，先看部署方的角色文件`);
  const scope = `dept:${departmentId}`;
  const bad = grants().issueCheck({ principal_id: principal, role: DEPT_LEAD_ROLE, scope, expires_at: null }, actor);
  if (bad) return bad;
  const by = actor.by.slice(0, 256);
  // 授予一律从草稿开始（库里的触发器）：起草、提交、放行三步照样走，各记一行痕
  const id = Number(db.prepare('INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_by_principal, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
    .run(principal, DEPT_LEAD_ROLE, scope, ISSUE_REASON, by, actor.principal, now, now).lastInsertRowid);
  event.run(id, 'draft', null, 'draft', by, actor.principal, ISSUE_REASON, now);
  db.prepare("UPDATE grants SET status = 'pending', updated_at = ? WHERE id = ?").run(now, id);
  event.run(id, 'submit', 'draft', 'pending', by, actor.principal, '', now);
  db.prepare("UPDATE grants SET status = 'active', approved_by = ?, approved_by_principal = ?, updated_at = ? WHERE id = ?").run(by, actor.principal, now, id);
  event.run(id, 'approve', 'pending', 'active', by, actor.principal, '', now);
  db.prepare('INSERT INTO dept_lead_grants (department_id, grant_id, principal_id, created_at) VALUES (?, ?, ?, ?)').run(departmentId, id, principal, now);
  return null;
}

/**
 * 负责人字段已经（或刚刚）定成 lead 之后，把授予理顺：
 *   · 记着的那条不是给 lead 的（换人、移除）：收回；
 *   · lead 有人、做这一步的是属主、他还没有这个部门的拍板授予：发一条、记下；已经有了（另外持有的，或 * 范围的）就不再发；
 *   · 不是属主：只收不发（只有字段的就是「待属主放行」）。
 * 拒绝时返回说法，调用方要整体回滚（字段也不能落）。
 */
export function settleLeadGrant(departmentId: string, lead: string | null, actor: Actor, now: number): Refusal | null {
  return tx(() => {
    const link = db.prepare('SELECT principal_id FROM dept_lead_grants WHERE department_id = ?').get(departmentId) as { principal_id: string } | undefined;
    if (link && link.principal_id !== lead) revokeLinked(departmentId, actor, now);
    if (!lead || !actor.owner || leadGrantActive(lead, departmentId, now)) return null;
    // 记着的那条给的正是 lead、却已经不生效了（被单独撤了、过期了）：换一条新的
    if (link && link.principal_id === lead) db.prepare('DELETE FROM dept_lead_grants WHERE department_id = ?').run(departmentId);
    return issue(departmentId, lead, actor, now);
  });
}

/** 属主指定（或移除）部门负责人：一个事务里改部门、理顺授予；任何一步不成都不落 */
export function setDepartmentLead(input: { id: string; name: string; functionCode: string | null; lead: string | null }, actor: Actor, now: number):
  ReturnType<DepartmentService['upsert']> | Refusal {
  return tx(() => {
    const r = departments().upsert(input, actor.by, now);
    if (!r.ok) return r;
    const bad = settleLeadGrant(input.id, input.lead, actor, now);
    // 应答里的部门要是理顺授予之后的样子（负责人的 grant 状态）
    return bad ?? { ...r, department: departments().get(input.id) ?? r.department };
  });
}

/** 删部门：一并收回随负责人发的那条授予（删不成就都不动）。别的还开着的部门授予照旧挡住删除 */
export function removeDepartment(id: string, actor: Pick<Actor, 'by' | 'principal'>, now: number): ReturnType<DepartmentService['remove']> {
  return tx(() => {
    revokeLinked(id, actor, now);
    return departments().remove(id);
  });
}

/** 首次安装向导：属主一次放行时自己发了这条授予、并把它的人设成负责人，记下这条（以后换人时收回它） */
export function linkWizardLeadGrant(departmentId: string, grantId: number, principal: string, now: number): void {
  db.prepare('INSERT INTO dept_lead_grants (department_id, grant_id, principal_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (department_id) DO UPDATE SET grant_id = excluded.grant_id, principal_id = excluded.principal_id, created_at = excluded.created_at')
    .run(departmentId, grantId, principal, now);
}

/** 只有字段、没有授予的部门负责人（待属主放行）：部门标识和那个人 */
export function pendingLeadGrants(now = Date.now()): { department_id: string; principal: string }[] {
  return (db.prepare("SELECT id, lead_principal FROM departments WHERE lead_principal <> '' ORDER BY id").all() as { id: string; lead_principal: string }[])
    .filter((d) => !leadGrantActive(d.lead_principal, d.id, now))
    .map((d) => ({ department_id: d.id, principal: d.lead_principal }));
}
