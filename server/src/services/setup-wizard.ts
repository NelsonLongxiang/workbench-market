/**
 * 首次安装向导（角色预设 ②）：按组织的形态生成一批草稿授予，属主一次放行。Cordis 服务 `setupWizard`。
 *
 *   · small（只有属主和同事）：现有的每个启用的人都给普通员工（member，范围 *）。
 *   · standard：assignments 指定谁是管理层（management，*）、谁是哪个部门的负责人（dept-lead，dept:<部门>）；
 *     其余启用的人给普通员工。
 * 草稿照常经授予服务起草（自授、范围、部门存在、期限这些规则一条不少）；起草被拒的记进 skipped 并写明原因，不中断整批。
 * 可重复跑：同一主体、角色、范围已经有草稿、待核或生效的授予就跳过（already）。
 * 放行：属主（本机命令行，或持生效 owner 授予的人）一次把这一批里还在草稿、待核的提交并放行。
 *   这一批里放行了的部门负责人授予（dept-lead，dept:<部门>），部门还没有负责人的，顺带把负责人设上：属主本人的动作，
 *   就是对这个关系的确认（规范 14「关系由谁说了算」：部门负责人只有属主能定）。部门已经有负责人的不动。
 * 「这条是向导建的」记在 setup_wizard_grants 里（grants 的来源列只认 manual、migration），读授予时推出来源 wizard。
 */
import { Service } from '@deepseek-ai/cordis';
import { svc } from '../context.ts';
import { db } from '../db.ts';
import type { Actor, GrantService } from './grant.ts';
import type { DepartmentService } from './department.ts';

export type WizardShape = 'small' | 'standard';
export type WizardAssignments = { management?: string[]; dept_leads?: { principal: string; department: string }[] };
export type WizardTarget = { principal: string; role: string; scope: string };
export type WizardRun = {
  id: number; shape: WizardShape; created_by: string; created_at: number; approved_by: string | null; approved_at: number | null;
  grants: { id: number; principal: string; role: string; scope: string; status: string }[];
};

const grants = () => svc<GrantService>('grants');

export class SetupWizardService extends Service {
  constructor(ctx: any) {
    super(ctx, 'setupWizard');
  }

