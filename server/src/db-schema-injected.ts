/**
 * 库由调用方注入的模块的建表（属主 2026-11-26 批准，单 c808f951 / KB 495c1b9cfe）。
 *
 * 有的模块按设计不碰主库：库由调用方选定后传进来（sop-run-access.ts 是未挂载服务、测试用内存库；
 * portal-observation.ts 只在显式选定的观测库上记数）。它们的表不能建在 db.ts 里（db.ts 一加载就打开主库），
 * 也不能放进 services/（那里只放语句）。这里是它们的建表的唯一位置。
 *
 * 限制（tech-route-check 的 injected-schema-ddl-only 红线守着）：
 *   - 只接收调用方传进来的库，不导入主库（只许 import type）、不自己 new DatabaseSync；
 *   - 只放建表、建索引、建触发器、改表；普通查询一律归 services/。
 * 语句逐字照搬自原调用方。
 */
import type { DatabaseSync } from 'node:sqlite';

/** SOP 运行写通道（sop-run-access.ts）的三张表 */
export function ensureSopRunAccessSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS sop_run_access (run_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL, sop_version INTEGER NOT NULL, owner_subject TEXT NOT NULL, assignee_subject TEXT NOT NULL, acl_revision INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS sop_run_revisions (run_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data_sha256 TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sop_channel_files (id TEXT PRIMARY KEY,run_id INTEGER NOT NULL,step TEXT NOT NULL,field_key TEXT NOT NULL,request_id TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,body BLOB NOT NULL,UNIQUE(run_id,step,request_id))');
}

/** 门户被动计数（portal-observation.ts）的表；客户端类别清单由调用方给（就是 PORTAL_CLIENT_CLASSES） */
export function ensurePortalObservationSchema(db: DatabaseSync, clientClasses: readonly string[]): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS portal_observation_counts (' +
    'target_id INTEGER NOT NULL CHECK(target_id>0), client_class TEXT NOT NULL CHECK(client_class IN (' +
    clientClasses.map(c => "'" + c + "'").join(',') +
    ')), utc_day TEXT NOT NULL, hits INTEGER NOT NULL CHECK(hits>0),' +
    'PRIMARY KEY(target_id,client_class,utc_day))'
  );
}
