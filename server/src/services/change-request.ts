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
  /** 批准、拒绝：principal 是经身份认出来的审核人（旧入口自填的 reviewed_by 只做显示）；note 是不通过的理由。时间由代码生成后传进来 */
  markApproved(reviewedBy: string, id: number, principal = '') {
    return db.prepare("UPDATE change_requests SET status='approved', reviewed_by=?, reviewed_by_principal=?, reviewed_at=? WHERE id=?").run(reviewedBy, principal, now(), id);
  }
  markRejected(reviewedBy: string, id: number, principal = '', note = '') {
    return db.prepare("UPDATE change_requests SET status='rejected', reviewed_by=?, reviewed_by_principal=?, review_note=?, reviewed_at=? WHERE id=?").run(reviewedBy, principal, note, now(), id);
  }

  /**
   * 审核卡片上「看内容所需的最少字段」：要动的是哪个台或技能、现在是第几版、回滚到第几版和那一版的说明、谁为什么申请、
   * 删除时会一并删掉几个版本几个文件（只给计数，不出文件内容）。删除不可恢复（irreversible）。
   */
  detailOf(r: { kind: string; slug: string; op: string; target_version: number | null; reason: string; requested_by: string; created_at: string }): Record<string, unknown> {
    const app = r.kind === 'app';
    const owner = (app
      ? db.prepare('SELECT id, title, active_version AS current FROM apps WHERE slug = ?').get(r.slug)
      : db.prepare('SELECT id, name AS title, COALESCE(active_version, (SELECT MAX(version) FROM skill_versions v WHERE v.skill_id = skills.id)) AS current FROM skills WHERE slug = ?').get(r.slug)) as { id: number; title: string; current: number | null } | undefined;
    const versions = owner ? (app
      ? db.prepare('SELECT version, changelog, file_count FROM app_versions WHERE app_id = ?').all(owner.id)
      : db.prepare('SELECT version, changelog, file_count FROM skill_versions WHERE skill_id = ?').all(owner.id)) as { version: number; changelog: string; file_count: number }[] : [];
    const target = r.op === 'rollback' ? versions.find((v) => v.version === Number(r.target_version)) : undefined;
    return {
      kind: r.kind, op: r.op, slug: r.slug, title: owner?.title ?? '', exists: !!owner,
      current_version: owner?.current ?? null, target_version: r.op === 'rollback' ? r.target_version ?? null : null,
      target_changelog: target ? String(target.changelog ?? '').slice(0, 300) : '',
      requested_by: r.requested_by, reason: r.reason, created_at: r.created_at,
      irreversible: r.op === 'delete',
      ...(r.op === 'delete' ? { impact: { versions: versions.length, files: versions.reduce((n, v) => n + Number(v.file_count || 0), 0) } } : {}),
    };
  }
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
