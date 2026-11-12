/**
 * 部门域：部门清单、负责人、归属。管理员维护（以后从 Odoo 同步的写进同一套表，source 分来源）；空就是空，不造数据。
 *
 * 部门标识就是授予范围 dept:<标识> 里的那个名字，只有这一套：部门负责人这类角色授予到 dept:<标识>，标识要在这张表里。
 * 职能代号（function_code）是给生命周期对上用的：阶段接口里的负责部门代号由管理员在这里配到某个部门上；只是字符串，不跨库约束。
 *
 * 规则：
 *   · 标识是 ASCII（小写字母开头，字母、数字、连字符，最多 48 个字符），建好不改；名称 1～64 个字符；
 *   · 职能代号可空，非空时唯一（小写字母开头，字母、数字、下划线、连字符，最多 48 个）；
 *   · 负责人可空；非空时要是存在的人（主体 kind=person），不要求是本部门成员；
 *   · 成员是人或席位（AI 员工）；同一个主体可在多个部门；
 *   · 删部门：还有没结束的授予（草稿、待核、生效）范围是这个部门的、或者还有团队挂在上面的，不能删（409）；删的时候成员归属一起删。
 * 时间由调用方给（毫秒），不在 SQL 里取。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export type DepartmentSource = 'manual' | 'odoo';
export type DepartmentLead = { principal: string; display_name: string } | null;
export type DepartmentView = {
  id: string; name: string; function_code: string | null; lead: DepartmentLead; member_count: number; source: DepartmentSource;
};
export type DepartmentMember = { principal: string; display_name: string; kind: string; status: string; is_lead: boolean };
export type Membership = { id: string; name: string; function_code: string | null; is_lead: boolean; is_member: boolean };
export type DepartmentRefusal = { ok: false; http: 400 | 404 | 409 | 422; code: string; message: string };

export const DEPARTMENT_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const FUNCTION_CODE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const MEMBER_KINDS = ['person', 'seat'];

const refuse = (http: DepartmentRefusal['http'], code: string, message: string): DepartmentRefusal => ({ ok: false, http, code, message });

type Row = { id: string; name: string; function_code: string; lead_principal: string; lead_name: string | null; member_count: number; source: DepartmentSource };
const view = (r: Row): DepartmentView => ({
  id: r.id, name: r.name, function_code: r.function_code || null,
  lead: r.lead_principal ? { principal: r.lead_principal, display_name: r.lead_name ?? '' } : null,
  member_count: Number(r.member_count), source: r.source,
});
const SELECT = `SELECT d.id, d.name, d.function_code, d.lead_principal, p.display_name AS lead_name, d.source,
  (SELECT COUNT(*) FROM department_members m WHERE m.department_id = d.id) AS member_count
  FROM departments d LEFT JOIN principals p ON p.id = d.lead_principal`;

export class DepartmentService extends Service {
  constructor(ctx: any) {
    super(ctx, 'departments');
  }

  list(): DepartmentView[] {
    return (db.prepare(`${SELECT} ORDER BY d.id`).all() as Row[]).map(view);
  }

  get(id: string): DepartmentView | null {
    const r = db.prepare(`${SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
    return r ? view(r) : null;
  }

  members(id: string): DepartmentMember[] {
    const lead = (db.prepare('SELECT lead_principal FROM departments WHERE id = ?').get(id) as { lead_principal: string } | undefined)?.lead_principal ?? '';
    return (db.prepare(`SELECT m.principal_id AS principal, COALESCE(p.display_name, '') AS display_name, COALESCE(p.kind, '') AS kind, COALESCE(p.status, '') AS status
      FROM department_members m LEFT JOIN principals p ON p.id = m.principal_id WHERE m.department_id = ? ORDER BY m.principal_id`).all(id) as Omit<DepartmentMember, 'is_lead'>[])
      .map((m) => ({ ...m, is_lead: m.principal === lead }));
  }

  /** 这个主体属于哪些部门（是成员的，和是负责人的；负责人不一定是成员） */
  of(principal: string): Membership[] {
    const rows = db.prepare(`SELECT d.id, d.name, d.function_code, d.lead_principal,
      (SELECT COUNT(*) FROM department_members m WHERE m.department_id = d.id AND m.principal_id = ?) AS member
      FROM departments d WHERE d.lead_principal = ? OR EXISTS (SELECT 1 FROM department_members m WHERE m.department_id = d.id AND m.principal_id = ?) ORDER BY d.id`)
      .all(principal, principal, principal) as { id: string; name: string; function_code: string; lead_principal: string; member: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, function_code: r.function_code || null, is_lead: r.lead_principal === principal, is_member: Number(r.member) > 0 }));
  }

  /** 建或改一个部门（标识建好不改）。lead 为 null 表示没有负责人；functionCode 为 null 表示不配职能代号 */
  /** 负责人要是已有的人：直接设和提议（routes/departments.ts）用同一处 */
  leadCheck(lead: string): DepartmentRefusal | null {
    const p = db.prepare('SELECT kind FROM principals WHERE id = ?').get(lead) as { kind: string } | undefined;
    if (!p) return refuse(422, 'lead_unknown', `负责人 ${lead} 不是已有的主体`);
    if (p.kind !== 'person') return refuse(422, 'lead_not_person', `负责人要是人，${lead} 不是`);
    return null;
  }

  upsert(input: { id: string; name: string; functionCode: string | null; lead: string | null }, by: string, now: number): { ok: true; created: boolean; department: DepartmentView } | DepartmentRefusal {
    if (!DEPARTMENT_ID_RE.test(input.id)) return refuse(400, 'department_id_invalid', '部门标识要是小写字母开头的字母、数字、连字符，最多 48 个字符');
    const name = input.name.trim();
    if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) return refuse(400, 'department_name_invalid', '部门名称要是 1～64 个字符，不带控制字符');
    const code = input.functionCode ?? '';
    if (code && !FUNCTION_CODE_RE.test(code)) return refuse(400, 'function_code_invalid', '职能代号要是小写字母开头的字母、数字、下划线、连字符，最多 48 个字符');
    const lead = input.lead ?? '';
    const badLead = lead ? this.leadCheck(lead) : null;
    if (badLead) return badLead;
    if (code) {
      const other = db.prepare('SELECT id FROM departments WHERE function_code = ? AND id <> ?').get(code, input.id) as { id: string } | undefined;
      if (other) return refuse(409, 'function_code_taken', `职能代号 ${code} 已经配给部门 ${other.id}`);
    }
    const created = !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(input.id);
    db.prepare(`INSERT INTO departments (id, name, function_code, lead_principal, source, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, function_code = excluded.function_code, lead_principal = excluded.lead_principal, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(input.id, name, code, lead, now, now, by.slice(0, 256));
    return { ok: true, created, department: this.get(input.id)! };
  }

  remove(id: string): { ok: true; members: number } | DepartmentRefusal {
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) return refuse(404, 'department_missing', `部门 ${id} 不存在`);
    const open = db.prepare("SELECT COUNT(*) AS n FROM grants WHERE scope = ? AND status IN ('draft', 'pending', 'active')").get(`dept:${id}`) as { n: number };
    if (Number(open.n) > 0) return refuse(409, 'department_in_use', `还有 ${open.n} 条没结束的授予范围是这个部门，先撤销再删`);
    const teamsOn = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE department_id = ? AND claimed = 1').get(id) as { n: number };
    if (Number(teamsOn.n) > 0) return refuse(409, 'department_has_teams', `还有 ${teamsOn.n} 个团队挂在这个部门上，先换部门或退回待认领再删`);
    db.exec('BEGIN');
    try {
      const members = db.prepare('DELETE FROM department_members WHERE department_id = ?').run(id).changes;
      db.prepare('DELETE FROM departments WHERE id = ?').run(id);
      db.exec('COMMIT');
      return { ok: true, members: Number(members) };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务没开成 */ }
      throw e;
    }
  }

  /** 加成员；已经在里面不重复加（added=false） */
  addMember(id: string, principal: string, by: string, now: number): { ok: true; added: boolean } | DepartmentRefusal {
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) return refuse(404, 'department_missing', `部门 ${id} 不存在`);
    const p = db.prepare('SELECT kind FROM principals WHERE id = ?').get(principal) as { kind: string } | undefined;
    if (!p) return refuse(404, 'principal_missing', `主体 ${principal} 不存在`);
    if (!MEMBER_KINDS.includes(p.kind)) return refuse(422, 'member_kind', `部门成员要是人或席位，${principal} 是 ${p.kind}`);
    const added = db.prepare("INSERT INTO department_members (department_id, principal_id, source, created_at, created_by) VALUES (?, ?, 'manual', ?, ?) ON CONFLICT (department_id, principal_id) DO NOTHING")
      .run(id, principal, now, by.slice(0, 256)).changes === 1;
    return { ok: true, added };
  }

  removeMember(id: string, principal: string): { ok: true; removed: boolean } | DepartmentRefusal {
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) return refuse(404, 'department_missing', `部门 ${id} 不存在`);
    return { ok: true, removed: db.prepare('DELETE FROM department_members WHERE department_id = ? AND principal_id = ?').run(id, principal).changes === 1 };
  }
}
