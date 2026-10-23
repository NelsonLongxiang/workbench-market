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
