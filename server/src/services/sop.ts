/** SOP 域（sop_runs ×10 + sop_bindings ×5 + a2a_run_ctx ×2）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class SopService extends Service {
  constructor(ctx: any) {
    super(ctx, 'sop');
  }

  runCreate(slug: string, version: number, startedBy: string) {
    return db.prepare(`INSERT INTO sop_runs (sop_slug, sop_version, started_by) VALUES (?, ?, ?)`).run(slug, version, startedBy);
  }
  runById(id: number) {
    return db.prepare('SELECT * FROM sop_runs WHERE id = ?').get(id);
  }
  runByIdRunning(id: number) {
    return db.prepare('SELECT * FROM sop_runs WHERE id = ? AND status = ?').get(id, 'running');
  }
  runStatusData(id: number) {
    return db.prepare('SELECT status, data FROM sop_runs WHERE id = ?').get(id);
  }
  runSaveData(id: number, data: string) {
    return db.prepare("UPDATE sop_runs SET data = ?, updated_at = datetime('now') WHERE id = ?").run(data, id);
  }
  runsBySlug(slug: string) {
    return db.prepare('SELECT * FROM sop_runs WHERE sop_slug = ? ORDER BY id DESC').all(slug);
  }
  runsRecent(limit: number) {
    return db.prepare('SELECT * FROM sop_runs ORDER BY id DESC LIMIT ?').all(limit);
  }
  runUpdateData(id: number, data: string) {
    return db.prepare(`UPDATE sop_runs SET data = ?, updated_at = datetime('now') WHERE id = ?`).run(data, id);
  }
  runFinish(id: number, data: string) {
    return db.prepare(`UPDATE sop_runs SET status = 'finished', data = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(data, id);
  }
  runsRunning() {
    return db.prepare("SELECT * FROM sop_runs WHERE status = 'running' ORDER BY updated_at DESC").all();
  }
  activeBindingCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM sop_bindings WHERE revoked_at = ''").get();
  }
  bindings(slug: string) {
    return db.prepare('SELECT * FROM sop_bindings WHERE sop_slug = ? ORDER BY id DESC').all(slug);
  }
  bindingCreate(slug: string, node: string, mode: string, remoteApiKey: string, createdBy: string) {
    return db.prepare('INSERT INTO sop_bindings (sop_slug, node, mode, remote_api_key, created_by) VALUES (?, ?, ?, ?, ?)').run(slug, node, mode, remoteApiKey, createdBy);
  }
  bindingExists(id: number, slug: string) {
    return db.prepare('SELECT id FROM sop_bindings WHERE id = ? AND sop_slug = ?').get(id, slug);
  }
  bindingRevoke(id: number) {
    return db.prepare("UPDATE sop_bindings SET revoked_at = datetime('now') WHERE id = ?").run(id);
  }
  bindingByNode(slug: string, node: string) {
    return db.prepare("SELECT mode FROM sop_bindings WHERE sop_slug = ? AND node = ? AND revoked_at = ''").get(slug, node);
  }
  runsQuery(sql: string, args: unknown[]) {
    return db.prepare(sql).all(...(args as never[]));
  }
  // ---- A2A P3 回执（network/a2a-receipt） ----
  ctxRegisterFull(r: { contextId: string; runId: number; taskId: string; caller: string; team: string; receiptStatus: string }) {
    return db.prepare('INSERT INTO a2a_run_ctx (context_id, run_id, task_id, caller, team, receipt_status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.contextId, r.runId, r.taskId, r.caller, r.team, r.receiptStatus);
  }
  ctxRegisterSource(r: { contextId: string; runId: number; taskId: string; caller: string; team: string; receiptStatus: string }) {
    return this.ctxRegisterFull(r);
  }
  ctxSetCallback(runId: number, callbackUrl: string) {
    return db.prepare('UPDATE a2a_run_ctx SET callback_url = ? WHERE run_id = ?').run(callbackUrl, runId);
  }
  ctxSourceByRun(runId: number) {
    return db.prepare('SELECT * FROM a2a_run_ctx WHERE run_id = ? ORDER BY id DESC').get(runId);
  }
  ctxSetReceiptStatus(runId: number, status: string) {
    return db.prepare('UPDATE a2a_run_ctx SET receipt_status = ? WHERE run_id = ?').run(status, runId);
  }
  bindingByNodeFull(slug: string, node: string) {
    return db.prepare("SELECT * FROM sop_bindings WHERE sop_slug = ? AND node = ? AND revoked_at = ''").get(slug, node);
  }
  bindingCreateFull(slug: string, node: string, mode: string, remoteApiKey: string, callbackUrl: string, createdBy: string) {
    return db.prepare('INSERT INTO sop_bindings (sop_slug, node, mode, remote_api_key, callback_url, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(slug, node, mode, remoteApiKey, callbackUrl, createdBy);
  }
  outboxInsert(r: { runId: number; taskId: string; contextId: string; targetUrl: string; payload: string }) {
    return db.prepare('INSERT OR IGNORE INTO a2a_outbox (run_id, task_id, context_id, target_url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(r.runId, r.taskId, r.contextId, r.targetUrl, r.payload);
  }
  outboxByRun(runId: number) {
    return db.prepare('SELECT * FROM a2a_outbox WHERE run_id = ? ORDER BY id DESC').get(runId);
  }
  outboxDue(limit: number) {
    return db.prepare("SELECT * FROM a2a_outbox WHERE status = 'pending' AND next_at <= datetime('now') ORDER BY id ASC LIMIT ?").all(limit);
  }
  outboxMarkSent(id: number) {
    return db.prepare("UPDATE a2a_outbox SET status = 'sent', sent_at = datetime('now'), last_error = '' WHERE id = ?").run(id);
  }
  outboxMarkRetry(id: number, attempts: number, nextAtIso: string, error: string) {
    return db.prepare("UPDATE a2a_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?").run(attempts, nextAtIso, error.slice(0, 300), id);
  }
  outboxMarkDead(id: number, error: string) {
    return db.prepare("UPDATE a2a_outbox SET status = 'dead', last_error = ? WHERE id = ?").run(error.slice(0, 300), id);
  }
  ctxRunId(contextId: string) {
    return db.prepare('SELECT run_id FROM a2a_run_ctx WHERE context_id = ? ORDER BY id DESC').get(contextId);
  }
  ctxRegister(contextId: string, runId: number) {
    return db.prepare('INSERT INTO a2a_run_ctx (context_id, run_id) VALUES (?, ?)').run(contextId, runId);
  }
}
