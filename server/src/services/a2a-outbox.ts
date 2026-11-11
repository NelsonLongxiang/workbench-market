/**
 * 唯一 outbox（阶段七第 3 步）双写期的镜像：两条出站路照旧写各自的表，每次写完把那一行的传输状态原样同步进 a2a_outbox_items。
 *   · 回执：a2a_outbox → kind=run-receipt，ref=run_id。
 *   · 事件投递：workbench_event_deliveries → kind=event-delivery，ref=投递 id。只镜像传输字段（地址、团队、调用方、context、信封、
 *     状态、次数、下次时间、错误、时间戳）；接单决定等业务字段留在原表。held（等管理员放行）的不进 outbox，放行那一刻
 *     在放行的同一事务里入队；从 held 直接撤回的记一行 cancelled（非 held 的投递与 outbox 一一对应）。
 * 读和投递仍走旧表；切读、停旧写是后面的 PR。
 *
 * 镜像和旧写在同一个保存点里：进程在两句之间崩掉不会只留一边。镜像本身出错只记日志、不挡旧写（双写期旧表是准的），
 * 漏掉的由启动时的整表同步（db.ts）补上，对账脚本（scripts/a2a-outbox-reconcile.mjs）报出来。
 */
import { db } from '../db.ts';

const MIRROR_SQL = `INSERT INTO a2a_outbox_items (kind, ref, target_url, task_id, context_id, payload, status, attempts, next_at, last_error, created_at, sent_at)
  SELECT 'run-receipt', CAST(run_id AS TEXT), target_url, task_id, context_id, payload, status, attempts, next_at, last_error, created_at, sent_at FROM a2a_outbox WHERE %WHERE%
  ON CONFLICT (kind, ref) DO UPDATE SET target_url = excluded.target_url, task_id = excluded.task_id, context_id = excluded.context_id, payload = excluded.payload,
    status = excluded.status, attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error, created_at = excluded.created_at, sent_at = excluded.sent_at`;

/** 计数：镜像失败了几次（进程内；测试和排障看） */
let mirrorFailures = 0;
export function receiptMirrorFailures(): number { return mirrorFailures; }

function mirror(where: 'id = ?' | 'run_id = ?', key: number): void {
  try {
    db.prepare(MIRROR_SQL.replace('%WHERE%', where)).run(key);
  } catch (e) {
    mirrorFailures++;
    console.error(`[a2a-outbox] 回执镜像没写进去（旧表照常；下次启动整表同步补上）：${(e as Error)?.message ?? e}`);
  }
}

/** 旧写 + 镜像放进一个保存点；旧写失败整体回滚并抛出（和原来一样），镜像失败不影响旧写 */
export function withReceiptMirror<T>(write: () => T, by: { id: number } | { runId: number }): T {
  db.exec('SAVEPOINT a2a_outbox_dual');
  try {
    const out = write();
    if ('id' in by) mirror('id = ?', by.id); else mirror('run_id = ?', by.runId);
    db.exec('RELEASE a2a_outbox_dual');
    return out;
  } catch (e) {
    db.exec('ROLLBACK TO a2a_outbox_dual');
    db.exec('RELEASE a2a_outbox_dual');
    throw e;
  }
}

const DELIVERY_MIRROR_SQL = `INSERT INTO a2a_outbox_items (kind, ref, target_url, team, caller, context_id, payload, status, attempts, next_at, last_error, created_at, sent_at)
  SELECT 'event-delivery', CAST(d.id AS TEXT), d.target_url, d.target_team, d.caller_session, e.context_id, d.message, d.status, d.attempts, d.next_at, d.last_error, d.created_at, d.sent_at
    FROM workbench_event_deliveries d JOIN workbench_events e ON e.event_id = d.event_id
   WHERE d.status IN ('pending','sent','dead','cancelled') AND %WHERE%
  ON CONFLICT (kind, ref) DO UPDATE SET target_url = excluded.target_url, team = excluded.team, caller = excluded.caller, context_id = excluded.context_id,
    payload = excluded.payload, status = excluded.status, attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error,
    created_at = excluded.created_at, sent_at = excluded.sent_at`;

let deliveryFailures = 0;
export function deliveryMirrorFailures(): number { return deliveryFailures; }

/**
 * 把一行投递的传输状态镜像进 outbox。在调用方的事务里跑（投递行状态变了的那一句之后，和它同生同灭）；
 * held 的行什么也不做。出错只记日志、计数：双写期旧表是准的，下次启动 syncDeliveryMirror() 补上。
 */
export function mirrorDelivery(deliveryId: number): void {
  try {
    db.prepare(DELIVERY_MIRROR_SQL.replace('%WHERE%', 'd.id = ?')).run(deliveryId);
  } catch (e) {
    deliveryFailures++;
    console.error(`[a2a-outbox] 投递镜像没写进去（旧表照常；下次启动整表同步补上）：${(e as Error)?.message ?? e}`);
  }
}

/** 不在事务里的那几处写（落定、重试）：旧写 + 镜像放进一个保存点 */
export function withDeliveryMirror<T>(write: () => T, deliveryId: number): T {
  db.exec('SAVEPOINT a2a_delivery_dual');
  try {
    const out = write();
    mirrorDelivery(deliveryId);
    db.exec('RELEASE a2a_delivery_dual');
    return out;
  } catch (e) {
    db.exec('ROLLBACK TO a2a_delivery_dual');
    db.exec('RELEASE a2a_delivery_dual');
    throw e;
  }
}

/** 启动时整表同步（事件表建好之后调）：存量迁入、补漏、改回；outbox 里对不上非 held 投递的 event-delivery 行删掉 */
export function syncDeliveryMirror(): void {
  try {
    db.exec('SAVEPOINT a2a_delivery_sync');
    try {
      db.prepare(DELIVERY_MIRROR_SQL.replace('%WHERE%', 'true')).run();
      db.prepare(`DELETE FROM a2a_outbox_items WHERE kind = 'event-delivery' AND ref NOT IN
        (SELECT CAST(id AS TEXT) FROM workbench_event_deliveries WHERE status IN ('pending','sent','dead','cancelled'))`).run();
      db.exec('RELEASE a2a_delivery_sync');
    } catch (e) { db.exec('ROLLBACK TO a2a_delivery_sync'); db.exec('RELEASE a2a_delivery_sync'); throw e; }
  } catch (e) {
    console.error(`[a2a-outbox] 启动时投递整表同步没做完（不挡启动；对账会报出来）：${(e as Error)?.message ?? e}`);
  }
}
