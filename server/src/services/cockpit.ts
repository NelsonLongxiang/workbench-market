/** 驾驶舱域（cockpits ×9）：SQL 原文自 index.ts 搬入（S1）。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class CockpitService extends Service {
  constructor(ctx: any) {
    super(ctx, 'cockpit');
  }

  all() {
    return db.prepare('SELECT * FROM cockpits').all();
  }
  byId(id: number) {
    return db.prepare('SELECT * FROM cockpits WHERE id = ?').get(id);
  }
  list() {
    return db.prepare('SELECT * FROM cockpits ORDER BY updated_at DESC, id DESC').all();
  }
  delete(id: number) {
    return db.prepare('DELETE FROM cockpits WHERE id = ?').run(id);
  }
}
