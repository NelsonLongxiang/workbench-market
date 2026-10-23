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
    return beforeId > 0
      ? db.prepare('SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND id < ? ORDER BY id DESC LIMIT ?').all(slug, beforeId, limit)
      : db.prepare('SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? ORDER BY id DESC LIMIT ?').all(slug, limit);
  }
  dataDelete(slug: string) {
    return db.prepare('DELETE FROM app_data WHERE app_slug = ?').run(slug);
  }
  fileInsert(slug: string, name: string, mime: string, size: number, storagePath: string, createdBy: string) {
    return db.prepare('INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(slug, name, mime, size, storagePath, createdBy);
  }
  filePage(slug: string, beforeId: number, limit: number) {
    return beforeId > 0
      ? db.prepare('SELECT id, original_name, mime, size, created_by, created_at FROM app_files WHERE app_slug = ? AND id < ? ORDER BY id DESC LIMIT ?').all(slug, beforeId, limit)
      : db.prepare('SELECT id, original_name, mime, size, created_by, created_at FROM app_files WHERE app_slug = ? ORDER BY id DESC LIMIT ?').all(slug, limit);
  }
  fileById(id: number, slug: string) {
    return db.prepare('SELECT * FROM app_files WHERE id = ? AND app_slug = ?').get(id, slug);
  }
  filePaths(slug: string) {
    return db.prepare('SELECT storage_path FROM app_files WHERE app_slug = ?').all(slug);
  }
  filesDelete(slug: string) {
    return db.prepare('DELETE FROM app_files WHERE app_slug = ?').run(slug);
  }
}
