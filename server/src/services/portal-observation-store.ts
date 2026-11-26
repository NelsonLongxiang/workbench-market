/**
 * 门户被动计数（portal-observation.ts）的语句：库由调用方显式选定并注入，这里同样不导入主库。
 * 每个方法返回预编译语句，调用方照原样 .run/.all；语句逐字照搬自 portal-observation.ts。建表仍在调用方（待裁定）。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export function createPortalObservationStore(db: DatabaseSync) {
  return {
    increment: (): StatementSync => db.prepare('INSERT INTO portal_observation_counts VALUES(?,?,?,1) ' +
      'ON CONFLICT(target_id,client_class,utc_day) DO UPDATE SET hits=hits+1'),
    counts: (): StatementSync => db.prepare('SELECT target_id,client_class,utc_day,hits FROM portal_observation_counts ' +
      'ORDER BY utc_day,target_id,client_class'),
  };
}
