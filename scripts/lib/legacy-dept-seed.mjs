/**
 * 测试用：直接写库造「旧部门」数据。部门已停写（docs/domains-step1.md 第六节）：部门的增删改、成员增删回 410，
 * 新起草 dept: 范围的授予 422，测试里要的部门、成员、部门负责人、dept: 授予只能这样造。
 * 停写前就有的数据在生产里照样存在（过渡期已生效的 dept: 授予照旧算），这里造出来的就是那种数据。
 *
 * 用法：const seed = legacySeed(join(dataDir, 'workbench-market.db'));
 *       seed.department('sales', '合成销售', { lead: 'user:x', functionCode: 'sales' });
 *       seed.member('sales', 'user:y');
 *       seed.grant('user:y', 'dept-member', 'dept:sales');   // 生效的授予（起草、提交、放行三步都走，各记一行痕）
 *       seed.deptLead('sales', 'user:x');                   // 部门负责人：字段 + 生效的 dept-lead 授予 + dept_lead_grants
 * 实例要已经起来（表已经建好）；写库时实例可以开着（WAL，带忙等）。
 */
import { DatabaseSync } from 'node:sqlite';

const BY = 'cli';

export function legacySeed(dbFile, { busyMs = 10000 } = {}) {
  const run = (fn) => { const d = new DatabaseSync(dbFile, { timeout: busyMs }); try { return fn(d); } finally { d.close(); } };
  const now = () => Date.now();

  /** 部门（已有就改名、改负责人字段、改职能代号；lead 只写字段，不带权力——要权力用 deptLead） */
  function department(id, name, { lead = '', functionCode = '' } = {}) {
    run((d) => d.prepare('INSERT INTO departments (id, name, function_code, lead_principal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, function_code = excluded.function_code, lead_principal = excluded.lead_principal, updated_at = excluded.updated_at')
      .run(id, name, functionCode ?? '', lead ?? '', now(), now()));
  }

  /** 部门成员（已在里面不重复加） */
  function member(departmentId, principal) {
    run((d) => d.prepare('INSERT OR IGNORE INTO department_members (department_id, principal_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(departmentId, principal, BY, now()));
  }

  /** 一条授予，按状态走到 to（draft / pending / active），各步记一行痕，返回编号 */
  function grant(principal, role, scope, { reason = '合成：停写前就有的', to = 'active', expiresAt = null } = {}) {
    return run((d) => {
      const t = now();
      const id = Number(d.prepare('INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(principal, role, scope, expiresAt, reason, BY, t, t).lastInsertRowid);
      const ev = d.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
      ev.run(id, 'draft', null, 'draft', BY, reason, t);
      if (to === 'pending' || to === 'active') { d.prepare("UPDATE grants SET status = 'pending', updated_at = ? WHERE id = ?").run(t, id); ev.run(id, 'submit', 'draft', 'pending', BY, '', t); }
      if (to === 'active') { d.prepare("UPDATE grants SET status = 'active', approved_by = ?, updated_at = ? WHERE id = ?").run(BY, t, id); ev.run(id, 'approve', 'pending', 'active', BY, '', t); }
      return id;
    });
  }

  /** 部门负责人（停写前属主确认过的样子）：字段 + 生效的 dept-lead / dept:<部门> 授予 + dept_lead_grants，返回授予编号 */
  function deptLead(departmentId, principal) {
    const id = grant(principal, 'dept-lead', `dept:${departmentId}`, { reason: '随部门负责人确认' });
    run((d) => {
      d.prepare('UPDATE departments SET lead_principal = ?, updated_at = ? WHERE id = ?').run(principal, now(), departmentId);
      d.prepare('INSERT INTO dept_lead_grants (department_id, grant_id, principal_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (department_id) DO UPDATE SET grant_id = excluded.grant_id, principal_id = excluded.principal_id, created_at = excluded.created_at')
        .run(departmentId, id, principal, now());
    });
    return id;
  }

  /** 部门负责人提议（停写前收下、还在等属主确认的） */
  function deptLeadProposal(departmentId, principal, { by = 'admin-token' } = {}) {
    return run((d) => Number(d.prepare("INSERT INTO relation_proposals (kind, department_id, principal_id, proposed_by, proposed_at) VALUES ('dept-lead', ?, ?, ?, ?)").run(departmentId, principal, by, now()).lastInsertRowid));
  }

  return { department, member, grant, deptLead, deptLeadProposal, run };
}

/**
 * 停写前「属主（本机命令行）建部门、指定负责人」那一步的替身：建部门，有负责人就连授予一起造好。
 * 返回一个像应答的对象（status 201），原来判「搭起来没有」的那行不用改。
 */
export function seedDepartmentAsOwnerDid(dbFile, id, name, lead = '') {
  const s = legacySeed(dbFile);
  s.department(id, name);
  if (lead) s.deptLead(id, lead);
  return { status: 201, body: { department: { id, name } }, json: { department: { id, name } } };
}

/**
 * 同 legacySeed().grant，但用调用方已经开着的库连接（进程内跑服务的测试：server/src/db.ts 的 db）。
 * 停写以后 GrantService.draft 拒新起草的 dept: 授予，测试要的「停写前就生效的部门授予」用它造。返回编号
 */
export function legacyGrantIn(db, principal, role, scope, { reason = '合成：停写前就有的', to = 'active', expiresAt = null } = {}) {
  const t = Date.now();
  const id = Number(db.prepare('INSERT INTO grants (principal_id, role, scope, expires_at, reason, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(principal, role, scope, expiresAt, reason, BY, t, t).lastInsertRowid);
  const ev = db.prepare('INSERT INTO grant_events (grant_id, event, from_status, to_status, actor, actor_principal, reason, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)');
  ev.run(id, 'draft', null, 'draft', BY, reason, t);
  if (to === 'pending' || to === 'active') { db.prepare("UPDATE grants SET status = 'pending', updated_at = ? WHERE id = ?").run(t, id); ev.run(id, 'submit', 'draft', 'pending', BY, '', t); }
  if (to === 'active') { db.prepare("UPDATE grants SET status = 'active', approved_by = ?, updated_at = ? WHERE id = ?").run(BY, t, id); ev.run(id, 'approve', 'pending', 'active', BY, '', t); }
  return id;
}

/** 同 seedDepartmentAsOwnerDid，但用调用方已经开着的库连接：建部门，有负责人就连 dept-lead 授予、dept_lead_grants 一起造好 */
export function legacyDepartmentIn(db, id, name, lead = '') {
  const t = Date.now();
  db.prepare('INSERT INTO departments (id, name, lead_principal, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, lead_principal = excluded.lead_principal, updated_at = excluded.updated_at').run(id, name, lead, t, t);
  if (!lead) return null;
  const g = legacyGrantIn(db, lead, 'dept-lead', `dept:${id}`, { reason: '随部门负责人确认' });
  db.prepare('INSERT INTO dept_lead_grants (department_id, grant_id, principal_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (department_id) DO UPDATE SET grant_id = excluded.grant_id, principal_id = excluded.principal_id, created_at = excluded.created_at').run(id, g, lead, t);
  return g;
}
