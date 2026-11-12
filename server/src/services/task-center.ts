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

  // ---------- 「安排一件事」：登录的人直接建一件任务（调用方负责事务） ----------
  /** 「安排一件事」的事务：查幂等、限流、建任务、记事件和请求在同一个事务里 */
  arrangeBegin() { db.exec('BEGIN IMMEDIATE'); }
  arrangeCommit() { db.exec('COMMIT'); }
  arrangeRollback() { db.exec('ROLLBACK'); }
  /** 这个人这个幂等键的上一次请求（没有就 undefined） */
  arrangeRequest(requester: string, key: string): { body_sha256: string; task_id: number; event_id: string } | undefined {
    return db.prepare('SELECT body_sha256, task_id, event_id FROM work_item_requests WHERE requester = ? AND idem_key = ?').get(requester, key) as never;
  }
  /** 这个人在某个时刻之后安排了几件（限流用） */
  arrangeCountSince(requester: string, since: string): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM work_item_requests WHERE requester = ? AND created_at > ?').get(requester, since) as { n: number }).n);
  }
  /** 建一行已发布的任务（没有录入 run，kind 记「安排」）和它的「已发布」事件。时间由调用方给 */
  insertArranged(t: { title: string; payload: string; sha256: string; requester: string; dispatch: boolean; at: string }): number {
    const id = Number(db.prepare("INSERT INTO tasks (title, kind, payload_json, status, material_sha256, published_at, published_by, created_by, created_at, agent_dispatch_enabled) VALUES (?, '安排', ?, 'published', ?, ?, ?, ?, ?, ?)")
      .run(t.title, t.payload, t.sha256, t.at, t.requester, t.requester, t.at, t.dispatch ? 1 : 0).lastInsertRowid);
    db.prepare("INSERT INTO task_events (task_id, type, actor, actor_kind, at, payload_json) VALUES (?, 'published', ?, 'human', ?, ?)").run(id, t.requester, t.at, JSON.stringify({ arranged: true, material_sha256: t.sha256 }));
    return id;
  }
  /** 记下这一次请求（同一事务里，和建任务、记事件一起） */
  insertArrangeRequest(r: { requester: string; key: string; sha256: string; taskId: number; eventId: string; at: string }): void {
    db.prepare('INSERT INTO work_item_requests (requester, idem_key, body_sha256, task_id, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.requester, r.key, r.sha256, r.taskId, r.eventId, r.at);
  }
}
