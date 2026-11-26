/** 待办读授权的存取：ygl-trees 来源的项目授权（task_source_read_grants）与 SOP 运行读授权的运行号（sop_run_read_grants）。判定口径在调用方（tasks-read-access.ts） */
import { db } from '../db.ts';

/** 某人在某个工作区上没撤、没过期的 ygl-trees 项目授权 */
export function activeTaskSourceProjects(subject: string, workspace: string): string[] {
  return (db.prepare("SELECT DISTINCT project FROM task_source_read_grants WHERE subject=? AND source='ygl-trees' AND workspace_sha256=? AND revoked_at='' AND datetime(expires_at)>datetime('now')").all(subject, workspace) as { project: string }[]).map(r => r.project);
}

/** 某人没撤的 SOP 运行读授权涉及的运行号（是否过期由调用方按最新一条判） */
export function grantedRunIds(subject: string): number[] {
  return (db.prepare("SELECT DISTINCT run_id FROM sop_run_read_grants WHERE subject=? AND revoked_at=''").all(subject) as { run_id: number }[]).map(r => Number(r.run_id));
}

export function insertTaskSourceGrant(subject: string, project: string, workspace: string, expires: string): void {
  db.prepare("INSERT INTO task_source_read_grants(subject,source,project,workspace_sha256,expires_at,granted_by) VALUES(?,'ygl-trees',?,?,?,'admin')").run(subject, project, workspace, expires);
}

/** 撤掉某人某项目的 ygl-trees 授权，返回撤了几条 */
export function revokeTaskSourceGrants(subject: string, project: string): number {
  return Number(db.prepare("UPDATE task_source_read_grants SET revoked_at=datetime('now') WHERE subject=? AND source='ygl-trees' AND project=? AND revoked_at=''").run(subject, project).changes);
}
