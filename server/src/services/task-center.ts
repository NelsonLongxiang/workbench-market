/** 任务中心域（tasks ×5 + task_events ×2 + task_center_policy ×1 + task_center_events ×1 + 事务语句）：
 *  SQL 原文自 index.ts 的 /api/task-center 路由和只有它们用的 applyTaskTransition 搬入——同语句、同参数、同结果形状。 */
import { Service } from '@deepseek-ai/cordis';
import type { SQLInputValue } from 'node:sqlite';
import { db } from '../db.ts';

export class TaskCenterService extends Service {
  constructor(ctx: any) {
    super(ctx, 'taskCenter');
  }

  /** 全部任务，新的在前 */
  list() {
    return db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
  }
  byId(id: number) {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  }
  /** 派发开关改完之后重读这一行（原文没有空格的那一句） */
  reload(id: number) {
    return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  }
  /** 任务锁要的两列 */
  switchState(id: number) {
    return db.prepare('SELECT id, enabled FROM tasks WHERE id = ?').get(id);
  }
  /** 一个任务的事件，按发生顺序。taskId 是从 tasks 行里取出来的原值（和原来直接交给 prepare 一样，不先转成数） */
  events(taskId: SQLInputValue) {
    return db.prepare('SELECT id, type, actor, actor_kind, at, payload_json FROM task_events WHERE task_id = ? ORDER BY id').all(taskId);
  }

  /** 改总开关的事务 */
  policyBegin() {
    db.exec('BEGIN IMMEDIATE');
  }
  policyCommit() {
    db.exec('COMMIT');
  }
  policyRollback() {
    db.exec('ROLLBACK');
  }
  setCenterSwitch(value: string) {
    return db.prepare("UPDATE task_center_policy SET value=? WHERE key='center_switch'").run(value);
  }
  recordPolicyChanged(detail: string) {
    return db.prepare("INSERT INTO task_center_events(actor,action,detail) VALUES('human:admin','policy_changed',?)").run(detail);
  }

  /** 任务状态迁移：每次变化恰一条事件（BEGIN IMMEDIATE 串行段·#159 C23 只增不改）。原样搬自 index.ts 的 applyTaskTransition */
  applyTransition<T = void>(taskId: number, action: 'created' | 'toggled' | 'published' | 'withdrawn', actor: string, patch: Record<string, unknown> = {}, inTx?: () => T): T | undefined {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (Object.keys(patch).length) {
        const sets = Object.keys(patch).map((k) => k + ' = @' + k).join(', ');
        db.prepare('UPDATE tasks SET ' + sets + ", updated_at = datetime('now') WHERE id = @___id").run({ ...patch, ___id: taskId });
      }
      db.prepare("INSERT INTO task_events (task_id, type, actor, actor_kind, payload_json) VALUES (?, ?, ?, 'human', ?)").run(taskId, action, actor, JSON.stringify(patch));
      const out = inTx?.(); // 同一事务里的附带写（撤回时取消未发出的投递）
      db.exec('COMMIT');
      return out;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
