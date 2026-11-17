/** 技能市场服务域（P0-a-2 建立 · P0-b 扩发布面）：数据访问收口，方法不做业务裁决。 */
import { Service } from '@deepseek-ai/cordis';
import type { SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { db } from '../db.ts';

export class SkillService extends Service {
  constructor(ctx: any) {
    super(ctx, 'skill');
  }

  // ---- skills ----
  upsertSkill(r: { slug: string; name: string; layer: number; layerName: string; familyParent?: string; description?: string; argumentHint?: string; author?: string; source: string; legacy?: number }) {
    return db.prepare(`INSERT INTO skills (slug, name, layer, layer_name, family_parent, description, argument_hint, author, source, legacy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET name=excluded.name, layer=excluded.layer, layer_name=excluded.layer_name,
        family_parent=excluded.family_parent, description=excluded.description, argument_hint=excluded.argument_hint,
        author=excluded.author, updated_at=datetime('now')`).run(
      r.slug, r.name, r.layer, r.layerName, r.familyParent ?? '', r.description ?? '', r.argumentHint ?? '', r.author ?? '', r.source, r.legacy ?? 0);
  }
  skillBySlug(slug: string) {
    return db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug);
  }
  skillsByLayer(layer: number) {
    return db.prepare('SELECT * FROM skills WHERE layer = ? ORDER BY slug').all(layer);
  }
  skillsAll() {
    return db.prepare('SELECT * FROM skills ORDER BY layer, slug').all();
  }
  skillsBySource(source: string) {
    return db.prepare('SELECT * FROM skills WHERE source = ? ORDER BY slug').all(source);
  }
  skillsCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM skills').get();
  }

  // ---- skill_versions（不可变：只 INSERT，无 UPDATE）----
  versionInsert(r: { skillId: number; version: number; changelog?: string; breaking?: number; treeDigest: string; fileCount?: number; totalBytes?: number; snapshotPath?: string; reviewedBy?: string }) {
    return db.prepare('INSERT INTO skill_versions (skill_id, version, changelog, breaking, tree_digest, file_count, total_bytes, snapshot_path, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.skillId, r.version, r.changelog ?? '', r.breaking ?? 0, r.treeDigest, r.fileCount ?? 0, r.totalBytes ?? 0, r.snapshotPath ?? '', r.reviewedBy ?? '');
  }
  versionsBySkill(skillId: number) {
    return db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(skillId);
  }
  versionByDigest(digest: string, skillId?: number) {
    // #94 S0⑥（K9）：digest 唯一性按 skill 域（不同技能同内容各自可发布——全局唯一是误拒）
    return skillId
      ? db.prepare('SELECT * FROM skill_versions WHERE tree_digest = ? AND skill_id = ?').get(digest, skillId)
      : db.prepare('SELECT * FROM skill_versions WHERE tree_digest = ?').get(digest);
  }
  /** 当前版本：skills.active_version 指针指向的版本（回滚后），未设或指向已不在的版本时取最新版。vs 为 versionsBySkill 结果（newest-first） */
  static currentOf(skill: { active_version?: number | null }, vs: any[]): any | undefined {
    return (skill.active_version != null && vs.find((v) => v.version === skill.active_version)) || vs[0];
  }
  /** 回滚/前移：指针指向已有版本（不新增版本）；version=null 恢复跟随最新版（发布新版时） */
  setActive(skillId: number, version: number | null, by = '') {
    return version == null
      ? db.prepare("UPDATE skills SET active_version = NULL, active_by = '', active_at = '' WHERE id = ?").run(skillId)
      : db.prepare("UPDATE skills SET active_version = ?, active_by = ?, active_at = datetime('now') WHERE id = ?").run(version, by, skillId);
  }
  versionsMax(skillId: number) {
    return db.prepare('SELECT MAX(version) AS v FROM skill_versions WHERE skill_id = ?').get(skillId);
  }

  /** P0-b 发布面：文件树摘要（排序相对路径+内容，/ 归一）——与导入器 treeDigest 同构 */
  static filesDigest(files: { path: string; content: string | Buffer }[]): { digest: string; fileCount: number; totalBytes: number } {
    // #94 S0①根治：全市场单一**字节序**摘要（codepoint——与导入器 files.sort() 同构；localeCompare 大小写/音标分歧即误判）
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const h = createHash('sha256');
    let bytes = 0;
    for (const f of sorted) {
      h.update(f.path.split('\\').join('/')); h.update('\0');
      h.update(createHash('sha256').update(typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content).digest('hex')); h.update('\0');
      bytes += Buffer.byteLength(f.content, 'utf8');
    }
    return { digest: h.digest('hex'), fileCount: sorted.length, totalBytes: bytes };
  }

  // ---- role_bundles ----
  bundleUpsert(r: { packId: string; memberName: string; bundleVersion: number; rosterDigest: string; promptSoul?: string; skillSlugs?: string; snapshotJson?: string }) {
    return db.prepare(`INSERT INTO role_bundles (pack_id, member_name, bundle_version, roster_digest, prompt_soul, skill_slugs, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pack_id, member_name, bundle_version) DO UPDATE SET roster_digest=excluded.roster_digest,
        prompt_soul=excluded.prompt_soul, skill_slugs=excluded.skill_slugs, snapshot_json=excluded.snapshot_json`)
      .run(r.packId, r.memberName, r.bundleVersion, r.rosterDigest, r.promptSoul ?? '', r.skillSlugs ?? '[]', r.snapshotJson ?? '');
  }
  bundlesAll() {
    return db.prepare('SELECT * FROM role_bundles ORDER BY pack_id, member_name, bundle_version DESC').all();
  }

  // ---- install_ledger ----
  ledgerInsert(r: { skillId: number; versionId: number; expectedDigest: string; installedPath: string; installedBy?: string }) {
    return db.prepare('INSERT INTO install_ledger (skill_id, version_id, expected_digest, installed_path, installed_by) VALUES (?, ?, ?, ?, ?)')
      .run(r.skillId, r.versionId, r.expectedDigest, r.installedPath, r.installedBy ?? '');
  }
  ledgerActive() {
    return db.prepare("SELECT * FROM install_ledger WHERE status = 'installed' ORDER BY id DESC").all();
  }
  ledgerRevoke(id: number) {
    return db.prepare("UPDATE install_ledger SET status = 'revoked' WHERE id = ?").run(id);
  }

  // ---- 以下原文自 index.ts 的 /api/skills 路由（下载、迁移、摘要上报）搬入：同语句、同参数、同结果形状 ----
  /** 下载票（库里只存票号的 sha256） */
  ticketByKey(key: string) {
    return db.prepare('SELECT * FROM skill_download_tickets WHERE id = ?').get(key);
  }
  /** 用满之后再来：记一次拒绝 */
  ticketDenied(key: string) {
    return db.prepare('UPDATE skill_download_tickets SET denied = denied + 1 WHERE id = ?').run(key);
  }
  ticketDownloaded(key: string) {
    return db.prepare("UPDATE skill_download_tickets SET downloads = downloads + 1, last_download_at = datetime('now') WHERE id = ?").run(key);
  }
  /** 迁移：推 LayerFS 失败 */
  versionShadowPublishFailed(id: number) {
    return db.prepare("UPDATE skill_versions SET shadow_status='failed', shadow_error='LayerFS publish failed; retry migrate-layerfs' WHERE id=? AND commit_id=''").run(id);
  }
  /** 迁移：推上去了，读回的摘要对不上 */
  versionShadowFailed(error: string, id: number) {
    return db.prepare("UPDATE skill_versions SET shadow_status='failed', shadow_error=? WHERE id=? AND commit_id=''").run(error, id);
  }
  versionMigrated(commitId: string, id: number) {
    return db.prepare("UPDATE skill_versions SET commit_id = ?, shadow_status='succeeded', shadow_error='' WHERE id = ?").run(commitId, id);
  }
  /** 补推：含二进制文件的版本，LayerFS 契约只收文本，以后不再试（和发布时一样记 skipped） */
  versionShadowSkipped(error: string, id: number) {
    return db.prepare("UPDATE skill_versions SET shadow_status='skipped', shadow_error=? WHERE id=? AND commit_id=''").run(error, id);
  }
  /**
   * 补推的候选：各技能的当前版本（active_version 指着的，没有就是最新版）里，没有 commit_id、不是 skipped、有快照的；
   * 遗产登记（legacy，不留快照）不算。没推过的排在失败过的前面，同一档按 id
   */
  shadowCatchUpCandidates(limit: number) {
    return db.prepare(`SELECT v.*, s.slug AS skill_slug FROM skill_versions v JOIN skills s ON s.id = v.skill_id
      WHERE v.commit_id = '' AND v.shadow_status <> 'skipped' AND v.snapshot_path <> '' AND s.legacy = 0
        AND v.version = COALESCE(
          (SELECT x.version FROM skill_versions x WHERE x.skill_id = s.id AND x.version = s.active_version),
          (SELECT MAX(x.version) FROM skill_versions x WHERE x.skill_id = s.id))
      ORDER BY CASE v.shadow_status WHEN 'failed' THEN 1 ELSE 0 END, v.id
      LIMIT ?`).all(limit);
  }
  /** 整库重建：项目删了，这个技能各版的 commit 都失效——commit_id 清掉、状态回到 pending（skipped 的不动） */
  versionsShadowCleared(skillId: number) {
    return db.prepare("UPDATE skill_versions SET commit_id = '', shadow_status = CASE WHEN shadow_status = 'skipped' THEN 'skipped' ELSE 'pending' END, shadow_error = CASE WHEN shadow_status = 'skipped' THEN shadow_error ELSE '' END WHERE skill_id = ?").run(skillId);
  }
  /** skillId 是技能行里取出来的原值（和原来直接交给 prepare 一样） */
  digestReportInsert(skillId: SQLInputValue, version: number, digest: string, expected: string, matchResult: number, reportedBy: string) {
    return db.prepare('INSERT INTO skill_digest_reports (skill_id, version, digest, expected, match_result, reported_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(skillId, version, digest, expected, matchResult, reportedBy);
  }
}
