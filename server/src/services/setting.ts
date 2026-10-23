/** 设置域（settings ×7）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class SettingService extends Service {
  constructor(ctx: any) {
    super(ctx, 'setting');
  }

  get(key: string) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  }
  has(key: string) {
    return db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
  }
  upsertStmt() {
    return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  }
  put(key: string, value: string) {
    return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  delete(key: string) {
    return db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
  all() {
    return db.prepare('SELECT key, value FROM settings').all();
  }
}
