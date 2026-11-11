/**
 * 唯一 outbox（阶段七第 3 步）双写期的镜像：回执照旧写 a2a_outbox，每次写完把那一行的传输状态原样同步进 a2a_outbox_items
 * （kind=run-receipt，ref=run_id）。读和投递仍走旧表；切读、停旧写是后面的 PR。
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
