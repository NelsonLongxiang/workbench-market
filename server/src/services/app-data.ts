/** 台数据域（app_data ×6 + app_files ×8）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class AppDataService extends Service {
  constructor(ctx: any) {
    super(ctx, 'appData');
  }

  dataInsertStmt() {
    return db.prepare('INSERT INTO app_data (app_slug, data, created_by) VALUES (?, ?, ?)');
  }
  fileInsertStmt() {
    return db.prepare('INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by) VALUES (?, ?, ?, ?, ?, ?)');
  }
  dataInsert(slug: string, data: string, createdBy: string) {
    return db.prepare('INSERT INTO app_data (app_slug, data, created_by) VALUES (?, ?, ?)').run(slug, data, createdBy);
  }
  dataPage(slug: string, beforeId: number, limit: number) {
    // #132 P0③：软删行过滤
    return beforeId > 0
      ? db.prepare("SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND deleted_at = '' AND id < ? ORDER BY id DESC LIMIT ?").all(slug, beforeId, limit)
      : db.prepare("SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND deleted_at = '' ORDER BY id DESC LIMIT ?").all(slug, limit);
  }
  dataDelete(slug: string) {
    return db.prepare('DELETE FROM app_data WHERE app_slug = ?').run(slug);
  }
  fileInsert(slug: string, name: string, mime: string, size: number, storagePath: string, createdBy: string, note = '') {
    // #132 P0①：note 落库（原收了不存）
    return db.prepare('INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(slug, name, mime, size, storagePath, createdBy, note);
  }
  filePage(slug: string, beforeId: number, limit: number) {
    // #132 P0①③：列表返 note/created_by/created_at·软删行过滤
    return beforeId > 0
      ? db.prepare("SELECT id, original_name, mime, size, note, created_by, created_at FROM app_files WHERE app_slug = ? AND deleted_at = '' AND id < ? ORDER BY id DESC LIMIT ?").all(slug, beforeId, limit)
      : db.prepare("SELECT id, original_name, mime, size, note, created_by, created_at FROM app_files WHERE app_slug = ? AND deleted_at = '' ORDER BY id DESC LIMIT ?").all(slug, limit);
  }
  fileById(id: number, slug: string) {
    return db.prepare('SELECT * FROM app_files WHERE id = ? AND app_slug = ?').get(id, slug);
  }
  /** #132 P0①：note 更新 */
  fileUpdateNote(id: number, slug: string, note: string) {
    return db.prepare('UPDATE app_files SET note = ? WHERE id = ? AND app_slug = ?').run(note, id, slug);
  }
  /** #132 P0③：软删（deleted_at 置位·原行留审计） */
  fileSoftDelete(id: number, slug: string) {
    return db.prepare("UPDATE app_files SET deleted_at = datetime('now') WHERE id = ? AND app_slug = ? AND deleted_at = ''").run(id, slug);
  }
  dataSoftDelete(id: number, slug: string) {
    return db.prepare("UPDATE app_data SET deleted_at = datetime('now') WHERE id = ? AND app_slug = ? AND deleted_at = ''").run(id, slug);
  }
  filePaths(slug: string) {
    return db.prepare("SELECT storage_path FROM app_files WHERE app_slug = ? AND deleted_at = ''").all(slug);
  }
  filesDelete(slug: string) {
    return db.prepare('DELETE FROM app_files WHERE app_slug = ?').run(slug);
  }
}
