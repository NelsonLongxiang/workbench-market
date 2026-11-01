/** #324: a fresh verified identity is not a source-wide task grant. */
import { db } from './db.ts';
import { resolveOdooViewer } from './lifecycle.ts';
import { runGrantActive } from './sop-read-auth.ts';
import { taskWorkspaceKey, type TasksReadScope } from './tasks.ts';

export async function tasksReadAccess(adminOk: boolean, cookie: string): Promise<
  { ok: true; scope: TasksReadScope } | { ok: false; http: number; error: string }
> {
  if (adminOk) return { ok: true, scope: { subject: 'admin', admin: true, yglProjects: 'all', marketRunIds: 'all', a2a: true } };
  if (!/(?:^|;\s*)session_id=/.test(cookie)) return { ok: false, http: 401, error: 'tasks_auth_required' };
  const who = await resolveOdooViewer(cookie);
  if (!who.ok) return { ok: false, http: who.http >= 500 ? 503 : who.http, error: who.http >= 500 ? 'tasks_identity_unavailable' : who.http === 403 ? 'tasks_internal_user_required' : 'tasks_auth_required' };
  const subject = who.viewer.sub;
  try {
    const workspace = taskWorkspaceKey();
    const projects = workspace ? (db.prepare("SELECT DISTINCT project FROM task_source_read_grants WHERE subject=? AND source='ygl-trees' AND workspace_sha256=? AND revoked_at='' AND datetime(expires_at)>datetime('now')").all(subject, workspace) as { project: string }[]).map(r => r.project) : [];
    // Match the run-detail authority: newest unrevoked grant decides expiry.
    const runs = (db.prepare("SELECT DISTINCT run_id FROM sop_run_read_grants WHERE subject=? AND revoked_at=''").all(subject) as { run_id: number }[]).map(r => Number(r.run_id)).filter(id => runGrantActive(id, subject));
    return { ok: true, scope: { subject, admin: false, yglProjects: projects, marketRunIds: runs, a2a: false } };
  } catch { return { ok: false, http: 503, error: 'tasks_authority_unavailable' }; }
}

function grantInput(body: any): { subject: string; project: string } | null {
  const subject = body?.subject, project = body?.project;
  if (typeof subject !== 'string' || !subject.startsWith('user:')) return null;
  const login = subject.slice(5);
  if (!login || login.length > 128 || login !== login.trim() || /[\x00-\x1f\x7f]/.test(login)) return null;
  if (typeof project !== 'string' || !project || project.length > 128 || /[\x00-\x1f\x7f]/.test(project) || project === '*') return null;
  return { subject, project };
}

export function createTaskSourceGrant(body: unknown): boolean {
  const input = grantInput(body), expires = (body as any)?.expires_at, workspace = taskWorkspaceKey();
  if (!input || !workspace || typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(expires)) return false;
  const date = new Date(expires.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(date.getTime()) || date <= new Date() || date.toISOString().slice(0, 19).replace('T', ' ') !== expires) return false;
  db.prepare("INSERT INTO task_source_read_grants(subject,source,project,workspace_sha256,expires_at,granted_by) VALUES(?,'ygl-trees',?,?,?,'admin')").run(input.subject, input.project, workspace, expires);
  return true;
}
export function revokeTaskSourceGrant(body: unknown): number | null {
  const input = grantInput(body);
  if (!input) return null;
  return Number(db.prepare("UPDATE task_source_read_grants SET revoked_at=datetime('now') WHERE subject=? AND source='ygl-trees' AND project=? AND revoked_at=''").run(input.subject, input.project).changes);
}
