/** 人审变更请求域（change_requests ×6）：SQL 原文自 index.ts 的 /api/change-requests 路由搬入——同语句、同参数、同结果形状。 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export class ChangeRequestService extends Service {
  constructor(ctx: any) {
    super(ctx, 'changeRequest');
  }

  /** 某个状态的请求，新的在前，最多 100 条 */
  listByStatus(status: string) {
    return db.prepare('SELECT * FROM change_requests WHERE status = ? ORDER BY id DESC LIMIT 100').all(status);
  }
  /** 全部请求，新的在前，最多 100 条 */
  listAll() {
    return db.prepare('SELECT * FROM change_requests ORDER BY id DESC LIMIT 100').all();
  }
  byId(id: number) {
    return db.prepare('SELECT * FROM change_requests WHERE id = ?').get(id);
  }
  markApproved(reviewedBy: string, id: number) {
    return db.prepare("UPDATE change_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(reviewedBy, id);
  }
  markRejected(reviewedBy: string, id: number) {
    return db.prepare("UPDATE change_requests SET status='rejected', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(reviewedBy, id);
  }
}
