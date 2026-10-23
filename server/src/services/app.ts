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
  delete(id: number) {
    return db.prepare('DELETE FROM apps WHERE id = ?').run(id);
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
