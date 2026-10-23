/** 台域（apps ×11 + app_versions ×8）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class AppService extends Service {
  constructor(ctx: any) {
    super(ctx, 'app');
  }

  bySlug(slug: string) {
    return db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
  }
  all() {
    return db.prepare('SELECT * FROM apps ORDER BY updated_at DESC, id DESC').all();
  }
  sops() {
    return db.prepare("SELECT * FROM apps WHERE kind = 'sop' ORDER BY updated_at DESC, id DESC").all();
  }
  sopBySlug(slug: string) {
    return db.prepare("SELECT * FROM apps WHERE slug = ? AND kind = 'sop'").get(slug);
  }
  delete(id: number) {
    return db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  }
  updatePublish(id: number, title: string, description: string, createdBy: string, code: string, activeVersion: number) {
    return db.prepare(`UPDATE apps SET title = ?, description = ?, created_by = ?, code = ?, active_version = ?, updated_at = datetime('now') WHERE id = ?`).run(title, description, createdBy, code, activeVersion, id);
  }
  versionInsert(appId: number, version: number, fileCount: number, totalBytes: number, createdBy: string, changelog: string) {
    return db.prepare(`INSERT INTO app_versions (app_id, version, file_count, total_bytes, created_by, changelog) VALUES (?, ?, ?, ?, ?, ?)`).run(appId, version, fileCount, totalBytes, createdBy, changelog);
  }
  versionInsertFirst(appId: number, fileCount: number, totalBytes: number, createdBy: string, changelog: string) {
    return db.prepare(`INSERT INTO app_versions (app_id, version, file_count, total_bytes, created_by, changelog) VALUES (?, 1, ?, ?, ?, ?)`).run(appId, fileCount, totalBytes, createdBy, changelog);
  }
  setActiveVersion(id: number, version: number) {
    return db.prepare(`UPDATE apps SET active_version = ?, updated_at = datetime('now') WHERE id = ?`).run(version, id);
  }
  setStatus(id: number, status: string) {
    return db.prepare(`UPDATE apps SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  }
  appendChangelog(appId: number, version: number, text: string) {
    return db.prepare(`UPDATE app_versions SET changelog = changelog || ? WHERE app_id = ? AND version = ?`).run(text, appId, version);
  }
  versionsMax(appId: number) {
    return db.prepare('SELECT MAX(version) AS v FROM app_versions WHERE app_id = ?').get(appId);
  }
  versionExists(appId: number, version: number) {
    return db.prepare('SELECT version FROM app_versions WHERE app_id = ? AND version = ?').get(appId, version);
  }
  versionsDelete(appId: number) {
    return db.prepare('DELETE FROM app_versions WHERE app_id = ?').run(appId);
  }
}