  /** 现有的启用的人（按标识排序） */
  private people(): string[] {
    return (db.prepare("SELECT id FROM principals WHERE kind = 'person' AND status = 'active' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  }

  /** 按形态算出要建的授予（还没去重） */
  targets(shape: WizardShape, a: WizardAssignments = {}): WizardTarget[] {
    const people = this.people();
    if (shape === 'small') return people.map((p) => ({ principal: p, role: 'member', scope: '*' }));
    const out: WizardTarget[] = [];
    const special = new Set<string>();
    for (const p of a.management ?? []) { out.push({ principal: p, role: 'management', scope: '*' }); special.add(p); }
    for (const d of a.dept_leads ?? []) { out.push({ principal: d.principal, role: 'dept-lead', scope: `dept:${d.department}` }); special.add(d.principal); }
    for (const p of people) if (!special.has(p)) out.push({ principal: p, role: 'member', scope: '*' });
    return out;
  }

  /** 跑一次：建一个运行记录，逐条起草（已有的跳过），把建出来的挂到这次运行上 */
  run(shape: WizardShape, a: WizardAssignments, actor: Actor, now: number): { run: number; created: (WizardTarget & { grant: number })[]; skipped: (WizardTarget & { reason: string; message?: string })[] } {
    const runId = Number(db.prepare('INSERT INTO setup_wizard_runs (shape, created_by, created_by_principal, created_at) VALUES (?, ?, ?, ?)').run(shape, actor.by.slice(0, 256), actor.principal, now).lastInsertRowid);
    const created: (WizardTarget & { grant: number })[] = [];
    const skipped: (WizardTarget & { reason: string; message?: string })[] = [];
    const seen = new Set<string>();
    for (const t of this.targets(shape, a)) {
      const k = `${t.principal}\u0000${t.role}\u0000${t.scope}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const existing = db.prepare("SELECT id FROM grants WHERE principal_id = ? AND role = ? AND scope = ? AND status IN ('draft','pending','active') LIMIT 1").get(t.principal, t.role, t.scope);
      if (existing) { skipped.push({ ...t, reason: 'already' }); continue; }
      const r = grants().draft({ principal: t.principal, role: t.role, scope: t.scope, expiresAt: null, reason: `首次安装向导（${shape === 'small' ? '小团队' : '标准'}）` }, actor, now);
      if (!r.ok) { skipped.push({ ...t, reason: r.code, message: r.message }); continue; }
      db.prepare('INSERT INTO setup_wizard_grants (run_id, grant_id) VALUES (?, ?)').run(runId, r.grant.id);
      created.push({ ...t, grant: r.grant.id });
    }
    return { run: runId, created, skipped };
  }

  /** 属主一次放行这次运行里还在草稿、待核的。调用方先核过是属主 */
  approve(runId: number, actor: Actor, now: number): { ok: true; approved: number[]; failed: { grant: number; reason: string }[] } | { ok: false; http: 404 | 409; code: string; message: string } {
    const run = db.prepare('SELECT id, approved_at FROM setup_wizard_runs WHERE id = ?').get(runId) as { id: number; approved_at: number | null } | undefined;
    if (!run) return { ok: false, http: 404, code: 'wizard_run_missing', message: `向导运行 ${runId} 不存在` };
    const ids = (db.prepare('SELECT g.id, g.status FROM setup_wizard_grants w JOIN grants g ON g.id = w.grant_id WHERE w.run_id = ? ORDER BY g.id').all(runId) as { id: number; status: string }[]);
    const approved: number[] = [];
    const failed: { grant: number; reason: string }[] = [];
    for (const g of ids) {
      if (g.status !== 'draft' && g.status !== 'pending') continue;
      if (g.status === 'draft') { const s = grants().submit(g.id, actor, now); if (!s.ok) { failed.push({ grant: g.id, reason: s.code }); continue; } }
      const a = grants().approve(g.id, actor, now);
      if (!a.ok) { failed.push({ grant: g.id, reason: a.code }); continue; }
      approved.push(g.id);
      const row = grants().get(g.id);
      if (row?.role === 'dept-lead' && row.scope.startsWith('dept:')) {
        const d = svc<DepartmentService>('departments').get(row.scope.slice(5));
        if (d && !d.lead) svc<DepartmentService>('departments').upsert({ id: d.id, name: d.name, functionCode: d.function_code, lead: row.principal_id }, actor.by, now);
      }
    }
    db.prepare('UPDATE setup_wizard_runs SET approved_by = ?, approved_at = ? WHERE id = ?').run(actor.by.slice(0, 256), now, runId);
    return { ok: true, approved, failed };
  }

  /** 最近的运行，连同挂在上面的授予和它们现在的状态 */
  runs(limit = 20): WizardRun[] {
    const rows = db.prepare('SELECT id, shape, created_by, created_at, approved_by, approved_at FROM setup_wizard_runs ORDER BY id DESC LIMIT ?').all(limit) as Omit<WizardRun, 'grants'>[];
    return rows.map((r) => ({
      ...r,
      grants: db.prepare('SELECT g.id, g.principal_id AS principal, g.role, g.scope, g.status FROM setup_wizard_grants w JOIN grants g ON g.id = w.grant_id WHERE w.run_id = ? ORDER BY g.id').all(r.id) as WizardRun['grants'],
    }));
  }

  /** 这条授予是不是向导建的 */
  isWizardGrant(grantId: number): boolean {
    return !!db.prepare('SELECT 1 FROM setup_wizard_grants WHERE grant_id = ?').get(grantId);
  }
}
