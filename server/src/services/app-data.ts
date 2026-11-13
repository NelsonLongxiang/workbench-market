/**
 * 台数据域（app_data + app_files）：台的提交记录和附件的元数据。
 *
 * 接口一律是异步的（数据层第 6 步，docs/data-views.md 第十三节）：下一步要按 WM_APP_DATA_STORE 把存法换成卡片的台库（台库在工作线程里，只能异步），
 * 调用方现在就按异步写，换存法时只换这里的里面。现在的里面仍是主库上的同步语句，所以应答、次序和原来一样。
 */
import { Service } from '@deepseek-ai/cordis';
import { db } from '../db.ts';

export type AppDataRow = { id: number; data: string; created_by: string; created_at: string };
export type AppFileRow = Record<string, unknown> & { id: number; storage_path: string };

export class AppDataService extends Service {
  constructor(ctx: any) {
    super(ctx, 'appData');
  }

  /** 写一条提交，返回 id。8f-2：submitter 是验过票据的提交人主体，没有就 null；idempotencyKey 是带了提交方范围的键（没有是空串） */
  async dataInsert(slug: string, data: string, createdBy: string, idempotencyKey: string, submitter: string | null): Promise<number> {
    const r = db.prepare('INSERT INTO app_data (app_slug, data, created_by, idempotency_key, submitter_principal) VALUES (?, ?, ?, ?, ?)').run(slug, data, createdBy, idempotencyKey, submitter);
    return Number(r.lastInsertRowid);
  }
  async dataByIdempotencyKey(slug: string, key: string): Promise<{ id: number; data: string; created_at: string } | undefined> {
    return db.prepare('SELECT id, data, created_at FROM app_data WHERE app_slug = ? AND idempotency_key = ?').get(slug, key) as { id: number; data: string; created_at: string } | undefined;
  }
  async dataPage(slug: string, beforeId: number, limit: number): Promise<AppDataRow[]> {
    // #132 P0③：软删行过滤
    return (beforeId > 0
      ? db.prepare("SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND deleted_at = '' AND id < ? ORDER BY id DESC LIMIT ?").all(slug, beforeId, limit)
      : db.prepare("SELECT id, data, created_by, created_at FROM app_data WHERE app_slug = ? AND deleted_at = '' ORDER BY id DESC LIMIT ?").all(slug, limit)) as AppDataRow[];
  }
  async dataDelete(slug: string): Promise<void> {
    db.prepare('DELETE FROM app_data WHERE app_slug = ?').run(slug);
  }
  /** #193 F5：没删到（不存在、已经删了）返回 false，路由回 404 */
  async dataSoftDelete(id: number, slug: string): Promise<boolean> {
    return Number(db.prepare("UPDATE app_data SET deleted_at = datetime('now') WHERE id = ? AND app_slug = ? AND deleted_at = ''").run(id, slug).changes) > 0;
  }
  /** 写一个附件的元数据，返回 id。#132 P0①：note 落库；sha256 入库时已知就存（REST 下载 ETag 用） */
  async fileInsert(slug: string, name: string, mime: string, size: number, storagePath: string, createdBy: string, note = '', sha256 = ''): Promise<number> {
    const r = db.prepare('INSERT INTO app_files (app_slug, original_name, mime, size, storage_path, created_by, note, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slug, name, mime, size, storagePath, createdBy, note, sha256);
    return Number(r.lastInsertRowid);
  }
  async fileSetSha256(id: number, slug: string, sha256: string): Promise<void> {
    db.prepare("UPDATE app_files SET sha256 = ? WHERE id = ? AND app_slug = ? AND sha256 = ''").run(sha256, id, slug);
  }
  async filePage(slug: string, beforeId: number, limit: number): Promise<Record<string, unknown>[]> {
    // #132 P0①③：列表返 note/created_by/created_at·软删行过滤
    return (beforeId > 0
      ? db.prepare("SELECT id, original_name, mime, size, note, created_by, created_at FROM app_files WHERE app_slug = ? AND deleted_at = '' AND id < ? ORDER BY id DESC LIMIT ?").all(slug, beforeId, limit)
      : db.prepare("SELECT id, original_name, mime, size, note, created_by, created_at FROM app_files WHERE app_slug = ? AND deleted_at = '' ORDER BY id DESC LIMIT ?").all(slug, limit)) as Record<string, unknown>[];
  }
  /** #193 F4：软删行不可见（下载、改 note、软删都 404） */
  async fileById(id: number, slug: string): Promise<AppFileRow | undefined> {
    return db.prepare("SELECT * FROM app_files WHERE id = ? AND app_slug = ? AND deleted_at = ''").get(id, slug) as AppFileRow | undefined;
  }
  /** 契约核 file_ids 用：给的这些 id 里，属于本台、没软删的有哪些（一次查完，契约校验本身是同步的） */
  async fileIdsExisting(slug: string, ids: number[]): Promise<Set<number>> {
    const out = new Set<number>();
    const stmt = db.prepare("SELECT 1 AS x FROM app_files WHERE id = ? AND app_slug = ? AND deleted_at = ''");
    for (const id of new Set(ids)) if (stmt.get(id, slug)) out.add(id);
    return out;
  }
  /** #132 P0①：note 更新 */
  async fileUpdateNote(id: number, slug: string, note: string): Promise<void> {
    db.prepare('UPDATE app_files SET note = ? WHERE id = ? AND app_slug = ?').run(note, id, slug);
  }
  /** #132 P0③：软删（deleted_at 置位·原行留审计）。#193 F5：没删到返回 false，路由回 404 */
  async fileSoftDelete(id: number, slug: string): Promise<boolean> {
    return Number(db.prepare("UPDATE app_files SET deleted_at = datetime('now') WHERE id = ? AND app_slug = ? AND deleted_at = ''").run(id, slug).changes) > 0;
  }
  async fileCount(slug: string): Promise<number> {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM app_files WHERE app_slug = ? AND deleted_at = ''").get(slug) as { n: number }).n); // #193 F8 全量计数
  }
  /** 删台级联用：含软删行（行随台硬删，磁盘字节也必须一并删，否则成无主孤儿） */
  async filePaths(slug: string): Promise<string[]> {
    return (db.prepare('SELECT storage_path FROM app_files WHERE app_slug = ?').all(slug) as { storage_path: string }[]).map((r) => r.storage_path);
  }
  async filesDelete(slug: string): Promise<void> {
    db.prepare('DELETE FROM app_files WHERE app_slug = ?').run(slug);
  }
}
