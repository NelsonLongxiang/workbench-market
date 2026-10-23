/** Cookie 池域（cookie_sets ×5）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class CookieService extends Service {
  constructor(ctx: any) {
    super(ctx, 'cookie');
  }

  byId(id: number) {
    return db.prepare('SELECT id FROM cookie_sets WHERE id = ?').get(id);
  }
  create(label: string, cookiesJson: string) {
    return db.prepare('INSERT INTO cookie_sets (label, cookies_json) VALUES (?, ?)').run(label, cookiesJson);
  }
  all() {
    return db.prepare('SELECT * FROM cookie_sets ORDER BY id DESC').all();
  }
  delete(id: number) {
    return db.prepare('DELETE FROM cookie_sets WHERE id = ?').run(id);
  }
  cookiesJsonById(id: number) {
    return db.prepare('SELECT cookies_json FROM cookie_sets WHERE id = ?').get(id);
  }
}
