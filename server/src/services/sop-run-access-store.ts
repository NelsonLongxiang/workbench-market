/**
 * SOP 运行写通道（sop-run-access.ts，未挂载服务）的语句：库由调用方注入（测试用内存库），这里不导入主库。
 * 每个方法返回预编译语句，调用方照原样 .get/.all/.run；语句逐字照搬自 sop-run-access.ts。建表仍在调用方（待裁定）。
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export function createSopRunAccessStore(db: DatabaseSync) {
  const q = (sql: string): StatementSync => db.prepare(sql);
  return {
    accessByRun: () => q("SELECT * FROM sop_run_access WHERE run_id=?"),
    runHead: () => q("SELECT id,sop_slug,sop_version,status FROM sop_runs WHERE id=?"),
    workbenchUrlEnabled: () => q("SELECT url,enabled FROM workbenches WHERE id=?"),
    appKindStatus: () => q("SELECT id,kind,status FROM apps WHERE slug=?"),
    appVersionExists: () => q("SELECT 1 FROM app_versions WHERE app_id=? AND version=?"),
    runData: () => q("SELECT data FROM sop_runs WHERE id=?"),
    stepFileRefs: () => q("SELECT id,field_key FROM sop_channel_files WHERE run_id=? AND step=? ORDER BY rowid"),
    runRevision: () => q("SELECT revision,data_sha256 FROM sop_run_revisions WHERE run_id=?"),
    upsertAccess: () => q("INSERT INTO sop_run_access(run_id,target_id,sop_version,owner_subject,assignee_subject,acl_revision,manifest_sha256,revoked) VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(run_id) DO UPDATE SET target_id=excluded.target_id,sop_version=excluded.sop_version,owner_subject=excluded.owner_subject,assignee_subject=excluded.assignee_subject,acl_revision=excluded.acl_revision,manifest_sha256=excluded.manifest_sha256,revoked=0"),
    initRevision: () => q("INSERT OR IGNORE INTO sop_run_revisions VALUES(?,0,?)"),
    revokeAccess: () => q("UPDATE sop_run_access SET revoked=1,acl_revision=acl_revision+1 WHERE run_id=?"),
    stepFiles: () => q("SELECT id,field_key,mime,size FROM sop_channel_files WHERE run_id=? AND step=? ORDER BY rowid"),
    bumpRevision: () => q("UPDATE sop_run_revisions SET revision=?,data_sha256=? WHERE run_id=? AND revision=? AND data_sha256=?"),
    finishRun: () => q("UPDATE sop_runs SET status='finished',data=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='running'"),
    uploadReplayed: () => q("SELECT 1 FROM sop_channel_files WHERE run_id=? AND step=? AND request_id=?"),
    fieldFileCount: () => q("SELECT count(*) n FROM sop_channel_files WHERE run_id=? AND step=? AND field_key=?"),
    runFileTotals: () => q("SELECT count(*) n,coalesce(sum(size),0) bytes FROM sop_channel_files WHERE run_id=?"),
    insertFile: () => q("INSERT INTO sop_channel_files VALUES(?,?,?,?,?,?,?,?)"),
    saveRunData: () => q("UPDATE sop_runs SET data=? WHERE id=? AND status='running'"),
    begin: () => db.exec('BEGIN IMMEDIATE'),
    commit: () => db.exec('COMMIT'),
    rollback: () => db.exec('ROLLBACK'),
  };
}
