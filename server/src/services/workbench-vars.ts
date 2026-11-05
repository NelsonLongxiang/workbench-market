/** 工作台变量域（#336 workbench_vars + workbench_var_audit）：按 workbench_id 隔离，写一律带 revision 条件。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export type WorkbenchVarRow = {
  workbench_id: number; key: string; kind: 'var' | 'const'; value: string;
  revision: number; updated_by: string; owner: string; created_at: string; updated_at: string;
};

export class WorkbenchVarsService extends Service {
  constructor(ctx: any) {
    super(ctx, 'workbenchVars');
  }

  list(workbenchId: number, prefix: string) {
    return prefix
      ? db.prepare("SELECT * FROM workbench_vars WHERE workbench_id = ? AND substr(key, 1, ?) = ? ORDER BY key").all(workbenchId, prefix.length, prefix)
      : db.prepare('SELECT * FROM workbench_vars WHERE workbench_id = ? ORDER BY key').all(workbenchId);
  }
  get(workbenchId: number, key: string) {
    return db.prepare('SELECT * FROM workbench_vars WHERE workbench_id = ? AND key = ?').get(workbenchId, key);
  }
  count(workbenchId: number) {
    return (db.prepare('SELECT COUNT(*) AS n FROM workbench_vars WHERE workbench_id = ?').get(workbenchId) as { n: number }).n;
  }
  /** 只在键不存在时插入（changes=0 ⇒ 并发创建撞键） */
  insert(workbenchId: number, key: string, kind: string, value: string, by: string, owner: string) {
    return db.prepare('INSERT INTO workbench_vars (workbench_id, key, kind, value, revision, updated_by, owner) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(workbench_id, key) DO NOTHING')
      .run(workbenchId, key, kind, value, by, owner);
  }
  /** 比较并写：revision 不等（被别人改过）⇒ changes=0 */
  update(workbenchId: number, key: string, expected: number, kind: string, value: string, by: string, owner: string) {
    return db.prepare("UPDATE workbench_vars SET kind = ?, value = ?, revision = revision + 1, updated_by = ?, owner = ?, updated_at = datetime('now') WHERE workbench_id = ? AND key = ? AND revision = ?")
      .run(kind, value, by, owner, workbenchId, key, expected);
  }
  delete(workbenchId: number, key: string, expected: number) {
    return db.prepare('DELETE FROM workbench_vars WHERE workbench_id = ? AND key = ? AND revision = ?').run(workbenchId, key, expected);
  }
  /** 删台级联（审计行保留） */
  deleteAll(workbenchId: number) {
    return db.prepare('DELETE FROM workbench_vars WHERE workbench_id = ?').run(workbenchId);
  }
  audit(r: { workbench_id: number; key: string; action: string; actor: string; kind: string; old_revision: number | null; new_revision: number | null; old_sha256: string; new_sha256: string; reason: string }) {
    return db.prepare(
      `INSERT INTO workbench_var_audit (workbench_id, key, action, actor, kind, old_revision, new_revision, old_sha256, new_sha256, reason)
       VALUES (@workbench_id, @key, @action, @actor, @kind, @old_revision, @new_revision, @old_sha256, @new_sha256, @reason)`
    ).run(r);
  }
  auditList(workbenchId: number, key: string, limit: number) {
    return db.prepare('SELECT id, key, action, actor, kind, old_revision, new_revision, old_sha256, new_sha256, reason, at FROM workbench_var_audit WHERE workbench_id = ? AND key = ? ORDER BY id DESC LIMIT ?')
      .all(workbenchId, key, limit);
  }
}
