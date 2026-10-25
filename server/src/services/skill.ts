/** 技能市场服务域（P0-a-2 · 方案 PR#57 §2）：skills/skill_versions/role_bundles/install_ledger
 *  数据访问收口——与八域同纪律：SQL 原文自方案 DDL 语义直出，服务方法不做业务裁决。 */
import { Service } from '@deepseek-ai/cordis';
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
  versionByDigest(digest: string) {
    return db.prepare('SELECT * FROM skill_versions WHERE tree_digest = ?').get(digest);
  }
  versionsMax(skillId: number) {
    return db.prepare('SELECT MAX(version) AS v FROM skill_versions WHERE skill_id = ?').get(skillId);
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
}
