/** 工作台域（workbenches ×37 + types ×13）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class WorkbenchService extends Service {
  constructor(ctx: any) {
    super(ctx, 'workbench');
  }

  byId(id: number) {
    return db.prepare('SELECT * FROM workbenches WHERE id = ?').get(id);
  }
  enabled() {
    return db.prepare('SELECT * FROM workbenches WHERE enabled = 1').all();
  }
  all() {
    return db.prepare('SELECT * FROM workbenches ORDER BY sort ASC, id ASC').all();
  }
  idById(id: number) {
    return db.prepare('SELECT id FROM workbenches WHERE id = ?').get(id);
  }
  delete(id: number) {
    return db.prepare('DELETE FROM workbenches WHERE id = ?').run(id);
  }
  idByUrl(url: string) {
    return db.prepare('SELECT id FROM workbenches WHERE url = ?').get(url);
  }
  typeUsageCount(key: string) {
    return db.prepare('SELECT COUNT(*) AS n FROM workbenches WHERE type = ?').get(key);
  }
  deleteByAppUrls(appUrl: string, sopUrl: string) {
    return db.prepare(`DELETE FROM workbenches WHERE (url = ? OR url = ?) AND type = 'market-app'`).run(appUrl, sopUrl);
  }
  setEnabledByUrl(enabled: number, url: string) {
    return db.prepare(`UPDATE workbenches SET enabled = ${enabled}, updated_at = datetime('now') WHERE url = ? AND type = 'market-app'`).run(url);
  }
  clearCookieSet(id: number) {
    return db.prepare('UPDATE workbenches SET cookie_set_id = 0 WHERE cookie_set_id = ?').run(id);
  }
  markDown(id: number) {
    return db.prepare(`UPDATE workbenches SET last_status='down', last_checked_at=datetime('now') WHERE id = ?`).run(id);
  }
  renameDescByUrl(name: string, description: string, url: string) {
    return db.prepare(`UPDATE workbenches SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?`).run(name, description, url);
  }
  deleteAll() {
    return db.prepare('DELETE FROM workbenches').run();
  }
  typeById(id: number) {
    return db.prepare('SELECT * FROM types WHERE id = ?').get(id);
  }
  typeDelete(id: number) {
    return db.prepare('DELETE FROM types WHERE id = ?').run(id);
  }
  typeByKey(key: string) {
    return db.prepare('SELECT * FROM types WHERE key = ?').get(key);
  }
  types() {
    return db.prepare('SELECT * FROM types ORDER BY id ASC').all();
  }
  typeIdByKey(key: string) {
    return db.prepare('SELECT id FROM types WHERE key = ?').get(key);
  }
}
