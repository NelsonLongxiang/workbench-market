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
  /** 全字段更新（REST 编辑路径）——SQL 原文自 index.ts 搬入 */
  updateAll(r: { name: string; url: string; type: string; icon: string; description: string; category: string; tags: string; enabled: number | boolean; health_path: string; sort: number; auth_config: string; cookie_set_id: number; id: number }) {
    return db.prepare(
      `UPDATE workbenches SET name=@name, url=@url, type=@type, icon=@icon, description=@description,
     category=@category, tags=@tags, enabled=@enabled, health_path=@health_path, sort=@sort,
     auth_config=@auth_config, cookie_set_id=@cookie_set_id, updated_at=datetime('now') WHERE id=@id`
    ).run(r);
  }
  markSelfUp(id: number) {
    return db.prepare(
      `UPDATE workbenches SET last_status='up', last_checked_at=datetime('now'), last_latency_ms=0, last_http_code=200, last_error='' WHERE id=?`
    ).run(id);
  }
  markDownWithError(id: number, error: string) {
    return db.prepare(`UPDATE workbenches SET last_status='down', last_checked_at=datetime('now'),
      last_latency_ms=NULL, last_http_code=NULL, last_error=? WHERE id=?`).run(error, id);
  }
  applyProbeResult(r: { status: string; latency: number | null; code: number | null; error: string; id: number }) {
    return db.prepare(
      `UPDATE workbenches SET last_status=@status, last_checked_at=datetime('now'),
     last_latency_ms=@latency, last_http_code=@code, last_error=@error WHERE id=@id`
    ).run({ status: r.status, latency: r.latency, code: r.code, error: r.error, id: r.id });
  }
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM workbenches').get();
  }
  cookieSetId(id: number) {
    return db.prepare('SELECT cookie_set_id FROM workbenches WHERE id = ?').get(id);
  }
  exists(id: number) {
    return db.prepare('SELECT 1 AS x FROM workbenches WHERE id = ?').get(id);
  }
  typeInsertIgnoreStmt() {
    return db.prepare(
      `INSERT OR IGNORE INTO types (key, name, icon, default_port, health_method, health_path, expect_status, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }
  importInsertStmt() {
    return db.prepare(
      `INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort, auth_config, last_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`
    );
  }
  insertStmt() {
    return db.prepare(`INSERT INTO workbenches (name, url, type, icon, description, category, tags, enabled, health_path, sort)
      VALUES (@name, @url, @type, @icon, @description, @category, @tags, @enabled, @health_path, @sort)`);
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
  typeInsertStmt() {
    return db.prepare(
      `INSERT INTO types (key, name, icon, default_port, health_method, health_path, expect_status, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }
  typeUpdate(r: { name: string; icon: string; default_port: number | null; health_method: string; health_path: string; expect_status: number | null; description: string; id: number }) {
    return db.prepare(
      `UPDATE types SET name=@name, icon=@icon, default_port=@default_port, health_method=@health_method,
     health_path=@health_path, expect_status=@expect_status, description=@description WHERE id=@id`
    ).run(r);
  }
  typeDeleteAllExcept(key: string) {
    return db.prepare('DELETE FROM types WHERE key != ?').run(key);
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
