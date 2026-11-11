/**
 * 自定义角色（角色预设之后）：从内置预设（或别的角色）复制出来、在界面上改的角色。和声明文件里的角色不同，它们是数据。
 *
 *   · 校验和声明文件同一套（roles.ts 的 checkShape、buildRoles）：形状、动作存在、范围写法、不和任何角色重名（id 或名字）。
 *   · 每次建、改、放行、删都留一行（custom_role_events）。
 *   · 会带来管理类或决定类权限的建和改要属主放行（和管理员级授予的规则对齐）：
 *     新建的先是 pending，放行前不能授予；已生效的改动先记成 proposed，放行后才换上。
 *   · 从 AI 员工（ai-staff）复制出来的不许带决定类（决定只认人）。授予时「决定类不给非人」照旧核。
 *   · 有授予在用（草稿、待核、生效）的不能删；改动返回会影响哪些授予。
 *   · 声明文件里的角色优先：声明文件后来用了同一个 id 或名字的，启动时这个自定义角色不加载（留一行痕）。
 * 时间由代码给（毫秒），SQL 里不取当前时间；留痕的序号在事务里取下一个。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';
import type { Permission, RoleDecl } from '../roles.ts';

export type CustomRoleRow = {
  id: string; name: string; based_on: string; permissions: string; status: 'pending' | 'active';
  proposed: string | null; proposed_by: string | null; created_by: string; created_at: number; updated_at: number;
};
export type CustomRoleView = Omit<CustomRoleRow, 'permissions' | 'proposed'> & { permissions: Permission[]; proposed: { name: string; permissions: Permission[] } | null };
type Actor = { by: string; principal: string | null };

const view = (r: CustomRoleRow): CustomRoleView => ({ ...r, permissions: JSON.parse(r.permissions) as Permission[], proposed: r.proposed ? JSON.parse(r.proposed) : null });

export class CustomRoleService extends Service {
  constructor(ctx: any) {
    super(ctx, 'customRoles');
  }

  list(): CustomRoleView[] {
    return (db.prepare('SELECT * FROM custom_roles ORDER BY id').all() as CustomRoleRow[]).map(view);
  }

  get(id: string): CustomRoleView | null {
    const r = db.prepare('SELECT * FROM custom_roles WHERE id = ?').get(id) as CustomRoleRow | undefined;
    return r ? view(r) : null;
  }

  /** 能授予的（生效的）自定义角色，交给角色表 */
  activeDecls(): RoleDecl[] {
    return this.list().filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.name, permissions: r.permissions }));
  }

  /** 用了这个角色、还没结束的授予（草稿、待核、生效） */
  grantsUsing(id: string): { id: number; principal_id: string; status: string; scope: string }[] {
    return db.prepare("SELECT id, principal_id, status, scope FROM grants WHERE role = ? AND status IN ('draft','pending','active') ORDER BY id").all(id) as never;
  }

  private event(roleId: string, event: string, actor: Actor, before: unknown, after: unknown, now: number): void {
    const next = Number((db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM custom_role_events').get() as { n: number }).n);
    db.prepare('INSERT INTO custom_role_events (seq, role_id, event, actor, actor_principal, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(next, roleId, event, actor.by, actor.principal, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), now);
  }

  events(id: string): { seq: number; event: string; actor: string; actor_principal: string | null; before: unknown; after: unknown; at: number }[] {
    return (db.prepare('SELECT * FROM custom_role_events WHERE role_id = ? ORDER BY seq').all(id) as { seq: number; event: string; actor: string; actor_principal: string | null; before: string | null; after: string | null; at: number }[])
      .map((e) => ({ ...e, before: e.before ? JSON.parse(e.before) : null, after: e.after ? JSON.parse(e.after) : null }));
  }

  /** 建（复制出来的）。pending=true 时要属主放行才能授予 */
  create(input: { id: string; name: string; basedOn: string; permissions: Permission[]; pending: boolean }, actor: Actor, now = Date.now()): CustomRoleView {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO custom_roles (id, name, based_on, permissions, status, proposed, proposed_by, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)')
        .run(input.id, input.name, input.basedOn, JSON.stringify(input.permissions), input.pending ? 'pending' : 'active', actor.by, now, now);
      this.event(input.id, 'create', actor, undefined, { name: input.name, permissions: input.permissions, based_on: input.basedOn, status: input.pending ? 'pending' : 'active' }, now);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
    return this.get(input.id)!;
  }

  /** 改：propose=true 时只记成待放行的改动，生效的定义不动 */
  update(id: string, next: { name: string; permissions: Permission[] }, propose: boolean, actor: Actor, now = Date.now()): CustomRoleView {
    const cur = this.get(id);
    if (!cur) throw new Error(`自定义角色 ${id} 不存在`);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (propose) {
        db.prepare('UPDATE custom_roles SET proposed = ?, proposed_by = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), actor.by, now, id);
        this.event(id, 'propose', actor, { name: cur.name, permissions: cur.permissions }, next, now);
      } else {
        db.prepare('UPDATE custom_roles SET name = ?, permissions = ?, proposed = NULL, proposed_by = NULL, updated_at = ? WHERE id = ?').run(next.name, JSON.stringify(next.permissions), now, id);
        this.event(id, 'update', actor, { name: cur.name, permissions: cur.permissions }, next, now);
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
    return this.get(id)!;
  }

  /** 属主放行：待放行的新角色生效，或者待放行的改动换上 */
  approve(id: string, actor: Actor, now = Date.now()): CustomRoleView | null {
    const cur = this.get(id);
    if (!cur || (cur.status === 'active' && !cur.proposed)) return null;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (cur.proposed) db.prepare("UPDATE custom_roles SET name = ?, permissions = ?, status = 'active', proposed = NULL, proposed_by = NULL, updated_at = ? WHERE id = ?").run(cur.proposed.name, JSON.stringify(cur.proposed.permissions), now, id);
      else db.prepare("UPDATE custom_roles SET status = 'active', updated_at = ? WHERE id = ?").run(now, id);
      this.event(id, 'approve', actor, { name: cur.name, permissions: cur.permissions, status: cur.status }, cur.proposed ?? { name: cur.name, permissions: cur.permissions }, now);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
    return this.get(id);
  }

  /** 删：调用方先核过没有授予在用 */
  delete(id: string, actor: Actor, now = Date.now()): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM custom_roles WHERE id = ?').run(id);
      this.event(id, 'delete', actor, { name: cur.name, permissions: cur.permissions }, undefined, now);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* 事务已经不在了 */ } throw e; }
    return true;
  }
}
